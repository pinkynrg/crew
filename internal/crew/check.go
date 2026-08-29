package crew

// crew check — hand-rolled config validator (strict). Errors block (exit 1); warnings are
// advisory. Validates the merged config + machine-local local.json.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

func cmdCheck(flags *Flags) {
	m := loadMerged(flags)
	cfg := m.cfg
	var errors, warns []string
	E := func(f string, a ...any) { errors = append(errors, fmt.Sprintf(f, a...)) }
	W := func(f string, a ...any) { warns = append(warns, fmt.Sprintf(f, a...)) }

	// Top level.
	for _, k := range cfg.Keys() {
		if !topKeys[k] {
			W("top-level: unknown key '%s'", k)
		}
	}
	if cfg.Get("version") != nil && !isNumber(cfg.Get("version")) {
		E("version must be a number")
	}
	if cfg.Get("guards") != nil && cfg.GetOM("guards") == nil {
		E("guards must be an object")
	}
	guards := cfg.GetOM("guards")
	if guards == nil {
		guards = NewOM()
	}

	// Services.
	services := cfg.GetOM("services")
	if services == nil || services.Len() == 0 {
		E("services: at least one service is required")
	} else {
		for _, name := range services.Keys() {
			at := "service '" + name + "'"
			p := services.GetOM(name)
			if p == nil {
				E("%s: must be an object", at)
				continue
			}
			for _, k := range p.Keys() {
				if !serviceKeys[k] {
					W("%s: unknown key '%s'", at, k)
				}
			}
			pathVal, pathIsStr := p.Get("path").(string)
			if !pathIsStr || strings.TrimSpace(pathVal) == "" {
				E("%s: 'path' (string) is required", at)
			} else {
				func() {
					defer func() {
						if r := recover(); r != nil {
							if ce, ok := r.(*CrewError); ok {
								W("%s: path cannot be resolved (%s)", at, ce.Error())
							} else {
								panic(r)
							}
						}
					}()
					if !pathExists(resolveServicePath(pathVal)) {
						W("%s: path does not exist on disk: %s", at, pathVal)
					}
				}()
			}
			if p.Get("type") != nil {
				if t, ok := p.Get("type").(string); !ok {
					E("%s: 'type' must be a string", at)
				} else {
					known := false
					for _, st := range serviceTypes {
						if st == t {
							known = true
						}
					}
					if !known {
						W("%s: unusual type '%s' (known: %s)", at, t, strings.Join(serviceTypes, ", "))
					}
				}
			}
			if p.Get("tasks") != nil {
				tasks := p.GetOM("tasks")
				if tasks == nil {
					E("%s: 'tasks' must be an object", at)
				} else {
					for _, t := range tasks.Keys() {
						if _, ok := tasks.Get(t).(string); !ok {
							E("%s: task '%s' command must be a string", at, t)
						}
					}
				}
			}
			if p.Get("env") != nil {
				if _, ok := p.Get("env").(string); !ok {
					E("%s: 'env' must be a string", at)
				}
			}
			if p.Get("local") != nil {
				if l, ok := p.Get("local").(string); !ok {
					E("%s: 'local' must be a string", at)
				} else if originOf(l) == "" {
					E("%s: 'local' must be an http(s) URL (got '%s')", at, l)
				}
			}
			if p.Get("match") != nil {
				match := p.GetOM("match")
				if match == nil {
					E("%s: 'match' must be an object { env: host | [hosts] }", at)
				} else {
					for _, env := range match.Keys() {
						v := match.Get(env)
						var hosts []any
						if arr, ok := v.([]any); ok {
							hosts = arr
						} else {
							hosts = []any{v}
						}
						if len(hosts) == 0 {
							W("%s: match['%s'] is empty", at, env)
						}
						for _, hv := range hosts {
							h, ok := hv.(string)
							if !ok {
								E("%s: match['%s'] must be a host string or array of host strings", at, env)
								continue
							}
							if regexp.MustCompile(`[*?]`).MatchString(h) {
								W("%s: match '%s' looks like a glob — matching is exact host (optionally + path)", at, h)
							} else if strings.Contains(h, "://") {
								W("%s: match '%s' must not include a scheme — use host or host/path", at, h)
							}
						}
					}
				}
			}
			if p.Get("guards") != nil {
				gl, ok := StrArr(p.Get("guards"))
				if !ok {
					E("%s: 'guards' must be an array of strings", at)
				} else {
					for _, g := range gl {
						if guards.GetOM(g) == nil {
							E("%s: references undefined guard '%s'", at, g)
						}
					}
				}
			}
			usesEnvfile := false
			if tasks := p.GetOM("tasks"); tasks != nil {
				for _, t := range tasks.Keys() {
					if s, ok := tasks.Get(t).(string); ok && strings.Contains(s, "{envfile}") {
						usesEnvfile = true
					}
				}
			}
			if usesEnvfile && p.GetStr("env") == "" {
				E("%s: uses {envfile} but has no 'env' field", at)
			}
			if match := p.GetOM("match"); match != nil && match.Len() > 0 && p.GetStr("local") == "" {
				W("%s: has 'match' (a wiring target) but no 'local' — peers can't wire to it locally", at)
			}
		}
	}

	// Guard registry.
	for _, name := range guards.Keys() {
		at := "guard '" + name + "'"
		g := guards.GetOM(name)
		if g == nil {
			E("%s: must be an object", at)
			continue
		}
		for _, k := range g.Keys() {
			if !guardKeys[k] {
				W("%s: unknown key '%s'", at, k)
			}
		}
		if cmd, ok := g.Get("command").(string); !ok || strings.TrimSpace(cmd) == "" {
			E("%s: 'command' (string) is required", at)
		}
		if cm, ok := g.Get("comment").(string); !ok || strings.TrimSpace(cm) == "" {
			W("%s: 'comment' is required — it explains what the check verifies", at)
		}
		if g.Get("message") != nil {
			if _, ok := g.Get("message").(string); !ok {
				E("%s: 'message' must be a string", at)
			}
		}
	}
	usedGuards := map[string]bool{}
	if services != nil {
		for _, name := range services.Keys() {
			if p := services.GetOM(name); p != nil {
				if gl, ok := StrArr(p.Get("guards")); ok {
					for _, g := range gl {
						usedGuards[g] = true
					}
				}
			}
		}
	}
	for _, name := range guards.Keys() {
		if !usedGuards[name] {
			W("guard '%s' is defined but used by no service", name)
		}
	}

	// Env overrides — validate BOTH layers: config.json (warn on secret-LOOKING keys) and the
	// local.json overlay (secrets belong there, no warn).
	projNames := map[string]bool{}
	if services != nil {
		for _, n := range services.Keys() {
			projNames[n] = true
		}
	}
	secretish := regexp.MustCompile(`(?i)(pass|pwd|secret|token|credential|private[_-]?key|api[_-]?key)`)
	checkOverrides := func(src any, label string, warnSecret bool) {
		if src == nil {
			return
		}
		srcOM, ok := src.(*OM)
		if !ok {
			E("%s must be an object", label)
			return
		}
		checkVar := func(where, k string, v any) {
			if !envVarNameRE.MatchString(k) {
				W("%s: invalid env var name '%s'", where, k)
			}
			if v == nil || IsObj(v) {
				W("%s.%s must be a string", where, k)
			}
			if _, isArr := v.([]any); isArr {
				W("%s.%s must be a string", where, k)
			}
			if warnSecret && secretish.MatchString(k) {
				W("%s.%s looks secret — put it in local.json overrides (machine-local, gitignored), not the committable config", where, k)
			}
		}
		for _, proj := range srcOM.Keys() {
			if !projNames[proj] {
				W("%s: unknown service '%s'", label, proj)
			}
			vars := srcOM.GetOM(proj)
			if vars == nil {
				E("%s['%s'] must be an object of VAR:value", label, proj)
				continue
			}
			for _, k := range vars.Keys() {
				v := vars.Get(k)
				if k == overrideWhenLocal {
					wl, ok := v.(*OM)
					if !ok {
						E("%s['%s'].whenLocal must be an object keyed by service", label, proj)
						continue
					}
					for _, peer := range wl.Keys() {
						if !projNames[peer] {
							W("%s['%s'].whenLocal: unknown service '%s'", label, proj, peer)
						}
						pv := wl.GetOM(peer)
						if pv == nil {
							E("%s['%s'].whenLocal['%s'] must be an object of VAR:value", label, proj, peer)
							continue
						}
						for _, vk := range pv.Keys() {
							checkVar(fmt.Sprintf("%s['%s'].whenLocal['%s']", label, proj, peer), vk, pv.Get(vk))
						}
					}
					continue
				}
				checkVar(fmt.Sprintf("%s['%s']", label, proj), k, v)
			}
		}
	}
	machine := loadMachine(flags)
	checkOverrides(cfg.Get("overrides"), "overrides", true)
	checkOverrides(machine.Get("overrides"), "local.json overrides", false)
	if arr, ok := StrArr(machine.Get("lastSelection")); ok {
		for _, n := range arr {
			if !projNames[n] {
				W("local.json lastSelection: unknown service '%s'", n)
			}
		}
	}
	if arr, ok := StrArr(machine.Get("lastDebug")); ok {
		for _, n := range arr {
			if !projNames[n] {
				W("local.json lastDebug: unknown service '%s'", n)
			}
		}
	}
	if ed := machine.Get("editor"); ed != nil && resolveEditor(ed) == nil {
		shown := ""
		if s, ok := ed.(string); ok {
			shown = s
		} else {
			shown = MarshalJSON(ed)
		}
		var ids []string
		for _, e := range editors {
			ids = append(ids, e.id)
		}
		var kinds []string
		for _, k := range editorKinds {
			kinds = append(kinds, "'"+k+"'")
		}
		E("local.json editor: unknown editor '%s' (known: %s, or an object { bin, kind:%s })", shown, strings.Join(ids, ", "), strings.Join(kinds, "|"))
	}

	// Report.
	head := cBold("Checking " + tildify(m.userPath))
	if m.localPath != "" {
		head += cDim("  (+ " + tildify(m.localPath) + ")")
	}
	fmt.Println(head)
	for _, msg := range errors {
		fmt.Printf("  %s %s\n", cRed("✗"), msg)
	}
	for _, msg := range warns {
		fmt.Printf("  %s %s\n", cYellow("!"), msg)
	}
	if len(errors) == 0 && len(warns) == 0 {
		fmt.Printf("  %s no problems found\n", cGreen("✓"))
		return
	}
	var parts []string
	if len(errors) > 0 {
		s := ""
		if len(errors) > 1 {
			s = "s"
		}
		parts = append(parts, cRed(fmt.Sprintf("%d error%s", len(errors), s)))
	}
	if len(warns) > 0 {
		s := ""
		if len(warns) > 1 {
			s = "s"
		}
		parts = append(parts, cYellow(fmt.Sprintf("%d warning%s", len(warns), s)))
	}
	fmt.Printf("\n  %s\n", strings.Join(parts, ", "))
	if len(errors) > 0 {
		exitCode = 1
	}
}

var _ = json.Number("")
