package crew

// crew MCP — a READ-ONLY MCP server (stdio JSON-RPC 2.0) that a development copilot uses to
// observe a running crew slice: services/graph/config_get (read the config + wiring) and
// status/logs (inspect the live run). It has NO write or lifecycle tools — the human owns
// start/stop/config via crew's own CLI + viewer. Launched by `crew start` when the user summons
// the agent split; the current run is passed in CREW_RUN_ID so status/logs default to it.
//
// stdout is the JSON-RPC channel in mcp mode — NOTHING but protocol frames may go there.

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

func envBytes(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// ==================== tools ====================

// services() — the discovery tool: what exists, what's runnable, how it's wired. An agent calls
// this FIRST (it has no other way to learn service names).
func toolServices(flags *Flags) *OM {
	m := loadMerged(flags)
	services := m.cfg.GetOM("services")
	out := NewOM()
	var last []any
	for _, n := range loadLastSelection(flags) {
		if services.GetOM(n) != nil {
			last = append(last, n)
		}
	}
	var lastDbg []any
	for _, n := range loadLastDebug(flags) {
		if services.GetOM(n) != nil {
			lastDbg = append(lastDbg, n)
		}
	}
	// The previous run's slice + debug set — surfaced so an agent can OFFER it to the user
	// ("repeat the last run, or pick a new slice?"). An offer to make, never a default to assume.
	out.Set("lastSelection", orEmptyArr(last))
	out.Set("lastDebug", orEmptyArr(lastDbg))
	var list []any
	for _, name := range services.Keys() {
		s := services.GetOM(name)
		present := false
		func() {
			defer func() { recover() }()
			present = pathExists(resolveServicePath(s.GetStr("path")))
		}()
		tasks := s.GetOM("tasks")
		guards, _ := StrArr(s.Get("guards"))
		var envs []any
		if match := s.GetOM("match"); match != nil {
			for _, e := range match.Keys() {
				envs = append(envs, e)
			}
		}
		row := NewOM()
		row.Set("name", name)
		row.Set("type", nullable(s.GetStr("type")))
		row.Set("local", nullable(s.GetStr("local")))
		row.Set("folderPresent", present) // absent folder => excluded from start
		row.Set("canStart", present && tasks.Get("start") != nil)
		row.Set("canDebug", present && tasks.Get("debug") != nil)
		row.Set("guards", orEmptyArr(toAnyArr(guards)))
		row.Set("envs", orEmptyArr(envs)) // env labels it's deployed under
		list = append(list, row)
	}
	out.Set("services", orEmptyArr(list))
	return out
}

// graph(env?) — dependencies as DATA (the drawing stays a human surface). references = link-backs
// into frontends: shown to humans but excluded from connectivity/env-derivation. With `env`, adds
// each service's derived env for that selection env.
func toolGraph(flags *Flags, args *OM) *OM {
	m := loadMerged(flags)
	ge := collectGraphEdges(m.cfg)
	env := args.GetStr("env")
	out := NewOM()
	out.Set("services", orEmptyArr(toAnyArr(ge.nodes)))
	edgeRows := func(pairs [][2]string) []any {
		var rows []any
		for _, e := range pairs {
			rows = append(rows, om("from", e[0], "to", e[1]))
		}
		return rows
	}
	out.Set("dependencies", orEmptyArr(edgeRows(ge.real)))
	out.Set("references", orEmptyArr(edgeRows(ge.ref)))
	if env != "" {
		d := resolveEnvs(m.cfg, ge.nodes, env)
		resolved := NewOM()
		for _, n := range ge.nodes {
			e, ok := d.resolved[n]
			if !ok {
				e = env
			}
			resolved.Set(n, e)
		}
		out.Set("resolved", resolved)
		if len(d.warnings) > 0 {
			out.Set("warnings", toAnyArr(d.warnings))
		}
	}
	return out
}

// config_get(kind?, name?) — read the stored config: everything, or one service/guard. Returns the
// COMMITTABLE shape (what config.json holds).
func toolConfigGet(flags *Flags, args *OM) *OM {
	uc := loadUserConfig(flags)
	kind, name := args.GetStr("kind"), args.GetStr("name")
	if kind == "service" {
		svc := uc.cfg.GetOM("services").GetOM(name)
		if name == "" || svc == nil {
			fail("unknown service '%s'", name)
		}
		wrap := NewOM()
		wrap.Set(name, svc)
		out := om("service", wrap)
		if ov := uc.cfg.GetOM("overrides").GetOM(name); ov != nil {
			out.Set("overrides", ov)
		} else {
			out.Set("overrides", nil)
		}
		return out
	}
	if kind == "guard" {
		g := uc.cfg.GetOM("guards").GetOM(name)
		if name == "" || g == nil {
			fail("unknown guard '%s'", name)
		}
		wrap := NewOM()
		wrap.Set(name, g)
		return om("guard", wrap)
	}
	return om("path", uc.path, "config", uc.cfg)
}

func toolStatus(flags *Flags, args *OM) *OM {
	m := loadMerged(flags)
	reg := readReg(m.userPath, currentRunID(m.userPath, args.GetStr("runId")))
	var rows []any
	running := false
	for _, s := range reg.Services {
		alive := pidAlive(s.Pid)
		running = running || alive
		rows = append(rows, om("name", s.Name, "alive", alive))
	}
	out := om("runId", reg.RunID, "env", reg.Env)
	out.Set("running", running)
	out.Set("startedAt", jsonNum(int(reg.StartedAt)))
	if reg.StoppedAt > 0 {
		out.Set("stoppedAt", jsonNum(int(reg.StoppedAt)))
	}
	out.Set("services", orEmptyArr(rows))
	return out
}

// logs(runId?, service?, lines?, grep?, context?, cursor?) — tail the captured
// output, token-frugally and without ever loading a huge file whole:
//   - reads are BYTE-CAPPED: without a cursor only the tail of each file is read; with a cursor at
//     most a capped span from it (a bigger gap is skipped with a marker line)
//   - `grep` keeps lines containing ANY |-separated term, case-insensitive — the same OR semantics
//     as the live viewer's `/` search
//   - `context` includes N lines around each match (grep -C), gaps marked `···`
//   - `cursor` (returned as `nextCursor`) makes repeat reads INCREMENTAL — only new lines since.
func readLogSlice(file string, from int64, tailBytes, readCap int64) (lines []string, end int64, note string) {
	fi, err := os.Stat(file)
	if err != nil {
		return nil, 0, ""
	}
	size := fi.Size()
	start := size - tailBytes
	if from >= 0 {
		start = from
		if start > size {
			start = size
		}
	}
	if start < 0 {
		start = 0
	}
	var skipped int64
	if size-start > readCap {
		skipped = size - readCap - start
		start = size - readCap
	}
	if start >= size {
		return nil, size, ""
	}
	f, err := os.Open(file)
	if err != nil {
		return nil, size, ""
	}
	defer f.Close()
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil && len(buf) == 0 {
		return nil, size, ""
	}
	lines = strings.Split(string(buf), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" { // the file's final newline is not a line
		lines = lines[:len(lines)-1]
	}
	// A tail-window or cap-jump cut lands mid-line -> drop the partial first line. A CURSOR read
	// starts exactly where the last read ended (a line boundary) — never drop there.
	cut := skipped > 0 || (from < 0 && start > 0)
	if cut {
		lines = lines[1:]
		gap := skipped
		if gap == 0 {
			gap = start
		}
		// Returned SEPARATELY (not as a line) so a grep can't silently swallow it.
		note = fmt.Sprintf("··· earlier output not read (%d bytes before this window) ···", gap)
	}
	return lines, size, note
}

// currentRunID resolves the run a read tool operates on: the explicit arg, else the session run
// crew start put in CREW_RUN_ID, else (last resort) the newest registered run.
func currentRunID(userPath, arg string) string {
	if arg != "" {
		return arg
	}
	if id := os.Getenv("CREW_RUN_ID"); id != "" {
		return id
	}
	ids := listRunIds(userPath)
	if len(ids) > 0 {
		return ids[len(ids)-1]
	}
	fail("no run to read — start one with `crew start`")
	return ""
}

func toolLogs(flags *Flags, args *OM) *OM {
	m := loadMerged(flags)
	runID := currentRunID(m.userPath, args.GetStr("runId"))
	reg := readReg(m.userPath, runID)
	tailBytes := int64(envBytes("CREW_LOG_TAIL_BYTES", 512*1024))
	readCap := int64(envBytes("CREW_LOG_READ_CAP", 4*1024*1024))
	n := 100
	if num, ok := args.Get("lines").(json.Number); ok {
		if v, err := num.Int64(); err == nil && v > 0 {
			n = int(v)
		}
	}
	grep := args.GetStr("grep")
	var terms []string
	if grep != "" {
		for _, t := range strings.Split(strings.ToLower(grep), "|") {
			if t = strings.TrimSpace(t); t != "" {
				terms = append(terms, t)
			}
		}
	}
	ctx := 0
	if num, ok := args.Get("context").(json.Number); ok {
		if v, err := num.Int64(); err == nil && v > 0 {
			ctx = int(v)
			if ctx > 10 {
				ctx = 10
			}
		}
	}
	from := args.GetOM("cursor")
	service := args.GetStr("service")
	pick := reg.Services
	// A guard-blocked run has a guards log but no live services — expose it as a pseudo-service
	// "guards" so an unfiltered read (or `service:"guards"`) surfaces WHY nothing started.
	if _, err := os.Stat(runLogPath(m.userPath, runID, guardsLogName)); err == nil {
		pick = append([]runSvc{{Name: "guards"}}, pick...)
	}
	if service != "" {
		want := service
		pick = nil
		for _, s := range reg.Services {
			if s.Name == want {
				pick = append(pick, s)
			}
		}
		if want == "guards" {
			pick = []runSvc{{Name: "guards"}}
		}
	}
	logs := NewOM()
	nextCursor := NewOM()
	if from != nil {
		for _, k := range from.Keys() {
			nextCursor.Set(k, from.Get(k))
		}
	}
	for _, s := range pick {
		fromOff := int64(-1)
		if num, ok := from.Get(s.Name).(json.Number); ok {
			if v, err := num.Int64(); err == nil && v > 0 {
				fromOff = v
			}
		}
		logName := s.Name
		if s.Name == "guards" {
			logName = guardsLogName // the reserved _guards.log
		}
		all, end, note := readLogSlice(runLogPath(m.userPath, runID, logName), fromOff, tailBytes, readCap)
		nextCursor.Set(s.Name, json.Number(strconv.FormatInt(end, 10)))
		var out []string
		if len(terms) > 0 {
			hit := func(l string) bool {
				low := strings.ToLower(l)
				for _, t := range terms {
					if strings.Contains(low, t) {
						return true
					}
				}
				return false
			}
			if ctx > 0 {
				// grep -C: merge ±ctx windows around each match; mark gaps with `···`
				keep := map[int]bool{}
				for i, l := range all {
					if hit(l) {
						lo, hi := i-ctx, i+ctx
						if lo < 0 {
							lo = 0
						}
						if hi > len(all)-1 {
							hi = len(all) - 1
						}
						for j := lo; j <= hi; j++ {
							keep[j] = true
						}
					}
				}
				var idxs []int
				for i := range keep {
					idxs = append(idxs, i)
				}
				sort.Ints(idxs)
				prev := -2
				for _, i := range idxs {
					if i > prev+1 && len(out) > 0 {
						out = append(out, "···")
					}
					out = append(out, all[i])
					prev = i
				}
			} else {
				for _, l := range all {
					if hit(l) {
						out = append(out, l)
					}
				}
			}
		} else {
			out = all
		}
		if len(out) > n {
			out = out[len(out)-n:]
		}
		if note != "" {
			out = append([]string{note}, out...) // survives any grep: the agent always learns the window was capped
		}
		logs.Set(s.Name, strings.Join(out, "\n"))
	}
	return om("runId", runID, "logs", logs, "nextCursor", nextCursor)
}

func om(kv ...any) *OM {
	o := NewOM()
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func orEmptyArr(a []any) []any {
	if a == nil {
		return []any{}
	}
	return a
}
