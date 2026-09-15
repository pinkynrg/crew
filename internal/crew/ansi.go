package crew

// Every raw terminal byte crew emits or matches, under a readable name. Output sequences are
// grouped by what they do to the screen; input sequences are what the PTY delivers per key.

import "fmt"

// ---- SGR (styling) ----
const (
	sgrReset      = "\x1b[0m" // clear ALL attributes + colors
	sgrBoldOn     = "\x1b[1m"
	sgrBoldOff    = "\x1b[22m" // also clears dim (22 = normal intensity)
	sgrDimOn      = "\x1b[2m"
	sgrDimOff     = "\x1b[22m"
	sgrReverseOn  = "\x1b[7m" // reverse video (the footer bar / cursor cell)
	sgrReverseOff = "\x1b[27m"
	sgrFgRed      = "\x1b[31m"
	sgrFgGreen    = "\x1b[32m"
	sgrFgYellow   = "\x1b[33m"
	sgrFgCyan     = "\x1b[36m"
	sgrFgDefault  = "\x1b[39m"       // restore default foreground WITHOUT touching attributes
	oscLinkClose  = "\x1b]8;;\x1b\\" // close an OSC-8 hyperlink (sgrReset does NOT — a cut link underlines the rest)
)

// ---- screen control ----
const (
	altScreenOn  = "\x1b[?1049h" // switch to the alternate screen (view leaves no scrollback)
	altScreenOff = "\x1b[?1049l" // back to the normal screen exactly as it was
	cursorHide   = "\x1b[?25l"
	cursorShow   = "\x1b[?25h"
	lineWrapOff  = "\x1b[?7l" // don't auto-wrap long lines (raw-mode views manage width themselves)
	lineWrapOn   = "\x1b[?7h"
	mouseOn      = "\x1b[?1000h\x1b[?1006h" // full mouse capture (SGR): wheel + clicks. Used by the graph selector, which must tell wheel (scroll graph) from arrows (move cursor).
	mouseOff     = "\x1b[?1000l\x1b[?1006l"
	// altScrollOn is the LOG VIEWER's lighter alternative: mode ?1007 makes the terminal translate
	// the wheel into arrow-key presses (which the viewer already scrolls on) WITHOUT reporting
	// clicks/drags — so native text selection keeps working, unlike full mouse capture. (claude does
	// the same.) The alt-screen already blocks the terminal's own scrollback; ?1007 only routes the
	// wheel. Ceiling: a few terminals emit SS3 arrows (\x1bOA) under ?1007 instead of CSI (\x1b[A) —
	// those won't scroll until keyUp/keyDown also match SS3.
	altScrollOn     = "\x1b[?1007h"
	altScrollOff    = "\x1b[?1007l"
	bracketPaste    = "\x1b[?2004h" // outer terminal wraps pastes in \x1b[200~…\x1b[201~ so claude collapses them
	bracketPasteOff = "\x1b[?2004l"
	cursorHome      = "\x1b[H"  // cursor to row 1, col 1
	clearLine       = "\x1b[K"  // erase from cursor to end of line
	clearBelow      = "\x1b[0J" // erase from cursor to end of screen
	clearScreen     = "\x1b[2J" // full clear — pushes rows into scrollback on some terminals; avoid in repaint loops
)

// cursor to an absolute position (1-based row, col)
func cup(row, col int) string { return fmt.Sprintf("\x1b[%d;%dH", row, col) }

// cursor up n rows
func cuu(n int) string { return fmt.Sprintf("\x1b[%dA", n) }

// ---- input sequences (what one keypress arrives as on stdin) ----
const (
	keyCtrlC      = "\x03"
	keyCtrlA      = "\x01"
	keyCtrlE      = "\x05"
	keyCtrlK      = "\x0b"
	keyCtrlU      = "\x15"
	keyCtrlW      = "\x17"
	keyEsc        = "\x1b"
	keyEnter      = "\r"
	keyNewline    = "\n"
	keyTab        = "\t"
	keyBackspace  = "\x7f"
	keyBackspace2 = "\b"
	keyUp         = "\x1b[A"
	keyDown       = "\x1b[B"
	keyRight      = "\x1b[C"
	keyLeft       = "\x1b[D"
	keyHome       = "\x1b[H"
	keyHome2      = "\x1b[1~"
	keyEnd        = "\x1b[F"
	keyEnd2       = "\x1b[4~"
	keyDelete     = "\x1b[3~"
	keyPgUp       = "\x1b[5~"
	keyPgDn       = "\x1b[6~"
	keyAltB       = "\x1bb" // word left
	keyAltF       = "\x1bf" // word right
	keyAltLeft    = "\x1b[1;3D"
	keyAltRight   = "\x1b[1;3C"
	keyCtrlLeft   = "\x1b[1;5D"
	keyCtrlRight  = "\x1b[1;5C"
)
