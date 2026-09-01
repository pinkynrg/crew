package crew

// `crew start` — crew's one core run command. Picks a co-running set (multiselect graph
// selector), wires their env, gates on guards, then STREAMS them (kill-others on first exit /
// Ctrl-C, interactive log viewer on a TTY). Per-node `d` debug toggle swaps a member to its
// `tasks.debug`. `crew workspace` reuses the picker to open the set instead.

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func cmdStart(flags *Flags, rest []string) {
	m := loadMerged(flags)
	warnMissing(m.cfg)       // heads-up about broken paths...
	cfg := presentCfg(m.cfg) // ...then run on only the services whose folder exists
	if cfg.GetOM("services").Len() == 0 {
		emptyServicesState("Nothing to start — no service folders found.")
		osExit(1)
	}
	var args, bare []string
	for _, a := range rest {
		if strings.Contains(a, "=") {
			args = append(args, a)
		} else {
			bare = append(bare, a)
		}
	}
	if len(bare) > 0 {
		warn(fmt.Sprintf("ignoring '%s' — services are chosen in the picker", strings.Join(bare, " ")))
	}
	envArg := ""
	hasEnvArg := false
	for _, a := range args {
		if strings.HasPrefix(a, "env=") {
			envArg = a[4:]
			hasEnvArg = true
			break
		}
	}
	// start must know the base env unselected services point at; require it up front.
	if !hasEnvArg {
		fail("crew start needs an environment (what unselected services point at) — e.g. crew start env=pre")
	}
	members := selectMembers(flags, cfg, selectOpts{selEnv: envArg, hasSelEnv: true, debugToggle: true})
	if members == nil {
		return
	}
	validateMemberPaths(members)

	res := resolveRun(cfg, "start", members, args)

	// Materialize wired env files (fills {envfile}); fresh per run, cleaned up after. Overrides:
	// shared (config) + per-user/secret (local.json), local wins.
	overrides := mergeOverrides(cfg.GetOM("overrides"), loadMachine(flags).GetOM("overrides"))
	overridesOff := loadOverridesOff(flags)
	wire := wireRun(m.userPath, res.runnable, members, overrides, overridesOff)

	interactive := canInteractive()
	// Skips + warnings: when the interactive viewer owns the alternate screen, printing these to
	// the MAIN screen would leave scrollback residue once the viewer exits. So in interactive
	// mode feed them INTO the viewer as notice rows; otherwise print inline.
	allWarnings := append(append([]string{}, res.warnings...), wire.warnings...)
	var notices []string
	for _, s := range res.skipped {
		notices = append(notices, fmt.Sprintf("skipping %s (no task 'start')", s))
	}
	notices = append(notices, allWarnings...)
	if !interactive {
		for _, s := range res.skipped {
			fmt.Printf("skipping %s (no task 'start')\n", s)
		}
		for _, wn := range allWarnings {
			warn(wn)
		}
	}
	// Guards gate the run. Interactive: runFanout runs them as live rows inside the viewer and
	// gates the spawn. Non-interactive: run them here before anything starts.
	runnableNames := make([]string, len(res.runnable))
	svcOf := map[string]*OM{}
	for i, r := range res.runnable {
		runnableNames[i] = r.name
		svcOf[r.name] = r.service
	}
	lookup := func(n string) *OM { return svcOf[n] }
	var guardSpecs []guardSpec
	if interactive {
		guardSpecs = collectGuards(cfg, runnableNames, lookup)
	} else {
		runGuards(cfg, runnableNames, lookup)
	}

	paint := serviceColors(cfg) // same per-service colors as `crew list`
	commands := make([]fanCmd, len(res.runnable))
	for i, r := range res.runnable {
		color := paint[r.name]
		if color == nil {
			color = func(s string) string { return s }
		}
		commands[i] = fanCmd{
			command: "cd " + shellQuote(serviceDir(r.service)) + " && " + r.resolved,
			name:    r.name,
			color:   color,
		}
	}

	opts := fanOpts{
		killOthers:    true,
		announceExits: true,
		interactive:   interactive,
		notices:       notices,
		guards:        guardSpecs,
		hidden:        loadHiddenLog(flags),
		saveHidden:    func(h []string) { saveHiddenLog(flags, h) },
		logWrap:       loadLogWrap(flags),
		saveWrap:      func(w bool) { saveLogWrap(flags, w) },
	}
	// EVERY interactive run is registered + tee'd: output mirrors into per-service log files and
	// the registry records the pids, so the read-only agent (summoned with the viewer's [a] key)
	// can inspect THIS run via status/logs. The agent session (cwd + .mcp.json + CLAUDE.md) is
	// prepared up front so the summon is instant. Nothing is written for a piped/non-TTY run.
	var runDone func()
	if interactive {
		runID := "r" + strconv.FormatInt(time.Now().UnixMilli(), 36)
		_ = os.MkdirAll(filepath.Join(runsDir(m.userPath), runID), 0o755)
		// Register the run UP FRONT with its intended services (pid 0 = not yet alive) so the agent
		// can find it the instant it's summoned — even if guards BLOCK the run before any spawn.
		reg := &runReg{RunID: runID, Env: envArg, StartedAt: time.Now().UnixMilli()}
		for _, r := range res.runnable {
			reg.Services = append(reg.Services, runSvc{Name: r.name})
		}
		writeReg(m.userPath, reg)
		pidOf := map[string]int{}
		tee := map[string]io.Writer{}
		var files []*os.File
		for _, r := range res.runnable {
			if f, err := os.OpenFile(runLogPath(m.userPath, runID, r.name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
				tee[r.name] = f
				files = append(files, f)
			}
		}
		// A dedicated guards.log so `logs` can explain a guard-blocked run (services never started).
		if gf, err := os.OpenFile(runLogPath(m.userPath, runID, guardsLogName), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			opts.guardLog = gf
			files = append(files, gf)
		}
		opts.tee = tee
		opts.onSpawned = func(pids map[string]int) {
			for name, pid := range pids {
				pidOf[name] = pid
			}
			for i := range reg.Services {
				reg.Services[i].Pid = pidOf[reg.Services[i].Name]
				reg.Services[i].Pgid = pidOf[reg.Services[i].Name]
			}
			writeReg(m.userPath, reg)
		}
		opts.agent = prepareAgentSession(flags, m, res.runnable, runID, envArg)
		runDone = func() {
			reg.StoppedAt = time.Now().UnixMilli()
			writeReg(m.userPath, reg)
			for _, f := range files {
				_ = f.Close()
			}
		}
	}

	// STREAM: the first exit (any) tears the whole group down; Ctrl-C too.
	results := runFanout(commands, opts)
	if runDone != nil {
		runDone()
	}
	wire.cleanup() // remove the wired temp env files
	osExit(exitCodeFromEvents(results))
}

// agentSession is everything needed to summon the read-only copilot beside the log viewer:
// claude's cwd (holds the generated .mcp.json + CLAUDE.md) and its CLI args (--add-dir per
// service, auto permission mode). Prepared by crew start, spawned lazily on the viewer's [a] key.
type agentSession struct {
	cwd     string
	cliArgs []string
}

// prepareAgentSession writes the read-only MCP wiring + session prompt for THIS run and returns
// the spawn recipe. The MCP server is launched with CREW_RUN_ID so status/logs default to it.
func prepareAgentSession(flags *Flags, m mergedConfig, runnable []*runnableCmd, runID, env string) *agentSession {
	exe, err := os.Executable()
	if err != nil {
		return nil // no binary path => no agent; the run still streams normally
	}
	cwd := filepath.Join(crewHomeFor(m.userPath), "sessions", "run-"+runID)
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		return nil
	}

	// project-scope .mcp.json: the read-only crew server, scoped to this run via CREW_RUN_ID.
	var mcpArgs []any
	if flags.Config != "" {
		mcpArgs = append(mcpArgs, "--config", resolvePath(flags.Config))
	}
	mcpArgs = append(mcpArgs, "mcp")
	crewSrv := NewOM()
	crewSrv.Set("command", exe)
	crewSrv.Set("args", mcpArgs)
	srvEnv := NewOM()
	srvEnv.Set("CREW_RUN_ID", runID)
	crewSrv.Set("env", srvEnv)
	servers := NewOM()
	servers.Set("crew", crewSrv)
	mcpJSON := NewOM()
	mcpJSON.Set("mcpServers", servers)
	_ = os.WriteFile(filepath.Join(cwd, ".mcp.json"), []byte(MarshalJSON(mcpJSON)+"\n"), 0o644)

	// CLAUDE.md — the session prompt (auto-loaded from cwd). Lists the running slice for context.
	var svcLines []string
	var dirs []string
	seen := map[string]bool{}
	for _, r := range runnable {
		dir := serviceDir(r.service)
		if !seen[dir] {
			seen[dir] = true
			dirs = append(dirs, dir)
		}
		line := "- **" + r.name + "**"
		if t := r.service.GetStr("type"); t != "" {
			line += " · " + t
		}
		if l := r.service.GetStr("local"); l != "" {
			line += " · " + l
		}
		svcLines = append(svcLines, line+" · "+dir)
	}
	// CLAUDE.md carries only the DYNAMIC context (the running slice); the read-only contract itself
	// arrives via the MCP server's `instructions` on the initialize handshake — no need to repeat it.
	md := strings.Join(append([]string{
		"# crew run (env=" + env + ")",
		"",
		"The human ran `crew start` and is watching the live log viewer beside you. Use the crew MCP",
		"tools (status/logs default to THIS run) to help them debug it.",
		"",
		"## Running this slice",
	}, svcLines...), "\n") + "\n"
	_ = os.WriteFile(filepath.Join(cwd, "CLAUDE.md"), []byte(md), 0o644)

	cliArgs := []string{"--permission-mode", "auto"}
	for _, d := range dirs {
		cliArgs = append(cliArgs, "--add-dir", d)
	}
	return &agentSession{cwd: cwd, cliArgs: cliArgs}
}

func cmdWorkspace(flags *Flags, rest []string) {
	m := loadMerged(flags)
	// The editor is machine-local and has NO default — gate BEFORE the picker so an unconfigured
	// machine fails fast instead of making the user select a set for nothing.
	editor := resolveEditor(loadMachine(flags).Get("editor"))
	if editor == nil {
		fail("no editor configured — set one first:  crew config › Settings › editor")
	}
	warnMissing(m.cfg)
	cfg := presentCfg(m.cfg)
	if cfg.GetOM("services").Len() == 0 {
		emptyServicesState("Nothing to open — no service folders found.")
		osExit(1)
	}
	if len(rest) > 0 {
		warn(fmt.Sprintf("ignoring '%s' — services are chosen in the picker", strings.Join(rest, " ")))
	}
	members := selectMembers(flags, cfg, selectOpts{})
	if members == nil {
		return
	}
	validateMemberPaths(members)
	dirs := dirList(members)

	// 'folders' editors (Zed, JetBrains, Neovim, …) take the dirs straight as args.
	if editor.kind == "folders" {
		launch(editor.bin, dirs, "")
		return
	}

	// 'workspace-file' editors (VS Code family): materialize a `.code-workspace` and open it.
	// The FILENAME is the workspace TITLE VS Code shows, so use the short auto-label.
	wsDir := filepath.Join(crewHomeFor(m.userPath), "workspaces")
	wsFile := filepath.Join(wsDir, workspaceLabel(members, 2)+".code-workspace")
	folders := make([]any, len(dirs))
	for i, p := range dirs {
		f := NewOM()
		f.Set("path", p)
		folders[i] = f
	}
	wsJSON := NewOM()
	wsJSON.Set("folders", folders)
	wsJSON.Set("settings", cloneOM(vscodeWorkspaceSettings))

	_ = os.MkdirAll(wsDir, 0o755)
	_ = os.WriteFile(wsFile, []byte(MarshalJSON(wsJSON)+"\n"), 0o644)
	launch(editor.bin, []string{wsFile}, "")
}

