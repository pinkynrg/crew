package crew

// Interactive graph picker for `crew start` (and workspace / claude): navigate the dependency
// graph and toggle which services run. ↑↓ = layer, ←→ = neighbour in the layer, space = toggle,
// a = all/none, enter = confirm, esc = cancel. Selected nodes render in their own colour and read
// [local]; the rest are grayed and read [<derived env>]. `d` toggles a node's debug task, `e`
// opens its per-run overrides checklist (start only).

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/pinkynrg/crew/internal/graph"
)

type selectResult struct {
	picked []string
	debug  []string
}

type selectOpts struct {
	selEnv      string
	hasSelEnv   bool
	debugToggle bool
}

var mouseEventRE = regexp.MustCompile(`\x1b\[<(\d+);\d+;\d+[Mm]`)

// mouseClickRE captures button, column, row of an SGR mouse event (M=press, m=release).
var mouseClickRE = regexp.MustCompile(`\x1b\[<(\d+);(\d+);(\d+)([Mm])`)

func graphSelect(flags *Flags, cfg *OM, opts selectOpts) (*selectResult, bool) {
	services := cfg.GetOM("services")
	if !canInteractive() || services == nil || services.Len() == 0 {
		return nil, false
	}
	ge := collectGraphEdges(cfg)
	if len(ge.nodes) == 0 {
		return nil, false
	}
	nodes := ge.nodes
	nodeSet := map[string]bool{}
	for _, n := range nodes {
		nodeSet[n] = true
	}
	showRef := loadGraphRefs(flags) // persisted, shared with `crew graph`
	hasRef := len(ge.ref) > 0
	paint := serviceColors(cfg)
	prefix := func(n string) string { return colorPrefix(paint, n) }
	selEnv, hasSelEnv := opts.selEnv, opts.hasSelEnv
	depEdges := dependencyEdges(cfg, services.Keys())

	active := map[string]bool{}
	for _, n := range loadLastSelection(flags) {
		if nodeSet[n] {
			active[n] = true
		}
	}
	if len(active) == 0 { // default: everything selected
		for _, n := range nodes {
			active[n] = true
		}
	}
	shown := map[string]bool{}
	shownSrc := loadGraphShown(flags)
	if shownSrc == nil {
		shownSrc = nodes
	}
	for _, n := range shownSrc {
		if nodeSet[n] {
			shown[n] = true
		}
	}
	if len(shown) == 0 {
		for _, n := range nodes {
			shown[n] = true
		}
	}
	for n := range active { // a hidden node can't be run
		if !shown[n] {
			delete(active, n)
		}
	}
	debugToggle := opts.debugToggle
	canDebug := func(n string) bool { // running node has a `tasks.debug`
		if !debugToggle {
			return false
		}
		t := services.GetOM(n).GetOM("tasks")
		return t != nil && t.Get("debug") != nil
	}
	debug := map[string]bool{}
	if debugToggle {
		for _, n := range loadLastDebug(flags) {
			if active[n] && canDebug(n) {
				debug[n] = true
			}
		}
	}
	// `e` overrides toggle (start only): merged config+local overrides per service; a checklist
	// enables/disables each for THIS run. Disabled set persisted machine-local.
	cfgOv, localOv := NewOM(), NewOM()
	if debugToggle {
		if o := cfg.GetOM("overrides"); o != nil {
			cfgOv = o
		}
		if o := loadMachine(flags).GetOM("overrides"); o != nil {
			localOv = o
		}
	}
	mergedOv := NewOM()
	if debugToggle {
		mergedOv = mergeOverrides(cfgOv, localOv)
	}
	ovEntriesFor := func(n string) []overrideEntry { return overrideEntries(mergedOv.GetOM(n)) }
	canEnv := func(n string) bool { return debugToggle && active[n] && len(ovEntriesFor(n)) > 0 }
	off := loadOverridesOff(flags) // { service: [disabled key…] }, mutated + persisted on apply
	var ePanel *filterPanel
	eNode := ""
	eLabelKey := map[string]string{}

	cursor := ""
	for _, n := range nodes {
		if shown[n] {
			cursor = n
			break
		}
	}
	if cursor == "" {
		cursor = nodes[0]
	}
	paintFn := func(n string) func(string) string { return paint[n] }
	panel := makeFilterPanel(panelStrings(nodes), paintFn, "Show nodes", false)

	// The [env] each service shows is derived over the SHOWN (in-scope) set, recomputed when the
	// f-filter changes it. Box widths stay STABLE across select/deselect: sublabelWidth = the
	// widest env label, so the geometry never moves on toggle.
	remoteEnvFull := map[string]string{}
	if hasSelEnv {
		remoteEnvFull = resolveEnvs(cfg, nodes, selEnv).resolved
	}
	envW := 0
	if hasSelEnv {
		envW = len("local")
		if len("debug") > envW {
			envW = len("debug")
		}
		if len(selEnv) > envW {
			envW = len(selEnv)
		}
		for _, v := range remoteEnvFull {
			if len(v) > envW {
				envW = len(v)
			}
		}
	}
	envSig := "\x00none"
	remoteEnv := remoteEnvFull
	refreshEnv := func() {
		if !hasSelEnv {
			return
		}
		scope := shownKeys(shown, nodes)
		sorted := append([]string(nil), scope...)
		sort.Strings(sorted)
		sig := strings.Join(sorted, "\n")
		if sig == envSig {
			return
		}
		envSig = sig
		remoteEnv = resolveEnvs(cfg, sorted, selEnv).resolved
	}
	// Per-keystroke work is a cheap Paint over CACHED geometry: cursor moves, space/a toggles and
	// the d/e states change only colors and sublabels, never box positions (widths are padded to
	// envW precisely so this holds). Geometry re-Prepares only when the f-filter or r-toggle
	// changes the visible graph — that's what keeps held-arrow navigation instant.
	colorFn := func(n string) string { // running set keeps per-source colours; the rest grayed
		if active[n] {
			return prefix(n)
		}
		return sgrDimOn
	}
	var subFn func(string) string
	if hasSelEnv {
		// [debug] = local under a debugger; [local] = plain local; else the resolved remote env
		subFn = func(n string) string {
			if active[n] {
				if debug[n] {
					return "debug"
				}
				return "local"
			}
			if e, ok := remoteEnv[n]; ok {
				return e
			}
			return selEnv
		}
	}
	var prep *graph.Prepared
	prepSig := "\x00never"
	draw := func() *graph.Layout {
		refreshEnv()
		sig := strings.Join(shownKeys(shown, nodes), "\n") + "\x00" + fmt.Sprint(showRef)
		if prep == nil || sig != prepSig {
			prepSig = sig
			var vis []string
			for _, n := range nodes {
				if shown[n] {
					vis = append(vis, n)
				}
			}
			var edges []graph.Edge
			for _, e := range ge.real {
				if shown[e[0]] && shown[e[1]] {
					edges = append(edges, graph.Edge{From: e[0], To: e[1]})
				}
			}
			if showRef {
				for _, e := range ge.ref {
					if shown[e[0]] && shown[e[1]] {
						edges = append(edges, graph.Edge{From: e[0], To: e[1], Ref: true})
					}
				}
			}
			prep = graph.Prepare(vis, edges, graph.Opts{Sublabel: subFn, SublabelWidth: envW})
		}
		lay := prep.LayoutOf()
		lay.Text = prep.Paint(colorFn, subFn, cursor)
		return lay
	}

	result := make(chan *selectResult, 1)
	top := 0
	layout := draw()
	body := func() int {
		_, rows := termSize()
		b := rows - 1 // reserve 1 row: the footer bar
		if b < 3 {
			b = 3
		}
		return b
	}
	var raw *rawInput
	cleanup := func() {
		os.Stdout.WriteString(mouseOff + lineWrapOn + cursorShow + altScreenOff)
		raw.restore()
	}
	repaint := func() {
		R := body()
		cols, _ := termSize()
		lines := strings.Split(layout.Text, "\n")
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
		} else if p, ok := layout.Place[cursor]; ok { // taller -> scroll cursor into view
			y := p.Y0
			if y < top {
				top = y
			} else if y+3 > top+R {
				top = y + 3 - R
			}
			if top > len(lines)-R {
				top = len(lines) - R
			}
			if top < 0 {
				top = 0
			}
		}
		// A modal (node filter `f` or overrides `e`) dims the whole graph + footer and floats a
		// CENTERED box.
		var modal *filterPanel
		if panel.Active() {
			modal = panel
		} else if ePanel != nil && ePanel.Active() {
			modal = ePanel
		}
		shade := func(x string) string { return x }
		if modal != nil {
			shade = dimText
		}
		var out strings.Builder
		out.WriteString(cursorHome)
		for i := 0; i < R; i++ {
			li := i - vpad
			line := ""
			if li >= 0 && top+li < len(lines) {
				line = mx + lines[top+li]
			}
			out.WriteString(clearLine + shade(line) + sgrReset + "\r\n")
		}
		split := cpw(connectivityStatus(cfg, depEdges, mapKeysInOrder(active, nodes), false)) > 0
		bar := graphFooter(footerOpts{
			mode: "select", total: len(nodes), sel: len(active), vis: len(shown),
			hasRef: hasRef, showRef: showRef,
			dbg: active[cursor] && canDebug(cursor), env: canEnv(cursor),
		})
		out.WriteString(clearLine + shade(footerBar(bar, cols)))
		// "not connected" as a YELLOW badge pinned top-right. Hidden under a modal.
		if split && modal == nil {
			txt := " ⚠ not all local nodes are connected "
			bw := len([]rune(txt))
			col := cols - bw - 1
			if col < 1 {
				col = 1
			}
			out.WriteString(cup(1, col) + sgrFgYellow + "┌" + repeat("─", bw) + "┐" + sgrFgDefault)
			out.WriteString(cup(2, col) + sgrFgYellow + "│" + sgrFgDefault + txt + sgrFgYellow + "│" + sgrFgDefault)
			out.WriteString(cup(3, col) + sgrFgYellow + "└" + repeat("─", bw) + "┘" + sgrFgDefault)
		}
		if modal != nil { // centered box over the dimmed backdrop (bright)
			pr := modal.Rows(R)
			w := modal.Width()
			mtop := ((R - len(pr)) >> 1) + 1
			if mtop < 1 {
				mtop = 1
			}
			col := ((cols - w) >> 1) + 1
			if col < 1 {
				col = 1
			}
			for i := 0; i < len(pr) && mtop+i <= R; i++ {
				out.WriteString(cup(mtop+i, col) + pr[i])
			}
			out.WriteString(sgrReset)
		}
		os.Stdout.WriteString(out.String())
	}

	type snapshot struct {
		shown, active, debug map[string]bool
		cursor               string
	}
	var snap *snapshot
	previewShown := func(list []string) { // live preview while toggling — no persist (that waits for Enter)
		shown = map[string]bool{}
		for _, n := range list {
			shown[n] = true
		}
		for n := range active { // a hidden node can't be run (or debugged)
			if !shown[n] {
				delete(active, n)
				delete(debug, n)
			}
		}
		if !shown[cursor] {
			for _, n := range nodes {
				if shown[n] {
					cursor = n
					break
				}
			}
		}
		layout = draw()
	}
	restoreSnap := func() {
		if snap == nil {
			return
		}
		shown = copySet(snap.shown)
		active = copySet(snap.active)
		debug = copySet(snap.debug)
		cursor = snap.cursor
		layout = draw()
	}
	moveH := func(d int) {
		p, ok := layout.Place[cursor]
		if !ok {
			return // no-op when the graph is empty (everything filtered out)
		}
		list := layout.Layers[p.Layer]
		i := indexOf(list, cursor)
		ni := i + d
		if ni < 0 {
			ni = 0
		}
		if ni > len(list)-1 {
			ni = len(list) - 1
		}
		if ni >= 0 && ni < len(list) {
			cursor = list[ni]
		}
	}
	moveV := func(d int) {
		p0, ok := layout.Place[cursor]
		if !ok {
			return
		}
		l := p0.Layer + d
		for l >= 0 && l < len(layout.Layers) && len(layout.Layers[l]) == 0 {
			l += d
		}
		if l < 0 || l >= len(layout.Layers) || len(layout.Layers[l]) == 0 {
			return
		}
		cx := p0.CX
		best := layout.Layers[l][0]
		bd := -1.0
		for _, n := range layout.Layers[l] {
			dd := layout.Place[n].CX - cx
			if dd < 0 {
				dd = -dd
			}
			if bd < 0 || dd < bd {
				bd = dd
				best = n
			}
		}
		cursor = best
	}
	// Handle ONE key. Returns true once the selector has resolved (so the reader stops feeding
	// the rest of a coalesced chunk).
	handleKey := func(key string) bool {
		// Mouse reporting is enabled ONLY to CAPTURE wheel/clicks so terminal scrollback doesn't
		// move under the alt-screen view. The wheel scrolls the GRAPH; clicks are swallowed.
		if m := mouseEventRE.FindStringSubmatch(key); m != nil {
			switch m[1] {
			case "64":
				top -= 3
				repaint()
			case "65":
				top += 3
				repaint()
			}
			return false
		}
		if panel.Active() { // filter panel owns keys: space previews live, Enter confirms + persists
			switch panel.Key(key) {
			case "change":
				previewShown(panel.Selected())
			case "apply":
				if panel.SelectedCount() > 0 {
					saveGraphShown(flags, shownKeys(shown, nodes))
				} else {
					restoreSnap()
				}
				panel.Close()
			case "cancel":
				restoreSnap()
				panel.Close()
			}
			repaint()
			return false
		}
		if ePanel != nil && ePanel.Active() { // overrides checklist: Enter persists the disabled set
			switch ePanel.Key(key) {
			case "apply":
				sel := map[string]bool{}
				for _, l := range ePanel.Selected() {
					sel[l] = true
				}
				var disabled []any
				for _, it := range ePanel.items {
					if it.header {
						continue
					}
					if !sel[it.text] {
						disabled = append(disabled, eLabelKey[it.text])
					}
				}
				if len(disabled) > 0 {
					off.Set(eNode, disabled)
				} else {
					off.Delete(eNode)
				}
				saveOverridesOff(flags, off)
				ePanel = nil
			case "cancel":
				ePanel = nil
			}
			repaint()
			return false
		}
		switch key {
		case keyCtrlC, keyEsc:
			cleanup()
			result <- nil
			return true
		case keyEnter, keyNewline:
			cleanup()
			result <- &selectResult{picked: mapKeysInOrder(active, nodes), debug: mapKeysInOrder(debug, nodes)}
			return true
		case "r":
			if hasRef {
				showRef = !showRef
				saveGraphRefs(flags, showRef)
				layout = draw()
				repaint()
			}
			return false
		case "f":
			snap = &snapshot{shown: copySet(shown), active: copySet(active), debug: copySet(debug), cursor: cursor}
			panel.Open(shownKeys(shown, nodes), false)
			repaint()
			return false
		case "d": // toggle debug — only for a running node that has a `tasks.debug`
			if active[cursor] && canDebug(cursor) {
				if debug[cursor] {
					delete(debug, cursor)
				} else {
					debug[cursor] = true
				}
				layout = draw()
				repaint()
			}
			return false
		case "e": // overrides checklist for the focused node — grouped GLOBAL (shared) then LOCAL (wins)
			if !canEnv(cursor) {
				return false
			}
			lEntries := overrideEntries(localOv.GetOM(cursor))
			localKeys := map[string]bool{}
			for _, en := range lEntries {
				localKeys[en.key] = true
			}
			var gEntries []overrideEntry // a global shadowed by a local shows only under local
			for _, en := range overrideEntries(cfgOv.GetOM(cursor)) {
				if !localKeys[en.key] {
					gEntries = append(gEntries, en)
				}
			}
			var items []panelItem
			eLabelKey = map[string]string{}
			addRow := func(en overrideEntry) {
				lbl := en.varName + " = " + en.value
				if en.peer != "" {
					lbl += "  (when " + en.peer + ")"
				}
				eLabelKey[lbl] = en.key
				items = append(items, panelItem{text: lbl})
			}
			if len(gEntries) > 0 {
				items = append(items, panelItem{text: "global (shared config)", header: true})
				for _, en := range gEntries {
					addRow(en)
				}
			}
			if len(lEntries) > 0 {
				items = append(items, panelItem{text: "local (wins · machine-only)", header: true})
				for _, en := range lEntries {
					addRow(en)
				}
			}
			offSet := map[string]bool{}
			if arr, ok := StrArr(off.Get(cursor)); ok {
				for _, k := range arr {
					offSet[k] = true
				}
			}
			eNode = cursor
			ePanel = makeFilterPanel(items, nil, "overrides · "+cursor, false)
			var enabled []string // preselect the ENABLED ones
			for _, it := range items {
				if !it.header && !offSet[eLabelKey[it.text]] {
					enabled = append(enabled, it.text)
				}
			}
			ePanel.Open(enabled, false)
			repaint()
			return false
		case " ":
			if active[cursor] {
				delete(active, cursor)
				delete(debug, cursor)
			} else {
				active[cursor] = true
			}
		case "a": // all/none among VISIBLE nodes; debug ⊂ active
			all := true
			for n := range shown {
				if !active[n] {
					all = false
					break
				}
			}
			active = map[string]bool{}
			if !all {
				for n := range shown {
					active[n] = true
				}
			}
			for n := range debug {
				if !active[n] {
					delete(debug, n)
				}
			}
		case keyRight, "l":
			moveH(1)
		case keyLeft, "h":
			moveH(-1)
		case keyDown, "j":
			moveV(1)
		case keyUp, "k":
			moveV(-1)
		default:
			return false
		}
		layout = draw()
		repaint()
		return false
	}
	raw = startRawInput(func(chunk string) {
		for _, key := range splitKeys(chunk) {
			if handleKey(key) {
				return
			}
		}
	})
	os.Stdout.WriteString(altScreenOn + cursorHide + lineWrapOff + mouseOn)
	repaint()
	return <-result, true
}

func copySet(s map[string]bool) map[string]bool {
	out := map[string]bool{}
	for k, v := range s {
		if v {
			out[k] = true
		}
	}
	return out
}

func indexOf(list []string, v string) int {
	for i, x := range list {
		if x == v {
			return i
		}
	}
	return -1
}

func mapKeysInOrder(set map[string]bool, order []string) []string {
	var out []string
	for _, n := range order {
		if set[n] {
			out = append(out, n)
		}
	}
	return out
}

// Pick services on the dependency graph and return the chosen members, or nil if cancelled /
// nothing chosen. Selection is ALWAYS interactive; the picked set persists globally.
func selectMembers(flags *Flags, cfg *OM, opts selectOpts) []member {
	services := cfg.GetOM("services")
	if services == nil || services.Len() == 0 {
		fail("no services configured yet — run: crew config")
	}
	if !canInteractive() {
		fail("crew needs an interactive terminal to pick services")
	}
	res, _ := graphSelect(flags, cfg, opts)
	if res == nil || len(res.picked) == 0 {
		fmt.Println(cDim("nothing selected"))
		return nil
	}
	saveLastSelection(flags, res.picked)
	if opts.debugToggle { // don't clobber the remembered debug set from workspace/claude runs
		saveLastDebug(flags, res.debug)
	}
	return membersFor(cfg, res.picked, res.debug)
}
