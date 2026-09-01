package crew

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// ordered string set — deterministic iteration in first-insert order
type oset struct {
	keys []string
	m    map[string]bool
}

func newOset() *oset { return &oset{m: map[string]bool{}} }
func (s *oset) add(k string) {
	if !s.m[k] {
		s.m[k] = true
		s.keys = append(s.keys, k)
	}
}
func (s *oset) has(k string) bool { return s != nil && s.m[k] }
func (s *oset) list() []string    { return append([]string(nil), s.keys...) }
func (s *oset) size() int         { return len(s.keys) }

var urlRE = regexp.MustCompile("\\bhttps?://[^\\s\"'`)}<]+")

type hostPath struct{ host, path string }

var urlHostPathRE = regexp.MustCompile(`(?i)^https?://([^/?#]+)([^?#\s]*)`)

// Split a URL into host + path (lowercased, scheme/port/query/trailing-slash dropped).
func urlHostPath(u string) *hostPath {
	m := urlHostPathRE.FindStringSubmatch(u)
	if m == nil {
		return nil
	}
	host := strings.ToLower(regexp.MustCompile(`:\d+$`).ReplaceAllString(m[1], ""))
	path := strings.ToLower(strings.TrimRight(m[2], "/"))
	return &hostPath{host: host, path: path}
}

// A match token identifies a service by EXACT host, optionally narrowed by a path prefix.
// Exact host, no globs → no cross-service collisions. Returns the matched length (host or
// host+path) so the most-specific token wins.
func tokenMatchLen(host, path, tok string) int {
	tok = strings.ToLower(tok)
	if tok == "" {
		return 0
	}
	slash := strings.Index(tok, "/")
	if slash == -1 {
		if tok == host {
			return len(tok)
		}
		return 0
	}
	tokHost := tok[:slash]
	tokPath := strings.TrimRight(tok[slash:], "/")
	if host != tokHost {
		return 0
	}
	if path == tokPath || strings.HasPrefix(path, tokPath+"/") {
		return len(tok)
	}
	return 0
}

var originRE = regexp.MustCompile(`(?i)^https?://[^/?#\s]+`)

// The scheme://host[:port] prefix of a URL (drops path/query/fragment). ” if not a URL.
func originOf(u string) string { return originRE.FindString(u) }

type wirePeer struct {
	name   string
	tokens []string
	origin string
	local  string
}

// Rewrite env-file text for local wiring: every URL matching a co-running peer's token is
// pointed at that peer locally. A host-only token swaps just the origin (path/query preserved);
// a host+path token replaces the WHOLE URL with the peer's full `local`. Most-specific wins.
func wireText(text string, peers []wirePeer) string {
	return urlRE.ReplaceAllStringFunc(text, func(u string) string {
		p := urlHostPath(u)
		if p == nil {
			return u
		}
		var best *wirePeer
		bestLen := 0
		bestTok := ""
		for i := range peers {
			for _, tok := range peers[i].tokens {
				if l := tokenMatchLen(p.host, p.path, tok); l > bestLen {
					bestLen = l
					best = &peers[i]
					bestTok = tok
				}
			}
		}
		if best == nil {
			return u
		}
		if strings.Contains(bestTok, "/") {
			return best.local // path token: replace the whole URL
		}
		if o := originOf(u); o != "" {
			return best.origin + u[len(o):] // host token: swap origin, keep path
		}
		return u
	})
}

// ---- env overrides ----

const overrideWhenLocal = "whenLocal"

// The extra env vars to upsert into `name`'s wired env: bare `VAR:val` always; whenLocal[peer]
// vars only when that peer is also being started. `off` = per-run disabled keys (`VAR` / `peer.VAR`).
func overrideVarsFor(overrides *OM, name string, running []string, off []string) *OM {
	skip := map[string]bool{}
	for _, k := range off {
		skip[k] = true
	}
	vars := NewOM()
	o := overrides.GetOM(name)
	if o == nil {
		return vars
	}
	for _, k := range o.Keys() {
		if k != overrideWhenLocal && !skip[k] {
			vars.Set(k, o.Get(k))
		}
	}
	if wl := o.GetOM(overrideWhenLocal); wl != nil {
		for _, peer := range running {
			if pv := wl.GetOM(peer); pv != nil {
				for _, k := range pv.Keys() {
					if !skip[peer+"."+k] {
						vars.Set(k, pv.Get(k))
					}
				}
			}
		}
	}
	return vars
}

type overrideEntry struct {
	key, varName, value, peer string
}

// The keys the `e` toggle uses to identify each override: bare `VAR`, and `peer.VAR` for a
// whenLocal entry. Order: bare first, then per-peer.
func overrideEntries(o *OM) []overrideEntry {
	var out []overrideEntry
	if o == nil {
		return out
	}
	for _, k := range o.Keys() {
		if k != overrideWhenLocal {
			out = append(out, overrideEntry{key: k, varName: k, value: anyToStr(o.Get(k)), peer: ""})
		}
	}
	if wl := o.GetOM(overrideWhenLocal); wl != nil {
		for _, peer := range wl.Keys() {
			if pv := wl.GetOM(peer); pv != nil {
				for _, vk := range pv.Keys() {
					out = append(out, overrideEntry{key: peer + "." + vk, varName: vk, value: anyToStr(pv.Get(vk)), peer: peer})
				}
			}
		}
	}
	return out
}

func anyToStr(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return "null"
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprintf("%v", t)
	}
}

// TWO-LAYER overrides: config.json (committable, shared) MERGED with local.json (machine-local,
// secrets). local WINS, per service + per var + per whenLocal[peer][var].
func mergeOverrides(cfgOv, localOv *OM) *OM {
	out := NewOM()
	union := newOset()
	if cfgOv != nil {
		for _, k := range cfgOv.Keys() {
			union.add(k)
		}
	}
	if localOv != nil {
		for _, k := range localOv.Keys() {
			union.add(k)
		}
	}
	for _, p := range union.list() {
		a, b := cfgOv.GetOM(p), localOv.GetOM(p)
		m := NewOM()
		if a != nil {
			for _, k := range a.Keys() {
				if k != overrideWhenLocal {
					m.Set(k, a.Get(k))
				}
			}
		}
		if b != nil {
			for _, k := range b.Keys() {
				if k != overrideWhenLocal {
					m.Set(k, b.Get(k)) // local bare wins
				}
			}
		}
		aw, bw := a.GetOM(overrideWhenLocal), b.GetOM(overrideWhenLocal)
		if aw != nil || bw != nil {
			wl := NewOM()
			peerU := newOset()
			if aw != nil {
				for _, k := range aw.Keys() {
					peerU.add(k)
				}
			}
			if bw != nil {
				for _, k := range bw.Keys() {
					peerU.add(k)
				}
			}
			for _, peer := range peerU.list() {
				pv := NewOM()
				if apv := aw.GetOM(peer); apv != nil {
					for _, k := range apv.Keys() {
						pv.Set(k, apv.Get(k))
					}
				}
				if bpv := bw.GetOM(peer); bpv != nil {
					for _, k := range bpv.Keys() {
						pv.Set(k, bpv.Get(k)) // local peer-var wins
					}
				}
				wl.Set(peer, pv)
			}
			m.Set(overrideWhenLocal, wl)
		}
		if m.Len() > 0 {
			out.Set(p, m)
		}
	}
	return out
}

var envSafeRE = regexp.MustCompile(`^[A-Za-z0-9_.:@/=+-]*$`)

// dotenv/sh-safe: quote only values with characters outside a safe set.
func envOverrideValue(v string) string {
	if envSafeRE.MatchString(v) {
		return v
	}
	return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'"
}

var envVarNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Upsert each KEY=value into env-file text: replace an existing assignment (optionally
// `export`-prefixed) in place, else append. Returns the new text, the keys applied, and warnings.
func applyEnvOverrides(text string, vars *OM) (string, []string, []string) {
	var applied, warnings []string
	out := text
	if vars == nil {
		return out, applied, warnings
	}
	for _, k := range vars.Keys() {
		v := vars.Get(k)
		if !envVarNameRE.MatchString(k) {
			warnings = append(warnings, fmt.Sprintf("override: skipping invalid env var name '%s'", k))
			continue
		}
		switch vv := v.(type) {
		case nil:
			warnings = append(warnings, fmt.Sprintf("override: '%s' must be a string value — got object", k))
			continue
		case *OM:
			warnings = append(warnings, fmt.Sprintf("override: '%s' must be a string value — got object", k))
			continue
		case []any:
			warnings = append(warnings, fmt.Sprintf("override: '%s' must be a string value — got array", k))
			continue
		default:
			_ = vv
		}
		line := k + "=" + envOverrideValue(anyToStr(v))
		re := regexp.MustCompile(`(?m)^([ \t]*(?:export[ \t]+)?)` + k + `=.*$`)
		if re.MatchString(out) {
			done := false
			out = re.ReplaceAllStringFunc(out, func(m string) string {
				if done {
					return m
				}
				done = true
				pre := re.FindStringSubmatch(m)[1]
				return pre + line
			})
		} else {
			sep := ""
			if out != "" && !strings.HasSuffix(out, "\n") {
				sep = "\n"
			}
			out += sep + line + "\n"
		}
		applied = append(applied, k)
	}
	return out, applied, warnings
}

// Best-effort copy to the system clipboard (shell out to the platform tool). Returns the tool
// used, or "" if none is available.
func clipboardCopy(text string) string {
	type tool struct {
		cmd  string
		args []string
	}
	var tools []tool
	if strings.Contains(strings.ToLower(os.Getenv("OSTYPE"))+runtimeGOOS(), "darwin") {
		tools = []tool{{"pbcopy", nil}}
	} else {
		tools = []tool{{"wl-copy", nil}, {"xclip", []string{"-selection", "clipboard"}}, {"xsel", []string{"--clipboard", "--input"}}}
	}
	for _, t := range tools {
		cmd := exec.Command(t.cmd, t.args...)
		cmd.Stdin = strings.NewReader(text)
		if err := cmd.Run(); err == nil {
			return t.cmd
		}
	}
	return ""
}

// ---- service identity + env discovery ----

type identity struct {
	tokens []string
	envOf  map[string]string // host token (lowercased) -> env label
	source string            // 'match' | 'none'
}

// A service's id comes from config `match`, an ENV-LABELED map { env: host | [hosts] }.
func serviceIdentity(service *OM) identity {
	id := identity{envOf: map[string]string{}, source: "none"}
	m := service.GetOM("match")
	if m == nil {
		return id
	}
	for _, env := range m.Keys() {
		v := m.Get(env)
		var hosts []string
		if arr, ok := v.([]any); ok {
			for _, h := range arr {
				if s, ok := h.(string); ok {
					hosts = append(hosts, s)
				}
			}
		} else if s, ok := v.(string); ok {
			hosts = append(hosts, s)
		}
		for _, h := range hosts {
			if h == "" {
				continue
			}
			id.tokens = append(id.tokens, h)
			id.envOf[strings.ToLower(h)] = env
		}
	}
	if len(id.tokens) > 0 {
		id.source = "match"
	}
	return id
}

// A URL from a non-frontend INTO a `type: frontend` service is a REFERENCE (a link-back), NOT a
// runtime dependency — excluded from connectivity and env derivation.
func isReferenceEdge(cfg *OM, from, to string) bool {
	services := cfg.GetOM("services")
	f, t := services.GetOM(from), services.GetOM(to)
	return t != nil && t.GetStr("type") == "frontend" && f != nil && f.GetStr("type") != "frontend"
}

type envFile struct {
	env, slug, path string
}

// Scan <dir>/.envs, parse each file's name as <env>[-<slug>].
func envFilesFor(dir string) []envFile {
	envsDir := filepath.Join(dir, ".envs")
	entries, err := os.ReadDir(envsDir)
	if err != nil {
		return nil
	}
	var out []envFile
	dotEnvRE := regexp.MustCompile(`^\.env\.(.+)$`)
	for _, e := range entries {
		name := e.Name()
		// Skip hidden/editor junk, but KEEP dotfile env files (`.env`, `.env.qa`, …).
		if strings.HasPrefix(name, ".") && name != ".env" && !strings.HasPrefix(name, ".env.") {
			continue
		}
		p := filepath.Join(envsDir, name)
		if m := dotEnvRE.FindStringSubmatch(name); m != nil {
			out = append(out, envFile{env: m[1], path: p})
			continue
		}
		if name == ".env" {
			out = append(out, envFile{env: "default", path: p})
			continue
		}
		base := strings.TrimSuffix(name, ".env")
		dash := strings.Index(base, "-")
		if dash > 0 {
			out = append(out, envFile{env: base[:dash], slug: base[dash+1:], path: p})
		} else {
			out = append(out, envFile{env: base, path: p})
		}
	}
	return out
}

var reMetaRE = regexp.MustCompile(`[.*+?^${}()|[\]\\]`)

func escapeRE(s string) string {
	return reMetaRE.ReplaceAllStringFunc(s, func(m string) string { return `\` + m })
}

// Enumerate a service's env files. If it declares `env` (a path template containing {env}),
// resolve it against the filesystem — {env} becomes a wildcard, captured CONSISTENTLY across
// every occurrence. No template (or a static one) -> the default `<dir>/.envs` scan.
func serviceEnvFiles(service *OM) []envFile {
	pathVal := service.GetStr("path")
	if pathVal == "" {
		return nil
	}
	var dir string
	ok := func() (ok bool) {
		defer func() {
			if recover() != nil {
				ok = false
			}
		}()
		dir = resolveServicePath(pathVal)
		return true
	}()
	if !ok {
		return nil
	}
	tmpl := service.GetStr("env")
	if tmpl == "" || !strings.Contains(tmpl, "{env}") {
		return envFilesFor(dir)
	}
	segs := strings.Split(tmpl, "/")
	firstGlob := -1
	for i, s := range segs {
		if strings.Contains(s, "{env}") {
			firstGlob = i
			break
		}
	}
	base := filepath.Join(append([]string{dir}, segs[:firstGlob]...)...)
	rest := segs[firstGlob:]
	var out []envFile
	var walk func(d string, i int, boundEnv *string)
	walk = func(d string, i int, boundEnv *string) {
		seg := rest[i]
		isLast := i == len(rest)-1
		globbed := strings.Contains(seg, "{env}")
		var re *regexp.Regexp
		if globbed {
			parts := strings.Split(seg, "{env}")
			esc := make([]string, len(parts))
			for j, p := range parts {
				esc[j] = escapeRE(p)
			}
			re = regexp.MustCompile("^" + strings.Join(esc, "(.+?)") + "$")
		}
		entries, err := os.ReadDir(d)
		if err != nil {
			return
		}
		for _, e := range entries {
			env := boundEnv
			if globbed {
				if strings.HasPrefix(e.Name(), ".") && !strings.HasPrefix(seg, ".") {
					continue // dotfiles aren't env variants
				}
				m := re.FindStringSubmatch(e.Name())
				if m == nil {
					continue
				}
				vals := m[1:]
				same := true
				for _, v := range vals {
					if v != vals[0] {
						same = false
					}
				}
				if !same {
					continue // every {env} occurrence must agree
				}
				if boundEnv != nil && vals[0] != *boundEnv {
					continue
				}
				v0 := vals[0]
				env = &v0
			} else if e.Name() != seg {
				continue // literal segment must match exactly
			}
			p := filepath.Join(d, e.Name())
			if isLast {
				if !e.IsDir() {
					ev := ""
					if env != nil {
						ev = *env
					}
					out = append(out, envFile{env: ev, path: p})
				}
			} else if e.IsDir() {
				walk(p, i+1, env)
			}
		}
	}
	walk(base, 0, nil)
	return out
}

// ---- graph edges + connectivity ----

type svcMeta struct {
	files []envFile
	identity
}

func metaFor(services *OM, names []string) map[string]*svcMeta {
	meta := map[string]*svcMeta{}
	for _, n := range names {
		s := services.GetOM(n)
		meta[n] = &svcMeta{files: serviceEnvFiles(s), identity: serviceIdentity(s)}
	}
	return meta
}

func urlsIn(files []envFile) []hostPath {
	seen := newOset()
	var out []hostPath
	for _, f := range files {
		data, err := os.ReadFile(f.path)
		if err != nil {
			continue
		}
		for _, u := range urlRE.FindAllString(string(data), -1) {
			if p := urlHostPath(u); p != nil {
				key := p.host + "\n" + p.path
				if !seen.has(key) {
					seen.add(key)
					out = append(out, *p)
				}
			}
		}
	}
	return out
}

func bestTarget(names []string, meta map[string]*svcMeta, host, path string) string {
	best := ""
	bestLen := 0
	for _, t := range names {
		for _, tok := range meta[t].tokens {
			if l := tokenMatchLen(host, path, tok); l > bestLen {
				bestLen = l
				best = t
			}
		}
	}
	return best
}

// Directed dependency edges among the services: name -> ordered set of peers.
func dependencyEdges(cfg *OM, names []string) map[string]*oset {
	services := cfg.GetOM("services")
	meta := metaFor(services, names)
	edges := map[string]*oset{}
	for _, name := range names {
		edges[name] = newOset()
		for _, hp := range urlsIn(meta[name].files) {
			best := bestTarget(names, meta, hp.host, hp.path)
			if best != "" && best != name && !isReferenceEdge(cfg, name, best) {
				edges[name].add(best)
			}
		}
	}
	return edges
}

// Connected components (undirected) of the induced dependency subgraph over `names`.
func componentsFrom(edges map[string]*oset, names []string) [][]string {
	set := map[string]bool{}
	for _, n := range names {
		set[n] = true
	}
	adj := map[string]*oset{}
	for _, n := range names {
		adj[n] = newOset()
	}
	for _, from := range names {
		if e := edges[from]; e != nil {
			for _, to := range e.list() {
				if set[to] {
					adj[from].add(to)
					adj[to].add(from)
				}
			}
		}
	}
	seen := map[string]bool{}
	var comps [][]string
	for _, n := range names {
		if seen[n] {
			continue
		}
		stack := []string{n}
		var comp []string
		seen[n] = true
		for len(stack) > 0 {
			x := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			comp = append(comp, x)
			for _, y := range adj[x].list() {
				if !seen[y] {
					seen[y] = true
					stack = append(stack, y)
				}
			}
		}
		comps = append(comps, comp)
	}
	return comps
}

// Single-line connectivity status for a selection. Empty when there's nothing to say (unless
// verbose). Disconnected => one inline line listing the islands.
func connectivityStatus(cfg *OM, edges map[string]*oset, names []string, verbose bool) string {
	services := cfg.GetOM("services")
	var valid []string
	for _, n := range names {
		if services.GetOM(n) != nil {
			valid = append(valid, n)
		}
	}
	if len(valid) < 2 {
		if verbose {
			return cDim("  select 2+ services to check local wiring")
		}
		return ""
	}
	comps := componentsFrom(edges, valid)
	if len(comps) <= 1 {
		if verbose {
			return "  " + cGreen("✓") + cDim(" connected")
		}
		return ""
	}
	paint := serviceColors(cfg)
	sort.SliceStable(comps, func(a, b int) bool { return len(comps[a]) > len(comps[b]) })
	var islands []string
	for _, comp := range comps {
		var painted []string
		for _, n := range comp {
			painted = append(painted, paint[n](n))
		}
		islands = append(islands, strings.Join(painted, cDim("·")))
	}
	return "  " + cYellow("⚠ not connected:") + " " + strings.Join(islands, cDim("  |  "))
}

// Verify every member's path exists. Names the offending service.
func validateMemberPaths(members []member) {
	for _, m := range members {
		p := resolveServicePath(m.service.GetStr("path"))
		if !pathExists(p) {
			fail("service '%s': path not found: %s", m.name, p)
		}
	}
}

// Build a deduped absolute-path list of member service paths, first-seen order.
func dirList(members []member) []string {
	seen := newOset()
	for _, m := range members {
		seen.add(resolveServicePath(m.service.GetStr("path")))
	}
	return seen.list()
}

func serviceDir(service *OM) string { return resolveServicePath(service.GetStr("path")) }

// graph edges for the renderer: real deps + reference edges
type graphEdges struct {
	nodes []string
	real  [][2]string
	ref   [][2]string
}

func collectGraphEdges(cfg *OM) graphEdges {
	services := cfg.GetOM("services")
	var names []string
	if services != nil {
		names = services.Keys()
	}
	meta := metaFor(services, names)
	out := graphEdges{nodes: names}
	for _, name := range names {
		targets := newOset()
		for _, hp := range urlsIn(meta[name].files) {
			if best := bestTarget(names, meta, hp.host, hp.path); best != "" && best != name {
				targets.add(best)
			}
		}
		for _, t := range targets.list() {
			if isReferenceEdge(cfg, name, t) {
				out.ref = append(out.ref, [2]string{name, t})
			} else {
				out.real = append(out.real, [2]string{name, t})
			}
		}
	}
	return out
}

// ---- Tarjan SCC + env derivation ----

// Tarjan's strongly-connected components over `adj`, visiting `nodes` in order.
func stronglyConnected(nodes []string, adj map[string]*oset) [][]string {
	idx := 0
	index := map[string]int{}
	low := map[string]int{}
	onStack := map[string]bool{}
	var stack []string
	var comps [][]string
	var strong func(v string)
	strong = func(v string) {
		index[v] = idx
		low[v] = idx
		idx++
		stack = append(stack, v)
		onStack[v] = true
		if a := adj[v]; a != nil {
			for _, w := range a.list() {
				if _, ok := index[w]; !ok {
					strong(w)
					if low[w] < low[v] {
						low[v] = low[w]
					}
				} else if onStack[w] {
					if index[w] < low[v] {
						low[v] = index[w]
					}
				}
			}
		}
		if low[v] == index[v] {
			var comp []string
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				comp = append(comp, w)
				if w == v {
					break
				}
			}
			comps = append(comps, comp)
		}
	}
	for _, v := range nodes {
		if _, ok := index[v]; !ok {
			strong(v)
		}
	}
	return comps
}

type envResolution struct {
	resolved map[string]string
	order    []string // resolution insertion order (unused by callers, kept for determinism)
	warnings []string
}

func (r *envResolution) set(n, e string) {
	if _, ok := r.resolved[n]; !ok {
		r.order = append(r.order, n)
	}
	r.resolved[n] = e
}

// Derive each selected service's run-env from the chain. The selection env seeds the ENTRY
// CLUSTERS (source SCCs); every other service inherits the env-variant its consumer's env file
// actually points at. BFS from the seeds (claim closest to an entry wins); within one file the
// MAJORITY label wins. Disagreements/missing envs/unreached nodes are reported, never silently
// mis-resolved.
func resolveEnvs(cfg *OM, selection []string, selEnv string) *envResolution {
	services := cfg.GetOM("services")
	var names []string
	for _, n := range selection {
		if services.GetOM(n) != nil {
			names = append(names, n)
		}
	}
	res := &envResolution{resolved: map[string]string{}}
	set := map[string]bool{}
	for _, n := range names {
		set[n] = true
	}
	if selEnv == "" || len(names) == 0 {
		return res
	}

	type envMeta struct {
		byEnv map[string]string // env -> first file path
		envs  []string
		identity
	}
	meta := map[string]*envMeta{}
	for _, n := range names {
		p := services.GetOM(n)
		em := &envMeta{byEnv: map[string]string{}, identity: serviceIdentity(p)}
		for _, f := range serviceEnvFiles(p) {
			if _, ok := em.byEnv[f.env]; !ok {
				em.byEnv[f.env] = f.path
				em.envs = append(em.envs, f.env)
			}
		}
		meta[n] = em
	}

	// Best (longest-token) peer a URL points at, plus that peer's env label for the matched host.
	matchURL := func(host, path string) (target, env string, envKnown bool) {
		bestLen := 0
		for _, t := range names {
			for _, tok := range meta[t].tokens {
				if l := tokenMatchLen(host, path, tok); l > bestLen {
					bestLen = l
					target = t
					env, envKnown = meta[t].envOf[strings.ToLower(tok)]
				}
			}
		}
		return
	}

	type claim struct {
		target, env string
		alt         []string
	}
	// Consumer `n`'s claims when running at env `e`: per target, the MAJORITY env-label its file
	// points at (tie -> lexical), with minority labels as `alt`.
	claimsOf := func(n, e string) []claim {
		file, ok := meta[n].byEnv[e]
		if !ok {
			return nil
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return nil
		}
		type envCount struct {
			env   string
			count int
		}
		targetOrder := newOset()
		byT := map[string][]envCount{}
		for _, u := range urlRE.FindAllString(string(data), -1) {
			p := urlHostPath(u)
			if p == nil {
				continue
			}
			target, env, known := matchURL(p.host, p.path)
			if target == "" || target == n || !known {
				continue
			}
			if isReferenceEdge(cfg, n, target) {
				continue // link-back, not a dependency
			}
			targetOrder.add(target)
			found := false
			for i := range byT[target] {
				if byT[target][i].env == env {
					byT[target][i].count++
					found = true
					break
				}
			}
			if !found {
				byT[target] = append(byT[target], envCount{env: env, count: 1})
			}
		}
		var out []claim
		for _, target := range targetOrder.list() {
			envs := append([]envCount(nil), byT[target]...)
			sort.SliceStable(envs, func(a, b int) bool {
				if envs[a].count != envs[b].count {
					return envs[a].count > envs[b].count
				}
				return envs[a].env < envs[b].env
			})
			c := claim{target: target, env: envs[0].env}
			for _, x := range envs[1:] {
				c.alt = append(c.alt, x.env)
			}
			out = append(out, c)
		}
		return out
	}

	// Structural edges (scan ALL of a consumer's env files) for SCC/entry detection.
	adj := map[string]*oset{}
	for _, n := range names {
		adj[n] = newOset()
	}
	for _, n := range names {
		for _, e := range meta[n].envs {
			for _, c := range claimsOf(n, e) {
				if set[c.target] {
					adj[n].add(c.target)
				}
			}
		}
	}

	// Entry clusters = source SCCs (no inbound edge from another component).
	comps := stronglyConnected(names, adj)
	compOf := map[string]int{}
	for i, comp := range comps {
		for _, n := range comp {
			compOf[n] = i
		}
	}
	inbound := make([]bool, len(comps))
	for _, n := range names {
		for _, t := range adj[n].list() {
			if compOf[n] != compOf[t] {
				inbound[compOf[t]] = true
			}
		}
	}

	var q []string
	hasEnv := func(n, e string) bool {
		for _, x := range meta[n].envs {
			if x == e {
				return true
			}
		}
		return false
	}
	seed := func(n, note string) {
		res.set(n, selEnv)
		q = append(q, n)
		if !hasEnv(n, selEnv) {
			res.warnings = append(res.warnings, fmt.Sprintf("%s: no '%s' env file — running %s anyway", n, selEnv, selEnv))
		}
		if note != "" {
			res.warnings = append(res.warnings, note)
		}
	}
	// BFS from the current seeds; first claim wins (closest to an entry); disagreements warned.
	drain := func() {
		for len(q) > 0 {
			n := q[0]
			q = q[1:]
			for _, c := range claimsOf(n, res.resolved[n]) {
				if !set[c.target] {
					continue
				}
				if len(c.alt) > 0 {
					res.warnings = append(res.warnings, fmt.Sprintf("%s: %s@%s points at %s (also %s) — dirty?", c.target, n, res.resolved[n], c.env, strings.Join(c.alt, ",")))
				}
				if cur, ok := res.resolved[c.target]; !ok {
					res.set(c.target, c.env)
					q = append(q, c.target)
				} else if cur != c.env {
					res.warnings = append(res.warnings, fmt.Sprintf("%s: keeping %s (closer to entry) vs %s from %s", c.target, cur, c.env, n))
				}
			}
		}
	}

	// Primary entries: source SCCs. Seed at selEnv, derive.
	for i, comp := range comps {
		if !inbound[i] {
			for _, n := range comp {
				seed(n, "")
			}
		}
	}
	drain()

	// Any node still unreached is the entry of its OWN subtree. Seed the most-upstream unreached
	// node(s) at selEnv and keep deriving; repeat until everything has an env.
	for {
		var un []string
		for _, n := range names {
			if _, ok := res.resolved[n]; !ok {
				un = append(un, n)
			}
		}
		if len(un) == 0 {
			break
		}
		var tops []string
		for _, n := range un {
			hasUp := false
			for _, m := range un {
				if m != n && adj[m].has(n) {
					hasUp = true
					break
				}
			}
			if !hasUp {
				tops = append(tops, n)
			}
		}
		if len(tops) == 0 {
			tops = []string{un[0]}
		}
		for _, n := range tops {
			seed(n, fmt.Sprintf("%s: no upstream consumer selected — running as entry at %s", n, selEnv))
		}
		drain()
	}
	return res
}

// ---- task resolution: tasks[task] -> skip; strict placeholders ----

type runnableCmd struct {
	name     string
	service  *OM
	template string
	task     string
	values   map[string]string
	resolved string
	envFile  string
}

type runResolution struct {
	runnable []*runnableCmd
	skipped  []string
	warnings []string
}

func resolveRun(cfg *OM, task string, members []member, args []string) *runResolution {
	var runnable []*runnableCmd
	var skipped []string
	for i := range members {
		m := &members[i]
		t := m.task
		if t == "" {
			t = task
		}
		tasks := m.service.GetOM("tasks")
		var template string
		if tasks != nil && tasks.Get(t) != nil {
			template = anyToStr(tasks.Get(t))
		} else {
			skipped = append(skipped, m.name)
			continue
		}
		runnable = append(runnable, &runnableCmd{name: m.name, service: m.service, template: template, task: t})
	}
	if len(runnable) == 0 {
		fail("no service in target can run task '%s' (all run-less for this task)", task)
	}

	// Reserved placeholders crew fills itself: {task} + {envfile}.
	reserved := map[string]bool{"task": true, "envfile": true}
	union := newOset()
	for _, r := range runnable {
		for _, p := range placeholdersIn(r.template) {
			if !reserved[p] {
				union.add(p)
			}
		}
	}

	// Parse user args: key=value fills {key}; bare positional fills a remaining one.
	keyVals := map[string]string{}
	keyOrder := newOset()
	var positionals []string
	kvRE := regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	for _, a := range args {
		eq := strings.Index(a, "=")
		if eq > 0 && kvRE.MatchString(a[:eq]) {
			keyVals[a[:eq]] = a[eq+1:]
			keyOrder.add(a[:eq])
		} else {
			positionals = append(positionals, a)
		}
	}

	// Unknown key=value: collect a warning and skip, don't abort.
	var argWarnings []string
	var unknown []string
	for _, k := range keyOrder.list() {
		if k == "env" { // required start parameter — a command without {env} is fine, not a user mistake
			continue
		}
		if !union.has(k) {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		takes := strings.Join(union.list(), ", ")
		if takes == "" {
			takes = "(none)"
		}
		argWarnings = append(argWarnings, fmt.Sprintf("ignoring unused argument(s): %s. Task '%s' takes: %s", strings.Join(unknown, ", "), task, takes))
	}

	var remaining []string
	for _, k := range union.list() {
		if _, ok := keyVals[k]; !ok {
			remaining = append(remaining, k)
		}
	}
	sort.Strings(remaining)
	if len(positionals) > len(remaining) {
		list := strings.Join(remaining, ", ")
		if list == "" {
			list = "(none)"
		}
		fail("too many positional args (%d) for %d unfilled placeholder(s): %s", len(positionals), len(remaining), list)
	}

	values := map[string]string{"task": task}
	for k, v := range keyVals {
		values[k] = v
	}
	for i, k := range remaining {
		if i < len(positionals) {
			values[k] = positionals[i]
		}
	}

	// Per-service value set: {env} is DERIVED from the chain (resolveEnvs); everything else shared.
	var derived *envResolution
	if _, hasEnv := values["env"]; hasEnv {
		var names []string
		for _, m := range members {
			names = append(names, m.name)
		}
		derived = resolveEnvs(cfg, names, values["env"])
	} else {
		derived = &envResolution{resolved: map[string]string{}}
	}
	unresolved := newOset()
	for _, r := range runnable {
		vals := map[string]string{}
		for k, v := range values {
			vals[k] = v
		}
		if env, ok := derived.resolved[r.name]; ok {
			vals["env"] = env
		}
		vals["task"] = r.task // {task} resolves per-member (start/debug)
		r.values = vals
		for _, p := range placeholdersIn(r.template) {
			if !reserved[p] {
				if _, ok := vals[p]; !ok {
					unresolved.add(p)
				}
			}
		}
		// Only demand env-path placeholders when the command actually sources {envfile}.
		if r.service.GetStr("env") != "" && strings.Contains(r.template, "{envfile}") {
			for _, p := range placeholdersIn(r.service.GetStr("env")) {
				if !reserved[p] {
					if _, ok := vals[p]; !ok {
						unresolved.add(p)
					}
				}
			}
		}
	}
	if unresolved.size() > 0 {
		fail("unresolved placeholder(s): %s. Provide as a positional or key=value.", strings.Join(unresolved.list(), ", "))
	}

	for _, r := range runnable {
		r.resolved = substitute(r.template, r.values) // {envfile} left intact for cmdStart
		// Resolve the base env-file path with the same values — raw (no shell quoting).
		if envTmpl := r.service.GetStr("env"); envTmpl != "" {
			r.envFile = placeholderRE.ReplaceAllStringFunc(envTmpl, func(m string) string {
				k := m[1 : len(m)-1]
				if v, ok := r.values[k]; ok {
					return v
				}
				return m
			})
		}
	}
	return &runResolution{runnable: runnable, skipped: skipped, warnings: append(argWarnings, derived.warnings...)}
}

// ---- guards ----

type guardSpec struct {
	name, command, comment, message string
}

// The target's guard specs, deduped by name. Errors if any referenced guard is undefined.
func collectGuards(cfg *OM, names []string, services func(string) *OM) []guardSpec {
	registry := cfg.GetOM("guards")
	order := newOset()
	for _, n := range names {
		svc := services(n)
		if svc == nil {
			continue
		}
		if gl, ok := StrArr(svc.Get("guards")); ok {
			for _, gn := range gl {
				order.add(gn)
			}
		}
	}
	var undef []string
	for _, n := range order.list() {
		g := registry.GetOM(n)
		if g == nil || g.GetStr("command") == "" {
			undef = append(undef, n)
		}
	}
	if len(undef) > 0 {
		fail("undefined guard(s): %s. Define them with: crew guards add", strings.Join(undef, ", "))
	}
	var out []guardSpec
	for _, n := range order.list() {
		g := registry.GetOM(n)
		msg := g.GetStr("message")
		if msg == "" {
			msg = "guard failed"
		}
		out = append(out, guardSpec{name: n, command: g.GetStr("command"), comment: g.GetStr("comment"), message: msg})
	}
	return out
}

func runGuardCommand(command string) bool {
	cmd := exec.Command("/bin/sh", "-c", command)
	return cmd.Run() == nil
}

// Non-interactive path: run the guards now, print the ✓/✗ block, abort on any failure.
func runGuards(cfg *OM, names []string, services func(string) *OM) {
	specs := collectGuards(cfg, names, services)
	if len(specs) == 0 {
		return
	}
	results := make([]bool, len(specs))
	done := make(chan int, len(specs))
	for i := range specs {
		go func(i int) {
			results[i] = runGuardCommand(specs[i].command)
			done <- i
		}(i)
	}
	for range specs {
		<-done
	}
	fmt.Println(cDim("guards:"))
	failed := 0
	for i, g := range specs {
		note := ""
		if g.comment != "" {
			note = "  " + faint(g.comment)
		}
		if results[i] {
			fmt.Printf("  %s %s%s\n", cGreen("✓"), g.name, note)
		} else {
			failed++
			fmt.Printf("  %s %s%s\n", cRed("✗"), g.name, note)
			fmt.Printf("      %s\n", cRed(g.message))
		}
	}
	if failed > 0 {
		word := "guard"
		if failed > 1 {
			word = "guards"
		}
		fail("%s failed — nothing started.", word)
	}
}

// ---- local service wiring ----

type wireResult struct {
	cleanup  func()
	warnings []string
}

// For each runnable whose command uses {envfile}, load its base env, rewrite any URL pointing at
// a CO-RUNNING peer to that peer's `local`, apply env overrides, and materialize a FRESH temp
// file per run. {envfile} in the command is replaced with the temp path.
func wireRun(userPath string, runnable []*runnableCmd, members []member, overrides *OM, overridesOff *OM) wireResult {
	var peers []wirePeer
	for _, m := range members {
		local := m.service.GetStr("local")
		if local == "" {
			continue
		}
		origin := originOf(local)
		if origin == "" {
			origin = local
		}
		peers = append(peers, wirePeer{name: m.name, tokens: serviceIdentity(m.service).tokens, origin: origin, local: local})
	}
	tmpDir := filepath.Join(crewHomeFor(userPath), "tmp")
	var tempPaths []string
	var warnings []string
	var running []string
	for _, r := range runnable {
		running = append(running, r.name)
	}
	for _, r := range runnable {
		if !strings.Contains(r.resolved, "{envfile}") {
			continue
		}
		if r.envFile == "" {
			fail("service '%s' uses {envfile} but has no \"env\" field in config", r.name)
		}
		basePath := filepath.Join(serviceDir(r.service), r.envFile)
		if !pathExists(basePath) {
			fail("service '%s': env file not found: %s", r.name, basePath)
		}
		var myPeers []wirePeer
		for _, p := range peers {
			if p.name != r.name {
				myPeers = append(myPeers, p)
			}
		}
		var off []string
		if arr, ok := StrArr(overridesOff.Get(r.name)); ok {
			off = arr
		}
		overrideVars := overrideVarsFor(overrides, r.name, running, off)
		data, err := os.ReadFile(basePath)
		if err != nil {
			fail("service '%s': cannot read env file %s: %s", r.name, basePath, err.Error())
		}
		// Normalize CRLF/CR -> LF so `. {envfile}` doesn't choke on ^M.
		baseText := regexp.MustCompile("\r\n?").ReplaceAllString(string(data), "\n")
		_ = os.MkdirAll(tmpDir, 0o755)
		out := filepath.Join(tmpDir, sanitize(r.name)+".env")
		wired, _, ovWarnings := applyEnvOverridesText(wireText(baseText, myPeers), overrideVars)
		for _, w := range ovWarnings {
			warnings = append(warnings, r.name+": "+w)
		}
		_ = os.WriteFile(out, []byte(wired), 0o644)
		tempPaths = append(tempPaths, out)
		r.resolved = strings.ReplaceAll(r.resolved, "{envfile}", shellQuote(out))
	}
	return wireResult{
		cleanup: func() {
			for _, p := range tempPaths {
				_ = os.Remove(p)
			}
		},
		warnings: warnings,
	}
}

func applyEnvOverridesText(text string, vars *OM) (string, []string, []string) {
	return applyEnvOverrides(text, vars)
}

// A stable id for a selection: sorted member names joined.
// A SHORT, readable title for the opened workspace: strips the `xxx-` prefix all picked services
// share, shows the first `cap` names, appends `+Nmore` for the rest.
func workspaceLabel(members []member, cap int) string {
	var names []string
	for _, m := range members {
		names = append(names, m.name)
	}
	sort.Strings(names)
	if len(names) == 0 {
		return "workspace"
	}
	prefix := ""
	if len(names) > 1 {
		parts := strings.Split(names[0], "-")
		for i := 1; i < len(parts); i++ {
			cand := strings.Join(parts[:i], "-") + "-"
			all := true
			for _, n := range names {
				if !strings.HasPrefix(n, cand) || len(n) <= len(cand) {
					all = false
					break
				}
			}
			if all {
				prefix = cand
			} else {
				break
			}
		}
	}
	short := make([]string, len(names))
	for i, n := range names {
		short[i] = sanitize(n[len(prefix):])
	}
	headN := cap
	if headN > len(short) {
		headN = len(short)
	}
	head := strings.Join(short[:headN], "+")
	extra := ""
	if len(short) > cap {
		extra = fmt.Sprintf("+%dmore", len(short)-cap)
	}
	if head+extra == "" {
		return "workspace"
	}
	return head + extra
}

// ---- folder detection (config editor prefill) ----

type detected struct {
	typ, env, local, start string
}

// Derive a service's fields from the folder on disk (best-effort). `match` is deliberately not
// derived — the guess was too weak, so the user always fills it by hand.
func detectService(abs string) detected {
	rd := func(rel string) string {
		b, err := os.ReadFile(filepath.Join(abs, rel))
		if err != nil {
			return ""
		}
		return string(b)
	}
	isFile := func(rel string) bool {
		fi, err := os.Stat(filepath.Join(abs, rel))
		return err == nil && fi.Mode().IsRegular()
	}
	ls := func(rel string) []string {
		entries, err := os.ReadDir(filepath.Join(abs, rel))
		if err != nil {
			return nil
		}
		var out []string
		for _, e := range entries {
			out = append(out, e.Name())
		}
		return out
	}
	var pkg *OM
	if txt := rd("package.json"); txt != "" {
		if v, err := ParseJSON([]byte(txt)); err == nil {
			pkg, _ = v.(*OM)
		}
	}
	deps := NewOM()
	if pkg != nil {
		if d := pkg.GetOM("dependencies"); d != nil {
			for _, k := range d.Keys() {
				deps.Set(k, d.Get(k))
			}
		}
		if d := pkg.GetOM("devDependencies"); d != nil {
			for _, k := range d.Keys() {
				deps.Set(k, d.Get(k))
			}
		}
	}
	scripts := pkg.GetOM("scripts")

	front := []string{"react", "vue", "next", "nuxt", "@angular/core", "vite", "svelte", "gatsby", "solid-js", "preact"}
	typ := ""
	hasFront := false
	for _, d := range front {
		if deps.Has(d) {
			hasFront = true
			break
		}
	}
	if hasFront || isFile("index.html") || isFile("public/index.html") {
		typ = "frontend"
	} else {
		backendMarkers := []string{"go.mod", "manage.py", "pyproject.toml", "requirements.txt", "Gemfile", "pom.xml", "Cargo.toml", "composer.json"}
		hasBackend := pkg != nil
		for _, m := range backendMarkers {
			if isFile(m) {
				hasBackend = true
				break
			}
		}
		if hasBackend {
			typ = "backend"
		}
	}

	var envNames []string
	for _, f := range ls(".envs") {
		if f != ".gitkeep" && isFile(filepath.Join(".envs", f)) {
			envNames = append(envNames, f)
		}
	}
	env := ""
	var envTexts []string
	for _, f := range envNames {
		envTexts = append(envTexts, rd(filepath.Join(".envs", f)))
	}
	envText := strings.Join(envTexts, "\n")
	if len(envNames) > 0 {
		cp := func(a, b string) string {
			i := 0
			for i < len(a) && i < len(b) && a[i] == b[i] {
				i++
			}
			return a[:i]
		}
		rev := func(s string) string {
			r := []rune(s)
			for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
				r[i], r[j] = r[j], r[i]
			}
			return string(r)
		}
		pre := envNames[0]
		for _, n := range envNames[1:] {
			pre = cp(pre, n)
		}
		suf := rev(envNames[0])
		for _, n := range envNames[1:] {
			suf = cp(suf, rev(n))
		}
		suf = rev(suf)
		pre = regexp.MustCompile(`[^/._-]*$`).ReplaceAllString(pre, "")
		suf = regexp.MustCompile(`^[^/._-]*`).ReplaceAllString(suf, "")
		anyLabel := false
		for _, s := range envNames {
			end := len(s) - len(suf)
			if end <= len(pre) {
				end = len(s)
			}
			if len(s[len(pre):end]) > 0 && end > len(pre) {
				anyLabel = true
			}
		}
		if anyLabel {
			env = ".envs/" + pre + "{env}" + suf
		} else {
			env = ".envs/" + envNames[0]
		}
	}

	port := ""
	if m := regexp.MustCompile(`(?:^|\n)\s*(?:export\s+)?PORT\s*=\s*(\d{2,5})`).FindStringSubmatch(envText); m != nil {
		port = m[1]
	}
	if port == "" && scripts != nil {
		for _, k := range scripts.Keys() {
			if m := regexp.MustCompile(`(?:--port|-p)[ =](\d{2,5})`).FindStringSubmatch(anyToStr(scripts.Get(k))); m != nil {
				port = m[1]
				break
			}
		}
	}
	if port == "" {
		cfgTxt := rd("vite.config.ts")
		if cfgTxt == "" {
			cfgTxt = rd("vite.config.js")
		}
		if cfgTxt == "" {
			cfgTxt = rd("next.config.js")
		}
		if m := regexp.MustCompile(`port\s*[:=]\s*(\d{2,5})`).FindStringSubmatch(cfgTxt); m != nil {
			port = m[1]
		}
	}
	if port == "" {
		if deps.Has("next") || deps.Has("react-scripts") {
			port = "3000"
		} else if deps.Has("vite") {
			port = "5173"
		}
	}
	local := ""
	if port != "" {
		local = "http://localhost:" + port
	}

	start := ""
	if scripts != nil {
		cand := ""
		prefRE := regexp.MustCompile(`^(dev|start|serve)[:.]`)
		for _, k := range scripts.Keys() {
			if prefRE.MatchString(k) {
				cand = k
				break
			}
		}
		if cand == "" {
			for _, k := range []string{"dev", "start", "serve"} {
				if scripts.Has(k) {
					cand = k
					break
				}
			}
		}
		if cand != "" {
			cmd := regexp.MustCompile(`(?:\./)?\.envs/\S+`).ReplaceAllString(anyToStr(scripts.Get(cand)), "{envfile}")
			sufTok := ""
			if idx := strings.IndexAny(cand, ":."); idx >= 0 {
				parts := strings.FieldsFunc(cand, func(r rune) bool { return r == ':' || r == '.' })
				sufTok = parts[len(parts)-1]
			}
			if sufTok != "" {
				cmd = regexp.MustCompile(`\b`+escapeRE(sufTok)+`\b`).ReplaceAllString(cmd, "{env}")
			}
			start = cmd
		}
	}
	return detected{typ: typ, env: env, local: local, start: start}
}

