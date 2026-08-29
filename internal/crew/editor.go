package crew

// Two-pane raw-mode config editor (`crew config`). Left column stacks every SECTION (Settings +
// Services + Guards) as a name list, each item-section ending in a green "+ New" row; the right
// column is the highlighted item's form. CREATE = the +New row (blank form), UPDATE = edit fields
// then `s` save, DELETE = `d` + confirm. Edits are a whole-session working copy (drafts) — nothing
// hits disk until `s` (that item) or save-all on exit; esc is level-by-level.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const boxMinRows = 3 // min body rows for an inline box (match/overrides) so scrolling services doesn't jump the layout

type ovRow struct{ varName, value, peer string }
type matchRow struct{ env, host string }

type edField struct {
	key, label, kind string // kind: name|text|choice|multiselect|map|list|match|overrides|readonly
	req              bool
	options          func() []string
	kLabel           string
	groupTitle       string
	desc             string
	paint            func(string) func(string) string
	hint             string
}

type edForm map[string]any

func (f edForm) str(k string) string {
	if v, ok := f[k].(string); ok {
		return v
	}
	return ""
}
func (f edForm) isNew() bool { b, _ := f["isNew"].(bool); return b }
func (f edForm) orig() string {
	if v, ok := f["orig"].(string); ok {
		return v
	}
	return ""
}

type edSection struct {
	key, title, noun, newLabel string
	fixed                      bool
	names                      func() []string
	fields                     []edField
	load                       func(string) edForm
	blank                      func() edForm
	save                       func(edForm) string
	del                        func(string)
	info                       func(edForm) string
}

type edModalChoice struct {
	keys  []string
	label string
	run   func() bool
}
type edModal struct {
	title   string
	lines   []string
	choices []edModalChoice
}

type brCol struct {
	dir     string
	entries []string
	cursor  int
	scroll  int
}
type brState struct {
	cols []*brCol
	ci   int
}

func configForm(flags *Flags, startSection string) {
	if !canInteractive() {
		fail("this editor needs an interactive terminal")
	}
	uc := loadUserConfig(flags)
	cfg := uc.cfg
	if cfg.GetOM("services") == nil {
		cfg.Set("services", NewOM())
	}
	if cfg.GetOM("guards") == nil {
		cfg.Set("guards", NewOM())
	}
	persist := func() { _ = writeUserConfig(uc.path, pruneConfig(cfg)) } // every write strips unknown keys
	paint := serviceColors(cfg)
	paintFn := func(n string) func(string) string { return paint[n] }
	cfgServices := func() *OM { return cfg.GetOM("services") }
	cfgGuards := func() *OM { return cfg.GetOM("guards") }

	toRows := func(o *OM) [][2]string {
		var rows [][2]string
		if o == nil {
			return rows
		}
		for _, k := range o.Keys() {
			if arr, ok := o.Get(k).([]any); ok {
				for _, x := range arr {
					rows = append(rows, [2]string{k, anyToStr(x)})
				}
			} else {
				rows = append(rows, [2]string{k, anyToStr(o.Get(k))})
			}
		}
		return rows
	}
	toObj := func(rows [][2]string) *OM {
		o := NewOM()
		for _, kv := range rows {
			kk := strings.TrimSpace(kv[0])
			if kk == "" {
				continue
			}
			o.Set(kk, kv[1])
		}
		return o
	}
	// match is an env-labeled host map with FIXED keys: env labels derived from the service's env
	// files, unioned with any labels already stored so existing data stays editable.
	matchLabels := func(f edForm) []string {
		svc := NewOM()
		svc.Set("path", f.str("path"))
		svc.Set("env", f.str("env"))
		labels := newOset()
		func() {
			defer func() { recover() }() // path unresolved
			for _, x := range serviceEnvFiles(svc) {
				labels.add(x.env)
			}
		}()
		if m, ok := f["match"].(*OM); ok {
			for _, k := range m.Keys() {
				labels.add(k)
			}
		}
		out := labels.list()
		sort.Strings(out)
		return out
	}
	matchValToStr := func(v any) string {
		if arr, ok := v.([]any); ok {
			var parts []string
			for _, x := range arr {
				parts = append(parts, anyToStr(x))
			}
			return strings.Join(parts, " ")
		}
		if v == nil {
			return ""
		}
		return anyToStr(v)
	}
	matchCommit := func(rows []matchRow) *OM { // blank = drop; several hosts = array
		o := NewOM()
		for _, r := range rows {
			toks := strings.Fields(r.host)
			if len(toks) == 0 {
				continue
			}
			if len(toks) == 1 {
				o.Set(r.env, toks[0])
			} else {
				o.Set(r.env, toAnyArr(toks))
			}
		}
		return o
	}
	// Environment overrides ↔ editor rows: bare VAR:val + whenLocal{peer:{VAR:val}} flatten into
	// one flat row list {var, value, peer} (peer='' = unconditional), rebuilt on save.
	overridesToRows := func(o *OM) []ovRow {
		var rows []ovRow
		if o == nil {
			return rows
		}
		for _, k := range o.Keys() {
			if k != overrideWhenLocal {
				rows = append(rows, ovRow{varName: k, value: anyToStr(o.Get(k))})
			}
		}
		if wl := o.GetOM(overrideWhenLocal); wl != nil {
			for _, peer := range wl.Keys() {
				if pv := wl.GetOM(peer); pv != nil {
					for _, vk := range pv.Keys() {
						rows = append(rows, ovRow{varName: vk, value: anyToStr(pv.Get(vk)), peer: peer})
					}
				}
			}
		}
		return rows
	}
	rowsToOverrides := func(rows []ovRow) *OM {
		entry := NewOM()
		for _, row := range rows {
			v := strings.TrimSpace(row.varName)
			if v == "" {
				continue
			}
			peer := strings.TrimSpace(row.peer)
			if peer != "" {
				wl := entry.GetOM(overrideWhenLocal)
				if wl == nil {
					wl = NewOM()
					entry.Set(overrideWhenLocal, wl)
				}
				pv := wl.GetOM(peer)
				if pv == nil {
					pv = NewOM()
					wl.Set(peer, pv)
				}
				pv.Set(v, row.value)
			} else {
				entry.Set(v, row.value)
			}
		}
		return entry
	}
	setOrDel := func(o *OM, key string, v any, keep bool) {
		if keep {
			o.Set(key, v)
		} else {
			o.Delete(key)
		}
	}
	usersOf := func(n string) []string {
		var out []string
		for _, pn := range cfgServices().Keys() {
			if gl, ok := StrArr(cfgServices().GetOM(pn).Get("guards")); ok {
				for _, g := range gl {
					if g == n {
						out = append(out, pn)
					}
				}
			}
		}
		return out
	}
	setServiceGuard := func(service *OM, name string, on bool) {
		gl, _ := StrArr(service.Get("guards"))
		set := newOset()
		for _, g := range gl {
			set.add(g)
		}
		if on {
			set.add(name)
		} else {
			// rebuild without it
			ns := newOset()
			for _, g := range set.list() {
				if g != name {
					ns.add(g)
				}
			}
			set = ns
		}
		if set.size() > 0 {
			service.Set("guards", toAnyArr(set.list()))
		} else {
			service.Delete("guards")
		}
	}
	machine := loadMachine(flags) // servicesDir + UI prefs still live in local.json
	// Apply a servicesDir edit to the WHOLE session immediately (working-copy model). Disk
	// (local.json) is still only written on save.
	syncServicesDir := func(v string) {
		pd := strings.TrimSpace(v)
		if pd != "" {
			machine.Set("servicesDir", pd)
			servicesDirGlobal = resolvePath(pd)
		} else {
			machine.Delete("servicesDir")
			servicesDirGlobal = ""
		}
	}
	// Env overrides are TWO layers: shared lives in the committable config.json, local lives in
	// machine-only local.json and WINS at run time.
	if cfg.GetOM("overrides") == nil {
		cfg.Set("overrides", NewOM())
	}
	if machine.GetOM("overrides") == nil {
		machine.Set("overrides", NewOM())
	}
	overrides := cfg.GetOM("overrides")          // shared layer — persist()
	localOverrides := machine.GetOM("overrides") // local layer — writeMachine()

	servicesSection := &edSection{
		key: "services", title: "SERVICES", noun: "service", newLabel: "+ New service",
		names: func() []string { return cfgServices().Keys() },
		fields: []edField{
			{key: "name", label: "name", kind: "name", req: true, desc: "A short, unique name for this service."},
			{key: "path", label: "path", kind: "text", req: true, desc: "Where the repo lives, relative to your services dir. Shared with the team — if it shows 'not found', fix YOUR services dir in Settings, don't change this. Press ⏎ to pick from your services dir."},
			{key: "type", label: "type", kind: "choice", options: func() []string { return serviceTypes }, desc: "What this service is: a frontend app, a backend service, or other."},
			{key: "start", label: "start", kind: "text", desc: "The command that starts this service (e.g. \"npm run dev\"). Write {envfile} where it should load the env file."},
			{key: "debug", label: "debug", kind: "text", desc: "Optional. A command to start this service in debug mode (attachable). If set, the picker offers a \"d\" toggle to launch it instead of start."},
			{key: "env", label: "env", kind: "text", desc: "Where this service's env files live, with {env} for the environment name (e.g. \".envs/{env}\")."},
			{key: "tasks", label: "tasks (other)", kind: "map", kLabel: "task", desc: "Optional extra commands besides start (e.g. a \"debug\" command). Not required."},
			{key: "guards", label: "guards", kind: "multiselect", options: func() []string { return cfgGuards().Keys() }, desc: "Checks that must pass before this service starts. Tick the ones to require."},
			{key: "local", label: "local", kind: "text", desc: "This service's local URL, e.g. http://localhost:3000."},
			{key: "match", label: "match", kind: "match", desc: "This service's deployed host per environment (e.g. pre = api.pre.example.com). Fill in the host for each env."},
			{key: "overrides", label: "overrides", kind: "overrides", groupTitle: "Environment overrides · shared", desc: "Extra environment variables to set when this service runs. Shared with your team — no secrets here."},
			{key: "localOverrides", label: "local overrides", kind: "overrides", groupTitle: "Environment overrides · local", desc: "Extra environment variables just for you, kept off git. Put secrets like a DB password here."},
		},
	}
	servicesSection.load = func(n string) edForm {
		p := cfgServices().GetOM(n)
		if p == nil {
			p = NewOM()
		}
		tasks := p.GetOM("tasks")
		start, debug := "", ""
		otherTasks := NewOM() // start + debug are edited in their own fields; the map shows the rest
		if tasks != nil {
			for _, k := range tasks.Keys() {
				switch k {
				case "start":
					start = anyToStr(tasks.Get(k))
				case "debug":
					debug = anyToStr(tasks.Get(k))
				default:
					otherTasks.Set(k, tasks.Get(k))
				}
			}
		}
		match := NewOM()
		if m := p.GetOM("match"); m != nil {
			match = cloneOM(m)
		}
		guardsList, _ := StrArr(p.Get("guards"))
		return edForm{
			"name": n, "path": p.GetStr("path"), "type": orDefault(p.GetStr("type"), "other"),
			"start": start, "debug": debug, "env": p.GetStr("env"), "local": p.GetStr("local"),
			"match": match, "guards": append([]string{}, guardsList...), "tasks": otherTasks,
			"overrides": overridesToRows(overrides.GetOM(n)), "localOverrides": overridesToRows(localOverrides.GetOM(n)),
			"isNew": false, "orig": n,
		}
	}
	servicesSection.blank = func() edForm {
		return edForm{
			"name": "", "path": "", "type": "other", "start": "", "debug": "", "env": "", "local": "",
			"match": NewOM(), "guards": []string{}, "tasks": NewOM(),
			"overrides": []ovRow{}, "localOverrides": []ovRow{},
			"isNew": true, "orig": "",
		}
	}
	servicesSection.save = func(f edForm) string {
		name := strings.TrimSpace(f.str("name"))
		if name == "" {
			return "name is required"
		}
		if strings.TrimSpace(f.str("path")) == "" {
			return "path is required"
		}
		renaming := !f.isNew() && name != f.orig()
		if (f.isNew() || renaming) && cfgServices().GetOM(name) != nil {
			return "service '" + name + "' already exists"
		}
		base := NewOM() // preserve any unmanaged/future keys
		if !f.isNew() {
			if old := cfgServices().GetOM(f.orig()); old != nil {
				base = cloneOM(old)
			}
		}
		if renaming {
			cfgServices().Delete(f.orig())
		}
		proj := base
		proj.Set("path", strings.TrimSpace(f.str("path")))
		proj.Set("type", f.str("type"))
		setOrDel(proj, "env", strings.TrimSpace(f.str("env")), strings.TrimSpace(f.str("env")) != "")
		setOrDel(proj, "local", strings.TrimSpace(f.str("local")), strings.TrimSpace(f.str("local")) != "")
		match, _ := f["match"].(*OM)
		setOrDel(proj, "match", match, match != nil && match.Len() > 0)
		// the dedicated start + debug fields fold back into tasks.start/tasks.debug; the map holds the rest
		tasks := NewOM()
		if t, ok := f["tasks"].(*OM); ok {
			tasks = cloneOM(t)
		}
		if startCmd := strings.TrimSpace(f.str("start")); startCmd != "" {
			tasks.Set("start", startCmd)
		} else {
			tasks.Delete("start")
		}
		if debugCmd := strings.TrimSpace(f.str("debug")); debugCmd != "" {
			tasks.Set("debug", debugCmd)
		} else {
			tasks.Delete("debug")
		}
		setOrDel(proj, "tasks", tasks, tasks.Len() > 0)
		guardsList, _ := f["guards"].([]string)
		setOrDel(proj, "guards", toAnyArr(guardsList), len(guardsList) > 0)
		cfgServices().Set(name, proj)
		// env overrides: shared -> cfg.overrides (persist), local -> machine.overrides
		// (writeMachine). Both move with a rename; empty = no entry.
		if renaming {
			overrides.Delete(f.orig())
			localOverrides.Delete(f.orig())
		}
		sharedRows, _ := f["overrides"].([]ovRow)
		shared := rowsToOverrides(sharedRows)
		if shared.Len() > 0 {
			overrides.Set(name, shared)
		} else {
			overrides.Delete(name)
		}
		localRows, _ := f["localOverrides"].([]ovRow)
		local := rowsToOverrides(localRows)
		hadLocal := localOverrides.Get(name) != nil || renaming
		if local.Len() > 0 {
			localOverrides.Set(name, local)
		} else {
			localOverrides.Delete(name)
		}
		persist()
		if hadLocal || local.Len() > 0 {
			_ = writeMachine(flags, machine)
		}
		return ""
	}
	servicesSection.del = func(n string) {
		cfgServices().Delete(n)
		overrides.Delete(n)
		hadLocal := localOverrides.Get(n) != nil
		localOverrides.Delete(n)
		persist()
		if hadLocal {
			_ = writeMachine(flags, machine)
		}
	}

	guardsSection := &edSection{
		key: "guards", title: "GUARDS", noun: "guard", newLabel: "+ New guard",
		names: func() []string { return cfgGuards().Keys() },
		fields: []edField{
			{key: "name", label: "name", kind: "name", req: true, desc: "A short name for this check."},
			{key: "comment", label: "comment", kind: "text", req: true, desc: "One line saying what this check verifies."},
			{key: "command", label: "command", kind: "text", req: true, desc: "A shell command to run. It passes if the command exits 0."},
			{key: "message", label: "message", kind: "text", desc: "What to show if the check fails — tell the user how to fix it."},
		},
	}
	guardsSection.load = func(n string) edForm {
		g := cfgGuards().GetOM(n)
		if g == nil {
			g = NewOM()
		}
		return edForm{"name": n, "comment": g.GetStr("comment"), "command": g.GetStr("command"), "message": g.GetStr("message"), "isNew": false, "orig": n}
	}
	guardsSection.blank = func() edForm {
		return edForm{"name": "", "comment": "", "command": "", "message": "", "isNew": true, "orig": ""}
	}
	guardsSection.save = func(f edForm) string {
		name := strings.TrimSpace(f.str("name"))
		if name == "" {
			return "name is required"
		}
		if strings.TrimSpace(f.str("comment")) == "" {
			return "comment is required"
		}
		if strings.TrimSpace(f.str("command")) == "" {
			return "command is required"
		}
		renaming := !f.isNew() && name != f.orig()
		if (f.isNew() || renaming) && cfgGuards().GetOM(name) != nil {
			return "guard '" + name + "' already exists"
		}
		if renaming {
			cfgGuards().Delete(f.orig())
			for _, pn := range cfgServices().Keys() {
				pr := cfgServices().GetOM(pn)
				if gl, ok := StrArr(pr.Get("guards")); ok {
					for _, g := range gl {
						if g == f.orig() {
							setServiceGuard(pr, f.orig(), false)
							setServiceGuard(pr, name, true)
							break
						}
					}
				}
			}
		}
		g := NewOM()
		g.Set("comment", strings.TrimSpace(f.str("comment")))
		g.Set("command", strings.TrimSpace(f.str("command")))
		if msg := strings.TrimSpace(f.str("message")); msg != "" {
			g.Set("message", msg)
		}
		cfgGuards().Set(name, g)
		persist()
		return ""
	}
	guardsSection.del = func(n string) {
		cfgGuards().Delete(n)
		for _, pn := range cfgServices().Keys() {
			setServiceGuard(cfgServices().GetOM(pn), n, false)
		}
		persist()
	}
	guardsSection.info = func(f edForm) string {
		if f.isNew() {
			return ""
		}
		used := strings.Join(usersOf(f.orig()), ", ")
		if used == "" {
			used = DIM + "(no services)" + UNDIM
		}
		return DIM + "used by" + UNDIM + "  " + used
	}

	// Machine-local settings (editor + servicesDir). A FIXED section: one synthetic item, no
	// +New/delete. The editor picker grays out editors whose binary isn't on PATH.
	const editorNone = "(none — workspace disabled)"
	editorPaint := func(id string) func(string) string {
		if e := editorByID(id); e != nil && !onPath(e.bin) {
			return func(s string) string { return cDim(s) }
		}
		return nil
	}
	loadSettings := func() edForm {
		ed := machine.GetStr("editor")
		if editorByID(ed) == nil {
			ed = editorNone
		}
		return edForm{"editor": ed, "servicesDir": machine.GetStr("servicesDir"), "isNew": false, "orig": "config"}
	}
	settingsSection := &edSection{
		key: "settings", title: "SETTINGS", noun: "settings", fixed: true,
		names: func() []string { return []string{"config"} },
		fields: []edField{
			{key: "editor", label: "editor", kind: "choice", options: func() []string {
				out := []string{editorNone}
				for _, e := range editors {
					out = append(out, e.id)
				}
				return out
			}, paint: editorPaint, desc: "Which editor `crew workspace` opens the picked services in. Left as none, workspace is off. Dimmed = not installed. Machine-local (each dev picks their own)."},
			{key: "servicesDir", label: "servicesDir", kind: "text", desc: "The folder your services live in. Service paths you enter as relative are looked up here."},
		},
		load:  nil,
		blank: nil,
	}
	settingsSection.load = func(string) edForm { return loadSettings() }
	settingsSection.blank = loadSettings
	settingsSection.save = func(f edForm) string {
		persist() // keep the "save normalizes the shared config" invariant
		if editorByID(f.str("editor")) != nil {
			machine.Set("editor", f.str("editor"))
		} else {
			machine.Delete("editor") // sentinel/unknown -> unset
		}
		syncServicesDir(f.str("servicesDir"))
		_ = writeMachine(flags, machine)
		return ""
	}
	settingsSection.info = func(f edForm) string {
		miss := missingServiceFolders(cfg, strings.TrimSpace(f.str("servicesDir")))
		total := cfgServices().Len()
		if len(miss) > 0 {
			return fmt.Sprintf("%s⚠ %d/%d service folder(s) not found under servicesDir%s", sgrFgYellow, len(miss), total, sgrFgDefault)
		}
		return ""
	}

	sections := []*edSection{settingsSection, servicesSection, guardsSection}
	optionsOf := func(fld edField) []string {
		if fld.options != nil {
			return fld.options()
		}
		return nil
	}
	type selEntry struct {
		si   int
		name string // "" (with isNew marker) means the +New row
		new  bool
	}
	selectable := func() []selEntry {
		var out []selEntry
		for si, s := range sections {
			for _, n := range s.names() {
				out = append(out, selEntry{si: si, name: n})
			}
			if !s.fixed {
				out = append(out, selEntry{si: si, new: true})
			}
		}
		return out
	}
	sel := selectable()
	li := 0
	focus := "left"
	fi := 0
	editing := false
	buf := ""
	caret := 0
	var form edForm
	msg := ""
	var panel *filterPanel
	type panelFieldT struct {
		key, kind, label string
		single           bool
		pickFolder       bool
		ov               bool
	}
	var panelField panelFieldT
	leftTop := 0
	dirty := false
	type mapEditT struct {
		field edField
		rows  [][2]string
		ri    int
	}
	var mapEdit *mapEditT
	editTarget := "" // routes an inline edit's commit: ''=field, val/newkey/newval=map cell, ovVar/ovVal/meHost=row cell
	newKey := ""
	type ovEditT struct {
		field     edField
		rows      []ovRow
		matchRows []matchRow
		ri, ci    int
		isMatch   bool
	}
	var ovEdit *ovEditT
	var browse *brState
	const ovNone = "— always (no condition) —"
	var modal *edModal

	secOf := func() *edSection { return sections[sel[li].si] }
	// In-memory edit drafts: a whole-session working copy keyed by section + item name (a NEW
	// item uses the section's sentinel slot).
	drafts := map[string]edForm{}
	draftKey := func(cur selEntry) string {
		if cur.new {
			return fmt.Sprintf("%d:\x00new", cur.si)
		}
		return fmt.Sprintf("%d:%s", cur.si, cur.name)
	}
	stashDraft := func() {
		if dirty {
			drafts[draftKey(sel[li])] = form
		}
	}
	loadForm := func() {
		cur := sel[li]
		key := draftKey(cur)
		if d, ok := drafts[key]; ok {
			form = d
			dirty = true
		} else {
			if cur.new {
				form = sections[cur.si].blank()
			} else {
				form = sections[cur.si].load(cur.name)
			}
			dirty = false
		}
	}
	reselect := func(si int, name string) {
		sel = selectable()
		i := -1
		for j, e := range sel {
			if e.si == si && e.name == name && !e.new {
				i = j
				break
			}
		}
		if i < 0 {
			for j, e := range sel {
				if e.si == si {
					i = j
					break
				}
			}
		}
		if i < 0 {
			i = 0
		}
		li = i
		if li > len(sel)-1 {
			li = len(sel) - 1
		}
		loadForm()
	}
	for i, e := range sel {
		if sections[e.si].key == startSection {
			li = i
			break
		}
	}
	loadForm()

	doSave := func() string {
		s := secOf()
		si := sel[li].si
		if err := s.save(form); err != "" {
			msg = sgrFgRed + err + sgrFgDefault
			return err
		}
		name := strings.TrimSpace(form.str("name"))
		delete(drafts, draftKey(sel[li])) // written to disk — no longer a pending draft
		reselect(si, name)
		dirty = false
		msg = sgrFgGreen + "saved '" + name + "'" + sgrFgDefault
		return ""
	}
	doDelete := func(name string) {
		s := secOf()
		si := sel[li].si
		delete(drafts, draftKey(sel[li]))
		s.del(name)
		reselect(si, "")
		focus = "left"
		msg = "removed '" + name + "'"
	}
	// Save/discard EVERY pending draft (the on-exit prompt). saveAll jumps to the first offender.
	saveAll := func() string {
		stashDraft()
		keys := make([]string, 0, len(drafts))
		for k := range drafts {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, key := range keys {
			f := drafts[key]
			si := 0
			fmt.Sscanf(key[:strings.Index(key, ":")], "%d", &si)
			if err := sections[si].save(f); err != "" {
				nm := ""
				if !f.isNew() {
					nm = strings.TrimSpace(f.str("name"))
					if nm == "" {
						nm = f.orig()
					}
				}
				delete(drafts, key)
				reselect(si, nm)
				if nm == "" {
					form = f
					dirty = true
				}
				focus = "right"
				msg = sgrFgRed + err + sgrFgDefault
				return err
			}
			delete(drafts, key)
		}
		return ""
	}
	discardAll := func() {
		drafts = map[string]edForm{}
		dirty = false
	}
	// When a NEW service's `path` points at a real folder, prefill the still-empty fields from
	// folder signals. Non-destructive: only blanks are filled.
	maybeDetect := func() {
		if secOf().key != "services" || !form.isNew() {
			return
		}
		pth := strings.TrimSpace(form.str("path"))
		if pth == "" {
			return
		}
		abs := ""
		func() {
			defer func() { recover() }()
			abs = resolveServicePath(pth)
		}()
		if abs == "" || !pathExists(abs) {
			return
		}
		d := detectService(abs)
		var got []string
		if form.str("name") == "" {
			parts := strings.FieldsFunc(pth, func(r rune) bool { return r == '/' || r == '\\' })
			if len(parts) > 0 {
				form["name"] = parts[len(parts)-1]
				got = append(got, "name")
			}
		}
		if (form.str("type") == "" || form.str("type") == "other") && d.typ != "" {
			form["type"] = d.typ
			got = append(got, "type")
		}
		if form.str("env") == "" && d.env != "" {
			form["env"] = d.env
			got = append(got, "env")
		}
		if form.str("local") == "" && d.local != "" {
			form["local"] = d.local
			got = append(got, "local")
		}
		if d.start != "" && form.str("start") == "" {
			form["start"] = d.start
			got = append(got, "start")
		}
		if len(got) > 0 {
			dirty = true
			msg = DIM + "auto-filled from folder: " + strings.Join(got, ", ") + UNDIM
		}
	}
	// Folder picker for the service `path` field: the subfolders of servicesDir + a "type a
	// path…" escape.
	const typePath = "✎ type a path…"
	serviceDirs := func() []string {
		d := machine.GetStr("servicesDir")
		if d == "" {
			return nil
		}
		entries, err := os.ReadDir(resolvePath(d))
		if err != nil {
			return nil
		}
		var out []string
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				out = append(out, e.Name())
			}
		}
		sort.Strings(out)
		return out
	}
	editPath := func() { // fall back to typing
		editing = true
		buf = form.str("path")
		caret = len([]rune(buf))
	}
	openFolderPick := func() {
		dirs := serviceDirs()
		if len(dirs) == 0 {
			editPath() // no servicesDir / no folders -> just type the path
			return
		}
		// NB: deliberately NOT marked single — the footer shows the multiselect hints for this
		// panel even though it picks one folder (the golden pins that behavior).
		panelField = panelFieldT{key: "path", pickFolder: true, label: "pick a folder"}
		panel = makeFilterPanel(panelStrings(append(dirs, typePath)), paintFn, "pick a folder", true)
		pre := ""
		for _, d := range dirs {
			if d == form.str("path") {
				pre = d
			}
		}
		panel.Open([]string{pre}, false)
	}
	// servicesDir: a multi-column (Miller/Finder-style) folder navigator.
	baseName := func(p string) string {
		parts := strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' })
		if len(parts) == 0 {
			return ""
		}
		return parts[len(parts)-1]
	}
	listSubdirs := func(abs string) []string {
		entries, err := os.ReadDir(abs)
		if err != nil {
			return nil
		}
		var out []string
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				out = append(out, e.Name())
			}
		}
		sort.Strings(out)
		return out
	}
	mkCol := func(dir, cursorName string) *brCol {
		entries := listSubdirs(dir)
		i := -1
		if cursorName != "" {
			i = indexOf(entries, cursorName)
		}
		if i < 0 {
			i = 0
		}
		return &brCol{dir: dir, entries: entries, cursor: i}
	}
	browseChild := func(col *brCol) string { // the highlighted subfolder
		if len(col.entries) == 0 {
			return ""
		}
		return filepath.Join(col.dir, col.entries[col.cursor])
	}
	browsePreview := func() { // trim deeper stale cols + preview the highlight
		browse.cols = browse.cols[:browse.ci+1]
		if child := browseChild(browse.cols[browse.ci]); child != "" {
			browse.cols = append(browse.cols, mkCol(child, ""))
		}
	}
	openBrowse := func() {
		start := ""
		func() {
			defer func() { recover() }()
			start = resolvePath(expandHome(orDefault(machine.GetStr("servicesDir"), "~")))
		}()
		if start == "" || !pathExists(start) {
			start = homeDir()
		}
		// Build the FULL ancestry chain from filesystem root down to `start`.
		var chain []string
		d := start
		for {
			chain = append([]string{d}, chain...)
			p := filepath.Dir(d)
			if p == d {
				break
			}
			d = p
		}
		var cols []*brCol
		if len(chain) > 1 {
			for i := 0; i < len(chain)-1; i++ {
				cols = append(cols, mkCol(chain[i], baseName(chain[i+1])))
			}
		} else {
			cols = []*brCol{mkCol(start, "")}
		}
		browse = &brState{cols: cols, ci: len(cols) - 1}
		browsePreview()
	}

	// ---- rendering ----
	result := make(chan struct{}, 1)
	clipP := func(s string, n int) string {
		a := []rune(s)
		if len(a) > n {
			end := n - 1
			if end < 0 {
				end = 0
			}
			return string(a[:end]) + "…"
		}
		return s
	}
	padP := func(s string, n int) string {
		d := cpw(s)
		if d >= n {
			return s
		}
		return s + strings.Repeat(" ", n-d)
	}
	rev := func(s string) string { return sgrReverseOn + s + sgrReverseOff }
	var raw *rawInput
	cleanup := func() {
		os.Stdout.WriteString(cursorShow + lineWrapOn + altScreenOff)
		raw.restore()
	}
	type dispRow struct {
		kind string // space | header | item | new
		si   int
		name string
	}
	displayRows := func() []dispRow {
		var d []dispRow
		for si, s := range sections {
			if si > 0 {
				d = append(d, dispRow{kind: "space"})
			}
			d = append(d, dispRow{kind: "header", si: si})
			for _, n := range s.names() {
				d = append(d, dispRow{kind: "item", si: si, name: n})
			}
			if !s.fixed {
				d = append(d, dispRow{kind: "new", si: si})
			}
		}
		return d
	}
	// A value being edited, windowed so a long value scrolls horizontally keeping the caret in view.
	editCell := func(avail int) string {
		w2 := avail
		if w2 < 4 {
			w2 = 4
		}
		r := []rune(buf)
		start := 0
		if caret >= w2 {
			start = caret - w2 + 1
		}
		end := start + w2
		if end > len(r) {
			end = len(r)
		}
		seg := r[start:end]
		cp := caret - start
		cell := " "
		if cp < len(seg) {
			cell = string(seg[cp])
		}
		after := ""
		if cp+1 <= len(seg) {
			after = string(seg[min(cp+1, len(seg)):])
		}
		return string(seg[:min(cp, len(seg))]) + sgrReverseOn + cell + sgrReverseOff + after
	}

	repaint := func() {
		C, R := termSize()
		if R < 10 {
			R = 10
		}
		LW := int(float64(C) * 0.32)
		if LW < 16 {
			LW = 16
		}
		if LW > 30 {
			LW = 30
		}
		RW := C - LW - 4
		if RW < 12 {
			RW = 12
		}
		body := R - 2 // title (1) + footer (1)
		cur := sel[li]
		s := secOf()
		// ---- left column ----
		d := displayRows()
		isCur := func(r dispRow) bool {
			return (r.kind == "item" && r.si == cur.si && !cur.new && r.name == cur.name) || (r.kind == "new" && r.si == cur.si && cur.new)
		}
		ci := 0
		for i, r := range d {
			if isCur(r) {
				ci = i
				break
			}
		}
		if ci < leftTop {
			leftTop = ci
		} else if ci >= leftTop+body {
			leftTop = ci - body + 1
		}
		maxTop := len(d) - body
		if maxTop < 0 {
			maxTop = 0
		}
		if leftTop > maxTop {
			leftTop = maxTop
		}
		if leftTop < 0 {
			leftTop = 0
		}
		var L []string
		for r := 0; r < body; r++ {
			idx := leftTop + r
			if idx >= len(d) || d[idx].kind == "space" {
				L = append(L, "")
				continue
			}
			row := d[idx]
			if row.kind == "header" {
				L = append(L, DIM+sections[row.si].title+UNDIM+"  "+DIM+fmt.Sprintf("%d", len(sections[row.si].names()))+UNDIM)
				continue
			}
			label := row.name
			if row.kind == "new" {
				label = sections[row.si].newLabel
			} else if isCur(row) && form.str("name") != "" {
				label = form.str("name") // current item shows its live (possibly-edited) name
			}
			on := isCur(row)
			ptr := "  "
			if on {
				ptr = "▸ "
			}
			cell := padP(ptr+clipP(label, LW-2), LW)
			if on && focus == "left" {
				cell = rev(cell)
			} else if row.kind == "new" {
				cell = sgrFgGreen + cell + sgrFgDefault
			}
			L = append(L, cell)
		}
		// ---- right column ----
		var Rn []string
		if browse != nil {
			colH := body - 3
			if colH < 1 {
				colH = 1
			}
			const colW = 22
			div := DIM + "│" + UNDIM
			maxCols := (RW + 1) / (colW + 1)
			if maxCols < 1 {
				maxCols = 1
			}
			startC := browse.ci - maxCols + 1
			if startC < 0 {
				startC = 0
			}
			endC := startC + maxCols
			if endC > len(browse.cols) {
				endC = len(browse.cols)
			}
			win := browse.cols[startC:endC]
			more := endC < len(browse.cols)
			lm, rm := "", ""
			if startC > 0 {
				lm = "‹ "
			}
			if more {
				rm = " ›"
			}
			Rn = append(Rn, sgrBoldOn+"services dir"+sgrBoldOff+" "+DIM+"· "+lm+tildify(browse.cols[browse.ci].dir)+rm+UNDIM)
			Rn = append(Rn, "")
			cell := func(c *brCol, ei int, isActive bool) string {
				if ei >= len(c.entries) {
					return strings.Repeat(" ", colW)
				}
				marker := ""
				if browseChild(c) != "" && ei == c.cursor {
					marker = " ›"
				}
				name := padP(" "+clipP(c.entries[ei], colW-3)+marker, colW)
				if isActive && ei == c.cursor {
					return rev(name) // active highlight
				}
				if ei == c.cursor {
					return sgrFgCyan + name + sgrFgDefault // the trail
				}
				return name
			}
			for _, c := range win {
				if c.cursor < c.scroll {
					c.scroll = c.cursor
				} else if c.cursor >= c.scroll+colH {
					c.scroll = c.cursor - colH + 1
				}
			}
			for r := 0; r < colH; r++ {
				var cells []string
				for idx, c := range win {
					isActive := startC+idx == browse.ci
					if len(c.entries) == 0 {
						if r == 0 {
							cells = append(cells, padP(DIM+" (empty)"+UNDIM, colW))
						} else {
							cells = append(cells, strings.Repeat(" ", colW))
						}
						continue
					}
					cells = append(cells, cell(c, c.scroll+r, isActive))
				}
				Rn = append(Rn, strings.Join(cells, div))
			}
		} else if mapEdit != nil && panel == nil {
			F := mapEdit
			fld := F.field
			Rn = append(Rn, sgrBoldOn+fld.label+sgrBoldOff+" "+DIM+"· "+s.noun+" "+orDefault(form.str("name"), form.orig())+UNDIM)
			Rn = append(Rn, "")
			kW := len(orDefault(fld.kLabel, "key"))
			if kW < 3 {
				kW = 3
			}
			for _, kv := range F.rows {
				if l := len([]rune(kv[0])); l > kW {
					kW = l
				}
			}
			if kW > 24 {
				kW = 24
			}
			valAvail := RW - kW - 6
			if valAvail < 8 {
				valAvail = 8
			}
			for i, kv := range F.rows {
				on := F.ri == i
				kc := padP(clipP(kv[0], kW), kW)
				vc := clipP(kv[1], valAvail)
				if editing && editTarget == "val" && on {
					vc = editCell(valAvail)
				}
				ptr := " "
				if on && !editing {
					ptr = "▸"
				}
				line := " " + ptr + " " + kc + "  " + vc
				if on && !editing {
					line = rev(padP(line, RW))
				}
				Rn = append(Rn, line)
			}
			if editing && (editTarget == "newkey" || editTarget == "newval") {
				kc := padP(clipP(newKey, kW), kW)
				if editTarget == "newkey" {
					kc = editCell(kW)
				}
				vc := ""
				if editTarget == "newval" {
					vc = editCell(valAvail)
				}
				Rn = append(Rn, "   "+kc+"  "+vc)
			} else {
				addLabel := orDefault(fld.kLabel, "row")
				if F.ri == len(F.rows) {
					Rn = append(Rn, rev(padP("  ▸ + add "+addLabel, RW)))
				} else {
					Rn = append(Rn, "    "+sgrFgGreen+"+ add "+addLabel+sgrFgDefault)
				}
			}
		} else if panel != nil {
			Rn = append(Rn, sgrBoldOn+panelField.label+sgrBoldOff+" "+DIM+"· "+s.noun+" "+orDefault(form.str("name"), form.orig())+UNDIM)
			Rn = append(Rn, "")
			Rn = append(Rn, panel.BareRows(body-2, RW)...)
		} else {
			if form.isNew() {
				Rn = append(Rn, sgrBoldOn+"New "+s.noun+sgrBoldOff)
			} else {
				title := strings.ToUpper(s.noun[:1]) + s.noun[1:]
				Rn = append(Rn, sgrBoldOn+title+sgrBoldOff+" "+DIM+"·"+UNDIM+" "+orDefault(form.str("name"), form.orig()))
			}
			Rn = append(Rn, "")
			labW := 4
			for _, f := range s.fields {
				if len(f.label) > labW {
					labW = len(f.label)
				}
			}
			vW := RW - labW - 6
			if vW < 8 {
				vW = 8
			}
			for i, fld := range s.fields {
				on := focus == "right" && i == fi
				// INLINE row lists (overrides + match): rendered as a BOX you ⏎ into.
				if fld.kind == "overrides" || fld.kind == "match" {
					isMatch := fld.kind == "match"
					editingRows := ovEdit != nil && ovEdit.field.key == fld.key
					var oRows []ovRow
					var mRows []matchRow
					if editingRows {
						if isMatch {
							mRows = ovEdit.matchRows
						} else {
							oRows = ovEdit.rows
						}
					} else if isMatch {
						formMatch, _ := form["match"].(*OM)
						for _, env := range matchLabels(form) {
							mRows = append(mRows, matchRow{env: env, host: matchValToStr(formMatch.Get(env))})
						}
					} else {
						oRows, _ = form[fld.key].([]ovRow)
					}
					nRows := len(oRows)
					if isMatch {
						nRows = len(mRows)
					}
					titleFocused := on && !editingRows && !editing
					active := on || editingRows
					plainTitle := fld.groupTitle
					if isMatch {
						plainTitle = "Environment hosts"
					}
					bw := RW - 1
					if bw < 24 {
						bw = 24
					}
					iw := bw - 4
					bc, bce := DIM, UNDIM
					if active {
						bc, bce = "", ""
					}
					bl := func(content string) string {
						return bc + "│" + bce + " " + padP(content, iw) + " " + bc + "│" + bce
					}
					tt := " " + plainTitle
					if titleFocused {
						tt += "  ⏎ edit"
					}
					tt += " "
					top := "┌─" + tt + strings.Repeat("─", max(0, bw-3-len([]rune(tt)))) + "┐"
					Rn = append(Rn, "")
					if titleFocused {
						Rn = append(Rn, rev(top))
					} else {
						Rn = append(Rn, bc+top+bce)
					}
					keyW := 3
					for ri := 0; ri < nRows; ri++ {
						k0 := ""
						if isMatch {
							k0 = mRows[ri].env
						} else {
							k0 = orDefault(mRows_or(oRows, ri), "(VAR)")
						}
						if l := len([]rune(k0)); l > keyW {
							keyW = l
						}
					}
					if capW := iw - 12; keyW > capW && capW >= 3 {
						keyW = capW
					}
					var bodyRows []string
					if nRows == 0 {
						empt := "(none)"
						if isMatch {
							empt = "(no env files found — set env / create them)"
						}
						bodyRows = append(bodyRows, bl(DIM+empt+UNDIM))
					}
					for ri := 0; ri < nRows; ri++ {
						rowOn := editingRows && ovEdit.ri == ri
						colI := -1
						if editingRows {
							colI = ovEdit.ci
						}
						if editing && rowOn && editTarget == "ovVar" {
							bodyRows = append(bodyRows, bl("▸ "+DIM+"VAR"+UNDIM+" "+editCell(max(6, iw-8))))
							continue
						}
						if editing && rowOn && (editTarget == "ovVal" || editTarget == "meHost") {
							lbl := "value"
							if isMatch {
								lbl = "host"
							}
							bodyRows = append(bodyRows, bl("▸ "+DIM+lbl+UNDIM+" "+editCell(max(6, iw-10))))
							continue
						}
						var k0, rawV, peer string
						if isMatch {
							k0, rawV = mRows[ri].env, mRows[ri].host
						} else {
							k0 = orDefault(oRows[ri].varName, "(VAR)")
							rawV, peer = oRows[ri].value, oRows[ri].peer
						}
						kP := padP(clipP(k0, keyW), keyW)
						c0 := " " + kP + " "
						if isMatch {
							c0 = " " + sgrFgCyan + kP + sgrFgDefault + " "
						} else if rowOn && !editing && colI == 0 {
							c0 = rev(" " + kP + " ")
						}
						wpLen := 6
						if isMatch {
							wpLen = 0
						} else if peer != "" {
							wpLen = len("when " + peer + " local")
						}
						vDisp := DIM + "(none)" + UNDIM
						if rawV != "" {
							vDisp = clipP(rawV, max(4, iw-keyW-wpLen-8))
						}
						c1 := " " + vDisp + " "
						if rowOn && !editing && colI == 1 {
							c1 = rev(" " + vDisp + " ")
						}
						ptr := " "
						if rowOn && !editing {
							ptr = "▸"
						}
						content := ptr + c0 + DIM + "=" + UNDIM + c1
						if !isMatch {
							wp := "always"
							if peer != "" {
								wp = "when " + peer + " local"
							}
							if rowOn && !editing && colI == 2 {
								content += rev(" " + wp + " ")
							} else if peer != "" {
								content += " " + sgrFgCyan + wp + sgrFgDefault
							} else {
								content += " " + DIM + wp + UNDIM
							}
						}
						bodyRows = append(bodyRows, bl(content))
					}
					if editingRows && !isMatch {
						if ovEdit.ri == nRows && !editing {
							bodyRows = append(bodyRows, bl(rev(" ▸ + add ")))
						} else {
							bodyRows = append(bodyRows, bl(sgrFgGreen+"+ add"+sgrFgDefault))
						}
					}
					for len(bodyRows) < boxMinRows {
						bodyRows = append(bodyRows, bl(""))
					}
					Rn = append(Rn, bodyRows...)
					Rn = append(Rn, bc+"└"+strings.Repeat("─", bw-2)+"┘"+bce)
					continue
				}
				if fld.groupTitle != "" {
					Rn = append(Rn, "", "  "+DIM+fld.groupTitle+UNDIM)
				}
				editText := editing && on && (fld.kind == "text" || fld.kind == "name")
				labStyled := func(l string) string {
					if on && !editing {
						return "  " + rev(" "+l+" ")
					}
					return "  " + DIM + " " + l + " " + UNDIM
				}
				// `path`: the value IS the RESOLVED absolute location, or a red "not found".
				if !editText && s.key == "services" && fld.key == "path" && strings.TrimSpace(form.str("path")) != "" {
					rel := strings.TrimSpace(form.str("path"))
					abs := ""
					func() {
						defer func() { recover() }()
						abs = resolveServicePath(rel)
					}()
					var cell string
					switch {
					case abs == "":
						cell = sgrFgRed + "no services dir set — set one in Settings" + sgrFgDefault
					case pathExists(abs):
						cell = clipP(tildify(abs), vW)
					default:
						cell = sgrFgRed + clipP("not found · "+tildify(abs), vW) + sgrFgDefault
					}
					Rn = append(Rn, labStyled(padP(fld.label, labW))+" "+cell)
					continue
				}
				var val string
				switch {
				case editText:
					val = editCell(vW) // block caret, scrolls if long
				case fld.kind == "multiselect" || fld.kind == "list":
					a, _ := form[fld.key].([]string)
					if len(a) > 0 {
						val = strings.Join(a, ", ")
					} else {
						val = DIM + "(none)" + UNDIM
					}
				case fld.kind == "map":
					o, _ := form[fld.key].(*OM)
					if o != nil && o.Len() > 0 {
						var parts []string
						for _, k := range o.Keys() {
							parts = append(parts, k+"="+anyToStr(o.Get(k)))
						}
						val = strings.Join(parts, "  ")
					} else {
						val = DIM + "(none)" + UNDIM
					}
				default:
					if form.str(fld.key) != "" {
						val = form.str(fld.key)
					} else {
						req := "optional"
						if fld.req {
							req = "required"
						}
						val = DIM + "(" + req + ")" + UNDIM
					}
				}
				if !editText {
					val = clipP(val, vW)
				}
				Rn = append(Rn, labStyled(padP(fld.label, labW))+" "+val)
			}
			// Section-level info at the foot (settings warning + guards used-by).
			if s.info != nil && s.key != "services" {
				if info := s.info(form); info != "" {
					Rn = append(Rn, "", "  "+info)
				}
			}
			// Per-field help: the FOCUSED field's desc, word-wrapped, in dim.
			if focus == "right" && fi < len(s.fields) && s.fields[fi].desc != "" {
				var lines []string
				line := ""
				for _, w := range strings.Fields(s.fields[fi].desc) {
					if line != "" && len(line)+1+len(w) > RW-4 {
						lines = append(lines, line)
						line = w
					} else if line == "" {
						line = w
					} else {
						line += " " + w
					}
				}
				if line != "" {
					lines = append(lines, line)
				}
				Rn = append(Rn, "")
				for _, ln := range lines {
					Rn = append(Rn, "  "+DIM+ln+UNDIM)
				}
			}
		}
		// ---- compose ---- (home + per-row clear, NEVER a full-screen 2J — it pushes erased
		// rows into scrollback on some terminals, making the editor "scrollable")
		shade := func(x string) string { return x }
		if modal != nil {
			shade = dimText
		}
		var out strings.Builder
		out.WriteString(cursorHome)
		out.WriteString(clearLine + shade(" "+sgrBoldOn+"crew"+sgrBoldOff+DIM+"  ·  config editor"+UNDIM) + "\r\n")
		for r := 0; r < body; r++ {
			left := ""
			if r < len(L) {
				left = L[r]
			}
			right := ""
			if r < len(Rn) {
				right = Rn[r]
			}
			out.WriteString(clearLine + shade(" "+padP(left, LW)+" "+DIM+"│"+UNDIM+" "+right) + "\r\n")
		}
		// ---- footer ----
		var parts []string
		switch {
		case modal != nil:
			for _, ch := range modal.choices {
				parts = append(parts, ch.label)
			}
		case browse != nil:
			parts = []string{"↑↓ move", "→ open", "← up", "⏎ select this folder", "t type", "esc cancel"}
		case panel != nil:
			if panelField.kind == "choice" || panelField.single {
				parts = []string{"↑↓ pick", "⏎ apply", "esc cancel"}
			} else {
				parts = []string{"space toggle", "a all", "⏎ apply", "esc cancel"}
			}
		case editing:
			parts = []string{"type", "←→ move", "⌥← word", "⏎ commit", "esc cancel"}
		case mapEdit != nil:
			parts = []string{"↑↓ row", "⏎ edit", "d remove", "esc done"}
		case ovEdit != nil:
			if ovEdit.isMatch {
				parts = []string{"↑↓ row", "⏎ edit host", "esc done"}
			} else {
				parts = []string{"↑↓ row", "←→ col", "⏎ edit", "d remove", "esc done"}
			}
		case focus == "left":
			parts = []string{"↑↓ move", "⏎ open", "n new", "d delete", "esc quit"}
		default:
			fld := s.fields[fi]
			eh := "⏎ edit"
			switch {
			case fld.key == "path" && s.key == "services":
				eh = "⏎ pick folder"
			case fld.kind == "choice" || fld.kind == "multiselect":
				eh = "⏎ pick"
			case fld.kind == "list" || fld.kind == "map":
				eh = "⏎ rows"
			case fld.kind == "readonly":
				eh = ""
			}
			parts = []string{"↑↓ field", eh, "s save"}
			if !form.isNew() && !s.fixed {
				parts = append(parts, "d delete")
			}
			parts = append(parts, "esc ← list")
		}
		if msg != "" {
			parts = append([]string{msg}, parts...)
		}
		out.WriteString(clearLine + shade(footerBar(footerTextParts(parts), C)))
		// ---- modal overlay (roomy, perfectly-centered box; captures all keys) ----
		if modal != nil {
			dw := cpw
			var labels []string
			for _, ch := range modal.choices {
				labels = append(labels, ch.label)
			}
			hint := strings.Join(labels, "     ")
			rows2 := append(append([]string{}, modal.lines...), "", hint)
			iw := 48
			if w := dw(modal.title) + 6; w > iw {
				iw = w
			}
			for _, r2 := range rows2 {
				if w := dw(r2); w > iw {
					iw = w
				}
			}
			iw += 6
			if iw > C-6 {
				iw = C - 6
			}
			center := func(ln string) string {
				l := (iw - dw(ln)) >> 1
				if l < 0 {
					l = 0
				}
				return strings.Repeat(" ", l) + ln + strings.Repeat(" ", max(0, iw-l-dw(ln)))
			}
			tt := " " + modal.title + " "
			dl := max(0, iw-dw(tt))
			lft := dl >> 1
			blank := "│" + strings.Repeat(" ", iw) + "│"
			const vpad = 4
			box := []string{sgrBoldOn + "┌" + strings.Repeat("─", lft) + tt + strings.Repeat("─", dl-lft) + "┐" + sgrBoldOff}
			for i := 0; i < vpad; i++ {
				box = append(box, blank)
			}
			for _, ln := range rows2 {
				box = append(box, "│"+center(ln)+"│")
			}
			for i := 0; i < vpad; i++ {
				box = append(box, blank)
			}
			box = append(box, "└"+strings.Repeat("─", iw)+"┘")
			w2 := iw + 2
			h := len(box)
			topRow := jsRound(float64(R-h) / 2)
			if topRow < 1 {
				topRow = 1
			}
			col := jsRound(float64(C-w2)/2) + 1
			if col < 1 {
				col = 1
			}
			for i := 0; i < h; i++ {
				out.WriteString(cup(topRow+i, col) + box[i])
			}
			out.WriteString(sgrReset)
		}
		os.Stdout.WriteString(out.String())
	}

	openPanel := func(fld edField) {
		items := optionsOf(fld)
		if len(items) == 0 {
			msg = "no " + fld.label + " defined yet"
			return
		}
		single := fld.kind == "choice"
		panelField = panelFieldT{key: fld.key, kind: fld.kind, label: fld.label, single: single}
		pp := paintFn
		if fld.paint != nil {
			pp = fld.paint
		}
		panel = makeFilterPanel(panelStrings(items), pp, fld.label, single)
		if single {
			panel.Open([]string{form.str(fld.key)}, false)
		} else {
			pre, _ := form[fld.key].([]string)
			panel.Open(pre, false)
		}
	}
	openItem := func() { focus = "right"; fi = 0 }
	quit := func() bool {
		cleanup()
		result <- struct{}{}
		return true
	}
	openDelete := func(name string) {
		var used []string
		if secOf().key == "guards" {
			used = usersOf(name)
		}
		lines := []string{"Delete '" + name + "'?"}
		if len(used) > 0 {
			lines = append(lines, fmt.Sprintf("%sused by %d service(s)%s", DIM, len(used), UNDIM))
		}
		modal = &edModal{title: "Delete", lines: lines, choices: []edModalChoice{
			{keys: []string{"y", "Y"}, label: "y delete", run: func() bool { doDelete(name); modal = nil; return false }},
			{keys: []string{keyEsc, "n", "N"}, label: "esc cancel", run: func() bool { modal = nil; return false }},
		}}
	}
	openUnsaved := func() {
		n := len(drafts)
		plural := "s"
		if n == 1 {
			plural = ""
		}
		modal = &edModal{title: "Unsaved changes", lines: []string{fmt.Sprintf("%d unsaved change%s — save all before leaving?", n, plural)}, choices: []edModalChoice{
			{keys: []string{"s", "S"}, label: "s save all & exit", run: func() bool {
				if saveAll() != "" {
					modal = nil
					return false
				}
				return quit()
			}},
			{keys: []string{"d", "D"}, label: "d discard all & exit", run: func() bool { discardAll(); return quit() }},
			{keys: []string{keyEsc}, label: "esc cancel", run: func() bool { modal = nil; return false }},
		}}
	}

	handleKey := func(k string) bool {
		msg = ""
		if modal != nil { // modal captures all keys
			for _, ch := range modal.choices {
				for _, key := range ch.keys {
					if key == k {
						if ch.run() {
							return true
						}
						repaint()
						return false
					}
				}
			}
			repaint()
			return false
		}
		if browse != nil { // Miller-columns navigator
			col := browse.cols[browse.ci]
			switch {
			case k == keyCtrlC:
				return quit()
			case k == keyEsc:
				browse = nil
			case (k == "j" || k == keyDown) && len(col.entries) > 0:
				if col.cursor < len(col.entries)-1 {
					col.cursor++
				}
				browsePreview()
			case (k == "k" || k == keyUp) && len(col.entries) > 0:
				if col.cursor > 0 {
					col.cursor--
				}
				browsePreview()
			case k == "t": // type a path instead
				browse = nil
				editing = true
				buf = form.str("servicesDir")
				caret = len([]rune(buf))
			case k == "l" || k == keyRight: // → into the highlighted folder's column
				if browse.ci+1 < len(browse.cols) {
					browse.ci++
					browsePreview()
				}
			case k == "h" || k == keyLeft: // ← up a level
				if browse.ci > 0 {
					browse.ci--
					browsePreview()
				} else {
					curDir := browse.cols[0].dir
					par := filepath.Dir(curDir)
					if par != curDir {
						browse.cols = append([]*brCol{mkCol(par, baseName(curDir))}, browse.cols...)
						browsePreview()
					}
				}
			case k == keyEnter || k == keyNewline: // SELECT the highlighted folder
				c := browse.cols[browse.ci]
				selPath := c.dir
				if len(c.entries) > 0 {
					selPath = filepath.Join(c.dir, c.entries[c.cursor])
				}
				form["servicesDir"] = tildify(selPath)
				dirty = true
				syncServicesDir(form.str("servicesDir"))
				browse = nil
			}
			repaint()
			return false
		}
		if panel != nil {
			switch panel.Key(k) {
			case "apply":
				switch {
				case panelField.pickFolder:
					v := ""
					if s := panel.Selected(); len(s) > 0 {
						v = s[0]
					}
					panel = nil
					if v == typePath {
						editPath()
					} else if v != "" {
						form["path"] = v
						dirty = true
						maybeDetect() // folder picked -> set path + auto-detect
					}
				case panelField.ov: // override when-local peer
					if s := panel.Selected(); len(s) > 0 {
						v := s[0]
						if v == ovNone {
							ovEdit.rows[ovEdit.ri].peer = ""
						} else {
							ovEdit.rows[ovEdit.ri].peer = v
						}
					}
					panel = nil
					dirty = true
				default:
					if panelField.kind == "choice" {
						if s := panel.Selected(); len(s) > 0 {
							form[panelField.key] = s[0]
						}
					} else {
						form[panelField.key] = panel.Selected()
					}
					panel = nil
					dirty = true
				}
			case "cancel":
				panel = nil
			}
			repaint()
			return false
		}
		if editing {
			r := []rune(buf)
			wordL := func(i int) int {
				j := i
				for j > 0 && r[j-1] == ' ' {
					j--
				}
				for j > 0 && r[j-1] != ' ' {
					j--
				}
				return j
			}
			wordR := func(i int) int {
				j := i
				for j < len(r) && r[j] != ' ' {
					j++
				}
				for j < len(r) && r[j] == ' ' {
					j++
				}
				return j
			}
			switch {
			case k == keyEnter || k == keyNewline: // route the commit
				switch editTarget {
				case "val":
					mapEdit.rows[mapEdit.ri][1] = buf
					editing = false
					editTarget = ""
				case "newkey":
					newKey = buf
					buf = ""
					caret = 0
					editTarget = "newval" // key entered -> now the value (stay editing)
				case "newval":
					if strings.TrimSpace(newKey) != "" {
						mapEdit.rows = append(mapEdit.rows, [2]string{strings.TrimSpace(newKey), buf})
						mapEdit.ri = len(mapEdit.rows) - 1
					}
					editing = false
					editTarget = ""
				case "ovVar":
					ovEdit.rows[ovEdit.ri].varName = strings.TrimSpace(buf)
					editing = false
					editTarget = ""
					dirty = true
				case "ovVal":
					ovEdit.rows[ovEdit.ri].value = buf
					editing = false
					editTarget = ""
					dirty = true
				case "meHost":
					ovEdit.matchRows[ovEdit.ri].host = buf
					editing = false
					editTarget = ""
					dirty = true
				default:
					fk := secOf().fields[fi].key
					form[fk] = buf
					editing = false
					dirty = true
					if fk == "path" {
						maybeDetect()
					} else if fk == "servicesDir" {
						syncServicesDir(buf) // live-apply in-session
					}
				}
			case k == keyEsc: // bare esc cancels the edit
				editing = false
				editTarget = ""
			case k == keyLeft:
				if caret > 0 {
					caret--
				}
			case k == keyRight:
				if caret < len(r) {
					caret++
				}
			case k == keyAltB || k == keyAltLeft || k == keyCtrlLeft:
				caret = wordL(caret)
			case k == keyAltF || k == keyAltRight || k == keyCtrlRight:
				caret = wordR(caret)
			case k == keyHome || k == keyHome2 || k == keyCtrlA:
				caret = 0
			case k == keyEnd || k == keyEnd2 || k == keyCtrlE:
				caret = len(r)
			case k == keyBackspace || k == keyBackspace2:
				if caret > 0 {
					buf = string(r[:caret-1]) + string(r[caret:])
					caret--
				}
			case k == keyDelete:
				if caret < len(r) {
					buf = string(r[:caret]) + string(r[caret+1:])
				}
			case k == keyCtrlW:
				j := wordL(caret)
				buf = string(r[:j]) + string(r[caret:])
				caret = j
			case k == keyCtrlU:
				buf = string(r[caret:])
				caret = 0
			case k == keyCtrlK:
				buf = string(r[:caret])
			case len([]rune(k)) == 1 && k >= " ":
				buf = string(r[:caret]) + k + string(r[caret:])
				caret++
			default:
				return false
			}
			repaint()
			return false
		}
		if mapEdit != nil { // map-editor row navigation
			F := mapEdit
			n := len(F.rows)
			switch {
			case k == "k" || k == keyUp:
				if F.ri > 0 {
					F.ri--
				}
			case k == "j" || k == keyDown:
				if F.ri < n { // n = the "+ add" row
					F.ri++
				}
			case k == keyEnter || k == keyNewline:
				if F.ri == n { // + add
					editing = true
					buf = ""
					caret = 0
					editTarget = "newkey"
					newKey = ""
				} else {
					editing = true
					buf = F.rows[F.ri][1]
					caret = len([]rune(buf))
					editTarget = "val"
				}
			case k == "d":
				if F.ri < n {
					F.rows = append(F.rows[:F.ri], F.rows[F.ri+1:]...)
					if F.ri > len(F.rows) {
						F.ri = len(F.rows)
					}
				}
			case k == keyEsc || k == keyCtrlC: // esc commits rows back to the form field
				form[F.field.key] = toObj(F.rows)
				mapEdit = nil
				dirty = true
			default:
				return false
			}
			repaint()
			return false
		}
		if ovEdit != nil { // inline row editor (overrides + match)
			F := ovEdit
			isMatch := F.isMatch
			n := len(F.rows)
			if isMatch {
				n = len(F.matchRows)
			}
			maxRi := n // overrides have a "+ add" row
			if isMatch {
				maxRi = n - 1 // match has no "+ add" row
			}
			if maxRi < 0 {
				maxRi = 0
			}
			switch {
			case k == "k" || k == keyUp:
				if F.ri > 0 {
					F.ri--
				}
			case k == "j" || k == keyDown:
				if F.ri < maxRi {
					F.ri++
				}
			case !isMatch && (k == "h" || k == keyLeft):
				if F.ri < n && F.ci > 0 {
					F.ci--
				}
			case !isMatch && (k == "l" || k == keyRight):
				if F.ri < n && F.ci < 2 {
					F.ci++
				}
			case k == keyEnter || k == keyNewline:
				switch {
				case isMatch: // ⏎ edits the host
					if F.ri < n {
						editing = true
						editTarget = "meHost"
						buf = F.matchRows[F.ri].host
						caret = len([]rune(buf))
					}
				case F.ri == n: // + add -> type the VAR
					F.rows = append(F.rows, ovRow{})
					F.ri = len(F.rows) - 1
					F.ci = 0
					editing = true
					editTarget = "ovVar"
					buf = ""
					caret = 0
				case F.ci == 0:
					editing = true
					editTarget = "ovVar"
					buf = F.rows[F.ri].varName
					caret = len([]rune(buf))
				case F.ci == 1:
					editing = true
					editTarget = "ovVal"
					buf = F.rows[F.ri].value
					caret = len([]rune(buf))
				default: // when-local peer -> single-select picker (services minus self, plus "always")
					self := orDefault(form.orig(), form.str("name"))
					var peers []string
					for _, p := range cfgServices().Keys() {
						if p != self {
							peers = append(peers, p)
						}
					}
					panelField = panelFieldT{ov: true, single: true, label: "when local"}
					panel = makeFilterPanel(panelStrings(append([]string{ovNone}, peers...)), paintFn, "when local", true)
					pre := F.rows[F.ri].peer
					if pre == "" {
						pre = ovNone
					}
					panel.Open([]string{pre}, false)
				}
			case !isMatch && k == "d": // match: keys can't be removed
				if F.ri < n {
					F.rows = append(F.rows[:F.ri], F.rows[F.ri+1:]...)
					if F.ri > len(F.rows) {
						F.ri = len(F.rows)
					}
					F.ci = 0
				}
			case k == keyEsc || k == keyCtrlC: // commit rows back to the form
				if isMatch {
					form["match"] = matchCommit(F.matchRows)
				} else {
					var kept []ovRow
					for _, r2 := range F.rows {
						if strings.TrimSpace(r2.varName) != "" {
							kept = append(kept, r2)
						}
					}
					form[F.field.key] = kept
				}
				ovEdit = nil
				dirty = true
			default:
				return false
			}
			repaint()
			return false
		}
		if k == keyCtrlC { // Ctrl-C force-quits (even with unsaved edits)
			return quit()
		}
		if k == keyEsc { // esc is level-by-level: right pane -> the list; list -> quit (prompt if unsaved)
			if focus == "right" {
				focus = "left"
				repaint()
				return false
			}
			stashDraft()
			if len(drafts) > 0 {
				openUnsaved()
				repaint()
				return false
			}
			return quit()
		}
		if focus == "left" {
			switch {
			case k == "k" || k == keyUp:
				stashDraft()
				if li > 0 {
					li--
				}
				loadForm()
			case k == "j" || k == keyDown:
				stashDraft()
				if li < len(sel)-1 {
					li++
				}
				loadForm()
			case k == keyEnter || k == keyNewline || k == "l" || k == keyTab: // open the item
				openItem()
			case k == "n": // fixed sections (Settings) have no create
				si := sel[li].si
				if !sections[si].fixed {
					stashDraft()
					at := -1
					for j, e := range sel {
						if e.si == si && e.new {
							at = j
							break
						}
					}
					if at >= 0 {
						li = at
					}
					loadForm()
					focus = "right"
					fi = 0
				}
			case k == "d": // ...and no delete
				if !sel[li].new && !secOf().fixed {
					openDelete(sel[li].name)
				}
			default:
				return false
			}
			repaint()
			return false
		}
		// focus == "right"
		fields := secOf().fields
		fld := fields[fi]
		switch {
		case k == "k" || k == keyUp:
			if fi > 0 {
				fi--
			}
		case k == "j" || k == keyDown:
			if fi < len(fields)-1 {
				fi++
			}
		case k == keyEnter || k == keyNewline:
			switch {
			case fld.key == "path" && secOf().key == "services":
				openFolderPick()
			case fld.key == "servicesDir" && secOf().key == "settings":
				openBrowse()
			case fld.kind == "text" || fld.kind == "name":
				editing = true
				buf = form.str(fld.key)
				caret = len([]rune(buf))
			case fld.kind == "choice" || fld.kind == "multiselect":
				openPanel(fld)
			case fld.kind == "map":
				o, _ := form[fld.key].(*OM)
				mapEdit = &mapEditT{field: fld, rows: toRows(o)}
			case fld.kind == "match":
				formMatch, _ := form["match"].(*OM)
				var rows []matchRow
				for _, env := range matchLabels(form) {
					rows = append(rows, matchRow{env: env, host: matchValToStr(formMatch.Get(env))})
				}
				ovEdit = &ovEditT{field: fld, matchRows: rows, ci: 1, isMatch: true}
			case fld.kind == "overrides":
				src, _ := form[fld.key].([]ovRow)
				rows := append([]ovRow{}, src...)
				ovEdit = &ovEditT{field: fld, rows: rows}
			case fld.kind == "readonly" && fld.hint != "":
				msg = fld.hint
			}
		case k == "s":
			doSave()
		case k == "d":
			if !form.isNew() && !secOf().fixed {
				openDelete(form.orig())
			}
		case k == "h" || k == keyTab: // back to the list; ←/→ stay reserved for caret + columns
			focus = "left"
		default:
			return false
		}
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
	os.Stdout.WriteString(altScreenOn + cursorHide + lineWrapOff)
	repaint()
	<-result
}

func mRows_or(rows []ovRow, i int) string { return rows[i].varName }
