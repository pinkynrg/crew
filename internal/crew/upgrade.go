package crew

// crew upgrade — self-update from GitHub Releases: resolve the latest release, compare versions,
// download this machine's tar.gz asset and atomically replace the running binary. Skips when
// already latest. Homebrew installs are nudged to `brew upgrade` instead (brew owns that file).
// offerUpgrade asks the same as a yes/no prompt, at most once a day, before the everyday commands.

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// Overridable for tests (a local fake release server).
func releasesAPI() string {
	if v := os.Getenv("CREW_RELEASES_API"); v != "" {
		return v
	}
	return "https://api.github.com/repos/pinkynrg/crew"
}

// The latest release and its version (the tag without the "v").
func latestRelease(timeout time.Duration) (*OM, string, error) {
	body, err := fetchUrl(releasesAPI()+"/releases/latest", timeout)
	if err != nil {
		return nil, "", fmt.Errorf("could not check the latest release: %s", err.Error())
	}
	rel, perr := ParseJSON([]byte(body))
	if perr != nil {
		return nil, "", fmt.Errorf("release info is not valid JSON")
	}
	relOM, _ := rel.(*OM)
	latest := strings.TrimPrefix(relOM.GetStr("tag_name"), "v")
	if latest == "" {
		return nil, "", fmt.Errorf("release info has no tag_name")
	}
	return relOM, latest, nil
}

// The running binary with symlinks resolved: the file an upgrade replaces.
func selfExe() (string, error) {
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	return exe, err
}

// Homebrew owns this file — replacing it underneath brew corrupts the keg.
func brewOwned(exe string) bool { return strings.Contains(exe, "/Cellar/") }

func cmdUpgrade() {
	rel, latest, err := latestRelease(0)
	if err != nil {
		fail("upgrade: %s", err.Error())
	}
	if latest == Version {
		fmt.Printf("%s already up to date %s\n", cGreen("✓"), cDim("(v"+Version+")"))
		return
	}
	exe, err := selfExe()
	if err != nil {
		fail("upgrade: cannot locate the running binary: %s", err.Error())
	}
	if brewOwned(exe) {
		fail("crew was installed with Homebrew — upgrade with: brew upgrade crew")
	}
	replaceSelf(rel, latest, exe)
}

// At most once a day (update-check.json beside the config; its mtime is the last check), ask to
// upgrade when a newer release is out; yes upgrades, then re-runs the same command on the new
// binary. Silent on any hiccup (offline, no reply within 2s, a bad reply) so the command just
// runs. Skipped when not interactive or with CREW_NO_UPDATE_CHECK set; a dev build (unstamped
// 0.0.0) only checks a release server set explicitly with CREW_RELEASES_API (the tests).
func offerUpgrade(flags *Flags) {
	if !canInteractive() || os.Getenv("CREW_NO_UPDATE_CHECK") != "" || (Version == "0.0.0" && os.Getenv("CREW_RELEASES_API") == "") {
		return
	}
	stamp := filepath.Join(crewHomeFor(userConfigPath(flags)), "update-check.json")
	if st, err := os.Stat(stamp); err == nil && time.Since(st.ModTime()) < 24*time.Hour {
		return
	}
	_ = os.WriteFile(stamp, []byte(`{"checked": "`+time.Now().UTC().Format(time.RFC3339)+`"}`+"\n"), 0o644)
	rel, latest, err := latestRelease(2 * time.Second)
	if err != nil || !newerVersion(latest, Version) {
		return
	}
	exe, err := selfExe()
	if err != nil || brewOwned(exe) {
		return
	}
	fmt.Printf("%s crew v%s is out (you have v%s) — upgrade now? [y/N] ", cYellow("↑"), latest, Version)
	answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	if a := strings.ToLower(strings.TrimSpace(answer)); a != "y" && a != "yes" {
		return
	}
	replaceSelf(rel, latest, exe)
	_ = syscall.Exec(exe, os.Args, os.Environ()) // if this fails, the command still runs on this binary
}

// a > b for x.y.z versions ("1.0.100" > "1.0.99"); anything else is never newer.
func newerVersion(a, b string) bool {
	var x, y [3]int
	if n, _ := fmt.Sscanf(a, "%d.%d.%d", &x[0], &x[1], &x[2]); n != 3 {
		return false
	}
	if n, _ := fmt.Sscanf(b, "%d.%d.%d", &y[0], &y[1], &y[2]); n != 3 {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return x[i] > y[i]
		}
	}
	return false
}

// Download this machine's asset of the release and atomically swap it in for exe.
func replaceSelf(rel *OM, latest, exe string) {
	// This machine's asset: crew_<version>_<os>_<arch>.tar.gz
	suffix := fmt.Sprintf("_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	assetURL := ""
	for _, a := range rel.GetArr("assets") {
		asset, _ := a.(*OM)
		if asset != nil && strings.HasPrefix(asset.GetStr("name"), "crew_") && strings.HasSuffix(asset.GetStr("name"), suffix) {
			assetURL = asset.GetStr("browser_download_url")
			break
		}
	}
	if assetURL == "" {
		fail("upgrade: v%s has no asset for %s/%s", latest, runtime.GOOS, runtime.GOARCH)
	}

	fmt.Print(cDim(fmt.Sprintf("upgrading crew v%s → v%s… ", Version, latest)))
	data, err := fetchUrl(assetURL, 0)
	if err != nil {
		fmt.Println()
		fail("upgrade: download failed: %s", err.Error())
	}
	bin, err := extractCrew(strings.NewReader(data))
	if err != nil {
		fmt.Println()
		fail("upgrade: bad release archive: %s", err.Error())
	}
	// Atomic self-replace: write beside the binary, then rename over it.
	tmp := exe + ".new"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		fmt.Println()
		fail("upgrade: cannot write %s: %s", tmp, err.Error())
	}
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Remove(tmp)
		fmt.Println()
		fail("upgrade: cannot replace %s: %s", exe, err.Error())
	}
	fmt.Print(cGreen("done\n"))
	fmt.Printf("%s upgraded %s\n", cGreen("✓"), cDim("v"+Version+" → v"+latest))
}

// The release asset is a tar.gz holding the `crew` binary.
func extractCrew(r io.Reader) ([]byte, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag == tar.TypeReg && filepath.Base(hdr.Name) == "crew" {
			return io.ReadAll(tr)
		}
	}
	return nil, fmt.Errorf("no 'crew' binary in the archive")
}
