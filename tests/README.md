# crew test suites

Two suites, both run by `npm test`. No test framework, no runtime deps — the suites are the
portability contract: a port to another language must pass them unchanged (`CREW=./crew-go npm test`).

```
tests/
  utils/keys.exp        key constants shared by every expect case — the "what key does what" reference
  graph/                ASCII graph renderer goldens (tests bin/graph.js directly — no PTY, no CLI)
    run.mjs             runner: render each case in mono, diff against the golden (-u accepts)
    gallery.html        every case rendered in colour (regenerated on full runs)
    cases/              everything about one case together: <name>.mmd (the graph),
                        <name>.opts.json (optional render options: cursor/sublabels = the start
                        selector's rendering mode), <name>.snap.txt (the golden, beside its case)
  e2e/                  black-box CLI tests driven by expect in a real PTY
    run.sh              runner: fresh fixture copy per case, one retry on flake, golden diffs
                        (`sh tests/e2e/run.sh [-u] [name…]` — names filter cases by substring)
    utils/lib.exp       helpers: crun/must/want_exit/want_done/config_has/local_has + snap/snapend
    utils/render.mjs    ANSI -> character-grid interpreter for screen snapshots
    fixtures/<name>/    throwaway configs/services a case runs against (copied fresh per attempt)
    cases/*.exp         the tests — each case's screen goldens live in <case>.snaps/ right beside it
                        (one <n>-<label>.txt per `snap`; sorts under the .exp with explorer "mixed" sort)
```

## Conventions

**Case naming** — `group_subgroup_scenario.exp`, full words, no abbreviations. The group prefix keeps
related tests adjacent in a directory listing. Current groups: `check_` `cli_` `claude_` `config_`
(the visual editor; subgroups `service`/`guard`/`overrides`/`settings`) `graph_` `list_` `load_`
`migrate_` `pull_` `resolve_` `retired_` `start_` `upgrade_` `viewer_` `workspace_`.

**Fixture declaration** — every case declares its fixture in-file, right above the `source` line:

```tcl
# fixture: rich-stack
source tests/e2e/utils/lib.exp
```

Filenames stay purely semantic; fixtures are shared freely across groups.

**Keys** — cases send the FOOTER-ADVERTISED keys via the constants in `tests/utils/keys.exp`
(`$ENTER` `$ESC` real `$UP`/`$DOWN`/`$LEFT`/`$RIGHT` arrows, `$SAVE` `$FILTER` …), never the app's
undocumented vim aliases. Typed TEXT (names, values, search queries) stays a literal string, flagged
with a `;# typed text` comment when it could be mistaken for a key.

**Screen snapshots** — any case may call `snap "<label>"` at a capture point (and `snapend` before
quitting). One snap = one golden file `cases/<case>.snaps/<n>-<label>.txt`, a pure rendered grid —
open it in an editor and you see the TUI at that moment. Rules for snapping cases:
- geometry is the shared lib default (100x40); a case that overrides `stty_init` gets its goldens
  rendered at its declared size — keep overrides rare
- fixture output must be deterministic — no timers, counters, or real paths (tmp is normalized to `__TMP__`)
- goldens are grids, not byte streams: a port that paints the same screen passes whatever escapes it used
- snaps are DELIBERATE capture points at meaningful states, not per-keystroke: each one drains the PTY
  (~1s) and becomes a reviewed golden — snap the states worth guarding

**Updating goldens** — `npm run test:update` (or `sh tests/e2e/run.sh -u` / `node tests/graph/run.mjs -u`).

## Harness gotchas (hard-won — read before writing a case)

- `must` patterns must be ASCII-ONLY: expect decodes the stream in chunks, and a multibyte character
  split across a read boundary decodes as mojibake that never matches — a load-dependent CI timeout.
  Bridge non-ASCII with a regex (`overrides .{0,4}local`) or assert an ASCII token from the same output.
- Keystrokes sent back-to-back coalesce into one stdin chunk; the viewer's search input deliberately
  ignores multi-char chunks — type through per-key `must` assertions.
- expect only reads the PTY while expecting: long sleeps between sends can stall the app on stdout
  backpressure. `snap` drains explicitly for the same reason.
- Raw-mode views (pager, picker, viewer, config editor) hold the PTY open — quit them (`$ESC`/Ctrl-C)
  or the case hangs. `crew start` ALWAYS streams: drive the viewer, then `send $ESC` + `want_done`.
- `crew start` requires `env=<name>` (errors before the picker without it).
- Tcl regex has no `\S` inside brackets; its `.` already spans newlines. `;#` is the only trailing
  comment syntax.
- A `spawn` inside a proc needs `global spawn_id`.
