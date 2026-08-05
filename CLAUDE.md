# CLAUDE.md

Guidance for working in this repo.

## Commits & PRs

- Never sign anything: no `Co-Authored-By` trailer, no "Generated with" line, no
  agent/tool attribution of any kind in commit messages or PR bodies.
- Single-line commit messages only — no body.

## What crew is

A single-file macOS CLI that fans a **named task** out across a group of local
projects — run tasks in parallel, open the set as one VSCode workspace, or hand it to
Claude Code. crew owns the fan-out (parallelism, labelled output, exit-code aggregation,
lifecycle); each **project** owns task semantics. crew never interprets a task beyond
`{placeholder}` substitution.

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
  shell-quote every substituted value. Hardcode no task names/values beyond
  `config.longRunning`.

## Config

- User-level: `~/.config/crew/config.json` (v2 schema). Project-local `./.crew.json`
  merges on top. v1 configs migrate to v2 on load (`start.command` -> `tasks.start`).
  `crew pull <url>` fetches a `config.json` from a URL (zero-dep `node:http(s)`, follows
  redirects, validates it has `projects`) and installs it, backing up the current one to
  `config.json.bak`; `local.json` is untouched.
- `projectsDir` (machine-local — stored in `local.json` beside the config, set via
  `crew config` → Settings, never in the committable `config.json`): relative project
  `path`s resolve against it; `~`/absolute paths are used as-is. Changing it can orphan every relative-path
  project, so both setters WARN (`missingProjectFolders(cfg, dir)` → `⚠ N/M project folder(s) not found`)
  but never touch the config — the fix is correcting the dir/paths, never bulk-deleting projects. So `config.json`
  (projects/guards, relative paths) is directly committable; a legacy `projectsDir`
  in `config.json` auto-migrates to `local.json` on load. `local.json` reads from beside
  the resolved config (works with `--config`); gitignore it when committing. `local.json`
  also holds `lastSelection` (the remembered picker selection) and `overrides` (below).
- `overrides` (machine-local — in `local.json`, so secrets/personal values never touch the
  shared `config.json`): extra env vars upserted into a project's **wired** env file (the one
  crew materializes for `{envfile}`; a project without `{envfile}` can't be overridden).
  `overrides["<project>"]` has two entry kinds: bare `VAR:val` applied whenever `<project>`
  starts (self/unconditional — e.g. a Temporal queue so the local worker consumes `foo-local`
  not shared `foo`); and `whenLocal: {"<peer>": {VAR:val}}` applied only when `<peer>` is also
  being started (`running` set in `wireRun`) — e.g. point a URL at a local dependency's exact
  host+path (which the host-only URL swap can't do), but only while it's up. Resolved by
  `overrideVarsFor(overrides, name, running)` (`whenLocal` wins over bare; reserved key
  `OVERRIDE_WHEN_LOCAL`) and applied by `applyEnvOverrides` in `wireRun`, after `wireText`;
  overrides beat the base file and the URL swap. Upsert = replace an existing `VAR=`/`export
  VAR=` line in place, else append; values quoted only when unsafe (non-string values skipped
  with a warning). Also the escape hatch for cross-env wiring (inject a key an env lacks) when
  env derivation + the URL swap don't cover a case. crew stays agnostic — a plain
  per-project table. Edited in `crew config` as two `map` fields at the END of each project's form —
  `envOverride` (bare `VAR:val`) and `whenLocal` (flattened `peer.VAR`→val rows) — which write `local.json`
  (moved on a project rename, cleared on delete; empty = no entry). `crew check` validates both forms.
- No groups, no `run` command. `start`/`workspace`/`claude` act on a **multiselect selection**
  (`selectMembers`, preselected with `lastSelection`); projects are never named on the CLI there
  (bare tokens ignored with a warning; only `key=value` args consumed). The picked set is saved to
  `lastSelection` (global, machine-local) and reused across the three. `install` is the exception:
  it acts on a **single** project chosen from a single-select picker (no CLI name; bare tokens ignored
  with a warning; doesn't touch `lastSelection`). A legacy `groups` key is dropped on load.
- Env derivation (replaces the old `envMap`): `{env}` is NOT a static per-project map — it's
  **derived from the chain** by `resolveEnvs(cfg, selection, selEnv)`. The **entry clusters**
  (source SCCs of the dependency graph — projects nothing else in the selection depends on) run
  at the selection env; every other project inherits the env-variant its consumer's env file
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
- `match` (per project): an **env-labeled map** `{ "<env>": host | [hosts] }` of the project's
  deployed host(s) — exact strings, each optionally narrowed by a **path** (`host` or
  `host/path/prefix`; `tokenMatchLen`, no globs, no collisions: `api.getbee.io` never matches
  `rge-api.getbee.io`). Partial/free-form keys OK (label only the envs a project has — the loader
  has just `qa`/`pro`). `projectIdentity` flattens the values into identity `tokens` (edges +
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
  `sel/total sel` (projects picked to run) then `vis/total shown` (nodes left visible after the `f` filter).
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
- Reference edges (`isReferenceEdge`): a URL from a **non-frontend into a `type: frontend`** project
  is a **reference** (link-back / allowed-origin / redirect base — a backend embedding the app's
  public URL), NOT a dependency. It's still shown by `crew graph` (marked `⇢ … (ref)`) but excluded
  from connectivity AND env derivation — so a backend that merely links to the frontend can't make an
  unrelated selection look "connected" nor seed the frontend's env. Only `frontend→frontend` edges
  (one app embedding another) stay real. Uses the declared `type` only; no per-edge config/marker.
- `env` (per project): the env-file path template — the SINGLE source of truth for env-file location
  (drives `{envfile}` wiring AND graph/derivation discovery). `projectEnvFiles` resolves it by globbing
  `{env}` (captured consistently across every occurrence, so `.envs/{env}`, `.envs/{env}-slug.env`,
  `.envs/.env.{env}`, and nested `../.envs/<app>/{env}/{env}-foo.env` monorepo layouts all enumerate
  their variants). No `env` (or a static path with no `{env}`) → the default `<dir>/.envs` scan (`envFilesFor`).
- `defaultBranch` (optional, per project): the branch new work is cut from (repos differ —
  `main`/`master`/`develop`/`trunk`). Pure metadata crew records/displays (`crew list` shows a
  `branch` line); crew runs no git with it. Set it in `crew config` (the `branch` field of a project).
- Task resolution per project: `tasks[task]` -> `runner` with `{task}` -> skip.
- `guards`: top-level `guards: {name: {comment, command, message}}` registry; a project lists
  names in `project.guards` (many-to-many). `comment` is required and states what the check
  verifies — it's printed in faint gray beside each result when guards run. Before a run, the
  target's guards are deduped by name, run once each in parallel (pass = exit 0); any failure
  prints its message and aborts. Run before `crew start`. Managed via
  the **visual editor** below (`crew config` → Guards section: create/update/delete/link).
- **Visual editor (`configForm`, TTY-only)**: `crew config` is the SOLE config command — one two-pane raw-mode
  editor for everything. Left column stacks the SECTIONS (Settings + Projects + Guards) as a
  name list, each item-section ending in a green `+ New …` row; scroll (`↑↓`) to reach a section. The right
  column is the highlighted item's form. The three actions fall out of
  position + key — CREATE = a `+ New` row (blank form), UPDATE = edit fields then `s` save, DELETE = `d` +
  confirm. **Settings** is a `fixed` section (one synthetic `config` item, NO `+ New`/`d` — you only edit
  values): the top-level config keys (`workspaceName`/`longRunning`/`workspaceSettings`) +
  machine-local `projectsDir`, so `crew config` covers EVERY key (and editing `projectsDir` shows a live
  `⚠ N/M project folders not found` warning via `missingProjectFolders`, never auto-deleting anything).
  Field KINDS: `text` (a real inline line-editor with a block caret — `←/→` move, Option/Ctrl+arrow
  word-jump, Home/End or Ctrl-A/E, Ctrl-W/U/K, forward-delete, mid-string insert; pre-fills current value),
  `name` (the item key, rename-aware, same editor),
  `choice` (SINGLE-select — radio `(•)`, `↑↓`+`⏎`, e.g. project `type`),
  `multiselect` (MULTI — checkboxes `[x]`, `space`/`a` toggle, e.g. a project's guard links),
  `map` (a **row editor** — `key → value` rows + a green `+ add`; `⏎` on a row edits its value via the same
  line-editor, `+ add` chains key→value, `d` removes; e.g. project `tasks` (task→cmd) and `match` (`multiVal`
  groups duplicate keys into host-arrays); the form carries these as objects, serialized on `save`; a `json`
  map (`workspaceSettings`) parses each value so `false`/`3` keep their type), `list` (the same row editor
  minus the key column — one value per row, e.g. `longRunning`, carried as a string array),
  `readonly` (display only). Editing any of choice/multiselect/map **TAKES OVER the whole right pane**
  (full width + height, left column stays for context) rather than a cramped popup — so long task commands /
  match hosts have room, and `text`/`map` cells horizontally scroll to keep the caret in view (`editCell`).
  choice/multiselect reuse `makeFilterPanel`'s state/keys via `bareRows(h, w)` (unboxed, full-width); the
  graph views still use its boxed `.rows()` overlay. Every editor write goes through `persist()` =
  `writeUserConfig(path, pruneConfig(cfg))` — a WHOLE-FILE rewrite of the one in-memory `cfg` (loaded once at
  open; last-writer-wins over external edits) that also **strips unknown keys** (`pruneConfig` whitelists
  top-level to `TOP_KEYS`, per-project to `PROJECT_KEYS`, per-guard to `GUARD_KEYS`), so a save normalizes the
  file. (The migration write-back in `loadUserConfig` does NOT prune — load never silently strips.) Each
  section owns `load/save/del`: Projects/Guards write the user config; the Settings `projectsDir` field AND
  each project's `envOverride`/`whenLocal` fields write `local.json` via `writeMachine`. Env **overrides live on the PROJECT form** (last two fields):
  `envOverride` = per-project bare `VAR:val` (`map`), `whenLocal` = the 2-level `peer→{VAR:val}` flattened to
  `peer.VAR`→val rows (split on the LAST dot — env var names have no dots) and round-tripped to nested on
  save; the project's `save` writes both stores (moving overrides on a rename, deleting them with the
  project), so there's no separate Overrides section. **Semi-auto add**: `⏎` on a project's `path` field opens
  a **folder picker** (`openFolderPick` — the subfolders of `projectsDir` via `projectDirs()`, single-select,
  plus a `✎ type a path…` escape that drops to the inline editor). Picking a folder (or committing a typed
  path) for a NEW project runs `detectProject(abs)` and prefills only the still-EMPTY fields — `name`
  (basename), `type`/`runner`/`env`/`local`/`tasks.start` — from package.json / lockfiles / manifests /
  `.envs` / dev scripts. `match` (the deployed host) is deliberately NOT derived — the guess was too weak,
  so it's always filled by hand. Path-driven,
  not a separate "auto" mode: works with no `projectsDir` (type an absolute/`~` path via the escape) and for
  folders outside it; non-destructive (blanks only). Renaming a guard migrates its key AND every
  `project.guards` link; deleting a guard unlinks it everywhere (warns if in use). A `readonly` field with a
  `.hint` shows it as a status message on `⏎`. `↑↓` move, `tab`/`←→` switch pane, `s` writes. A `dirty` flag
  is set on any field/map/pick mutation and cleared on save (or when navigating loads a fresh item); `esc`
  quits, but if the current form is `dirty` it opens the **`modal`** — a reusable centered-box prompt
  (`{title, lines, choices:[{keys, label, run()->doneBool}]}`) that captures every key until a choice runs:
  here `s` save & exit / `d` discard & exit / `esc` cancel. The delete confirm uses the same `modal`
  (`y`/`esc`). `Ctrl-C` force-quits regardless. Same raw-mode primitives as the graph views
  (`splitKeys`, alt screen, absolute cursor) and the SAME footer: every raw-mode view renders its hint line
  through the shared `footerText` (` · `-joined parts) + `footerBar` (one full-width reverse-video bar) —
  `graphFooter` also returns `footerText(parts)`, so the graph pager, selector and config editor bars are
  byte-for-byte the same treatment. `crew config` (no args) is the only entry. The whole old config surface —
  `crew add`, `crew remove`, `crew guards` (+ `add/remove/link/unlink`), `crew overrides` (+ `set/remove`)
  and the sequential wizard — was RETIRED into this editor; those verbs now error with a pointer to `crew
  edit` (the `cmdGuards`/`cmdOverrides`/`guardList`/`overrideList`/`makePrompter`/`confirm`/`collectProject`/
  `detectDefaultBranch` code was all deleted). The
  v1 `checks` key auto-migrates to `guards` on load.
- `workspaceSettings` (optional top-level object): written verbatim into the generated
  `.code-workspace` `settings` (e.g. `{"jest.enable": false}` to stop the Jest extension
  auto-running per folder). crew injects nothing by default. Edited in `crew config` → Settings (a `json` map).
- Two execution modes by `config.longRunning`: long-running (streamed, first exit or
  Ctrl-C tears the whole group down) vs run-to-completion (wait all, no kill-others,
  pass/fail summary, non-zero if any failed).
- Runner (`runFanout`): each command spawns `detached` in its own process group; teardown
  signals the group by pgid (`kill(-pgid)`) with SIGTERM -> grace -> SIGKILL escalation, so
  reparented grandchildren (autoreload children, supervisord) die too — unlike a ppid
  tree-kill. Grace via `CREW_KILL_GRACE_MS` (default 5000). Colored `[name]` prefixes reuse
  the `crew list` per-project colors; `FORCE_COLOR` is set for children when the parent is a
  TTY. `emit` routes each proc's output to the interactive viewer (below) when active, else
  streams it straight through with per-line prefixes.
- Interactive log viewer (`runFanout` with `interactive`, set by `cmdRun` only for streamed
  mode on a TTY): a `viewer` object on an **alternate screen** (`\x1b[?1049h`) that keeps a
  tagged line `history` (cap `CREW_LOG_HISTORY`, default 5000) and `repaint`s a filtered view —
  `emit` routes to `viewer.feed` (splits on `\n`, buffers partials in `pending`, live-`render`s
  a line only when its project is in `shown`). `feed` caps each line's length at `MAX_LINE`
  (`CREW_MAX_LINE`, default 4000) and flushes an unterminated remainder longer than that — so a
  newline-less spew (minified bundle, base64/binary) can't grow `pending` unbounded or make
  `splitRows`/`repaint` explode into hundreds of thousands of rows (which previously wedged the viewer). `f` opens the `menu` multiselect (preselected =
  `shown`); applying repaints from history, so **select none = blank screen** and re-showing a
  project brings its recent lines back. Footer pinned to row R via a DECSTBM scroll region
  (`\x1b[1;R-1r`). `Ctrl-C`/`esc` -> `requestStop` (shared graceful-stop; raw mode swallows
  SIGINT). `menu()` pauses stdin + drops raw mode on close, so `openFilter` re-asserts
  `setRawMode(true)`+`resume()` after or keys go dead. `detachKeys` (called in `settle`) resets
  the region + leaves the alternate screen. No-op when piped/CI (`viewer` stays null).

## Testing

No unit-test framework. Two suites, both run by `npm test`:
- `tests/snapshot.mjs` — the graph renderer (imports `bin/graph.js`; golden mono renders).
- `tests/e2e/` — **portable black-box E2E driven by `expect`** (a real PTY, so the interactive picker,
  wizard, and log viewer are exercised as a user would). Every case runs the crew BINARY (`$CREW`,
  default `node bin/crew.js`) — it imports NOTHING from the source, so a port to another language keeps
  the whole suite: `CREW=./crew-rs sh tests/e2e/run.sh`. Layout: `run.sh` copies `fixtures/<fx>/` to a
  tmp dir (sed `__DIR__`→tmp in `local.json`) and runs each `cases/<fx>__<scenario>.exp`; `lib.exp`
  gives the helpers `crun`/`must`/`want_exit`/`want_done`/`config_has`/`local_has`. Covers check (+error/exit
  codes), v1 migration (asserts the rewritten config), graph/resolve/list, dir (+ orphan warning)/config
  (path + removed `edit`), the visual editor (`crew config`, scrolling to the Settings/Projects/Guards
  sections: create/update/delete/map-rows/list-rows/pick panels), the retired-command errors
  (`add`/`remove`/`guards`/`overrides`), and the runner: `crew start`
  (picker → run-to-completion AND streamed viewer + teardown),
  `workspace`/`claude` (via `code`/`claude` stubs on `PATH`), env wiring + guards. Interactive tips:
  `spawn`-in-a-proc needs `global spawn_id`; the graph `pager`/picker/viewer are raw-mode alt-screen so
  quit them (`esc`/Ctrl-C) or they hang; `longRunning: []` makes `crew start` run-to-completion (auto-exit
  0); `crew start` REQUIRES `env=<name>` (errors before the picker without it — pass `env=x`).
  Coverage: `npm run test:cov` (c8 over `NODE_V8_COVERAGE`);
  it's black-box so it works per-language (Go `-cover`+`GOCOVERDIR`, Python coverage.py) — same tests.

Also verify manually against a throwaway config (no build — run the file):

```sh
node --check bin/crew.js
node bin/crew.js --config /tmp/x.json list
node bin/crew.js --config /tmp/x.json graph            # read-only, no TTY needed
node bin/crew.js --config /tmp/x.json check            # validate; exit 1 on errors
```

`start`/`install`/`workspace`/`claude` open the picker, so they need an interactive TTY
(non-TTY = clear error); `list`/`graph`/`check`/`resolve` work non-interactively.

`crew check` (`cmdCheck`) is the hand-rolled, zero-dep config validator — NO JSON-Schema
library (would break the zero-deps constraint) and NO separate schema file (would break the
single-file constraint). It validates the merged config + `local.json`: known-key sets
(`TOP_KEYS`/`PROJECT_KEYS`/`GUARD_KEYS`), types, and cross-references a schema can't express
(guard names must exist; `{envfile}` needs `env`; `match` must be an env-labeled object of bare hosts, not globs;
`match` without `local` is a dangling wiring target). Errors exit 1; warnings don't. Keep its
key sets in sync when adding a config field.

## Non-goals

No task dependency graph, no ordering, no caching, no build-system behavior, no
terminal/pane spawning, no health checks. That is make/turbo/nx territory.
