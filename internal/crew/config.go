package crew

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// `start` is crew's one core task — the streamed command (kill-others + interactive viewer).
// `debug` runs under it (the per-node toggle), so it streams too. Everything else in a service's
// `tasks` map is optional data with no core command yet. This set drives display only.
var streamedTasks = map[string]bool{"start": true, "debug": true}

// Machine-local services directory; relative service paths resolve against it.
var servicesDirGlobal = ""

// Resolve a SERVICE path: `~`/absolute is used as-is (escape hatch for repos outside the
// services dir); anything relative resolves against the services dir.
func resolveServicePath(p string) string {
	e := expandHome(p)
	if filepath.IsAbs(e) {
		return filepath.Clean(e)
	}
	if servicesDirGlobal == "" {
		fail("service path '%s' is relative but no services directory is set.\n  Set it in Settings: crew config", p)
	}
	return filepath.Join(servicesDirGlobal, e)
}

// Which services' folders don't exist under `dir` — the consistency check behind `crew check`
// and the editor's Settings warning. Warn-only: a wrong servicesDir must never silently
// invalidate — or auto-delete — services.
func missingServiceFolders(cfg *OM, dir string) []string {
	abs := ""
	if dir != "" {
		abs = resolvePath(dir)
	}
	var out []string
	services := cfg.GetOM("services")
	if services == nil {
		return out
	}
	for _, name := range services.Keys() {
		p := services.GetOM(name)
		if p == nil || p.GetStr("path") == "" {
			continue
		}
		e := expandHome(p.GetStr("path"))
		full := ""
		if filepath.IsAbs(e) {
			full = e
		} else if abs != "" {
			full = filepath.Join(abs, e)
		}
		if full == "" || !pathExists(full) {
			out = append(out, name)
		}
	}
	return out
}

// Shared NON-blocking gate for the folder-consuming commands: a service whose `path` folder is
// absent is treated as if it didn't exist — excluded from the graph AND the selector — while the
// SHARED config is never touched.
func presentCfg(cfg *OM) *OM {
	miss := map[string]bool{}
	for _, n := range missingServiceFolders(cfg, servicesDirGlobal) {
		miss[n] = true
	}
	out := cloneOM(cfg)
	services := NewOM()
	if s := cfg.GetOM("services"); s != nil {
		for _, n := range s.Keys() {
			if !miss[n] {
				services.Set(n, cloneValue(s.Get(n)))
			}
		}
	}
	out.Set("services", services)
	return out
}

func warnMissing(cfg *OM) []string {
	missing := missingServiceFolders(cfg, servicesDirGlobal)
	if len(missing) == 0 {
		return missing
	}
	total := 0
	if s := cfg.GetOM("services"); s != nil {
		total = s.Len()
	}
	// No services dir, or a MAJORITY missing -> the services dir is the likely culprit. A minority
	// -> the individual paths are. Informational only — the command runs on whatever remains.
	if servicesDirGlobal == "" || len(missing) > total/2 {
		under := ""
		if servicesDirGlobal != "" {
			under = " under " + tildify(servicesDirGlobal)
		}
		warn(fmt.Sprintf("%d/%d service folder(s) not found%s — check your services dir:  crew config › Settings › config › servicesDir", len(missing), total, under))
	} else {
		services := cfg.GetOM("services")
		var parts []string
		for _, n := range missing {
			e := expandHome(services.GetOM(n).GetStr("path"))
			full := e
			if !filepath.IsAbs(e) && servicesDirGlobal != "" {
				full = filepath.Join(servicesDirGlobal, e)
			}
			parts = append(parts, n+" → "+tildify(full))
		}
		warn("service folder(s) missing — fix each path (or remove it):  " + strings.Join(parts, "  "))
	}
	return missing
}

func emptyServicesState(headline string) {
	fmt.Println("\n  " + cBold(headline))
	extra := ""
	if servicesDirGlobal != "" {
		extra = cDim(" (checked under " + tildify(servicesDirGlobal) + ")")
	}
	fmt.Println(cDim("  Make sure your config has services and their paths are correct") + extra + cDim("."))
	fmt.Println(cDim("  Set your services dir:  crew config › Settings › config › servicesDir") + "\n")
}

// ---- config files ----

func defaultConfig() *OM {
	cfg := NewOM()
	cfg.Set("version", json.Number("2"))
	cfg.Set("services", NewOM())
	return cfg
}

type Flags struct {
	Version bool
	Config  string
}

func userConfigPath(flags *Flags) string {
	if flags.Config != "" {
		return resolvePath(flags.Config)
	}
	return filepath.Join(homeDir(), ".config", "crew", "config.json")
}

// The dir that holds the config also holds generated workspaces.
func crewHomeFor(configPath string) string { return filepath.Dir(configPath) }

// Machine-local settings live beside the config as `local.json` — never committed.
func machineConfigPath(flags *Flags) string {
	return filepath.Join(crewHomeFor(userConfigPath(flags)), "local.json")
}

func loadMachine(flags *Flags) *OM {
	p := machineConfigPath(flags)
	if !pathExists(p) {
		return NewOM()
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return NewOM()
	}
	v, err := ParseJSON(data)
	if err != nil {
		return NewOM()
	}
	m, ok := v.(*OM)
	if !ok {
		return NewOM()
	}
	if m.Has("projectsDir") && !m.Has("servicesDir") { // key renamed
		m.Set("servicesDir", m.Get("projectsDir"))
		m.Delete("projectsDir")
	}
	return m
}

func writeMachine(flags *Flags, obj *OM) error {
	p := machineConfigPath(flags)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(MarshalJSON(obj)+"\n"), 0o644)
}

func isNumber(v any) bool { _, ok := v.(json.Number); return ok }

// Migrate a config object in place to v2. Returns true if anything changed.
func migrate(cfg *OM) bool {
	changed := false
	if cfg.Has("projects") && !cfg.Has("services") { // key renamed: `projects` -> `services`
		cfg.Set("services", cfg.Get("projects"))
		cfg.Delete("projects")
		changed = true
	}
	verOld := !isNumber(cfg.Get("version"))
	if !verOld {
		n, _ := cfg.Get("version").(json.Number)
		if f, err := n.Float64(); err == nil && f < 2 {
			verOld = true
		}
	}
	if verOld {
		// v1 -> v2: a service's single `start` block becomes tasks.start.
		if services := cfg.GetOM("services"); services != nil {
			for _, name := range services.Keys() {
				p := services.GetOM(name)
				if p == nil {
					continue
				}
				if st := p.GetOM("start"); st != nil {
					tasks := p.GetOM("tasks")
					if tasks == nil {
						tasks = NewOM()
						p.Set("tasks", tasks)
					}
					if cmd := st.GetStr("command"); cmd != "" && tasks.Get("start") == nil {
						tasks.Set("start", cmd)
					}
					p.Delete("start") // cwd/defaults/allowed dropped: v2 fills placeholders from args only
				}
			}
		}
		cfg.Set("version", json.Number("2"))
		changed = true
	}
	if cfg.Has("longRunning") { // retired: `start` is always streamed
		cfg.Delete("longRunning")
		changed = true
	}
	if services := cfg.GetOM("services"); services != nil { // retired per-service keys
		for _, name := range services.Keys() {
			svc := services.GetOM(name)
			if svc == nil {
				continue
			}
			for _, k := range []string{"runner", "defaultBranch"} {
				if svc.Has(k) {
					svc.Delete(k)
					changed = true
				}
			}
		}
	}
	if cfg.GetOM("services") == nil {
		cfg.Set("services", NewOM())
		changed = true
	}
	// Groups were removed in favour of the on-the-fly picker + remembered selection; drop any.
	if cfg.Has("groups") {
		cfg.Delete("groups")
		changed = true
	}
	// `workspaceName` + `workspaceSettings` are retired: the title is an auto-label and the
	// VS Code settings are baked. Strip legacy values so `check` doesn't warn.
	if cfg.Get("workspaceName") != nil {
		cfg.Delete("workspaceName")
		changed = true
	}
	if cfg.Get("workspaceSettings") != nil {
		cfg.Delete("workspaceSettings")
		changed = true
	}
	// Rename the short-lived `checks` feature to `guards` (top-level registry + per-service).
	if checks := cfg.GetOM("checks"); checks != nil {
		merged := NewOM()
		for _, k := range checks.Keys() {
			merged.Set(k, checks.Get(k))
		}
		if g := cfg.GetOM("guards"); g != nil {
			for _, k := range g.Keys() {
				merged.Set(k, g.Get(k))
			}
		}
		cfg.Set("guards", merged)
		cfg.Delete("checks")
		changed = true
	}
	if services := cfg.GetOM("services"); services != nil {
		for _, name := range services.Keys() {
			p := services.GetOM(name)
			if p == nil {
				continue
			}
			if arr, ok := p.Get("checks").([]any); ok && !p.Has("guards") {
				p.Set("guards", arr)
				changed = true
			}
		}
		// Self-heal: drop fields removed in later versions.
		for _, name := range services.Keys() {
			p := services.GetOM(name)
			if p == nil {
				continue
			}
			for _, dead := range []string{"relatedDirs", "cwd", "start", "checks"} {
				if p.Has(dead) {
					p.Delete(dead)
					changed = true
				}
			}
		}
	}
	return changed
}

type userConfig struct {
	path    string
	cfg     *OM
	existed bool
}

// Load (and migrate-in-place) the user-level config. Writes back if migrated.
func loadUserConfig(flags *Flags) userConfig {
	path := userConfigPath(flags)
	if !pathExists(path) {
		return userConfig{path: path, cfg: defaultConfig(), existed: false}
	}
	data, err := os.ReadFile(path)
	var cfg *OM
	if err == nil {
		v, perr := ParseJSON(data)
		if perr == nil {
			cfg, _ = v.(*OM)
		}
	}
	if cfg == nil {
		fail("config file is not valid JSON: %s", path)
	}
	changed := migrate(cfg)
	if cfg.Has("projectsDir") && !cfg.Has("servicesDir") { // key renamed
		cfg.Set("servicesDir", cfg.Get("projectsDir"))
		cfg.Delete("projectsDir")
		changed = true
	}
	// servicesDir is machine-local: it belongs in local.json, not the committable config.
	machine := loadMachine(flags)
	servicesDir := machine.GetStr("servicesDir")
	if cfg.Has("servicesDir") {
		if servicesDir == "" {
			servicesDir = cfg.GetStr("servicesDir")
			m2 := loadMachine(flags)
			m2.Set("servicesDir", servicesDir)
			_ = writeMachine(flags, m2) // read-only fs tolerated
		}
		cfg.Delete("servicesDir")
		changed = true
	}
	// NB: `local.json.overrides` is NOT migrated up — it's the machine-local, per-user/secret
	// OVERLAY that merges over `config.json.overrides` at run time (mergeOverrides).
	if changed {
		_ = writeUserConfig(path, cfg) // read-only fs — proceed with the in-memory migration
	}
	if servicesDir != "" {
		servicesDirGlobal = resolvePath(servicesDir)
	} else {
		servicesDirGlobal = ""
	}
	return userConfig{path: path, cfg: cfg, existed: true}
}

func writeUserConfig(path string, cfg *OM) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(MarshalJSON(cfg)+"\n"), 0o644)
}

func cloneValue(v any) any {
	switch t := v.(type) {
	case *OM:
		return cloneOM(t)
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = cloneValue(x)
		}
		return out
	default:
		return v
	}
}

func cloneOM(o *OM) *OM {
	out := NewOM()
	if o == nil {
		return out
	}
	for _, k := range o.keys {
		out.Set(k, cloneValue(o.m[k]))
	}
	return out
}

type mergedConfig struct {
	cfg       *OM
	userPath  string
	localPath string // "" when no ./.crew.json
}

// Merge service-local ./.crew.json on top of the user config (read-only overlay).
func loadMerged(flags *Flags) mergedConfig {
	uc := loadUserConfig(flags)
	merged := cloneOM(uc.cfg)
	cwd, _ := os.Getwd()
	localPath := filepath.Join(cwd, ".crew.json")
	used := ""
	if pathExists(localPath) {
		data, err := os.ReadFile(localPath)
		var local *OM
		if err == nil {
			if v, perr := ParseJSON(data); perr == nil {
				local, _ = v.(*OM)
			}
		}
		if local == nil {
			fail("service-local config is not valid JSON: %s", localPath)
		}
		services := merged.GetOM("services")
		if services == nil {
			services = NewOM()
			merged.Set("services", services)
		}
		if ls := local.GetOM("services"); ls != nil {
			for _, k := range ls.Keys() {
				services.Set(k, ls.Get(k))
			}
		}
		guards := NewOM()
		if g := merged.GetOM("guards"); g != nil {
			for _, k := range g.Keys() {
				guards.Set(k, g.Get(k))
			}
		}
		if lg := local.GetOM("guards"); lg != nil {
			for _, k := range lg.Keys() {
				guards.Set(k, lg.Get(k))
			}
		}
		merged.Set("guards", guards)
		used = localPath
	}
	return mergedConfig{cfg: merged, userPath: uc.path, localPath: used}
}

// ---- selection helpers ----

type member struct {
	name    string
	service *OM
	task    string // "" = the command's task; "debug" when debug-toggled
}

func membersFor(cfg *OM, names []string, debug []string) []member {
	services := cfg.GetOM("services")
	var known []string
	if services != nil {
		known = services.Keys()
	}
	var missing []string
	for _, n := range names {
		if services.GetOM(n) == nil {
			missing = append(missing, n)
		}
	}
	if len(missing) > 0 {
		list := strings.Join(known, ", ")
		if list == "" {
			list = "(none) — run: crew config"
		}
		fail("unknown service(s): %s.\n  services: %s", strings.Join(missing, ", "), list)
	}
	dbg := map[string]bool{}
	for _, n := range debug {
		dbg[n] = true
	}
	out := make([]member, 0, len(names))
	for _, n := range names {
		service := services.GetOM(n)
		useDebug := dbg[n] && service.GetOM("tasks") != nil && service.GetOM("tasks").Get("debug") != nil
		m := member{name: n, service: service}
		if useDebug {
			m.task = "debug"
		}
		out = append(out, m)
	}
	return out
}

// ---- machine-local prefs (local.json) — read-only fs failures just don't persist ----

func machineStrArr(flags *Flags, key string) []string {
	if arr, ok := StrArr(loadMachine(flags).Get(key)); ok {
		return arr
	}
	return nil
}

func saveMachineKey(flags *Flags, key string, v any) {
	m := loadMachine(flags)
	m.Set(key, v)
	_ = writeMachine(flags, m)
}

func toAnyArr(names []string) []any {
	out := make([]any, len(names))
	for i, n := range names {
		out[i] = n
	}
	return out
}

func loadLastSelection(flags *Flags) []string { return machineStrArr(flags, "lastSelection") }
func saveLastSelection(flags *Flags, names []string) {
	saveMachineKey(flags, "lastSelection", toAnyArr(names))
}
func loadLastDebug(flags *Flags) []string { return machineStrArr(flags, "lastDebug") }
func saveLastDebug(flags *Flags, names []string) {
	saveMachineKey(flags, "lastDebug", toAnyArr(names))
}

// Per-run DISABLED overrides: { service: [key…] } where key is `VAR` / `peer.VAR`.
func loadOverridesOff(flags *Flags) *OM {
	if o := loadMachine(flags).GetOM("overridesOff"); o != nil {
		return o
	}
	return NewOM()
}
func saveOverridesOff(flags *Flags, m *OM) { saveMachineKey(flags, "overridesOff", m) }

// Log-viewer filter memory: persist the HIDDEN names so anything NEW defaults to visible.
func loadHiddenLog(flags *Flags) []string { return machineStrArr(flags, "hiddenLog") }
func saveHiddenLog(flags *Flags, names []string) {
	saveMachineKey(flags, "hiddenLog", toAnyArr(names))
}

// Log-viewer wrap/cut preference. Default: wrap.
func loadLogWrap(flags *Flags) bool {
	if b, ok := loadMachine(flags).Get("logWrap").(bool); ok {
		return b
	}
	return true
}
func saveLogWrap(flags *Flags, wrap bool) { saveMachineKey(flags, "logWrap", wrap) }

// Graph-view prefs, shared by every graph UI. `graphRefs` = show reference edges (default on).
// `graphShown` = the node filter (nil = all).
func loadGraphRefs(flags *Flags) bool {
	if b, ok := loadMachine(flags).Get("graphRefs").(bool); ok {
		return b
	}
	return true
}
func saveGraphRefs(flags *Flags, on bool) { saveMachineKey(flags, "graphRefs", on) }
func loadGraphShown(flags *Flags) []string {
	if arr, ok := StrArr(loadMachine(flags).Get("graphShown")); ok {
		return arr
	}
	return nil
}
func saveGraphShown(flags *Flags, names []string) {
	saveMachineKey(flags, "graphShown", toAnyArr(names))
}

// ---- editors ----

var serviceTypes = []string{"frontend", "backend", "fullstack", "other"}

type editorDef struct {
	id, bin, kind, label string
}

// The editor `crew workspace` opens the selected set in. TWO kinds cover every editor:
// 'workspace-file' (VS Code family: materialize a .code-workspace and open THAT file) and
// 'folders' (Zed/JetBrains/Neovim: pass the resolved dirs straight as CLI args). The choice is
// machine-local (`local.json.editor`) — UNSET => `crew workspace` is disabled; there is NO default.
var editors = []editorDef{
	{"vscode", "code", "workspace-file", "VS Code"},
	{"cursor", "cursor", "workspace-file", "Cursor"},
	{"codium", "codium", "workspace-file", "VSCodium"},
	{"vscode-insiders", "code-insiders", "workspace-file", "VS Code Insiders"},
	{"zed", "zed", "folders", "Zed"},
	{"intellij", "idea", "folders", "IntelliJ IDEA"},
	{"pycharm", "pycharm", "folders", "PyCharm"},
	{"goland", "goland", "folders", "GoLand"},
	{"webstorm", "webstorm", "folders", "WebStorm"},
	{"nvim", "nvim", "folders", "Neovim"},
}

func editorByID(id string) *editorDef {
	for i := range editors {
		if editors[i].id == id {
			return &editors[i]
		}
	}
	return nil
}

var editorKinds = []string{"workspace-file", "folders"}

// Settings crew bakes into the generated `.code-workspace` for the VS Code family — one narrow,
// near-universal QoL default. Edit HERE to change it.
var vscodeWorkspaceSettings = func() *OM {
	o := NewOM()
	o.Set("jest.enable", false)
	return o
}()

// Is `bin` an executable on PATH? Zero-dep PATH scan (no subprocess).
func onPath(bin string) bool {
	if bin == "" {
		return false
	}
	isExec := func(p string) bool {
		fi, err := os.Stat(p)
		return err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0
	}
	if strings.Contains(bin, "/") {
		return isExec(bin)
	}
	for _, d := range strings.Split(os.Getenv("PATH"), ":") {
		if d == "" {
			continue
		}
		if isExec(filepath.Join(d, bin)) {
			return true
		}
	}
	return false
}

type editorResolved struct {
	bin, kind, label string
}

// Resolve `local.json.editor` -> { bin, kind, label } or nil (unset/invalid => workspace disabled).
// Accepts a built-in id (string) OR an escape-hatch object { bin, kind } for any other editor.
func resolveEditor(val any) *editorResolved {
	switch v := val.(type) {
	case string:
		if e := editorByID(v); e != nil {
			return &editorResolved{bin: e.bin, kind: e.kind, label: e.label}
		}
		return nil
	case *OM:
		bin := strings.TrimSpace(v.GetStr("bin"))
		kind := v.GetStr("kind")
		okKind := false
		for _, k := range editorKinds {
			if k == kind {
				okKind = true
			}
		}
		if bin != "" && okKind {
			label := v.GetStr("label")
			if label == "" {
				label = bin
			}
			return &editorResolved{bin: bin, kind: kind, label: label}
		}
		return nil
	default:
		return nil
	}
}

// ---- config-validation key sets (used by `crew check` + pruneConfig) ----

var topKeys = map[string]bool{"version": true, "services": true, "guards": true, "overrides": true}
var serviceKeys = map[string]bool{"path": true, "type": true, "env": true, "local": true, "match": true, "tasks": true, "guards": true}
var guardKeys = map[string]bool{"comment": true, "command": true, "message": true}

// Strip keys the schema doesn't know — the visual editor calls this on every write so a save
// fully normalizes the file.
func pruneConfig(cfg *OM) *OM {
	for _, k := range cfg.Keys() {
		if !topKeys[k] {
			cfg.Delete(k)
		}
	}
	if services := cfg.GetOM("services"); services != nil {
		for _, name := range services.Keys() {
			if p := services.GetOM(name); p != nil {
				for _, k := range p.Keys() {
					if !serviceKeys[k] {
						p.Delete(k)
					}
				}
			}
		}
	}
	if guards := cfg.GetOM("guards"); guards != nil {
		for _, name := range guards.Keys() {
			if g := guards.GetOM(name); g != nil {
				for _, k := range g.Keys() {
					if !guardKeys[k] {
						g.Delete(k)
					}
				}
			}
		}
	}
	return cfg
}
