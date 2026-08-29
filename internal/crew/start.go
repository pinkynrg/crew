package crew

// `crew start` — crew's one core run command. Picks a co-running set (multiselect graph
// selector), wires their env, gates on guards, then STREAMS them (kill-others on first exit /
// Ctrl-C, interactive log viewer on a TTY). Per-node `d` debug toggle swaps a member to its
// `tasks.debug`. `crew workspace` / `crew claude` reuse the picker to open the set instead.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

	// STREAM: the first exit (any) tears the whole group down; Ctrl-C too.
	results := runFanout(commands, fanOpts{
		killOthers:    true,
		announceExits: true,
		interactive:   interactive,
		notices:       notices,
		guards:        guardSpecs,
		hidden:        loadHiddenLog(flags),
		saveHidden:    func(h []string) { saveHiddenLog(flags, h) },
		logWrap:       loadLogWrap(flags),
		saveWrap:      func(w bool) { saveLogWrap(flags, w) },
	})
	wire.cleanup() // remove the wired temp env files
	osExit(exitCodeFromEvents(results))
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

func cmdClaude(flags *Flags, rest []string) {
	m := loadMerged(flags)
	warnMissing(m.cfg)
	cfg := presentCfg(m.cfg)
	if cfg.GetOM("services").Len() == 0 {
		emptyServicesState("Nothing to open — no service folders found.")
		osExit(1)
	}
	// Optional first bare arg = a session name for the chat history.
	session := ""
	for _, a := range rest {
		if !strings.Contains(a, "=") {
			session = a
			break
		}
	}
	members := selectMembers(flags, cfg, selectOpts{})
	if members == nil {
		return
	}
	validateMemberPaths(members)
	dirs := dirList(members)

	// Claude Code keys its history off the cwd path, so a fixed, crew-owned cwd keeps history
	// tied to the session name — not any single service's dir.
	name := selectionLabel(members)
	if session != "" {
		name = sanitize(session)
	}
	cwd := filepath.Join(crewHomeFor(m.userPath), "sessions", name)
	_ = os.MkdirAll(cwd, 0o755)

	var cliArgs []string
	for _, d := range dirs {
		cliArgs = append(cliArgs, "--add-dir", d)
	}
	launch("claude", cliArgs, cwd)
}
