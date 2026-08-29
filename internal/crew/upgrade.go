package crew

// crew upgrade — self-update to the latest published version. npm's own output is useless here,
// so we hide it and compare versions ourselves: skip if already latest, else install silently and
// report old -> new (or surface npm's error on failure).

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// The version npm actually has installed globally — the source of truth. Never trust npm
// install's exit code: it exits 0 even when it reinstalls the same version.
func installedGlobalVersion(pkg string) string {
	out, err := exec.Command("npm", "ls", "-g", pkg, "--depth=0", "--json").Output()
	if err != nil && len(out) == 0 {
		return ""
	}
	v, perr := ParseJSON(out)
	if perr != nil {
		return ""
	}
	om, _ := v.(*OM)
	return om.GetOM("dependencies").GetOM(pkg).GetStr("version")
}

func cmdUpgrade() {
	pkg := pkgName
	current := Version
	view := exec.Command("npm", "view", pkg, "version")
	viewOut, viewErr := view.Output()
	latest := ""
	if viewErr == nil {
		latest = strings.TrimSpace(string(viewOut))
	}
	if latest != "" && latest == current {
		fmt.Printf("%s already up to date %s\n", cGreen("✓"), cDim("(v"+current+")"))
		return
	}
	// Install the exact resolved version, NOT the `@latest` tag — the tag can resolve against a
	// stale cached packument and silently reinstall the old version while exiting 0.
	spec := pkg + "@latest"
	verb := "(v" + current + ")"
	if latest != "" {
		spec = pkg + "@" + latest
		verb = "v" + current + " → v" + latest
	}
	fmt.Print(cDim(fmt.Sprintf("upgrading %s %s… ", pkg, verb)))
	install := exec.Command("npm", "install", "-g", spec)
	var stderr strings.Builder
	install.Stderr = &stderr
	err := install.Run()
	if err != nil {
		fmt.Println()
		if _, isStart := err.(*exec.Error); isStart {
			fail("'npm' not found on PATH")
		}
		if stderr.Len() > 0 {
			fmt.Fprint(os.Stderr, stderr.String()) // surface the real npm error only on failure
		}
		fail("upgrade failed — see npm output above")
	}
	fmt.Print(cGreen("done\n"))
	// Verify against the actual global install — npm exiting 0 does not mean the version changed.
	installed := installedGlobalVersion(pkg)
	if installed != "" && installed == current {
		fail("npm reported success but %s is still v%s. Try: npm cache clean --force && npm install -g %s", pkg, current, spec)
	}
	switch {
	case installed != "":
		fmt.Printf("%s upgraded %s\n", cGreen("✓"), cDim("v"+current+" → v"+installed))
	case latest != "":
		fmt.Printf("%s upgraded %s\n", cGreen("✓"), cDim("v"+current+" → v"+latest))
	default:
		fmt.Printf("%s upgraded %s\n", cGreen("✓"), cDim("(was v"+current+")"))
	}
}
