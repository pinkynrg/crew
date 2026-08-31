package crew

// Raw-mode terminal primitives shared by every interactive view: TTY detection, raw stdin with
// key tokenizing, the shared footer bar, the overlay pick panel, and the alternate-screen pager.

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

func isTTY(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func canInteractive() bool { return isTTY(os.Stdin) && isTTY(os.Stdout) }

func termSize() (cols, rows int) {
	cols, rows, err := term.GetSize(int(os.Stdout.Fd()))
	if err != nil || cols <= 0 {
		return 80, 24
	}
	return cols, rows
}

// rawInput puts stdin in raw mode and routes chunks (a chunk can bundle several keystrokes) to
// the CURRENT view's handler. One persistent process-wide reader goroutine — a goroutine blocked
// in Read can't be cancelled, so per-view readers would go stale and steal keys from the next
// view (e.g. the pager re-opened after an `r` toggle). restore() detaches the handler; chunks
// arriving between views are dropped, exactly like a detached listener.
type rawInput struct {
	oldState *term.State
}

var stdinRoute struct {
	mu      sync.Mutex
	handler func(string)
	running bool
	wakeR   *os.File // reader-side of the wake pipe: poll() watches it beside stdin
	wakeW   *os.File // releaseStdinReader writes one byte here to stop the loop WITHOUT reading stdin
	stopped chan struct{}
}

// incompleteEscTail returns the index at which s ends with an INCOMPLETE CSI/SS3 escape (ESC[…
// or ESCO… with no final byte yet), or -1. A read boundary can split a multi-byte key like an
// arrow (`\x1b[B`) across two reads; poll()ing before each read widens that window. Holding the
// unfinished tail until the next read heals it, so splitKeys never sees `\x1b[` alone (which it
// would drop) followed by a stray `B`. A lone trailing ESC is deliberately NOT held — that stays
// an immediate Escape keypress (no added latency, no change to quit responsiveness).
func incompleteEscTail(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] != 0x1b {
			continue
		}
		rest := s[i:]
		if len(rest) >= 2 && (rest[1] == '[' || rest[1] == 'O') {
			for j := 2; j < len(rest); j++ {
				if c := rest[j]; (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '~' {
					return -1 // has a final byte: the sequence is complete
				}
			}
			return i // ESC[ / ESCO with no final byte yet
		}
		return -1 // lone ESC or ESC+other (Alt-b/f): leave as-is
	}
	return -1
}

// The reader loop polls stdin AND a wake pipe, so it can stop without stealing a byte — vital
// before handing the terminal to a child process (claude, an editor): a reader blocked in Read
// would race the child for keystrokes and eat most of them.
func stdinReadLoop() {
	buf := make([]byte, 4096)
	fds := []unix.PollFd{
		{Fd: int32(os.Stdin.Fd()), Events: unix.POLLIN},
		{Fd: int32(stdinRoute.wakeR.Fd()), Events: unix.POLLIN},
	}
	carry := "" // an unfinished escape sequence split across reads (see incompleteEscTail)
	for {
		fds[0].Revents, fds[1].Revents = 0, 0
		n, err := unix.Poll(fds, -1)
		if err != nil && err != unix.EINTR {
			break
		}
		if n <= 0 {
			continue
		}
		if fds[1].Revents != 0 { // wake requested: drain the pipe and stop
			drain := make([]byte, 16)
			_, _ = stdinRoute.wakeR.Read(drain)
			break
		}
		if fds[0].Revents == 0 {
			continue
		}
		nr, rerr := os.Stdin.Read(buf)
		if nr > 0 {
			data := carry + string(buf[:nr])
			carry = ""
			if k := incompleteEscTail(data); k >= 0 {
				carry = data[k:]
				data = data[:k]
			}
			if data != "" {
				stdinRoute.mu.Lock()
				h := stdinRoute.handler
				stdinRoute.mu.Unlock()
				if h != nil {
					h(data)
				}
			}
		}
		if rerr != nil {
			break
		}
	}
	stdinRoute.mu.Lock()
	stdinRoute.running = false
	close(stdinRoute.stopped)
	stdinRoute.mu.Unlock()
}

func startRawInput(onChunk func(string)) *rawInput {
	fd := int(os.Stdin.Fd())
	old, err := term.MakeRaw(fd)
	r := &rawInput{}
	if err == nil {
		r.oldState = old
		// MakeRaw also clears OPOST on output, which stops "\n" translating to CRLF and makes
		// bare-newline writes stair-step. Raw INPUT is what the views need — restore output
		// post-processing so newline behavior stays conventional.
		if t, terr := unix.IoctlGetTermios(fd, ioctlReadTermios); terr == nil {
			t.Oflag |= unix.OPOST | unix.ONLCR
			_ = unix.IoctlSetTermios(fd, ioctlWriteTermios, t)
		}
	}
	stdinRoute.mu.Lock()
	stdinRoute.handler = onChunk
	if !stdinRoute.running {
		if stdinRoute.wakeR == nil {
			stdinRoute.wakeR, stdinRoute.wakeW, _ = os.Pipe()
		}
		stdinRoute.running = true
		stdinRoute.stopped = make(chan struct{})
		go stdinReadLoop()
	}
	stdinRoute.mu.Unlock()
	return r
}

// releaseStdinReader stops the reader loop (if any) WITHOUT consuming a byte of stdin, so a child
// process can own the terminal. A later raw-mode view just starts a fresh loop.
func releaseStdinReader() {
	stdinRoute.mu.Lock()
	if !stdinRoute.running {
		stdinRoute.mu.Unlock()
		return
	}
	stdinRoute.handler = nil
	stopped := stdinRoute.stopped
	_, _ = stdinRoute.wakeW.Write([]byte{0})
	stdinRoute.mu.Unlock()
	<-stopped
}

func (r *rawInput) restore() {
	stdinRoute.mu.Lock()
	stdinRoute.handler = nil
	stdinRoute.mu.Unlock()
	if r.oldState != nil {
		_ = term.Restore(int(os.Stdin.Fd()), r.oldState)
	}
}

// Split one stdin chunk into individual key tokens — a single read can bundle several keystrokes
// (fast typing, paste, PTY batching). An escape sequence (CSI/SS3, incl. SGR mouse) stays one
// token; everything else is one char. A lone ESC stays its own token (so a coalesced "esc then s"
// isn't misread as Alt-s); ESC merges with a following char ONLY for Alt-b/Alt-f (word move).
var csiFinalRE = regexp.MustCompile(`[A-Za-z~]`)

func splitKeys(s string) []string {
	var out []string
	r := []rune(s)
	for i := 0; i < len(r); {
		if r[i] == 0x1b && i+1 < len(r) && (r[i+1] == '[' || r[i+1] == 'O') {
			j := i + 2
			for j < len(r) && !csiFinalRE.MatchString(string(r[j])) {
				j++
			}
			if j < len(r) {
				out = append(out, string(r[i:j+1]))
				i = j + 1
			} else {
				out = append(out, string(r[i:]))
				i = len(r)
			}
		} else if r[i] == 0x1b && i+1 < len(r) && (r[i+1] == 'b' || r[i+1] == 'f') {
			out = append(out, string(r[i:i+2]))
			i += 2
		} else {
			out = append(out, string(r[i]))
			i++
		}
	}
	return out
}

// ---- shared footer bar (graph pager, selector, config editor — one identical treatment) ----

func footerTextParts(parts []string) string {
	var kept []string
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return " " + strings.Join(kept, " · ") + " "
}

// One full-width reverse-video bar. ANSI inside survives as long as it resets with 39m/27m
// (fg/attr only), never a full 0m.
func footerBar(inner string, cols int) string {
	wide := cpw(inner)
	return sgrReverseOn + inner + repeat(" ", cols-wide) + sgrReset
}

type footerOpts struct {
	mode    string // "select" | "pager"
	total   int
	sel     int
	vis     int
	shown   int
	hasRef  bool
	showRef bool
	scroll  string
	dbg     bool
	env     bool
}

// Shared footer for the graph views. Order: state -> how to move -> what to toggle -> action ->
// exit. Counts turn RED when partial (39m keeps the reverse bar alive, not a full reset).
func graphFooter(o footerOpts) string {
	red := func(n, d int) string {
		if n < d {
			return fmt.Sprintf("%s%d/%d%s", sgrFgRed, n, d, sgrFgDefault)
		}
		return fmt.Sprintf("%d/%d", n, d)
	}
	var parts []string
	if o.mode == "select" { // selector shows TWO counts: picked-to-run, then visible after the f-filter
		parts = append(parts, fmt.Sprintf("%d/%d sel · %s shown", o.sel, o.total, red(o.vis, o.total)))
		parts = append(parts, "↑↓←→ move", "space pick")
		if o.dbg {
			parts = append(parts, "d debug")
		}
		if o.env {
			parts = append(parts, "e env")
		}
		parts = append(parts, "a all")
	} else {
		parts = append(parts, red(o.shown, o.total)+" shown")
		if o.scroll != "" {
			parts = append(parts, o.scroll)
		}
	}
	parts = append(parts, "f filter")
	if o.hasRef {
		state := "off"
		if o.showRef {
			state = "on"
		}
		parts = append(parts, "r refs "+state)
	}
	if o.mode == "select" {
		parts = append(parts, "enter run", "esc cancel")
	} else {
		parts = append(parts, "esc quit")
	}
	return footerTextParts(parts)
}

// Render a line as a dimmed backdrop behind a modal: STRIP its own colours/reverse and repaint
// the plain text in faint dark-grey, so the whole background recedes uniformly.
func dimText(s string) string { return sgrDimOn + "\x1b[38;5;240m" + stripSGR(s) + sgrReset }

// ---- overlay pick panel ----

// An item is a selectable string or a non-selectable group header.
type panelItem struct {
	text   string
	header bool
}

func panelStrings(items []string) []panelItem {
	out := make([]panelItem, len(items))
	for i, s := range items {
		out[i] = panelItem{text: s}
	}
	return out
}

// A right-anchored pick panel that OVERLAYS a graph/form view. The caller paints `.rows(h)` over
// the screen's rightmost columns each frame and feeds keys to `.key(k)`, which returns "apply"
// (close, take `.selected`), "cancel", "change" (repaint) or "" (ignored). MULTI (default) =
// checkboxes, space/a toggle, ⏎ applies the set; SINGLE = radio, ⏎/space picks + applies.
type filterPanel struct {
	items    []panelItem
	paint    func(string) func(string) string // nil = plain
	title    string
	single   bool
	selected map[string]bool
	selOrder []string
	cursor   int
	scroll   int
	active   bool
	innerW   int
}

func makeFilterPanel(items []panelItem, paint func(string) func(string) string, title string, single bool) *filterPanel {
	if title == "" {
		title = "Show nodes"
	}
	p := &filterPanel{items: items, paint: paint, title: title, single: single, selected: map[string]bool{}}
	nameMax := 0
	for _, it := range items {
		if w := cpw(it.text); w > nameMax {
			nameMax = w
		}
	}
	p.innerW = cpw(title) + 4
	if nameMax+6 > p.innerW {
		p.innerW = nameMax + 6
	}
	return p
}

func (p *filterPanel) pick() []string {
	var out []string
	for _, it := range p.items {
		if !it.header {
			out = append(out, it.text)
		}
	}
	return out
}

func (p *filterPanel) Selected() []string {
	var out []string
	for _, it := range p.items {
		if !it.header && p.selected[it.text] {
			out = append(out, it.text)
		}
	}
	return out
}

func (p *filterPanel) SelectedCount() int { return len(p.Selected()) }
func (p *filterPanel) Active() bool       { return p.active }
func (p *filterPanel) Width() int         { return p.innerW + 2 }

func (p *filterPanel) firstSel() int {
	for i, it := range p.items {
		if !it.header {
			return i
		}
	}
	return 0
}

func (p *filterPanel) step(from, dir int) int {
	i := from
	for {
		i += dir
		if i < 0 || i >= len(p.items) {
			return from
		}
		if !p.items[i].header {
			return i
		}
	}
}

// single: pre is the current value -> cursor lands on it; multi: pre is the preselected list
// (nil = all).
func (p *filterPanel) Open(pre []string, preAll bool) {
	p.selected = map[string]bool{}
	pickSet := map[string]bool{}
	for _, n := range p.pick() {
		pickSet[n] = true
	}
	if p.single {
		v := ""
		if len(pre) > 0 {
			v = pre[0]
		}
		if v != "" && pickSet[v] {
			p.selected[v] = true
		}
		p.cursor = p.firstSel()
		for i, it := range p.items {
			if it.text == v {
				p.cursor = i
				break
			}
		}
	} else {
		if preAll {
			for _, n := range p.pick() {
				p.selected[n] = true
			}
		} else {
			for _, n := range pre {
				if pickSet[n] {
					p.selected[n] = true
				}
			}
		}
		p.cursor = p.firstSel()
	}
	p.scroll = 0
	p.active = true
}

func (p *filterPanel) Close() { p.active = false }

func (p *filterPanel) Key(k string) string {
	switch k {
	case keyEsc:
		return "cancel"
	case "j", keyDown:
		p.cursor = p.step(p.cursor, 1)
		return "change"
	case "k", keyUp:
		p.cursor = p.step(p.cursor, -1)
		return "change"
	}
	if p.single {
		if (k == keyEnter || k == keyNewline || k == " ") && !p.items[p.cursor].header {
			p.selected = map[string]bool{p.items[p.cursor].text: true}
			return "apply"
		}
		return ""
	}
	switch k {
	case keyEnter, keyNewline:
		return "apply"
	case " ":
		it := p.items[p.cursor]
		if it.header {
			return ""
		}
		if p.selected[it.text] {
			delete(p.selected, it.text)
		} else {
			p.selected[it.text] = true
		}
		return "change"
	case "a":
		all := true
		for _, n := range p.pick() {
			if !p.selected[n] {
				all = false
				break
			}
		}
		p.selected = map[string]bool{}
		if !all {
			for _, n := range p.pick() {
				p.selected[n] = true
			}
		}
		return "change"
	}
	return ""
}

func (p *filterPanel) colOf(n string) func(string) string {
	if p.paint != nil {
		if f := p.paint(n); f != nil {
			return f
		}
	}
	return func(s string) string { return s }
}

func (p *filterPanel) clampScroll(vis int) {
	if p.cursor < p.scroll {
		p.scroll = p.cursor
	} else if p.cursor >= p.scroll+vis {
		p.scroll = p.cursor - vis + 1
	}
	max := len(p.items) - vis
	if max < 0 {
		max = 0
	}
	if p.scroll > max {
		p.scroll = max
	}
	if p.scroll < 0 {
		p.scroll = 0
	}
}

func (p *filterPanel) pad(s string, cur bool) string {
	body := s + repeat(" ", p.innerW-cpw(s))
	if cur {
		return "│" + sgrReverseOn + body + sgrReverseOff + "│"
	}
	return "│" + body + "│"
}

// Unboxed, full-WIDTH list lines (no border) for rendering INSIDE a pane rather than an overlay.
func (p *filterPanel) BareRows(maxH, width int) []string {
	vis := len(p.items)
	if vis > maxH {
		vis = maxH
	}
	if vis < 1 {
		vis = 1
	}
	p.clampScroll(vis)
	padW := func(str string) string { return str + repeat(" ", width-cpw(str)) }
	var out []string
	for i := 0; i < vis; i++ {
		idx := p.scroll + i
		if idx >= len(p.items) {
			break
		}
		it := p.items[idx]
		cur := idx == p.cursor
		if it.header {
			out = append(out, padW("  "+sgrDimOn+it.text+sgrDimOff))
			continue
		}
		mark := "[ ]"
		if p.single {
			mark = "( )"
			if p.selected[it.text] {
				mark = "(•)"
			}
		} else if p.selected[it.text] {
			mark = "[x]"
		}
		if cur {
			out = append(out, sgrReverseOn+padW(" ▸ "+mark+" "+it.text)+sgrReverseOff)
		} else {
			out = append(out, padW("   "+mark+" "+p.colOf(it.text)(it.text)))
		}
	}
	return out
}

// Boxed panel as full rows, capped to maxH (scrolls the item list to keep the cursor in view).
func (p *filterPanel) Rows(maxH int) []string {
	const chrome = 4 // title border + separator + hint + bottom border
	limit := maxH
	if limit == 0 {
		limit = len(p.items) + chrome
	}
	vis := limit - chrome
	if vis > len(p.items) {
		vis = len(p.items)
	}
	if vis < 1 {
		vis = 1
	}
	p.clampScroll(vis)
	up := p.scroll > 0
	down := p.scroll+vis < len(p.items)
	t := "─ " + p.title + " "
	upC, downC := "─", "─"
	if up {
		upC = "↑"
	}
	if down {
		downC = "↓"
	}
	out := []string{"┌" + t + repeat("─", p.innerW-cpw(t)-1) + upC + "┐"}
	for i := 0; i < vis; i++ {
		idx := p.scroll + i
		it := p.items[idx]
		cur := idx == p.cursor
		if it.header {
			out = append(out, p.pad("  "+sgrDimOn+it.text+sgrDimOff, false))
			continue
		}
		mark := "[ ]"
		if p.single {
			mark = "( )"
			if p.selected[it.text] {
				mark = "(•)"
			}
		} else if p.selected[it.text] {
			mark = "[x]"
		}
		ptr := " "
		name := p.colOf(it.text)(it.text)
		if cur {
			ptr = "▸"
			name = it.text
		}
		out = append(out, p.pad(" "+ptr+mark+" "+name, cur))
	}
	out = append(out, "├"+repeat("─", p.innerW-1)+downC+"┤")
	hint := " space·a·↵·esc"
	if p.single {
		hint = " ↑↓·↵·esc"
	}
	out = append(out, "│"+hint+repeat(" ", p.innerW-cpw(hint))+"│")
	out = append(out, "└"+repeat("─", p.innerW)+"┘")
	return out
}

// ---- alternate-screen pager ----

type pagerFilter struct {
	nodes   []string
	shown   []string
	paint   func(string) func(string) string
	render  func(map[string]bool) string
	onApply func([]string)
}

type pagerMeta struct {
	shown   int
	total   int
	hasRef  bool
	showRef bool
	filter  *pagerFilter
}

// Show a (possibly tall) block in an ALTERNATE-SCREEN pager. Vertical scroll only. 'r' returns
// "refs", esc "quit". With a filter, 'f' overlays a node-filter panel IN PLACE (the graph stays
// visible) and re-renders on apply. Non-TTY: plain print.
func pagerView(text string, meta pagerMeta) string {
	if !canInteractive() {
		fmt.Println(text)
		return "quit"
	}
	lines := strings.Split(text, "\n")
	var panel *filterPanel
	if meta.filter != nil {
		panel = makeFilterPanel(panelStrings(meta.filter.nodes), meta.filter.paint, "Show nodes", false)
	}
	shown := map[string]bool{}
	if meta.filter != nil {
		for _, n := range meta.filter.shown {
			shown[n] = true
		}
	}
	shownCount := meta.shown
	var snap []string
	top := 0
	result := make(chan string, 1)

	body := func() int {
		_, rows := termSize()
		b := rows - 1
		if b < 1 {
			b = 1
		}
		return b
	}
	maxTop := func() int {
		m := len(lines) - body()
		if m < 0 {
			m = 0
		}
		return m
	}
	paint := func() {
		R := body()
		cols, _ := termSize()
		gw := 0
		for _, l := range lines {
			if w := cpw(l); w > gw {
				gw = w
			}
		}
		mx := repeat(" ", (cols-gw)>>1) // centre horizontally
		vpad := 0
		if len(lines) <= R {
			vpad = (R - len(lines)) >> 1
			top = 0
		} else {
			if top > maxTop() {
				top = maxTop()
			}
			if top < 0 {
				top = 0
			}
		}
		var out strings.Builder
		out.WriteString(cursorHome)
		for i := 0; i < R; i++ {
			li := i - vpad
			line := ""
			if li >= 0 && top+li < len(lines) {
				line = mx + lines[top+li]
			}
			out.WriteString(clearLine + line + sgrReset + "\r\n")
		}
		scroll := ""
		if len(lines) > R {
			end := top + R
			if end > len(lines) {
				end = len(lines)
			}
			scroll = fmt.Sprintf("↑↓ scroll %d-%d/%d", top+1, end, len(lines))
		}
		bar := graphFooter(footerOpts{mode: "pager", shown: shownCount, total: meta.total, hasRef: meta.hasRef, showRef: meta.showRef, scroll: scroll})
		out.WriteString(clearLine + footerBar(bar, cols))
		if panel != nil && panel.active {
			pr := panel.Rows(R)
			col := cols - panel.Width() + 1
			if col < 1 {
				col = 1
			}
			for i := 0; i < len(pr) && i < R; i++ {
				out.WriteString(cup(i+1, col) + pr[i])
			}
			out.WriteString(sgrReset)
		}
		os.Stdout.WriteString(out.String())
	}
	filterRender := func(set []string) {
		shown = map[string]bool{}
		for _, n := range set {
			shown[n] = true
		}
		shownCount = len(shown)
		lines = strings.Split(meta.filter.render(shown), "\n")
	}

	var raw *rawInput
	cleanup := func() {
		os.Stdout.WriteString(lineWrapOn + cursorShow + altScreenOff)
		raw.restore()
	}
	handleKey := func(key string) bool {
		R := body()
		if panel != nil && panel.active {
			switch panel.Key(key) {
			case "change":
				filterRender(panel.Selected())
			case "apply":
				if len(shown) > 0 {
					meta.filter.onApply(shownKeys(shown, meta.filter.nodes))
				} else {
					filterRender(snap)
				}
				panel.Close()
			case "cancel":
				filterRender(snap)
				panel.Close()
			}
			paint()
			return false
		}
		switch key {
		case keyEsc, keyCtrlC:
			cleanup()
			result <- "quit"
			return true
		case "f":
			if panel != nil {
				snap = shownKeys(shown, meta.filter.nodes)
				panel.Open(snap, false)
				paint()
				return false
			}
			cleanup()
			result <- "filter"
			return true
		case "r":
			cleanup()
			result <- "refs"
			return true
		case "j", keyDown:
			top++
		case "k", keyUp:
			top--
		case " ", keyPgDn:
			top += R
		case "b", keyPgUp:
			top -= R
		}
		paint()
		return false
	}
	raw = startRawInput(func(chunk string) {
		for _, key := range splitKeys(chunk) {
			if handleKey(key) {
				return
			}
		}
	})
	os.Stdout.WriteString(altScreenOn + cursorHide + lineWrapOff)
	paint()
	return <-result
}

// preserve node order when converting a shown-set back to a list
func shownKeys(shown map[string]bool, order []string) []string {
	var out []string
	for _, n := range order {
		if shown[n] {
			out = append(out, n)
		}
	}
	return out
}
