package crew

// crew upgrade — self-update from GitHub Releases: resolve the latest release, compare versions,
// download this machine's tar.gz asset and atomically replace the running binary. Skips when
// already latest. Homebrew installs are nudged to `brew upgrade` instead (brew owns that file).

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Overridable for tests (a local fake release server).
func releasesAPI() string {
	if v := os.Getenv("CREW_RELEASES_API"); v != "" {
		return v
	}
	return "https://api.github.com/repos/pinkynrg/crew"
}

func cmdUpgrade() {
	current := Version
	body, err := fetchUrl(releasesAPI() + "/releases/latest")
	if err != nil {
		fail("upgrade: could not check the latest release: %s", err.Error())
	}
	rel, perr := ParseJSON([]byte(body))
	if perr != nil {
		fail("upgrade: release info is not valid JSON")
	}
	relOM, _ := rel.(*OM)
	latest := strings.TrimPrefix(relOM.GetStr("tag_name"), "v")
	if latest == "" {
		fail("upgrade: release info has no tag_name")
	}
	if latest == current {
		fmt.Printf("%s already up to date %s\n", cGreen("✓"), cDim("(v"+current+")"))
		return
	}

	// This machine's asset: crew_<version>_<os>_<arch>.tar.gz
	suffix := fmt.Sprintf("_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	assetURL := ""
	for _, a := range relOM.GetArr("assets") {
		asset, _ := a.(*OM)
		if asset != nil && strings.HasPrefix(asset.GetStr("name"), "crew_") && strings.HasSuffix(asset.GetStr("name"), suffix) {
			assetURL = asset.GetStr("browser_download_url")
			break
		}
	}
	if assetURL == "" {
		fail("upgrade: v%s has no asset for %s/%s", latest, runtime.GOOS, runtime.GOARCH)
	}

	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		fail("upgrade: cannot locate the running binary: %s", err.Error())
	}
	if strings.Contains(exe, "/Cellar/") { // Homebrew owns this file — replacing it underneath brew corrupts the keg
		fail("crew was installed with Homebrew — upgrade with: brew upgrade crew")
	}

	fmt.Print(cDim(fmt.Sprintf("upgrading crew v%s → v%s… ", current, latest)))
	data, err := fetchUrl(assetURL)
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
	fmt.Printf("%s upgraded %s\n", cGreen("✓"), cDim("v"+current+" → v"+latest))
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
