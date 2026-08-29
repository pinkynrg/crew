package crew

// Every raw terminal byte crew emits or matches, under a readable name. Output sequences are
// grouped by what they do to the screen; input sequences are what the PTY delivers per key.

import "fmt"

// ---- SGR (styling) ----
const (
	sgrReset     = "\x1b[0m"  // clear ALL attributes + colors
	sgrBoldOn    = "\x1b[1m"
	sgrBoldOff   = "\x1b[22m" // also clears dim (22 = normal intensity)
	sgrDimOn     = "\x1b[2m"
	sgrDimOff    = "\x1b[22m"
	sgrReverseOn  = "\x1b[7m"  // reverse video (the footer bar / cursor cell)
	sgrReverseOff = "\x1b[27m"
	sgrFgRed     = "\x1b[31m"
	sgrFgGreen   = "\x1b[32m"
	sgrFgYellow  = "\x1b[33m"
	sgrFgCyan    = "\x1b[36m"
	sgrFgDefault = "\x1b[39m" // restore default foreground WITHOUT touching attributes
)

// ---- screen control ----
const (
	altScreenOn  = "\x1b[?1049h" // switch to the alternate screen (view leaves no scrollback)
	altScreenOff = "\x1b[?1049l" // back to the normal screen exactly as it was
	cursorHide   = "\x1b[?25l"
	cursorShow   = "\x1b[?25h"
	lineWrapOff  = "\x1b[?7l" // don't auto-wrap long lines (raw-mode views manage width themselves)
	lineWrapOn   = "\x1b[?7h"
	mouseOn      = "\x1b[?1000h\x1b[?1006h" // capture mouse (SGR encoding) so the wheel scrolls the view, not the terminal
	mouseOff     = "\x1b[?1000l\x1b[?1006l"
	cursorHome   = "\x1b[H" // cursor to row 1, col 1
	clearLine    = "\x1b[K" // erase from cursor to end of line
	clearBelow   = "\x1b[0J" // erase from cursor to end of screen
	clearScreen  = "\x1b[2J" // full clear — pushes rows into scrollback on some terminals; avoid in repaint loops
)

// cursor to an absolute position (1-based row, col)
func cup(row, col int) string { return fmt.Sprintf("\x1b[%d;%dH", row, col) }

// cursor up n rows
func cuu(n int) string { return fmt.Sprintf("\x1b[%dA", n) }

// ---- input sequences (what one keypress arrives as on stdin) ----
const (
	keyCtrlC     = "\x03"
	keyCtrlA     = "\x01"
	keyCtrlE     = "\x05"
	keyCtrlK     = "\x0b"
	keyCtrlU     = "\x15"
	keyCtrlW     = "\x17"
	keyEsc       = "\x1b"
	keyEnter     = "\r"
	keyNewline   = "\n"
	keyTab       = "\t"
	keyBackspace = "\x7f"
	keyBackspace2 = "\b"
	keyUp        = "\x1b[A"
	keyDown      = "\x1b[B"
	keyRight     = "\x1b[C"
	keyLeft      = "\x1b[D"
	keyHome      = "\x1b[H"
	keyHome2     = "\x1b[1~"
	keyEnd       = "\x1b[F"
	keyEnd2      = "\x1b[4~"
	keyDelete    = "\x1b[3~"
	keyPgUp      = "\x1b[5~"
	keyPgDn      = "\x1b[6~"
	keyAltB      = "\x1bb" // word left
	keyAltF      = "\x1bf" // word right
	keyAltLeft   = "\x1b[1;3D"
	keyAltRight  = "\x1b[1;3C"
	keyCtrlLeft  = "\x1b[1;5D"
	keyCtrlRight = "\x1b[1;5C"
)
