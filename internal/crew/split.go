package crew

// Reusable PTY-pane primitives for compositing a child terminal (claude) beside crew's own
// in-process log viewer. The child runs under its own PTY; its screen is emulated in-process with
// charmbracelet/x/vt — a REAL terminal on the answering side too (it replies to the DA1/DECRQM/DSR
// identity+mode queries a demanding TUI sends at boot and awaits with no timeout). The viewer
// (runner.go) owns the paint loop, focus and key routing; this file just spawns/feeds/renders the
// pane. No tmux.

import (
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/charmbracelet/x/vt"
	"github.com/creack/pty"
)

type splitPane struct {
	emu    *vt.Emulator
	pty    *os.File
	cmd    *exec.Cmd
	w, h   int
	curVis bool // cursor visibility, tracked via the emulator's callback
	exited bool // set by a waiter goroutine when the child process ends
}

// emuFeed pumps a pane's PTY output into its emulator under the compositor lock and flags a repaint.
type emuFeed struct {
	pane  *splitPane
	dirty *bool
	mu    *sync.Mutex
}

func (f *emuFeed) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, err := f.pane.emu.Write(p)
	*f.dirty = true
	return n, err
}

// startPane launches cmd under a PTY sized w×h and wires its output into a fresh emulator. dirty is
// flagged on any child output so the compositor repaints; mu guards the emulator.
func startPane(cmd *exec.Cmd, w, h int, dirty *bool, mu *sync.Mutex) (*splitPane, error) {
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(w), Rows: uint16(h)})
	if err != nil {
		return nil, err
	}
	p := &splitPane{emu: vt.NewEmulator(w, h), pty: f, cmd: cmd, w: w, h: h, curVis: true}
	p.emu.SetCallbacks(vt.Callbacks{
		CursorVisibility: func(visible bool) { p.curVis = visible }, // fires inside emu.Write (already under mu)
	})
	go func() { // child output -> emulator (screen state)
		_, _ = io.Copy(&emuFeed{pane: p, dirty: dirty, mu: mu}, f)
		mu.Lock()
		*dirty = true
		mu.Unlock()
	}()
	go func() { // emulator's own replies (DA1, DECRQM, DSR …) -> child input, like a real terminal
		_, _ = io.Copy(f, p.emu)
	}()
	return p, nil
}

func (p *splitPane) resize(w, h int, mu *sync.Mutex) {
	mu.Lock()
	p.w, p.h = w, h
	p.emu.Resize(w, h)
	mu.Unlock()
	_ = pty.Setsize(p.pty, &pty.Winsize{Cols: uint16(w), Rows: uint16(h)})
}

func (p *splitPane) close() {
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	_ = p.emu.Close()
	_ = p.pty.Close()
}

// keyFocusToggle is Ctrl+Q — claude's own keybinding table explicitly leaves it unreserved, so it
// can't shadow anything on either side when it moves the keyboard between the viewer and claude.
const keyFocusToggle = "\x11"

// navBar paints a session's bottom row in its OWN treatment (a colored band, deliberately NOT the
// reverse-video footerBar the panes' inner views use — the session chrome reads as a distinct layer).
func navBar(inner string, cols int) string {
	pad := cols - cpw(inner)
	if pad < 0 {
		pad = 0
	}
	if !Color {
		return inner + repeat(" ", pad)
	}
	return "\x1b[48;5;24m\x1b[38;5;153m " + inner + repeat(" ", pad-1) + sgrReset
}
