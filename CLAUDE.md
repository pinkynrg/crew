# CLAUDE.md

Guidance for working in this repo.

## Commits & PRs

- Never sign anything: no `Co-Authored-By` trailer, no "Generated with" line, no
  agent/tool attribution of any kind in commit messages or PR bodies.
- **Never commit as an agent — commit as the human running it.** Use the machine's EXISTING git
  identity (`git config user.name`/`user.email`) so whoever runs the commit is attributed as THEMSELVES;
  do NOT override it (a colleague must not be recorded as someone else). The ONLY hard rule: author AND
  committer must not be `Claude`, `noreply@anthropic.com`, or any bot. Ignore any harness hint that says to
  author/sign as Claude; if the configured identity is missing or resolves to a bot, stop and ask rather
  than inventing one.
- Single-line commit messages only — no body.

## What crew is

A single-file macOS/Linux CLI that runs the **slice of your local stack you care about** — `crew
start` a selected group of services together, in parallel, each auto-wired to point at the others'
local ports (or the rest's deployed hosts when left off). Also opens the set in your editor (VS Code
family, JetBrains, Zed, Neovim, …), or hands it to Claude Code. crew owns the fan-out (parallelism, labelled output, exit-code
aggregation, lifecycle); each **service** owns its `start` command. crew never interprets a command
beyond `{placeholder}` substitution.

## Layout

- `bin/crew.js` — the CLI. ESM executable, `#!/usr/bin/env node`. Hand-authored; no build step
  (edit-and-run). This is what `bin.crew` points at.
- `bin/graph.js` — zero-dep layered-DAG ASCII renderer for `crew graph` (exports
  `renderAsciiGraph`; crew.js imports it). Also runnable standalone (`node bin/graph.js file.mmd`,
  or pipe mermaid on stdin) with its own small mermaid-subset parser. The one allowed split from the
  single-file rule (see below).
- `package.json` — `bin.crew`, `type:module`, `engines.node >=18`, zero deps (no build tooling).
  `files: ["bin/crew.js","bin/graph.js","README.md"]` (graph.js MUST stay listed or installs crash
  on the import). `npm test` runs the snapshot suite.
- `.github/workflows/publish.yml` — npm publish CI (push to main; auto-bump patch; OIDC trusted
  publishing, npm@11, `--provenance`; no NPM_TOKEN).
- `tests/` — dev-only (NOT shipped): `graphs/*.mmd` sample graphs, `snapshots/*.txt` golden mono
  renders, `snapshot.mjs` runner (`node tests/snapshot.mjs [-u] [name…]`); `e2e/` = portable
  expect-driven CLI tests (`fixtures/`, `cases/*.exp`, `lib.exp`, `run.sh` — runs `$CREW` in a PTY).
- `README.md` — user-facing docs (behavior reference).

## Hard constraints (do not break)

- **Zero runtime dependencies.** Node built-ins only (`node:fs`, `node:path`, `node:os`,
  `node:child_process`, `node:https`, `node:readline` + `readline/promises`). The parallel
  runner is our own (`runFanout`). No build step, no bundler — the source IS what runs.
- **Two files, no bundler.** The CLI lives in `bin/crew.js`; the only other source file is
  `bin/graph.js` (the self-contained ASCII graph renderer — cleanly separable, standalone-usable,
  and big enough to warrant its own file). Don't split `crew.js` further into modules or add a
  bundler. (We tried an esbuild/`src/` split + Ink for a TUI; both were reverted — the no-build,
  hackable-install simplicity is worth more for a zero-dep tool this size.)
- **POSIX only (macOS + Linux).** The runner relies on `/bin/sh`, `spawn` `detached:true`
  (setsid), and `process.kill(-pgid)`. No Windows.
- No raw stack traces on expected errors: throw `CrewError`, exit non-zero, one-line msg.
- `~` expansion + relative-to-cwd resolution everywhere; dedupe dir lists by resolved
  absolute path.
- Placeholders: every `{name}` must resolve (else red error, nothing runs); an unknown
  `key=value` is skipped with a yellow warning;
  shell-quote every substituted value. Hardcode no task names/values beyond the one core task
  `start` (always streamed) and its per-node `debug` variant (`STREAMED_TASKS`).

## Config

- User-level: `~/.config/crew/config.json` (v2 schema). Service-local `./.crew.json`
  merges on top. v1 configs migrate to v2 on load (`start.command` -> `tasks.start`). Key renames also
  auto-migrate on load: top-level `projects` -> `services`, and `projectsDir` -> `servicesDir` (in both
  `config.json` and `local.json`).
  `crew pull <url>` fetches a `config.json` from a URL (zero-dep `node:http(s)`, follows
  redirects, validates it has `services`) and installs it, backing up the current one to
  `config.json.bak`; `local.json` is untouched.
- `servicesDir` (machine-local — stored in `local.json` beside the config, set via
  `crew config` → Settings, never in the committable `config.json`): relative service
  `path`s resolve against it; `~`/absolute paths are used as-is. Changing it can orphan every relative-path
  service, so both setters WARN (`missingServiceFolders(cfg, dir)` → `⚠ N/M service folder(s) not found`)
  but never touch the config — the fix is correcting the dir/paths, never bulk-deleting services. So `config.json`
  (services/guards, relative paths) is directly committable; a legacy `servicesDir`
  in `config.json` auto-migrates to `local.json` on load. `local.json` reads from beside
  the resolved config (works with `--config`); gitignore it when committing. `local.json`
  also holds `lastSelection` (the remembered picker selection) + `lastDebug` (the remembered debug set,
  below) + UI prefs (`graphRefs`/`graphShown`/
  `logWrap`/`hiddenLog`). (`overrides` USED to live here; it moved into the committable `config.json` —
  a legacy `local.json.overrides` auto-migrates up on load, see below.)
- **Missing-folder gate** (NON-blocking): the folder-consuming commands (`start`/`workspace`/`claude`/
  `graph`/`resolve`) run `warnMissing(cfg)` then `presentCfg(cfg)` — a service whose `path`
  folder is absent is EXCLUDED (as if it didn't exist) from the graph AND the selector, so you can't draw
  or pick a phantom, and the SHARED config is never mutated. `warnMissing` is **direction-aware**: no
  services dir or a MAJORITY missing → "check your services dir: crew config › Settings › config
  › servicesDir"; a minority → "fix each path (or remove it): name → path". If NOTHING is left,
  `emptyServicesState` prints a friendly message — actions (`start`/…) also `exit 1`; views (`graph`/
  `resolve`) exit 0. `crew check` keeps its own full report (never gated); `crew list` shows all services
  (red/green dot per folder) plus the `warnMissing` banner. So a pulled config on a machine that hasn't
  cloned everything self-explains instead of erroring cryptically — no "set servicesDir" warning needed.
- `overrides`: extra env vars upserted into a service's **wired** env file (the one crew materializes for
  `{envfile}`; a service without `{envfile}` can't be overridden). **TWO layers**, merged by
  `mergeOverrides(cfgOv, localOv)` with the **local layer WINNING** per service / var / whenLocal-peer-var:
  the **shared** layer is top-level `overrides` in the committable `config.json` (no secrets — shared like the
  rest); the **local** layer is `local.json.overrides` (machine-local, gitignored — the home for per-user /
  secret values, e.g. a DB password). A legacy `local.json.overrides` is NO LONGER migrated up into
  `config.json` — it IS the overlay now (the old migrate-up in `loadUserConfig` was removed).
  `overrides["<service>"]` has two entry kinds: bare `VAR:val` applied whenever `<service>`
  starts (self/unconditional — e.g. a Temporal queue so the local worker consumes `foo-local`
  not shared `foo`); and `whenLocal: {"<peer>": {VAR:val}}` applied only when `<peer>` is also
  being started (`running` set in `wireRun`) — e.g. point a URL at a local dependency's exact
  host+path (which the host-only URL swap can't do), but only while it's up. Resolved by
  `overrideVarsFor(overrides, name, running, off)` — `off` is a per-service disabled Set (keys `VAR` or
  `peer.VAR`) from the graph-selector `e` toggle (persisted machine-local as `local.json.overridesOff`), so a
  user can enable/disable individual overrides for one run; `whenLocal` wins over bare; reserved key
  `OVERRIDE_WHEN_LOCAL` — and applied by `applyEnvOverrides` in `wireRun`, after `wireText`;
  overrides beat the base file and the URL swap. Upsert = replace an existing `VAR=`/`export
  VAR=` line in place, else append; values quoted only when unsafe (non-string values skipped
  with a warning). Also the escape hatch for cross-env wiring (inject a key an env lacks) when
  env derivation + the URL swap don't cover a case. crew stays agnostic — a plain
  per-service table. Edited in `crew config` as **TWO inline Environment Overrides blocks** at the END of each
  service's form (both `kind: 'overrides'`, same row editor, distinguished only by `field.key`): **· shared
  (config)** → `cfg.overrides` (written by `persist()`) and **· local (wins · machine-only)** →
  `machine.overrides` (written by `writeMachine`, loaded via `localOverrides`). Each is an INLINE list, one line
  per override — `VAR = value   when <peer> local` (peer blank = unconditional/bare). Bare `VAR:val` and
  `whenLocal` are flattened into ONE flat row list `{var, value, peer}` (`overridesToRows`) and rebuilt to the
  stored shape on save (`rowsToOverrides`) — so `whenLocal` is a per-row OPTION (the `when local` column, a
  single-select picker of the other services + an "always" choice), NOT a separate field. `⏎` on a block enters
  in-place row-edit (`ovEdit = {field, rows, ri, ci}`, `ci` 0=VAR 1=value 2=when): `↑↓` rows, `←→` columns, `⏎`
  edits the focused cell (VAR/value inline, `when` opens the picker), `d` removes, `esc` commits to
  `form[field.key]`. Both blocks move on rename and clear on delete (shared via `persist`, local via
  `writeMachine` — local.json untouched unless a local override actually changed). `crew check` validates both
  stored forms in BOTH files (`checkOverrides` — a secret-looking key in the shared `config.json` layer WARNs;
  the local layer doesn't).
- No groups, no `run` command. `start`/`workspace`/`claude` act on a **multiselect selection**
  (`selectMembers`, preselected with `lastSelection`); services are never named on the CLI there
  (bare tokens ignored with a warning; only `key=value` args consumed). The picked set is saved to
  `lastSelection` (global, machine-local) and reused across the three. There is NO `install` (or any
  other) run command — `start` is the sole core task (see Task resolution below); `crew install` now
  errors as a retired command. A legacy `groups` key is dropped on load.
- Env derivation (replaces the old `envMap`): `{env}` is NOT a static per-service map — it's
  **derived from the chain** by `resolveEnvs(cfg, selection, selEnv)`. The **entry clusters**
  (source SCCs of the dependency graph — services nothing else in the selection depends on) run
  at the selection env; every other service inherits the env-variant its consumer's env file
  actually points at (host → env via the labeled `match`, below). BFS from the seeds, so the
  claim CLOSEST to an entry wins; within one file the MAJORITY label wins. Cycles (e.g. a
  frontend↔backend URL reference loop) collapse into one entry cluster via `stronglyConnected`
  (Tarjan) — so no reference-marker is needed to keep root-finding correct. Same shared config
  serves multiple teams: beepro-frontend@pre derives sdk-frontend=qa (consumed via the qa
  loader), while sdk-frontend@pre (SDK team's entry) derives sdk-api=pre. Disagreements, missing
  envs and unreached nodes are collected as warnings (surfaced by `crew start`, printed by
  `crew resolve`), never silently mis-resolved. `crew resolve <env> [proj…]` is the read-only
  dry-run. Feeds the start command, the `env` file path, and wiring. crew stays agnostic — env
  names are free-form; no hardcoded env list.
- `match` (per service): an **env-labeled map** `{ "<env>": host | [hosts] }` of the service's
  deployed host(s) — exact strings, each optionally narrowed by a **path** (`host` or
  `host/path/prefix`; `tokenMatchLen`, no globs, no collisions: `api.getbee.io` never matches
  `rge-api.getbee.io`). Partial/free-form keys OK (label only the envs a service has — the loader
  has just `qa`/`pro`). Edited in `crew config` as an INLINE `match` field (one `env = host` line per env),
  with the env keys DERIVED from the service's env files (see the `match` field-kind below) — you fill hosts,
  you don't invent env labels. `serviceIdentity` flattens the values into identity `tokens` (edges +
  wiring) and builds `envOf` (host → env label — the basis for env derivation). A host-only token
  swaps just the origin in wiring (path preserved); a **host+path** token matches only URLs on
  that host under that path AND replaces the WHOLE URL with the peer's full `local` — so two
  services sharing a host but differing by path stay distinct, and a local path can differ from
  the deployed one (e.g. `…-app-rsrc…/plugin/v2/BeePlugin.js` → `localhost:8088/v2/api/loader`;
  for a path token, set `local` to the full local URL incl. path). `crew graph` derives edges
  from `.envs/*` URLs (incl. dotfile `.env.<env>`); `crew start` warns when a co-running set isn't
  connected. `crew graph` (`collectGraphEdges` → `renderAsciiGraph` in `bin/graph.js`) draws the
  graph as a laid-out ASCII diagram (boxes, per-source colored double-line dep edges, thin single
  reference edges, `╦╤` box-connect T-junctions) — our own zero-dep layered-DAG renderer, no external
  tool. On a TTY it's shown in an alternate-screen pager (`pagerView`: `↑↓` scroll — shown only when the
  graph overflows — `f` opens the node filter, `r` toggles reference edges, `esc` quits leaving no
  scrollback); piped/redirected → plain print. `crew graph list` prints the adjacency text instead.
  Both graph UIs — the pager AND the start/workspace/claude selector (`graphSelect`) — share one footer
  builder `graphFooter({mode, total, sel, vis, shown, hasRef, showRef, warn, scroll})` (order: state → move
  → `f`/`r` toggles → action → exit) which returns `footerText(parts)`; the caller paints it with the
  shared `footerBar(inner, cols)` (full-width reverse-video). The guards editor uses the same two helpers,
  so ALL raw-mode footers are one treatment. The pager shows one `shown/total` count; the selector shows TWO —
  `sel/total sel` (services picked to run) then `vis/total shown` (nodes left visible after the `f` filter).
  Any count that isn't full turns RED (via `\x1b[31m…\x1b[39m`, so it survives the reverse-video bar). Both
  UIs share one ref filter (`e => showRef || !e.ref`) and one node-visibility filter: `f` overlays a
  right-anchored multiselect panel (`makeFilterPanel`) ON the graph's rightmost columns — the graph stays
  drawn (no screen clear, unlike a full-screen `menu()`) and updates LIVE: `space`/`a` toggle a node and
  redraw the graph immediately (a snapshot is taken on open), `↵` confirms + persists, `esc` reverts to
  the pre-open state. In the selector, hidden nodes are also dropped from the run set. `r` toggles refs.
  Both UIs process input one key at a time via a `handleKey` fed from `splitKeys` — one stdin chunk can
  bundle several keys (e.g. Enter then esc as `"\r\x1b"`), so a mode-closing key mid-chunk must not swallow
  the rest (Enter applies/commits AND the trailing esc still acts). `splitKeys` keeps CSI/SS3 sequences
  whole and treats a lone `\x1b` as its own key — it merges `ESC`+char ONLY for `Alt-b`/`Alt-f` (word-jump),
  so a coalesced "Esc then s" (`"\x1bs"`) parses as `[esc, s]`, not a bogus `Alt-s` (which would be dropped).
  Both prefs are machine-local (`local.json`) and shared across the two UIs: `graphRefs` (show-refs) +
  `graphShown` (node filter) — see `loadGraphRefs`/`saveGraphRefs`/`loadGraphShown`/`saveGraphShown`,
  mirroring `loadLogWrap`.
- Reference edges (`isReferenceEdge`): a URL from a **non-frontend into a `type: frontend`** service
  is a **reference** (link-back / allowed-origin / redirect base — a backend embedding the app's
  public URL), NOT a dependency. It's still shown by `crew graph` (marked `⇢ … (ref)`) but excluded
  from connectivity AND env derivation — so a backend that merely links to the frontend can't make an
  unrelated selection look "connected" nor seed the frontend's env. Only `frontend→frontend` edges
  (one app embedding another) stay real. Uses the declared `type` only; no per-edge config/marker.
- `env` (per service): the env-file path template — the SINGLE source of truth for env-file location
  (drives `{envfile}` wiring AND graph/derivation discovery). `serviceEnvFiles` resolves it by globbing
  `{env}` (captured consistently across every occurrence, so `.envs/{env}`, `.envs/{env}-slug.env`,
  `.envs/.env.{env}`, and nested `../.envs/<app>/{env}/{env}-foo.env` monorepo layouts all enumerate
  their variants). No `env` (or a static path with no `{env}`) → the default `<dir>/.envs` scan (`envFilesFor`).
- Task resolution per service: `tasks[task]` -> skip (the `runner` fallback + the `defaultBranch` metadata
  key were both retired — legacy values auto-strip on load; see `migrate`). `crew start` (`cmdStart`)
  is the ONLY core run command — task `start`, plus its per-node `debug` variant; a service's OTHER `tasks`
  are just data with no core command yet (a future generic runner will funnel them). In `crew config`,
  `start` AND `debug` are **dedicated text fields** (stored as `tasks.start` / `tasks.debug`); the `tasks`
  map holds only the OTHER tasks. `debug` is optional — filling it is what enables the per-node `d` toggle.
- **Per-node debug toggle** (`crew start` only): in the graph selector, `d` flips the focused node into
  debug mode — it launches `tasks.debug` instead of `tasks.start`. Only offered when the node is running
  locally (ON) AND has a `tasks.debug` (`canDebug`); the `d` hint + `[debug]` box sublabel appear only
  then. It's a per-member override: `membersFor(cfg, picked, debug)` tags those members `task:'debug'`,
  and `resolveRun` uses each member's own task (`m.task || task`), so a mixed slice runs some `start` and
  some `debug` in one `crew start` (same viewer/wiring/guards — debug is NOT a separate command). debug ⊂
  the run selection (deselecting/hiding a node clears its debug flag); the set is remembered in
  `local.json.lastDebug`. Gated by `opts.debugToggle` so it's start-only — the shared selector shows
  nothing debug-related for `workspace`/`claude` (which don't run tasks) and never clobbers `lastDebug`.
  Each service owns its debugger command + port (`node --inspect=:9230 …`, `python -m debugpy …`, `next
  dev`), so it's language-agnostic. The graph selector is the ONLY picker now (`--list` and its flat
  multiselect were retired — `crew start --list` errors as an unknown flag).
- `guards`: top-level `guards: {name: {comment, command, message}}` registry; a service lists
  names in `service.guards` (many-to-many). `comment` is required and states what the check
  verifies — it's printed in faint gray beside each result when guards run. Before a run, the
  target's guards are deduped by name, run once each in parallel (pass = exit 0); any failure
  prints its message and aborts. Run before `crew start`. Managed via
  the **visual editor** below (`crew config` → Guards section: create/update/delete/link).
- **Visual editor (`configForm`, TTY-only)**: `crew config` is the SOLE config command — one two-pane raw-mode
  editor for everything. Left column stacks the SECTIONS (Settings + Services + Guards) as a
  name list, each item-section ending in a green `+ New …` row; scroll (`↑↓`) to reach a section. The right
  column is the highlighted item's form. The three actions fall out of
  position + key — CREATE = a `+ New` row (blank form), UPDATE = edit fields then `s` save, DELETE = `d` +
  confirm. **Settings** is a `fixed` section (one synthetic `config` item, NO `+ New`/`d` — you only edit
  values): the machine-local `editor` (a `choice`) + `servicesDir` (both live in `local.json`, not the shared
  config), so `crew config` covers every machine-local key (and editing `servicesDir` shows a live
  `⚠ N/M service folders not found` warning via `missingServiceFolders`, never auto-deleting anything).
  The `editor` picker grays out (dims) editors whose binary isn't on PATH via a per-field `paint`
  (`onPath` + `editorPaint`; `openPanel` honors `fld.paint || paint`). `(none)` sentinel clears it.
  Field KINDS: `text` (a real inline line-editor with a block caret — `←/→` move, Option/Ctrl+arrow
  word-jump, Home/End or Ctrl-A/E, Ctrl-W/U/K, forward-delete, mid-string insert; pre-fills current value),
  `name` (the item key, rename-aware, same editor),
  `choice` (SINGLE-select — radio `(•)`, `↑↓`+`⏎`, e.g. service `type`),
  `multiselect` (MULTI — checkboxes `[x]`, `space`/`a` toggle, e.g. a service's guard links),
  `map` (a **row editor** — `key → value` rows + a green `+ add`; `⏎` on a row edits its value via the same
  line-editor, `+ add` chains key→value, `d` removes; e.g. service `tasks` (task→cmd); the form carries these
  as objects, serialized on `save`; a `json` map (parses each value so `false`/`3` keep their type — no
  field currently uses this kind since `workspaceSettings` was retired), `list` (the same row editor
  minus the key column — one value per row, carried as a string array; no field currently uses this kind),
  `overrides` + `match` (INLINE row editors — drawn as a bordered BOX in the form, NOT a full-pane takeover,
  so each reads as a distinct container you `⏎` INTO; focused = reversed title bar + bright border, else dim.
  Each box is padded to `BOX_MIN_ROWS` body rows so scrolling between services with different row counts
  doesn't jump the layout. Titles: `Environment hosts` (match), `Environment overrides · shared` / `· local`.
  Edited in place via the shared `ovEdit` mode; `⏎` enters row-edit, `↑↓` rows). `overrides` = a service's env
  overrides, 3 columns `VAR / value / when <peer> local` (`←→` between columns, `+ add`, `d` removes; the
  when-column opens a single-select peer picker). `match` = env-labeled hosts, 2 columns `env = host` with
  **FIXED keys** — the env labels are DERIVED from the service's env files (`matchLabels` = `serviceEnvFiles`
  unioned with any stored labels), so rows can't be added/removed, only each host value filled (blank = no
  match; space-separate for several hosts → array via `matchCommit`). `readonly` (display only). Editing any of choice/multiselect/map **TAKES OVER the whole right pane**
  (full width + height, left column stays for context) rather than a cramped popup — so long task commands /
  match hosts have room, and `text`/`map` cells horizontally scroll to keep the caret in view (`editCell`).
  choice/multiselect reuse `makeFilterPanel`'s state/keys via `bareRows(h, w)` (unboxed, full-width); the
  graph views still use its boxed `.rows()` overlay. Every editor write goes through `persist()` =
  `writeUserConfig(path, pruneConfig(cfg))` — a WHOLE-FILE rewrite of the one in-memory `cfg` (loaded once at
  open; last-writer-wins over external edits) that also **strips unknown keys** (`pruneConfig` whitelists
  top-level to `TOP_KEYS`, per-service to `SERVICE_KEYS`, per-guard to `GUARD_KEYS`), so a save normalizes the
  file. (The migration write-back in `loadUserConfig` does NOT prune — load never silently strips.) Each
  section owns `load/save/del`: Services/Guards write the user config via `persist()`; the Settings
  `servicesDir` field AND each service's **local** overrides block write `local.json` via `writeMachine`.
  Env **overrides live on the SERVICE form** as the TWO inline **Environment Overrides** blocks described above
  (`kind: 'overrides'`; `overridesToRows`/`rowsToOverrides` round-trip) — the **shared** block
  (`cfg.overrides[service]`, `persist()`) and the **local** block (`machine.overrides[service]`,
  `writeMachine`); both move on a rename and are deleted with the service, so there's no separate Overrides
  section. **Semi-auto add**: `⏎` on a service's `path` field opens
  a **folder picker** (`openFolderPick` — the subfolders of `servicesDir` via `serviceDirs()`, single-select,
  plus a `✎ type a path…` escape that drops to the inline editor). Picking a folder (or committing a typed
  path) for a NEW service runs `detectService(abs)` and prefills only the still-EMPTY fields — `name`
  (basename), `type`/`env`/`local`/`start` — from package.json / lockfiles / manifests /
  `.envs` / dev scripts. `match` (the deployed host) is deliberately NOT derived — the guess was too weak,
  so it's always filled by hand. Path-driven,
  not a separate "auto" mode: works with no `servicesDir` (type an absolute/`~` path via the escape) and for
  folders outside it; non-destructive (blanks only). A service's `path` field VALUE renders the RESOLVED
  absolute location (servicesDir + relative), or a red "not found — check your services dir" when the folder
  is absent (the fix is almost always the machine-local servicesDir, not the shared `path`). **servicesDir
  browser**: `⏎` on the Settings `servicesDir` field opens a multi-column (Miller/Finder-style) navigator
  (`openBrowse` → `browse = {cols:[{dir,entries,cursor,scroll}], ci}`): the FULL ancestry chain from `/` down
  to the current dir, one column per level; `←/→` move between columns (right = into the highlighted folder,
  left = up), `↑↓` within the active column (the next column live-previews the highlight via `browsePreview`),
  `⏎` SELECTS the highlighted folder (stored tildified), `t` drops to typing a path, `esc` cancels. Columns
  scroll vertically (cursor-follow) and horizontally (window shows the rightmost that fit; `‹ ›` in the header
  mark scrolled-off levels); a dim `│` divides columns. NB: inside the `configForm` Promise executor `resolve`
  is the Promise resolver (shadowing `node:path.resolve`) — use `join`/`dirname` there.
  Renaming a guard migrates its key AND every
  `service.guards` link; deleting a guard unlinks it everywhere (warns if in use). A `readonly` field with a
  `.hint` shows it as a status message on `⏎`. Every field can carry a `desc` string — the FOCUSED field's
  `desc` is word-wrapped and rendered as a dim help block pinned under the form (only while the RIGHT pane is
  focused; no keypress;
  hidden during a sub-editor takeover). `↑↓` move, `tab`/`←→` switch pane, `s` writes (that item, to
  disk). A `dirty` flag is set on any field/map/pick mutation. **Edits are a whole-session working copy**: a
  `drafts` Map (keyed by section+item, a NEW item uses a sentinel slot) holds every edited-but-unsaved form —
  `stashDraft` parks the current form before any navigation and `loadForm` returns the SAME draft ref if one
  exists, so edits to ANY item survive leaving and returning (nothing rolls back until you save or discard).
  Nothing is written to disk until `s` (that item) or **save all** on exit. **`esc` is level-by-level**: in
  the RIGHT pane (a field / editing a cell / a sub-editor) it steps back one level — cell-edit → field →
  the item LIST — never quitting the editor from the right; only from the LEFT list does `esc` quit. So the
  full climb out is edit → `esc` field → `esc` list → `esc` quit. When it does quit, `esc` `stashDraft`s then, if
  `drafts.size`, opens the **`modal`** — a reusable centered-box prompt
  (`{title, lines, choices:[{keys, label, run()->doneBool}]}`) that captures every key until a choice runs:
  here `s` **save all** & exit (`saveAll` validates each draft, jumping to the first offender) / `d` **discard
  all** & exit (`discardAll`) / `esc` cancel. The delete confirm uses the same `modal`
  (`y`/`esc`). `Ctrl-C` force-quits regardless. Same raw-mode primitives as the graph views
  (`splitKeys`, alt screen, absolute cursor). Its `repaint` composes from `\x1b[H` + a per-row `\x1b[K` (every
  row is rewritten each frame), NEVER a full-screen `\x1b[2J` — `2J` pushes the erased lines into scrollback on
  some terminals, which made the editor "scrollable" (a **"spirit"** left behind); the pager + log viewer already
  paint this way, so all three leave no scrollback. Same footer too: every raw-mode view renders its hint line
  through the shared `footerText` (` · `-joined parts) + `footerBar` (one full-width reverse-video bar) —
  `graphFooter` also returns `footerText(parts)`, so the graph pager, selector and config editor bars are
  byte-for-byte the same treatment. `crew config` (no args) is the only entry. The whole old config surface —
  `crew add`, `crew remove`, `crew guards` (+ `add/remove/link/unlink`), `crew overrides` (+ `set/remove`)
  and the sequential wizard — was RETIRED into this editor; those verbs now error with a pointer to `crew
  edit` (the `cmdGuards`/`cmdOverrides`/`guardList`/`overrideList`/`makePrompter`/`confirm`/`collectService`/
  `detectDefaultBranch` code was all deleted). The
  v1 `checks` key auto-migrates to `guards` on load; `projects`->`services` and `projectsDir`->`servicesDir`
  renames migrate too; legacy `longRunning` (top-level), per-service `runner`/`defaultBranch`, and the retired
  top-level `workspaceName`/`workspaceSettings` are stripped.
- **`crew workspace` — editor abstraction.** The editor is **machine-local** (`local.json.editor`, per-developer
  like `servicesDir`) with **NO default**: unset ⇒ `crew workspace` is disabled with a "no editor configured"
  error (gated BEFORE the picker). `resolveEditor` maps a built-in id (`EDITORS`: vscode/cursor/codium/
  vscode-insiders → `workspace-file`; zed/intellij/pycharm/goland/webstorm/nvim → `folders`) OR an escape-hatch
  object `{bin, kind}` to `{bin, kind, label}`. TWO kinds: **`workspace-file`** (VS Code family) materializes a
  `.code-workspace` (`{folders, settings}`) and opens THAT file; **`folders`** (Zed/JetBrains/Neovim) passes the
  resolved dirs straight as CLI args (no file). The `.code-workspace` **filename IS the VS Code title** (it reads
  no `name` key), so it's the short **auto-label** `workspaceLabel(members)` — strips the `xxx-` prefix all picked
  services share, first 2 names, `+Nmore` for the rest (`bee-auth+bee-cloudstorage+bee-fsp-x` → `auth+cloudstorage+1more`).
  Its `settings` are the **baked** `VSCODE_WORKSPACE_SETTINGS` constant (`{ 'jest.enable': false }`) — deliberately
  NOT a config field (the `.code-workspace` is crew-owned, touches no repo file); edit the constant to change it.
  `workspaceName` + `workspaceSettings` config keys are RETIRED (migrate-stripped). `crew claude` is separate
  (Claude Code, not an editor) and untouched.
- `crew start` always STREAMS: each service spawns and the first exit (any) or Ctrl-C tears the whole
  group down (`runFanout` `killOthers`). There is NO run-to-completion mode and no `longRunning` config —
  `start` is the one core command and is always a service (see `cmdStart`). (`runFanout` still supports a
  non-kill-others / wait-all mode, but nothing calls it now that `install` is gone.)
- Runner (`runFanout`): each command spawns `detached` in its own process group; teardown
  signals the group by pgid (`kill(-pgid)`) with SIGTERM -> grace -> SIGKILL escalation, so
  reparented grandchildren (autoreload children, supervisord) die too — unlike a ppid
  tree-kill. Grace via `CREW_KILL_GRACE_MS` (default 5000). Colored `[name]` prefixes reuse
  the `crew list` per-service colors; `FORCE_COLOR` is set for children when the parent is a
  TTY. `emit` routes each proc's output to the interactive viewer (below) when active, else
  streams it straight through with per-line prefixes.
- Interactive log viewer (`runFanout` with `interactive`, set by `cmdRun` only for streamed
  mode on a TTY): a `viewer` object on an **alternate screen** (`\x1b[?1049h`) that keeps a
  tagged line `history` (cap `CREW_LOG_HISTORY`, default 5000) and `repaint`s a filtered view —
  `emit` routes to `viewer.feed` (splits on `\n`, buffers partials in `pending`, live-`render`s
  a line only when its service is in `shown`). `feed` caps each line's length at `MAX_LINE`
  (`CREW_MAX_LINE`, default 4000) and flushes an unterminated remainder longer than that — so a
  newline-less spew (minified bundle, base64/binary) can't grow `pending` unbounded or make
  `splitRows`/`repaint` explode into hundreds of thousands of rows (which previously wedged the viewer). Pre-run
  messages — task **skips** + **warnings** (from `resolveRun`: the unused-arg + env-derivation warnings; AND from
  `wireRun`: env-override warnings) — are passed to `runFanout` as `notices` and **seeded into `history` as
  `{notice:true}` rows** (unprefixed, ignore the `f` service filter, honor `/` search, excluded from `c` copy).
  This is the anti-**"spirit"** rule: in interactive mode those messages must NOT be `console.log`/`warn`ed to the
  MAIN screen (they'd survive the viewer's alt-screen exit as scrollback residue) — so `cmdStart` prints skips/warnings
  inline ONLY when `!interactive` (piped, no alt screen). `resolveRun` and `applyEnvOverrides`
  therefore COLLECT their warnings into their return value instead of printing. `f` opens the `menu` multiselect (preselected =
  `shown`); applying repaints from history, so **select none = blank screen** and re-showing a
  service brings its recent lines back. Footer pinned to row R via a DECSTBM scroll region
  (`\x1b[1;R-1r`). `Ctrl-C`/`esc` -> `requestStop` (shared graceful-stop; raw mode swallows
  SIGINT). `menu()` pauses stdin + drops raw mode on close, so `openFilter` re-asserts
  `setRawMode(true)`+`resume()` after or keys go dead. `detachKeys` (called in `settle`) resets
  the region + leaves the alternate screen. No-op when piped/CI (`viewer` stays null).

## Testing

**New behavior ⇒ new test — always, unprompted.** Every new command/flag/config field/interactive
affordance (a selector key, a picker, a footer state) SHIPS WITH a `tests/e2e` case in the same change,
and a `tests/snapshots` golden if it alters a graph render. A feature without a test is not done — add a
fixture under `tests/e2e/fixtures/<fx>/` + a `cases/<fx>__<scenario>.exp` that drives it in the PTY and
asserts the observable result (not internals). Adding a config field also means updating
`TOP_KEYS`/`SERVICE_KEYS`/`GUARD_KEYS` + `cmdCheck` + `pruneConfig`. Run the full suite (`npm test`) and
keep it green before calling anything finished.

No unit-test framework. Three suites, all run by `npm test`:
- `tests/snapshot.mjs` — the graph renderer (imports `bin/graph.js`; golden mono renders).
- `tests/e2e/` — **portable black-box E2E driven by `expect`** (a real PTY, so the interactive picker,
  wizard, and log viewer are exercised as a user would). Every case runs the crew BINARY (`$CREW`,
  default `node bin/crew.js`) — it imports NOTHING from the source, so a port to another language keeps
  the whole suite: `CREW=./crew-rs sh tests/e2e/run.sh`. Layout: `run.sh` copies `fixtures/<fx>/` to a
  tmp dir (sed `__DIR__`→tmp in `local.json`) and runs each `cases/<fx>__<scenario>.exp`; `lib.exp`
  gives the helpers `crun`/`must`/`want_exit`/`want_done`/`config_has`/`local_has`. Covers check (+error/exit
  codes), v1 migration (asserts the rewritten config), graph/resolve/list, dir (+ orphan warning)/config
  (path + removed `edit`), the visual editor (`crew config`, scrolling to the Settings/Services/Guards
  sections: create/update/delete/map-rows/pick panels), the retired-command errors
  (`add`/`remove`/`guards`/`overrides`/`install`), and the runner: `crew start`
  (picker → streamed viewer + teardown),
  `workspace`/`claude` (via `code`/`claude` stubs on `PATH`), env wiring + guards. Interactive tips:
  `spawn`-in-a-proc needs `global spawn_id`; the graph `pager`/picker/viewer are raw-mode alt-screen so
  quit them (`esc`/Ctrl-C) or they hang; `crew start` ALWAYS streams, so a start case must drive the viewer
  (assert its output, then `send "\033"` + `want_done` — the viewer holds open once every child exits);
  `crew start` REQUIRES `env=<name>` (errors before the picker without it — pass `env=x`).
  Coverage: `npm run test:cov` (c8 over `NODE_V8_COVERAGE`);
  it's black-box so it works per-language (Go `-cover`+`GOCOVERDIR`, Python coverage.py) — same tests.
- `tests/tui/` — **TUI screen goldens**: expect drives `$CREW` in a PTY (like e2e) but records the raw
  output between explicit `snap` points; `render.mjs` (a ~100-line vendored ANSI→character-grid
  interpreter: CUP/EL/ED/SGR-strip/alt-screen/scroll-region — the subset any sane implementation emits)
  renders each segment to a SCREEN, diffed against `golden/<case>.txt`. Goldens are grids, not byte
  streams — a port that paints the same screen passes whatever escapes it used. `-u` regenerates.
  Determinism rules: fixed 100x30 PTY, tmp dirs under a SHORT root (`/tmp/crew-tui.XXXXXX` — long
  macOS $TMPDIR paths display-clip to `…` before the `__TMP__` normalization can match), fixtures with
  FIXED output (no timers/counters), and `snap` drains the PTY first (expect only reads while
  expecting — an undrained buffer stalls the app on stdout backpressure and frames land in the wrong
  segment). No tmux anywhere in the tests: expect is the PTY, render.mjs is the screen.

Harness gotchas learned the hard way (apply to new e2e cases too): keystrokes sent back-to-back
coalesce into one stdin chunk — the viewer's search input deliberately ignores multi-char chunks, so
type through per-key `must` assertions (which also drain the PTY; long sleeps between sends can stall
the app on a full PTY buffer). Tcl regex has no `\S` inside brackets — its `.` already spans newlines.

Audit notes (for a port): `crew start` requires a full TTY for the picker, so the piped/non-interactive
branches in cmdStart/runGuards/render are UNREACHABLE from the CLI today (defensive code, not spec);
resolveEnvs' unreached-node re-seed loop is likewise defensive (ref edges are skipped entirely, so
source-seeding reaches everything). `crew upgrade` is e2e-tested via an `npm` stub on PATH driven by
`CREW_TEST_LATEST`; `crew pull` via a throwaway node http server spawned inside the case.


Also verify manually against a throwaway config (no build — run the file):

```sh
node --check bin/crew.js
node bin/crew.js --config /tmp/x.json list
node bin/crew.js --config /tmp/x.json graph            # read-only, no TTY needed
node bin/crew.js --config /tmp/x.json check            # validate; exit 1 on errors
```

`start`/`workspace`/`claude` open the picker, so they need an interactive TTY
(non-TTY = clear error); `list`/`graph`/`check`/`resolve` work non-interactively.

`crew check` (`cmdCheck`) is the hand-rolled, zero-dep config validator — NO JSON-Schema
library (would break the zero-deps constraint) and NO separate schema file (would break the
single-file constraint). It validates the merged config + `local.json`: known-key sets
(`TOP_KEYS`/`SERVICE_KEYS`/`GUARD_KEYS`), types, and cross-references a schema can't express
(guard names must exist; `{envfile}` needs `env`; `match` must be an env-labeled object of bare hosts, not globs;
`match` without `local` is a dangling wiring target). Errors exit 1; warnings don't. Keep its
key sets in sync when adding a config field.

## Non-goals

No task dependency graph, no ordering, no caching, no build-system behavior, no
terminal/pane spawning, no health checks. That is make/turbo/nx territory.
