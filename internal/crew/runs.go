package crew

// Per-run registry + per-service log files — the persistence behind `crew start` and the
// read-only MCP tools. A run is <crewHome>/runs/<runId>.json (services + pids) with per-service
// logs in <crewHome>/runs/<runId>/<name>.log (tee'd from the live viewer).

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

func runsDir(userPath string) string     { return filepath.Join(crewHomeFor(userPath), "runs") }
func regPath(userPath, id string) string { return filepath.Join(runsDir(userPath), id+".json") }
func runLogPath(userPath, id, name string) string {
	return filepath.Join(runsDir(userPath), id, sanitize(name)+".log")
}

// guardsLogName is the reserved per-run log for guard pass/fail — read by `logs` so the agent can
// explain a guard-BLOCKED run (services never started). Leading underscore avoids a service clash.
const guardsLogName = "_guards"

type runSvc struct {
	Name string `json:"name"`
	Pid  int    `json:"pid"`
	Pgid int    `json:"pgid"`
}

type runReg struct {
	RunID     string   `json:"runId"`
	Env       string   `json:"env"`
	StartedAt int64    `json:"startedAt"`
	Services  []runSvc `json:"services"`
	StoppedAt int64    `json:"stoppedAt,omitempty"`
}

func readReg(userPath, id string) *runReg {
	data, err := os.ReadFile(regPath(userPath, id))
	if err != nil {
		fail("no such run: %s", id)
	}
	var reg runReg
	if json.Unmarshal(data, &reg) != nil {
		fail("no such run: %s", id)
	}
	return &reg
}

func writeReg(userPath string, reg *runReg) {
	data, _ := json.MarshalIndent(reg, "", "  ")
	_ = os.WriteFile(regPath(userPath, reg.RunID), data, 0o644)
}

func listRunIds(userPath string) []string {
	entries, err := os.ReadDir(runsDir(userPath))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			out = append(out, strings.TrimSuffix(e.Name(), ".json"))
		}
	}
	sort.Strings(out)
	return out
}

// pid 0 (a registered-but-never-spawned service, e.g. a guard-blocked run) is NOT alive — and
// kill(0,…) targets the caller's whole process group, so it must be guarded explicitly.
func pidAlive(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }


func jsonNum(n int) json.Number { return json.Number(fmt.Sprintf("%d", n)) }

// compactJSON — one-line JSON for the MCP wire (MarshalJSON is the pretty 2-space writer).
func compactJSON(v any) string {
	var b strings.Builder
	writeCompact(&b, v)
	return b.String()
}

func writeCompact(b *strings.Builder, v any) {
	switch t := v.(type) {
	case *OM:
		b.WriteString("{")
		for i, k := range t.Keys() {
			if i > 0 {
				b.WriteString(",")
			}
			b.WriteString(scalarJSON(k) + ":")
			writeCompact(b, t.Get(k))
		}
		b.WriteString("}")
	case []any:
		b.WriteString("[")
		for i, x := range t {
			if i > 0 {
				b.WriteString(",")
			}
			writeCompact(b, x)
		}
		b.WriteString("]")
	case json.Number:
		b.WriteString(t.String())
	case nil:
		b.WriteString("null")
	default:
		b.WriteString(scalarJSON(v))
	}
}
