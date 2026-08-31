package crew

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

func homeDir() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return "/"
	}
	return h
}

func tildify(p string) string {
	h := homeDir()
	if p == h || strings.HasPrefix(p, h+"/") {
		return "~" + p[len(h):]
	}
	return p
}

// CrewError — expected failures print a clean one-line message, never a stack.
type CrewError struct{ msg string }

func (e *CrewError) Error() string { return e.msg }

func fail(format string, args ...any) {
	panic(&CrewError{msg: fmt.Sprintf(format, args...)})
}

func warn(msg string) {
	fmt.Fprintln(os.Stderr, cYellow("crew: "+msg))
}

// ---- path helpers: ~ expansion + relative-to-cwd resolution everywhere ----

func expandHome(p string) string {
	if p == "~" {
		return homeDir()
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(homeDir(), p[2:])
	}
	return p
}

func resolvePath(p string) string {
	e := expandHome(p)
	if filepath.IsAbs(e) {
		return filepath.Clean(e)
	}
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, e)
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// ---- shell quoting: wrap substituted values so spaces/metacharacters are safe ----

var shellSafeRE = regexp.MustCompile(`^[A-Za-z0-9_/.:=@%+,-]+$`)

func shellQuote(v string) string {
	if v == "" {
		return "''"
	}
	if shellSafeRE.MatchString(v) {
		return v
	}
	return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'"
}

// ---- placeholders: {name} tokens inside a resolved command string ----

var placeholderRE = regexp.MustCompile(`\{([A-Za-z0-9_]+)\}`)

func placeholdersIn(str string) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range placeholderRE.FindAllStringSubmatch(str, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

func substitute(str string, values map[string]string) string {
	// Unknown placeholders are left intact (e.g. crew fills {envfile} per-service later).
	return placeholderRE.ReplaceAllStringFunc(str, func(m string) string {
		k := m[1 : len(m)-1]
		if v, ok := values[k]; ok {
			return shellQuote(v)
		}
		return m
	})
}

var sanitizeRE = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func sanitize(name string) string { return sanitizeRE.ReplaceAllString(name, "_") }

// launch replaces the process with `bin args...` semantics: inherit stdio, exit with its status.
func launch(bin string, args []string, dir string) {
	// Stop crew's stdin reader WITHOUT consuming a byte before the child owns the terminal — an
	// immortal reader blocked in Read would race the child (claude, an editor) for keystrokes and
	// eat most of them.
	releaseStdinReader()
	cmd := exec.Command(bin, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if dir != "" {
		cmd.Dir = dir
	}
	err := cmd.Run()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			osExit(ee.ExitCode())
		}
		if _, ok := err.(*exec.Error); ok {
			fail("'%s' not found on PATH. Install it and try again.", bin)
		}
		fail("failed to launch '%s': %s", bin, err.Error())
	}
	osExit(0)
}

// GET a URL as text, following redirects.
func fetchUrl(u string) (string, error) {
	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 5 {
				return fmt.Errorf("too many redirects")
			}
			return nil
		},
	}
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "crew")
	res, err := client.Do(req)
	if err != nil {
		if ue, ok := err.(*url.Error); ok {
			return "", ue.Err
		}
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// exit code aggregation: first non-zero numeric wins; else 130 if anything was signalled; else 1.
type exitEvent struct {
	name   string
	index  int
	code   int    // valid when signal == ""
	signal string // signal name when killed
}

func exitCodeFromEvents(events []exitEvent) int {
	killed := false
	for _, e := range events {
		if e.signal != "" {
			killed = true
		} else if e.code != 0 {
			return e.code
		}
	}
	if killed {
		return 130
	}
	return 1
}
