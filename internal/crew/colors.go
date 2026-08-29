package crew

// Colors — ANSI only. Disabled when stdout isn't a TTY, NO_COLOR is set, or TERM=dumb,
// so piped/redirected output stays clean.

import (
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strings"
)

var Color = func() bool {
	fi, err := os.Stdout.Stat()
	tty := err == nil && fi.Mode()&os.ModeCharDevice != 0
	return tty && os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"
}()

func wrapCode(n int) func(string) string {
	return func(s string) string {
		if !Color {
			return s
		}
		return fmt.Sprintf("\x1b[%dm%s\x1b[0m", n, s)
	}
}

var (
	cBold      = wrapCode(1)
	cDim       = wrapCode(2)
	cUnderline = wrapCode(4)
	cRed       = wrapCode(31)
	cGreen     = wrapCode(32)
	cYellow    = wrapCode(33)
	cCyan      = wrapCode(36)
)

// Truecolor when the terminal advertises it, otherwise fall back to the xterm-256 cube.
var trueColor = Color && regexp.MustCompile(`^(?i)(truecolor|24bit)$`).MatchString(os.Getenv("COLORTERM"))

func rgbTo256(r, g, b int) int {
	to6 := func(v int) int {
		if v < 48 {
			return 0
		}
		if v > 247 {
			return 5
		}
		return jsRound(float64(v-35) / 40)
	}
	return 16 + 36*to6(r) + 6*to6(g) + to6(b)
}

func fgRGB(r, g, b int) func(string) string {
	if !Color {
		return func(s string) string { return s }
	}
	var code string
	if trueColor {
		code = fmt.Sprintf("38;2;%d;%d;%d", r, g, b)
	} else {
		code = fmt.Sprintf("38;5;%d", rgbTo256(r, g, b))
	}
	return func(s string) string { return "\x1b[" + code + "m" + s + "\x1b[0m" }
}

// A subdued gray for low-priority annotations (guard descriptions, etc.) — darker than cDim.
var faint = fgRGB(110, 110, 110)

// Chrome (labels, separators, hints): the dim ATTRIBUTE, not a color — the terminal fades it
// toward its own background, so it stays legible on both light and dark themes. Closes with
// 22m, never 39m (39m restores the foreground color, it doesn't turn dim off).
const (
	DIM   = "\x1b[2m"
	UNDIM = "\x1b[22m"
)

// jsRound rounds half-up (floor(x+0.5)).
func jsRound(x float64) int { return int(math.Floor(x + 0.5)) }

func hslToRgb(h, s, l float64) (int, int, int) {
	a := s * math.Min(l, 1-l)
	f := func(n float64) float64 {
		k := math.Mod(n+h/30, 12)
		return l - a*math.Max(-1, math.Min(k-3, math.Min(9-k, 1)))
	}
	return jsRound(f(0) * 255), jsRound(f(8) * 255), jsRound(f(4) * 255)
}

// An ordered palette where each color sits ~137.5deg (golden angle) from the previous one, so
// consecutive indices are maximally distant in hue. Index N is stable — not random.
func rgbForIndex(i int) (int, int, int) {
	hue := math.Mod(float64(i)*137.508, 360)
	return hslToRgb(hue, 0.75, 0.45)
}

func colorForIndex(i int) func(string) string {
	r, g, b := rgbForIndex(i)
	return fgRGB(r, g, b)
}

// Assign every known service a stable rank (sorted name order) -> golden-angle color.
func serviceColors(cfg *OM) map[string]func(string) string {
	services := cfg.GetOM("services")
	var names []string
	if services != nil {
		names = services.Keys()
	}
	sort.Strings(names)
	m := map[string]func(string) string{}
	for i, n := range names {
		m[n] = colorForIndex(i)
	}
	return m
}

var sgrRE = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// display width, ANSI-stripped (codepoints)
func cpw(s string) int { return len([]rune(sgrRE.ReplaceAllString(s, ""))) }

func stripSGR(s string) string { return sgrRE.ReplaceAllString(s, "") }

func repeat(s string, n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat(s, n)
}
