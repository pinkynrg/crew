package crew

// Process runner (POSIX: macOS + Linux). Each command runs in its OWN process group, so teardown
// signals the whole group by pgid — catching grandchildren that reparent away (a dev server's
// autoreload child) which a ppid-walking tree-kill would miss. SIGTERM -> grace -> SIGKILL
// escalation; a second Ctrl-C force-kills, but only after a window so an impatient double-tap
// can't skip teardown. crew never forwards stdin, so detaching the children is safe; SIGINT/
// SIGTERM/SIGHUP are forwarded to each group by hand.

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

func envMs(name string, def int) time.Duration {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Millisecond
		}
	}
	return time.Duration(def) * time.Millisecond
}

func envInt(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

type fanCmd struct {
	command string
	name    string
	color   func(string) string
}

type fanProc struct {
	name       string
	index      int
	color      func(string) string
	prefix     string
	cmd        *exec.Cmd
	pid        int
	killedByUs bool
}

type fanOpts struct {
	killOthers    bool
	announceExits bool
	interactive   bool
	notices       []string
	guards        []guardSpec
	hidden        []string
	saveHidden    func([]string)
	logWrap       bool
	saveWrap      func(bool)
	// Run hooks (crew start): tee mirrors each service's
	// raw output into a writer (the run's log file — what the MCP `logs` tool reads), onSpawned
	// reports the spawned pids once (the run registry — what `status`/`logs` read).
	tee       map[string]io.Writer
	onSpawned func(pids map[string]int)
	agent     *agentSession // when set (interactive), the viewer's [a] key summons a read-only claude beside it
	guardLog  io.Writer     // guard pass/fail lines are mirrored here so the agent can read WHY a run was blocked
}

type histRow struct {
	proc   *fanProc
	text   string
	notice bool
}

func runFanout(commands []fanCmd, o fanOpts) []exitEvent {
	killGraceMs := envMs("CREW_KILL_GRACE_MS", 5000)
	// A second Ctrl-C only force-kills once this long has passed since the first — within the
	// window, extra Ctrl-C is ignored with a nudge.
	sigintForceAfter := envMs("CREW_FORCE_AFTER_MS", 10000)
	logHistory := envInt("CREW_LOG_HISTORY", 5000)
	// Cap the VISIBLE length of any single log line so a newline-less spew (minified bundle,
	// base64) can't wedge the viewer.
	maxLine := envInt("CREW_MAX_LINE", 4000)

	var mu sync.Mutex
	var results []exitEvent
	live := map[*fanProc]bool{}
	var spawned []*fanProc
	var timers []*time.Timer
	aborting := false
	var firstSigintAt time.Time
	stopRequested := false
	allStopped := false
	settled := false
	restarting := false
	settledCh := make(chan struct{})
	var launch, doRelaunch, requestRestart func()
	viewerRepaint := func() {}
	menuOpen := false
	detachKeys := func() {}
	var view *viewerState

	// Shared line-aware logger (plain streaming path): prefix only at line starts; when a
	// different command interrupts an unterminated line, close it first.
	lastProc := (*fanProc)(nil)
	lastChar := byte('\n')
	rawWrite := func(s string) { _, _ = os.Stdout.WriteString(s) }
	render := func(proc *fanProc, text string) {
		if text == "" {
			return
		}
		if lastProc != nil && lastProc != proc && lastChar != '\n' {
			rawWrite("\n")
			lastChar = '\n'
		}
		pfx := proc.prefix
		lines := strings.Split(text, "\n")
		var out strings.Builder
		for i, seg := range lines {
			if i > 0 {
				out.WriteString("\n")
				lastChar = '\n'
			}
			if seg != "" {
				if lastChar == '\n' {
					out.WriteString(pfx)
				}
				out.WriteString(seg)
				lastChar = seg[len(seg)-1]
			}
		}
		lastProc = proc
		rawWrite(out.String())
	}
	emit := func(proc *fanProc, text string) {
		if text == "" {
			return
		}
		if view != nil {
			view.feed(proc, text)
			return
		}
		render(proc, text)
	}
	note := func(proc *fanProc, msg string) {
		lead := ""
		if lastChar != '\n' {
			lead = "\n"
		}
		emit(proc, lead+msg+"\n")
	}

	killGroup := func(proc *fanProc, sig syscall.Signal) {
		if proc.pid == 0 {
			return
		}
		if err := syscall.Kill(-proc.pid, sig); err != nil && err != syscall.ESRCH {
			_ = syscall.Kill(proc.pid, sig)
		}
	}
	tearDown := func(sig syscall.Signal) {
		aborting = true
		for p := range live {
			p.killedByUs = true
			killGroup(p, sig)
		}
		if sig != syscall.SIGKILL && len(live) > 0 {
			t := time.AfterFunc(killGraceMs, func() {
				mu.Lock()
				defer mu.Unlock()
				for p := range live {
					killGroup(p, syscall.SIGKILL)
				}
			})
			timers = append(timers, t)
		}
	}
	forceKill := func() {
		for p := range live {
			killGroup(p, syscall.SIGKILL)
		}
	}

	var settle func()

	// Graceful stop with a double-tap escape hatch. Shared by the OS SIGINT and the interactive
	// key, since raw mode swallows the signal.
	requestStop := func() {
		stopRequested = true
		if len(live) == 0 {
			settle()
			return
		}
		now := time.Now()
		if firstSigintAt.IsZero() {
			firstSigintAt = now
			tearDown(syscall.SIGINT) // graceful: signal group -> grace -> SIGKILL
			return
		}
		if now.Sub(firstSigintAt) >= sigintForceAfter {
			forceKill()
			return
		}
		left := int((sigintForceAfter - now.Sub(firstSigintAt) + time.Second - 1) / time.Second)
		if lastChar != '\n' {
			rawWrite("\n")
		}
		rawWrite(cDim(fmt.Sprintf("crew: shutting down… press Ctrl-C again in %ds to force-kill\n", left)))
		lastChar = '\n'
	}

	sigCh := make(chan os.Signal, 8)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		for sig := range sigCh {
			mu.Lock()
			if sig == syscall.SIGINT {
				requestStop()
			} else {
				tearDown(syscall.SIGTERM)
			}
			mu.Unlock()
		}
	}()

	settle = func() {
		if settled {
			return
		}
		settled = true
		detachKeys() // leave the alternate screen + restore raw mode first
		signal.Stop(sigCh)
		for _, t := range timers {
			t.Stop()
		}
		// Final sweep: SIGKILL each service's process group to reap stragglers that outlived
		// their tracked shell (supervisord/gunicorn workers orphaned on a "clean" exit).
		for _, pr := range spawned {
			killGroup(pr, syscall.SIGKILL)
		}
		if lastChar != '\n' {
			rawWrite("\n")
		}
		if Color {
			rawWrite(sgrReset)
		}
		close(settledCh)
	}

	finish := func(proc *fanProc, ev exitEvent) {
		if !live[proc] {
			return // 'error' and 'close' can both fire — settle once
		}
		delete(live, proc)
		results = append(results, ev)
		if o.announceExits {
			codeStr := ""
			if ev.signal != "" {
				codeStr = ev.signal
			} else {
				codeStr = strconv.Itoa(ev.code)
			}
			paintFn := cDim
			if ev.signal != "" || ev.code != 0 {
				paintFn = cRed
			}
			note(proc, paintFn("exited ("+codeStr+")"))
		}
		if o.killOthers && !aborting && len(live) > 0 {
			tearDown(syscall.SIGTERM)
		}
		if len(live) == 0 {
			if restarting { // [r] pressed: the group has drained — re-spawn the same slice
				go doRelaunch()
				return
			}
			// If processes exited on their OWN and the user hasn't asked to quit, hold the
			// interactive viewer open so the error stays on screen.
			if o.interactive && !stopRequested {
				allStopped = true
				viewerRepaint()
			} else {
				settle()
			}
		}
	}

	// Spawn all commands. Deferred behind the guard phase so nothing starts until guards pass.
	startSpawn := func() {
		if settled || stopRequested {
			return
		}
		for i, cmd := range commands {
			child := exec.Command("/bin/sh", "-c", cmd.command)
			child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // own process group
			env := os.Environ()
			if Color {
				env = append([]string{"FORCE_COLOR=1"}, env...)
			}
			child.Env = env
			stdout, _ := child.StdoutPipe()
			stderr, _ := child.StderrPipe()
			proc := &fanProc{name: cmd.name, index: i, color: cmd.color, prefix: cmd.color("[" + cmd.name + "] "), cmd: child}
			live[proc] = true
			spawned = append(spawned, proc)
			note(proc, cDim("▶ "+cmd.command)) // show the executed command up front
			if err := child.Start(); err != nil {
				note(proc, cRed("failed to start: "+err.Error()))
				finish(proc, exitEvent{name: proc.name, index: i, code: 1})
				continue
			}
			proc.pid = child.Process.Pid
			read := func(pipe interface{ Read([]byte) (int, error) }) {
				buf := make([]byte, 8192)
				for {
					n, err := pipe.Read(buf)
					if n > 0 {
						mu.Lock()
						emit(proc, string(buf[:n]))
						if w := o.tee[proc.name]; w != nil {
							_, _ = w.Write(buf[:n])
						}
						mu.Unlock()
					}
					if err != nil {
						return
					}
				}
			}
			go read(stdout)
			go read(stderr)
			go func(proc *fanProc, index int) {
				err := child.Wait()
				mu.Lock()
				defer mu.Unlock()
				ev := exitEvent{name: proc.name, index: index}
				if err != nil {
					if ee, ok := err.(*exec.ExitError); ok {
						if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
							ev.signal = "SIG" + strings.ToUpper(strings.TrimPrefix(ws.Signal().String(), "signal "))
							if name := signalName(ws.Signal()); name != "" {
								ev.signal = name
							}
						} else {
							ev.code = ee.ExitCode()
						}
					} else {
						ev.code = 1
					}
				}
				finish(proc, ev)
			}(proc, i)
		}
		if o.onSpawned != nil {
			pids := map[string]int{}
			for _, pr := range spawned {
				if pr.pid != 0 {
					pids[pr.name] = pr.pid
				}
			}
			o.onSpawned(pids)
		}
		if len(live) == 0 {
			settle()
		}
	}

	// Interactive log viewer (streamed mode on a TTY): full-screen pager on the alternate screen
	// showing the SELECTED services' history, scrollable, with wrap/cut, search, filter, copy and
	// a pinned footer. No-op when piped/CI.
	var viewerRunGuards func() bool
	if o.interactive && len(commands) > 0 {
		v := newViewerState(commands, o, logHistory, maxLine, &mu)
		v.requestStop = requestStop
		v.isAllStopped = func() bool { return allStopped }
		v.menuOpenRef = &menuOpen
		view = v
		viewerRepaint = v.paint
		viewerRunGuards = func() bool { return v.runGuards(o.guards) }
		detachKeys = v.detach
		v.attach()
	}

	// Guard phase then spawn — run once initially and again on each [r] restart. Interactive: run
	// guards as live rows inside the viewer and only spawn once they pass (holding the viewer open
	// on failure). Non-interactive: the caller already ran + gated them. Called WITHOUT mu held.
	launch = func() {
		if viewerRunGuards != nil && len(o.guards) > 0 {
			go func() {
				ok := viewerRunGuards()
				mu.Lock()
				defer mu.Unlock()
				if settled || stopRequested {
					return
				}
				if ok {
					startSpawn()
				} else {
					allStopped = true // guards failed: hold the viewer so the ✗ + message stay on screen
					viewerRepaint()
				}
			}()
		} else {
			mu.Lock()
			startSpawn()
			mu.Unlock()
		}
	}
	// doRelaunch resets the per-run state and launches the same slice again (fresh guards + spawn).
	doRelaunch = func() {
		mu.Lock()
		restarting = false
		aborting = false
		allStopped = false
		firstSigintAt = time.Time{}
		results = nil
		mu.Unlock()
		launch()
	}
	// requestRestart tears the current group down and re-spawns the same slice — no exit/re-pick.
	// Called under mu (from the viewer key). finish() relaunches once the group has drained.
	requestRestart = func() {
		if restarting || settled || stopRequested {
			return
		}
		restarting = true
		if view != nil {
			view.notice(cDim("── restarting stack ──"))
		}
		if len(live) == 0 {
			go doRelaunch()
			return
		}
		tearDown(syscall.SIGTERM)
	}
	if view != nil {
		view.requestRestart = requestRestart
	}
	launch()

	<-settledCh
	return results
}

func signalName(sig syscall.Signal) string {
	switch sig {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	}
	return ""
}

// ---- the interactive log viewer ----

type viewerState struct {
	mu           *sync.Mutex
	names        []string
	guardProcs   map[string]*fanProc
	history      []histRow
	pending      map[*fanProc]string
	shown        map[string]bool
	wrap         bool
	scroll       int
	active       bool
	dirty        bool
	searching    bool
	query        string
	copyMsg      string
	copyTimer    *time.Timer
	fillW        int
	logHistory   int
	maxLine      int
	saveHidden     func([]string)
	saveWrap       func(bool)
	requestStop    func()
	requestRestart func()
	isAllStopped   func() bool
	menuOpenRef  *bool
	raw          *rawInput
	ticker       *time.Ticker
	tickStop     chan struct{}
	menu         *viewerMenu
	// Read-only agent pane: [a] summons claude beside the viewer (left = this viewer, right =
	// claude reading the run via MCP). ^Q / [a] toggle which side has the keyboard.
	agentCfg   *agentSession
	agent      *splitPane
	agentFocus bool
	guardLog   io.Writer
}

type viewerMenu struct {
	items     []string
	idx       int
	checked   map[string]bool
	order     []string
	prevLines int
}

func newViewerState(commands []fanCmd, o fanOpts, logHistory, maxLine int, mu *sync.Mutex) *viewerState {
	v := &viewerState{
		mu: mu, pending: map[*fanProc]string{}, shown: map[string]bool{},
		wrap: o.logWrap, active: true, logHistory: logHistory, maxLine: maxLine,
		saveHidden: o.saveHidden, saveWrap: o.saveWrap,
		guardProcs:   map[string]*fanProc{},
		agentCfg:     o.agent,
		guardLog:     o.guardLog,
	}
	// Guards appear as pseudo-services ([vpn]/[aws]) — filterable rows.
	for _, cmd := range commands {
		v.names = append(v.names, cmd.name)
	}
	for _, g := range o.guards {
		v.names = append(v.names, g.name)
		v.guardProcs[g.name] = &fanProc{name: g.name, color: func(s string) string { return cDim(s) }}
	}
	hidden := map[string]bool{}
	for _, h := range o.hidden {
		hidden[h] = true
	}
	for _, n := range v.names {
		if !hidden[n] {
			v.shown[n] = true
		}
	}
	for _, n := range o.notices { // pre-run skips/warnings, shown inside the viewer
		v.history = append(v.history, histRow{text: cYellow(n), notice: true})
	}
	// Uniform prefix width: pad every [name] to the longest name so log columns line up.
	maxName := 0
	for _, n := range v.names {
		if len(n) > maxName {
			maxName = len(n)
		}
	}
	v.fillW = maxName + 2
	return v
}

// `[name ····]` — name in its color, a dim dot leader to the aligned `]`, log right after.
func (v *viewerState) prefixFor(proc *fanProc) string {
	color := proc.color
	if color == nil {
		color = func(s string) string { return s }
	}
	dots := v.fillW - len(proc.name) - 1
	if dots < 1 {
		dots = 1
	}
	return color("["+proc.name+" ") + cDim(strings.Repeat("·", dots)) + color("]") + " "
}

// A history row is visible when its service is shown AND (no search, or the LOG TEXT matches —
// search is content-only).
func (v *viewerState) matches(proc *fanProc, text string) bool {
	if !v.shown[proc.name] {
		return false
	}
	if v.query == "" {
		return true
	}
	return strings.Contains(strings.ToLower(stripSGR(text)), strings.ToLower(v.query))
}

// ANSI-aware line wrap: split into rows of <= w VISIBLE columns, carrying SGR codes verbatim.
var sgrPrefixRE = regexp.MustCompile(`^\x1b\[[0-9;]*m`)

func splitRows(s string, w int) []string {
	var out []string
	var cur strings.Builder
	vis := 0
	for i := 0; i < len(s); {
		if s[i] == 0x1b {
			if m := sgrPrefixRE.FindString(s[i:]); m != "" {
				cur.WriteString(m)
				i += len(m)
				continue
			}
		}
		_, size := decodeRune(s[i:])
		cur.WriteString(s[i : i+size])
		i += size
		vis++
		if vis == w {
			out = append(out, cur.String())
			cur.Reset()
			vis = 0
		}
	}
	if cur.Len() > 0 || len(out) == 0 {
		out = append(out, cur.String())
	}
	return out
}

func cutRow(s string, w int) string {
	var out strings.Builder
	vis := 0
	for i := 0; i < len(s) && vis < w; {
		if s[i] == 0x1b {
			if m := sgrPrefixRE.FindString(s[i:]); m != "" {
				out.WriteString(m)
				i += len(m)
				continue
			}
		}
		_, size := decodeRune(s[i:])
		out.WriteString(s[i : i+size])
		i += size
		vis++
	}
	return out.String()
}

func decodeRune(s string) (rune, int) {
	for i, r := range s {
		if i > 0 {
			return r, i
		}
		_ = r
	}
	if len(s) > 0 {
		r := []rune(s)
		return r[0], len(string(r[0]))
	}
	return 0, 1
}

func viewerRows() int {
	_, rows := termSize()
	return rows
}
func viewerCols() int {
	cols, _ := termSize()
	return cols
}

// viewW is the viewer's usable width: the whole terminal, or the LEFT half when the agent pane is up.
func (v *viewerState) viewW() int {
	if v.agent != nil {
		return (viewerCols() - 1) / 2
	}
	return viewerCols()
}

// Flatten the filtered history into screen rows (each <= terminal width).
func (v *viewerState) screenRows() []string {
	w := v.viewW()
	var out []string
	for _, h := range v.history {
		if h.notice { // notice rows ignore the service filter, honor search
			if v.query != "" && !strings.Contains(strings.ToLower(stripSGR(h.text)), strings.ToLower(v.query)) {
				continue
			}
		} else if !v.matches(h.proc, h.text) {
			continue
		}
		line := h.text
		if !h.notice {
			line = v.prefixFor(h.proc) + h.text
		}
		if v.wrap {
			out = append(out, splitRows(line, w)...)
		} else {
			out = append(out, cutRow(line, w))
		}
	}
	return out
}

func (v *viewerState) footerText() string {
	if v.copyMsg != "" {
		return v.copyMsg
	}
	if v.searching {
		return cDim("search: ") + v.query + cCyan("▌") + cDim("   (Enter apply · Esc clear)")
	}
	// Stopped keeps every hotkey listed (they all still work, [r] restart most of
	// all here) and marks the state with a red badge, rather than dropping half
	// the bar so the keys look gone.
	stopped := v.isAllStopped != nil && v.isAllStopped()
	pos := ""
	if v.scroll > 0 {
		pos = cYellow(fmt.Sprintf("  ↑%d", v.scroll))
	}
	// Count goes RED when anything is hidden, so a suppressed service/guard is always obvious.
	nShown := fmt.Sprintf("%d/%d", len(v.shown), len(v.names))
	count := cDim(nShown)
	if len(v.shown) < len(v.names) {
		count = cRed(nShown)
	}
	q := ""
	if v.query != "" {
		q = cCyan("  /" + v.query)
	}
	wrapWord := "wrap"
	if v.wrap {
		wrapWord = "cut"
	}
	agentHint := ""
	if v.agentCfg != nil && v.agent == nil {
		agentHint = "  [a] agent"
	}
	lead := cDim("crew: ")
	escWord := "stop"
	if stopped {
		lead = cRed("■ stopped  ")
		escWord = "exit"
	}
	return lead + cDim("[f] filter (") + count + cDim(fmt.Sprintf(")  [/] search  [w] %s  [c] copy  [r] restart%s  [esc] %s", wrapWord, agentHint, escWord)) + q + pos
}

// Full repaint: body rows painted by absolute position, footer on the last row. One batched
// write to minimize flicker; cursor hidden.
func (v *viewerState) paint() {
	if v.menu != nil {
		v.paintMenu(false)
		return
	}
	if v.agent != nil {
		v.paintSplit()
		return
	}
	r := viewerRows()
	H := r - 1
	if H < 1 {
		H = 1
	}
	all := v.screenRows()
	maxScroll := len(all) - H
	if maxScroll < 0 {
		maxScroll = 0
	}
	if v.scroll > maxScroll {
		v.scroll = maxScroll
	}
	endExcl := len(all) - v.scroll
	start := endExcl - H
	if start < 0 {
		start = 0
	}
	win := all[start:endExcl]
	var buf strings.Builder
	buf.WriteString(cursorHide)
	for i := 0; i < H; i++ {
		line := ""
		if i < len(win) {
			line = win[i]
		}
		buf.WriteString(cup(i+1, 1) + "\x1b[2K" + line)
	}
	buf.WriteString(cup(r, 1) + "\x1b[2K" + v.footerText())
	_, _ = os.Stdout.WriteString(buf.String())
	v.dirty = false
}

// splitDims returns the current split geometry: left/right pane widths, their pane height (rows
// minus the nav bar), and the right pane's 1-based first column.
func (v *viewerState) splitDims() (leftW, rightW, paneH, rightX0 int) {
	cols, rows := termSize()
	paneH = rows - 1
	if paneH < 1 {
		paneH = 1
	}
	leftW = (cols - 1) / 2
	rightX0 = leftW + 2 // col 1..leftW = viewer, col leftW+1 = divider, leftW+2.. = claude
	rightW = cols - (leftW + 1)
	if rightW < 1 {
		rightW = 1
	}
	return
}

// summonAgent spawns the read-only claude beside the viewer (or, if already up, just returns —
// the caller flips focus). No-op when no agent session was prepared (piped run, missing binary).
func (v *viewerState) summonAgent() {
	if v.agentCfg == nil || v.agent != nil {
		return
	}
	_, rightW, paneH, _ := v.splitDims()
	cmd := exec.Command("claude", v.agentCfg.cliArgs...)
	cmd.Dir = v.agentCfg.cwd
	cmd.Env = os.Environ()
	pane, err := startPane(cmd, rightW, paneH, &v.dirty, v.mu)
	if err != nil {
		v.notice(cRed("could not launch claude: " + err.Error()))
		return
	}
	v.agent = pane
	v.agentFocus = true
	_, _ = pane.pty.WriteString("\x1b[I") // focus-in
	go func() { // collapse back to full viewer when claude exits
		_ = pane.cmd.Wait()
		v.mu.Lock()
		pane.exited = true
		v.dirty = true
		v.mu.Unlock()
	}()
	v.paint()
}

// closeAgent tears the pane down and returns the viewer to full width.
func (v *viewerState) closeAgent() {
	if v.agent == nil {
		return
	}
	v.agent.close()
	v.agent = nil
	v.agentFocus = false
	v.paint()
}

// paintSplit composites the viewer (left) and claude's emulated screen (right) with a divider and
// a nav bar. The viewer keeps its own footer hints inside the left pane's bottom row.
func (v *viewerState) paintSplit() {
	// collapse if claude exited on its own
	if v.agent.exited {
		v.closeAgent()
		return
	}
	leftW, rightW, paneH, rightX0 := v.splitDims()
	if v.agent.w != rightW || v.agent.h != paneH {
		v.agent.resize(rightW, paneH, v.mu)
	}
	// left: viewer body (leftW wide) with its footer on the last row
	all := v.screenRows()
	bodyH := paneH - 1
	if bodyH < 1 {
		bodyH = 1
	}
	maxScroll := len(all) - bodyH
	if maxScroll < 0 {
		maxScroll = 0
	}
	if v.scroll > maxScroll {
		v.scroll = maxScroll
	}
	endExcl := len(all) - v.scroll
	start := endExcl - bodyH
	if start < 0 {
		start = 0
	}
	win := all[start:endExcl]
	rightRows := strings.Split(v.agent.emu.Render(), "\n")
	cur := v.agent.emu.CursorPosition()

	var buf strings.Builder
	buf.WriteString(cursorHide)
	divider := sgrDimOn + "│" + sgrReset
	for y := 0; y < paneH; y++ {
		// left cell
		left := ""
		if y == paneH-1 {
			left = cutRow(v.footerText(), leftW) // viewer footer pinned to the pane's last row
		} else if y < len(win) {
			left = cutRow(win[y], leftW)
		}
		buf.WriteString(cup(y+1, 1) + "\x1b[2K" + left)
		// divider
		buf.WriteString(cup(y+1, leftW+1) + divider)
		// right cell (claude)
		rline := ""
		if y < len(rightRows) {
			rline = rightRows[y]
		}
		buf.WriteString(cup(y+1, rightX0) + cutRow(rline, rightW) + sgrReset)
	}
	// nav bar
	logsLbl, claudeLbl := "logs", "claude"
	if v.agentFocus {
		claudeLbl = sgrBoldOn + "▸ claude" + sgrBoldOff
	} else {
		logsLbl = sgrBoldOn + "▸ logs" + sgrBoldOff
	}
	cols, rows := termSize()
	bar := logsLbl + " · " + claudeLbl + "   ^Q switch · [a] close agent"
	buf.WriteString(cup(rows, 1) + "\x1b[2K" + navBar(bar, cols))
	// real cursor tracks claude only when it has focus
	if v.agentFocus && v.agent.curVis {
		buf.WriteString(cup(cur.Y+1, rightX0+cur.X) + cursorShow)
	}
	_, _ = os.Stdout.WriteString(buf.String())
	v.dirty = false
}

// Run guards live as rows (⏳ → ✓/✗) inside the already-open viewer; return pass/fail.
func (v *viewerState) runGuards(guards []guardSpec) bool {
	v.mu.Lock()
	idx := make([]int, len(guards))
	for i, g := range guards {
		v.history = append(v.history, histRow{proc: v.guardProcs[g.name], text: cDim("⏳ " + orDefault(g.comment, "checking…"))})
		idx[i] = len(v.history) - 1
	}
	v.paint()
	v.mu.Unlock()
	results := make([]bool, len(guards))
	done := make(chan int, len(guards))
	for i := range guards {
		go func(i int) {
			results[i] = runGuardCommand(guards[i].command)
			done <- i
		}(i)
	}
	for range guards {
		<-done
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	allOk := true
	for i, g := range guards {
		if results[i] {
			v.history[idx[i]].text = cGreen("✓") + " " + orDefault(g.comment, "passed")
			if v.guardLog != nil {
				fmt.Fprintf(v.guardLog, "PASS %s — %s\n", g.name, orDefault(g.comment, "passed"))
			}
		} else {
			allOk = false
			v.history[idx[i]].text = cRed("✗ " + orDefault(g.message, "guard failed"))
			if v.guardLog != nil {
				fmt.Fprintf(v.guardLog, "FAIL %s — %s\n", g.name, orDefault(g.message, "guard failed"))
			}
		}
	}
	if !allOk && v.guardLog != nil {
		fmt.Fprintf(v.guardLog, "run BLOCKED: guard(s) failed — services were NOT started\n")
	}
	v.paint()
	return allOk
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func (v *viewerState) scrollBy(d int) {
	H := viewerRows() - 1
	if H < 1 {
		H = 1
	}
	maxScroll := len(v.screenRows()) - H
	if maxScroll < 0 {
		maxScroll = 0
	}
	v.scroll += d
	if v.scroll > maxScroll {
		v.scroll = maxScroll
	}
	if v.scroll < 0 {
		v.scroll = 0
	}
	v.paint()
}

func (v *viewerState) feed(proc *fanProc, text string) {
	parts := strings.Split(v.pending[proc]+text, "\n")
	rem := parts[len(parts)-1]
	parts = parts[:len(parts)-1]
	// Bound `pending`: an unterminated line longer than the cap is flushed now.
	if len(rem) > v.maxLine {
		parts = append(parts, rem)
		rem = ""
	}
	v.pending[proc] = rem
	added := 0
	for _, raw := range parts {
		line := raw
		if len(raw) > v.maxLine { // clip overlong lines so wrapping stays cheap
			line = raw[:v.maxLine] + cDim(fmt.Sprintf(" …[+%d chars]", len(raw)-v.maxLine))
		}
		v.history = append(v.history, histRow{proc: proc, text: line})
		if len(v.history) > v.logHistory {
			v.history = v.history[1:]
		}
		if v.matches(proc, line) {
			if v.wrap {
				added += len(splitRows(v.prefixFor(proc)+line, viewerCols()))
			} else {
				added++
			}
		}
	}
	if !v.active || added == 0 {
		return
	}
	if v.scroll > 0 {
		v.scroll += added // hold position when scrolled up into history
	}
	v.dirty = true // throttled repaint follows the tail
}

// ---- the viewer's `f` filter menu (full-screen multiselect) ----

func (v *viewerState) openMenu() {
	v.active = false // capture to history only; the menu owns the screen
	*v.menuOpenRef = true
	_, _ = os.Stdout.WriteString(mouseOff)
	_, _ = os.Stdout.WriteString(clearScreen + cursorHome + cursorShow)
	m := &viewerMenu{items: v.names, checked: map[string]bool{}}
	for _, n := range v.names {
		if v.shown[n] {
			m.checked[n] = true
			m.order = append(m.order, n)
		}
	}
	v.menu = m
	v.paintMenu(true)
}

func (v *viewerState) paintMenu(first bool) {
	m := v.menu
	out := &strings.Builder{}
	if first {
		out.WriteString("Show logs for (Space toggles, Enter applies)" + cDim("  (↑/↓ move, Space toggle, Enter confirm, Esc cancel)") + "\n")
		out.WriteString(cursorHide)
	} else {
		out.WriteString(cuu(m.prevLines) + clearBelow)
	}
	lines := 0
	for i, it := range m.items {
		ptr := "  "
		if i == m.idx {
			ptr = cCyan("❯ ")
		}
		box := "◯ "
		if m.checked[it] {
			box = cGreen("◉ ")
		}
		label := it
		if i == m.idx {
			label = cBold(it)
		}
		out.WriteString(ptr + box + label + "\n")
		lines++
	}
	m.prevLines = lines
	_, _ = os.Stdout.WriteString(out.String())
}

func (v *viewerState) closeMenu(apply bool) {
	m := v.menu
	if apply {
		v.shown = map[string]bool{}
		for _, n := range m.order {
			v.shown[n] = true
		}
		var hidden []string // remember the hidden set globally
		for _, n := range v.names {
			if !v.shown[n] {
				hidden = append(hidden, n)
			}
		}
		if v.saveHidden != nil {
			v.saveHidden(hidden)
		}
	}
	v.menu = nil
	_, _ = os.Stdout.WriteString(mouseOn)
	v.scroll = 0
	v.active = true
	*v.menuOpenRef = false
	v.paint()
}

func (v *viewerState) menuKey(key string) {
	m := v.menu
	switch key {
	case keyUp, "k":
		m.idx = (m.idx - 1 + len(m.items)) % len(m.items)
		v.paintMenu(false)
	case keyDown, "j":
		m.idx = (m.idx + 1) % len(m.items)
		v.paintMenu(false)
	case " ":
		it := m.items[m.idx]
		if m.checked[it] {
			delete(m.checked, it)
			for i, x := range m.order {
				if x == it {
					m.order = append(m.order[:i], m.order[i+1:]...)
					break
				}
			}
		} else {
			m.checked[it] = true
			m.order = append(m.order, it)
		}
		v.paintMenu(false)
	case keyEnter, keyNewline:
		v.closeMenu(true)
	case keyEsc, keyCtrlC:
		v.closeMenu(false)
	}
}

// handleKey routes input: when the agent pane is up, ^Q/[a] flip focus and the focused side gets
// the keys (claude via its PTY, the viewer via its own handler); otherwise the viewer handles it.
func (v *viewerState) handleKey(s string) {
	if v.agent != nil {
		for _, tok := range splitKeys(s) {
			if tok == keyFocusToggle {
				v.toggleFocus()
			} else if v.agentFocus {
				_, _ = v.agent.pty.WriteString(tok) // claude has the keyboard — everything (incl 'a') goes to it
			} else {
				v.handleViewerKey(tok) // viewer side: scroll/filter as usual; 'a' closes the pane
			}
		}
		return
	}
	v.handleViewerKey(s)
}

// toggleFocus moves the keyboard between the viewer and claude, sending claude the matching focus
// event so its own UI (cursor, hints) reacts like a native terminal.
func (v *viewerState) toggleFocus() {
	if v.agent == nil {
		return
	}
	v.agentFocus = !v.agentFocus
	if v.agentFocus {
		_, _ = v.agent.pty.WriteString("\x1b[I")
	} else {
		_, _ = v.agent.pty.WriteString("\x1b[O")
	}
	v.paint()
}

func (v *viewerState) handleViewerKey(s string) {
	if v.menu != nil {
		// The menu takes one key at a time — a chunk can bundle several (space+Enter as " \r").
		for _, k := range splitKeys(s) {
			if v.menu == nil {
				break
			}
			v.menuKey(k)
		}
		return
	}
	// Search-input mode: type a substring; Enter applies, Esc clears. Ctrl-C still stops.
	if v.searching {
		switch {
		case s == keyCtrlC:
			v.requestStop()
		case s == keyEnter || s == keyNewline:
			v.searching = false
			v.scroll = 0
			v.paint()
		case s == keyEsc:
			v.searching = false
			v.query = ""
			v.scroll = 0
			v.paint()
		case s == keyBackspace || s == keyBackspace2:
			if len(v.query) > 0 {
				r := []rune(v.query)
				v.query = string(r[:len(r)-1])
			}
			v.paint()
		case len([]rune(s)) == 1 && s >= " ":
			v.query += s
			v.scroll = 0
			v.paint()
		}
		return // ignore escape sequences while typing
	}
	// Mouse wheel (SGR): 64 = wheel up, 65 = wheel down.
	mouse := false
	for _, m := range mouseEventRE.FindAllStringSubmatch(s, -1) {
		switch m[1] {
		case "64":
			v.scrollBy(3)
			mouse = true
		case "65":
			v.scrollBy(-3)
			mouse = true
		}
	}
	if mouse {
		return
	}
	switch s {
	case keyCtrlC, keyEsc: // quit on Ctrl-C or a bare ESC
		v.requestStop()
	case "/":
		v.searching = true
		v.paint()
	case "a":
		// toggle the read-only claude copilot open/closed (focus is separate: ^Q switches sides)
		if v.agent == nil {
			v.summonAgent()
		} else {
			v.closeAgent()
		}
	case "r":
		if v.requestRestart != nil {
			v.requestRestart() // tear down + re-spawn the SAME slice (no exit/re-pick)
		}
	case "f":
		v.openMenu()
	case "w":
		v.wrap = !v.wrap
		v.scroll = 0
		if v.saveWrap != nil {
			v.saveWrap(v.wrap) // remember wrap/cut across runs
		}
		v.paint()
	case "c":
		// Copy the FILTERED view as full lines — ANSI stripped, [name] prefixed, ignoring the
		// wrap/cut display transform.
		var lines []string
		for _, h := range v.history {
			if !h.notice && v.matches(h.proc, h.text) {
				lines = append(lines, "["+h.proc.name+"] "+stripSGR(h.text))
			}
		}
		if len(lines) == 0 {
			v.copyMsg = cDim("nothing to copy (filtered view is empty)")
		} else if tool := clipboardCopy(strings.Join(lines, "\n") + "\n"); tool != "" {
			plural := "s"
			if len(lines) == 1 {
				plural = ""
			}
			v.copyMsg = cGreen("✓ ") + cDim(fmt.Sprintf("copied %d line%s to clipboard", len(lines), plural))
		} else {
			v.copyMsg = cYellow("⚠ ") + cDim("no clipboard tool found (pbcopy/wl-copy/xclip/xsel)")
		}
		v.paint()
		if v.copyTimer != nil {
			v.copyTimer.Stop()
		}
		v.copyTimer = time.AfterFunc(1600*time.Millisecond, func() {
			v.mu.Lock()
			defer v.mu.Unlock()
			v.copyMsg = ""
			v.paint()
		})
	case keyUp, "k":
		v.scrollBy(1) // up = older
	case keyDown, "j":
		v.scrollBy(-1) // down = newer
	case keyPgUp:
		v.scrollBy(viewerRows() - 1)
	case keyPgDn:
		v.scrollBy(-(viewerRows() - 1))
	case "g":
		v.scroll = 1 << 30
		v.scrollBy(0) // jump to oldest (clamped)
	case "G":
		v.scroll = 0
		v.paint() // jump to live tail
	}
}

func (v *viewerState) attach() {
	v.raw = startRawInput(func(chunk string) {
		v.mu.Lock()
		defer v.mu.Unlock()
		v.handleKey(chunk) // the viewer treats a chunk as one input (search ignores multi-char chunks)
	})
	v.tickStop = make(chan struct{})
	v.ticker = time.NewTicker(60 * time.Millisecond)
	go func() {
		for {
			select {
			case <-v.tickStop:
				return
			case <-v.ticker.C:
				v.mu.Lock()
				if v.dirty && v.active && !*v.menuOpenRef {
					v.paint()
				}
				v.mu.Unlock()
			}
		}
	}()
	_, _ = os.Stdout.WriteString(altScreenOn + mouseOn) // enter the alternate screen + capture mouse
	v.paint()
}

func (v *viewerState) detach() {
	if v.agent != nil {
		v.agent.close()
		v.agent = nil
	}
	if v.ticker != nil {
		v.ticker.Stop()
		close(v.tickStop)
	}
	if v.copyTimer != nil {
		v.copyTimer.Stop()
	}
	_, _ = os.Stdout.WriteString(mouseOff + cursorShow)
	_, _ = os.Stdout.WriteString(altScreenOff) // restore the terminal as it was
	if v.raw != nil {
		v.raw.restore()
	}
	// No history dump: leaving the alternate screen restores the terminal to before the run.
}

func (v *viewerState) notice(text string) {
	v.history = append(v.history, histRow{text: text, notice: true})
	if len(v.history) > v.logHistory {
		v.history = v.history[1:]
	}
	v.paint()
}

