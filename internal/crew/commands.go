package crew

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

const pkgName = "@pinkynrg/crew"

// Version is stamped by the release build; the dev default still satisfies `-v` output shape.
var Version = "0.0.0"

var exitCode = 0

func osExit(code int) {
	os.Exit(code)
}

func runtimeGOOS() string { return runtime.GOOS }

// ---- crew list ----

func cmdList(flags *Flags) {
	m := loadMerged(flags)
	cfg := m.cfg
	services := cfg.GetOM("services")
	paint := serviceColors(cfg)
	if services == nil || services.Len() == 0 {
		fmt.Println(cDim("No services configured yet."))
		fmt.Printf("Run %s to add one.\n", cCyan("crew config"))
		return
	}
	warnMissing(cfg) // list shows ALL services (red/green dot below), plus a direction-aware banner

	fmt.Println(cBold(cUnderline("Services")))
	for _, name := range services.Keys() {
		p := services.GetOM(name)
		// Tolerant of an unset services dir: show the raw relative path instead of crashing.
		abs := ""
		func() {
			defer func() { recover() }()
			abs = resolveServicePath(p.GetStr("path"))
		}()
		ok := abs != "" && pathExists(abs)
		dot := cRed("●")
		if ok {
			dot = cGreen("●")
		}
		typ := p.GetStr("type")
		if typ == "" {
			typ = "other"
		}
		shown := ""
		if abs != "" {
			shown = tildify(abs)
		} else {
			shown = p.GetStr("path") + "  " + cDim("(set services dir: crew config)")
		}
		pathCell := shown
		if !ok {
			suffix := ""
			if abs != "" {
				suffix = "  ✗ missing"
			}
			pathCell = cRed(shown + suffix)
		}
		fmt.Printf("  %s %s\n", dot, cBold(paint[name](name))) // header: status + name only

		// Every field is a labeled row, columns aligned per service.
		tasks := p.GetOM("tasks")
		var taskNames []string
		if tasks != nil {
			taskNames = tasks.Keys()
		}
		guardsList, _ := StrArr(p.Get("guards"))
		labels := append([]string{"type", "path"}, taskNames...)
		if len(guardsList) > 0 {
			labels = append(labels, "guards")
		}
		labelW := 6
		for _, s := range labels {
			if len(s) > labelW {
				labelW = len(s)
			}
		}
		lab := func(s string) string { return cDim(s + strings.Repeat(" ", labelW+2-len(s))) }
		fmt.Printf("      %s%s\n", lab("type"), typ)
		fmt.Printf("      %s%s\n", lab("path"), pathCell)
		for _, t := range taskNames {
			kind := cGreen("task")
			if streamedTasks[t] {
				kind = cYellow("service")
			}
			fmt.Printf("      %s%s  %s%s%s\n", lab(t), anyToStr(tasks.Get(t)), cDim("["), kind, cDim("]"))
		}
		if len(taskNames) == 0 {
			fmt.Printf("      %s\n", cDim("(run-less)"))
		}
		if len(guardsList) > 0 {
			fmt.Printf("      %s%s\n", lab("guards"), strings.Join(guardsList, ", "))
		}
	}

	// Footer.
	var last []string
	for _, n := range loadLastSelection(flags) {
		if services.GetOM(n) != nil {
			last = append(last, n)
		}
	}
	if len(last) > 0 {
		var painted []string
		for _, n := range last {
			painted = append(painted, paint[n](n))
		}
		fmt.Println("\n" + cDim("last selection  ") + strings.Join(painted, cDim(", ")))
	}
	lead := "\n"
	if len(last) > 0 {
		lead = ""
	}
	localNote := ""
	if m.localPath != "" {
		localNote = cDim("  (+ " + tildify(m.localPath) + ")")
	}
	fmt.Println(lead + cDim("config        ") + cDim(tildify(userConfigPath(flags))) + localNote)
	machinePath := machineConfigPath(flags)
	noneYet := ""
	if !pathExists(machinePath) {
		noneYet = cDim("  (none yet)")
	}
	fmt.Println(cDim("local         ") + cDim(tildify(machinePath)) + noneYet)
}

// ---- crew resolve <env> [service...] — read-only env-derivation dry-run ----

func cmdResolve(flags *Flags, rest []string) {
	m := loadMerged(flags)
	warnMissing(m.cfg)
	cfg := presentCfg(m.cfg) // resolve reads env files — skip services whose folder is absent
	selEnv := ""
	for _, a := range rest {
		if !strings.Contains(a, "=") {
			selEnv = a
			break
		}
	}
	if selEnv == "" {
		fail("resolve: usage: crew resolve <env> [service...]")
	}
	var explicit []string
	for _, a := range rest {
		if a != selEnv && !strings.Contains(a, "=") {
			explicit = append(explicit, a)
		}
	}
	machine := loadMachine(flags)
	var names []string
	if len(explicit) > 0 {
		names = explicit
	} else if last, ok := StrArr(machine.Get("lastSelection")); ok && len(last) > 0 {
		names = last
	} else if s := cfg.GetOM("services"); s != nil {
		names = s.Keys()
	}
	services := cfg.GetOM("services")
	var valid []string
	for _, n := range names {
		if services.GetOM(n) != nil {
			valid = append(valid, n)
		}
	}
	if len(valid) == 0 {
		emptyServicesState("Nothing to resolve.")
		return
	}

	res := resolveEnvs(cfg, valid, selEnv)
	paint := serviceColors(cfg)
	w := 0
	for _, n := range valid {
		if len(n) > w {
			w = len(n)
		}
	}
	plural := ""
	if len(valid) > 1 {
		plural = "s"
	}
	fmt.Println(cBold("Resolved envs") + cDim(fmt.Sprintf("  — selection env = %s  (%d service%s)", selEnv, len(valid), plural)))
	fmt.Println(cDim("  entry runs at the selection env; deps inherit the env their consumer points at."))
	for _, n := range valid {
		e, ok := res.resolved[n]
		if !ok {
			e = selEnv
		}
		tag := cCyan(e)
		if e == selEnv {
			tag = cDim(e)
		}
		label := n
		if f, ok := paint[n]; ok {
			label = f(n)
		}
		pad := w - len(n) + 2
		if pad < 2 {
			pad = 2
		}
		fmt.Printf("  %s%s%s\n", label, strings.Repeat(" ", pad), tag)
	}
	if len(res.warnings) > 0 {
		fmt.Println("\n" + cYellow("⚠ notes:"))
		for _, wn := range res.warnings {
			fmt.Println("  " + cDim(wn))
		}
	}
}

// ---- crew graph [list] ----

// The ANSI color PREFIX of a service's paint function (the renderer colors per-box).
func colorPrefix(paint map[string]func(string) string, n string) string {
	f, ok := paint[n]
	if !ok {
		return ""
	}
	s := f("\x01")
	if i := strings.Index(s, "\x01"); i > 0 {
		return s[:i]
	}
	return ""
}

func cmdGraph(flags *Flags, rest []string) {
	m := loadMerged(flags)
	warnMissing(m.cfg)
	cfg := presentCfg(m.cfg) // broken services are dropped from the graph (as if absent)
	if len(rest) == 0 || rest[0] != "list" {
		cmdGraphDraw(flags, cfg)
		return
	}
	paint := serviceColors(cfg)
	services := cfg.GetOM("services")
	if services == nil || services.Len() == 0 {
		emptyServicesState("Nothing to show here.")
		return
	}
	names := services.Keys()
	meta := metaFor(services, names)

	fmt.Println(cBold("Dependency graph") + cDim("  — edges auto-discovered from .envs, no wiring"))
	fmt.Println(cDim(strings.Join([]string{
		"How it works:",
		"  1. Give each service an id so crew can recognize it when another service's URL",
		"     points at it: `match` = an env-labeled map of the complete hostname(s) it is",
		"     served under (exact strings). E.g. match: {\"pro\":\"api.example.com\",",
		"     \"qa\":\"qa-api.example.com\"}. No `match` = no id, so nothing can point at it (⚠).",
		"  2. Read every env file and pull out every http(s):// URL.",
		"  3. For each URL, compare its host to every `match` string — exact match only, so",
		"     api.example.com never collides with rge-api.example.com.",
		"  4. A URL in P whose host equals one of T's match hosts → edge P → T.",
		"  5. URLs matching no service are dropped as 3rd-party.",
	}, "\n")))
	warned := false
	for _, name := range names {
		mt := meta[name]
		edges := newOset()
		refs := map[string]bool{}
		for _, hp := range urlsIn(mt.files) {
			// Pick the service whose matching token is longest (most specific).
			if best := bestTarget(names, meta, hp.host, hp.path); best != "" && best != name {
				edges.add(best)
				if isReferenceEdge(cfg, name, best) {
					refs[best] = true
				}
			}
		}
		painted := name
		if f, ok := paint[name]; ok {
			painted = f(name)
		}
		head := cBold(painted)
		if mt.source == "none" {
			warned = true
			fmt.Printf("\n%s  %s\n", head, cYellow("⚠ no `match` — no id, peers can't link to it"))
		} else {
			fmt.Printf("\n%s  %s\n", head, cDim("["+strings.Join(mt.tokens, ", ")+"]"))
		}
		if edges.size() > 0 {
			targets := edges.list()
			sort.Strings(targets)
			for _, t := range targets {
				arrow := cGreen("→")
				tag := ""
				if refs[t] {
					arrow = cDim("⇢")
					tag = cDim(" (ref — not a dep)")
				}
				tp := t
				if f, ok := paint[t]; ok {
					tp = f(t)
				}
				fmt.Printf("  %s %s%s\n", arrow, tp, tag)
			}
		} else {
			fmt.Printf("  %s\n", cDim("→ (no crew-service edges)"))
		}
	}
	if warned {
		fmt.Println("\n" + cYellow("⚠ ") + cDim("some services have no `match` — add `match: {\"pro\":\"host.example.com\"}` (env-labeled exact hosts) so peers can link to them."))
	}
}

// ---- crew config (path + non-TTY degrade; the editor lives in editor.go) ----

func cmdConfig(flags *Flags, sub string) {
	if sub == "path" {
		fmt.Println(userConfigPath(flags))
		return
	}
	if sub != "" {
		fail("config: unknown subcommand '%s'. Use: crew config  (opens the editor)  |  crew config path", sub)
	}
	if !canInteractive() {
		fmt.Println(userConfigPath(flags)) // non-interactive: just print the path
		return
	}
	configForm(flags, "services")
}

// ---- crew pull <url> ----

func cmdPull(flags *Flags, url string) {
	if url == "" || !strings.HasPrefix(strings.ToLower(url), "http://") && !strings.HasPrefix(strings.ToLower(url), "https://") {
		fail("pull: usage: crew pull <url-to-config.json>")
	}
	path := userConfigPath(flags)
	text, err := fetchUrl(url)
	if err != nil {
		fail("pull: could not fetch config: %s", err.Error())
	}
	v, perr := ParseJSON([]byte(text))
	if perr != nil {
		fail("pull: response is not valid JSON (check the URL / token)")
	}
	cfg, ok := v.(*OM)
	if !ok || cfg.GetOM("services") == nil {
		fail("pull: that JSON is not a crew config (missing \"services\")")
	}

	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	backed := false
	if pathExists(path) {
		if data, err := os.ReadFile(path); err == nil {
			_ = os.WriteFile(path+".bak", data, 0o644)
			backed = true
		}
	}
	_ = os.WriteFile(path, []byte(MarshalJSON(cfg)+"\n"), 0o644)
	n := cfg.GetOM("services").Len()
	plural := "s"
	if n == 1 {
		plural = ""
	}
	fmt.Printf("Loaded config → %s %s\n", tildify(path), cDim(fmt.Sprintf("(%d service%s)", n, plural)))
	if backed {
		fmt.Println(cDim("  previous saved as " + tildify(path+".bak")))
	}
	fmt.Println(cDim("  set your services dir if needed: crew config (Settings)"))
}

// ---- help + dispatch ----

func help() {
	const col = 35
	cmd := func(name, rest, desc string) string {
		sig := name
		left := cCyan(name)
		if rest != "" {
			sig = name + " " + rest
			left = cCyan(name) + " " + rest
		}
		pad := col - len(sig)
		if pad < 2 {
			pad = 2
		}
		return "  " + left + strings.Repeat(" ", pad) + desc
	}
	actions := [][3]string{
		{"help", "", "Show this help"},
		{"list", "", "List services"},
		{"start", "env=<env>", "Pick services, wire + start them for that env"},
		{"workspace", "", "Pick services, open them in your editor"},
		{"claude", "[session]", "Pick services, launch Claude Code"},
		{"graph", "[list]", "Show the dependency graph (list = text)"},
		{"resolve", "<env> [proj…]", "Show each service's resolved env (dry-run)"},
	}
	config := [][3]string{
		{"config", "[path]", "Visual config editor (path = print file path)"},
		{"check", "", "Validate the config"},
		{"pull", "<url>", "Load config.json from a URL"},
		{"upgrade", "", "Self-update to the latest release"},
	}
	flagRows := [][2]string{
		{"--config <path>", "Use a specific config file"},
		{"-v, --version", "Print version"},
	}
	var L []string
	L = append(L, fmt.Sprintf("%s %s — run the slice of your stack you care about, locally + wired", cBold("crew"), Version))
	L = append(L, "", cBold("USAGE"), "  crew <command> [args] [flags]", "", cBold("ACTIONS"))
	for _, a := range actions {
		L = append(L, cmd(a[0], a[1], a[2]))
	}
	L = append(L, "", cBold("CONFIG"))
	for _, a := range config {
		L = append(L, cmd(a[0], a[1], a[2]))
	}
	L = append(L, "", cBold("FLAGS"))
	for _, f := range flagRows {
		pad := 18 - len(f[0])
		if pad < 2 {
			pad = 2
		}
		L = append(L, "  "+cCyan(f[0])+strings.Repeat(" ", pad)+f[1])
	}
	fmt.Println(strings.Join(L, "\n"))
}

func parseArgs(argv []string) (*Flags, []string) {
	flags := &Flags{}
	var pos []string
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		switch {
		case a == "-v" || a == "--version":
			flags.Version = true
		case a == "--config":
			i++
			if i >= len(argv) {
				fail("--config requires a path")
			}
			flags.Config = argv[i]
		case strings.HasPrefix(a, "--config="):
			flags.Config = a[len("--config="):]
		case strings.HasPrefix(a, "-") && a != "-":
			fail("unknown flag: %s", a)
		default:
			pos = append(pos, a)
		}
	}
	return flags, pos
}

// Main runs the CLI; expected failures (CrewError) print one line and exit 1.
func Main(argv []string) {
	defer func() {
		if r := recover(); r != nil {
			if ce, ok := r.(*CrewError); ok {
				fmt.Fprintln(os.Stderr, cRed("crew: "+ce.Error()))
				os.Exit(1)
			}
			fmt.Fprintln(os.Stderr, cRed(fmt.Sprintf("crew: unexpected error: %v", r)))
			os.Exit(1)
		}
		os.Exit(exitCode)
	}()

	flags, pos := parseArgs(argv)
	if flags.Version {
		fmt.Println(Version)
		return
	}
	if len(pos) == 0 {
		help()
		return
	}
	cmd, rest := pos[0], pos[1:]
	restFirst := ""
	if len(rest) > 0 {
		restFirst = rest[0]
	}

	switch cmd {
	case "help":
		help()
	case "list":
		cmdList(flags)
	case "start":
		cmdStart(flags, rest)
	case "install":
		fail("crew install was removed — `crew start` is the only run command; a service's other tasks aren't wired to a command yet")
	case "workspace":
		cmdWorkspace(flags, rest)
	case "claude":
		cmdClaude(flags, rest)
	case "add":
		fail("crew add was removed — create services visually: crew config  (then the \"+ New service\" row)")
	case "edit":
		fail("crew edit is now `crew config` — the two-pane visual editor")
	case "remove":
		fail("crew remove was removed — delete visually: crew config  (highlight the service, press d)")
	case "guards":
		fail("crew guards was removed — view/edit guards in: crew config")
	case "overrides":
		fail("crew overrides was removed — view/edit overrides in: crew config")
	case "dir":
		fail("crew dir was removed — set the services directory in Settings: crew config")
	case "graph":
		cmdGraph(flags, rest)
	case "resolve":
		cmdResolve(flags, rest)
	case "config":
		cmdConfig(flags, restFirst)
	case "check":
		cmdCheck(flags)
	case "pull":
		cmdPull(flags, restFirst)
	case "upgrade":
		cmdUpgrade()
	default:
		fmt.Fprintln(os.Stderr, cRed(fmt.Sprintf("crew: unknown command '%s'", cmd))+"\n")
		help()
		exitCode = 1
	}
}
