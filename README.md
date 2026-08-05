# crew

![coverage](https://img.shields.io/badge/coverage-80%25-yellowgreen)

Fan a **named task** out across a group of local projects — run it in parallel, open
the group as one VSCode workspace, or hand the whole set to Claude Code. Driven by one
persistent config. Runs via `npx` with nothing to install by hand.

`crew` is thin on purpose. It does **not** know what a task means — `install`, `build`,
`start` are just strings forwarded to each project's own runner (`make`, `npm`, a shell
script). crew owns the fan-out (parallelism, labelled output, exit-code aggregation,
lifecycle); the **project** owns task semantics.

## Install

Run with no install (npx needs the full scoped package name):

```sh
npx @pinkynrg/crew list
```

Or install globally — the command is `crew` once installed:

```sh
npm i -g @pinkynrg/crew
crew list
```

Requires Node >= 18 on a POSIX system (macOS or Linux), with `code` (VSCode CLI) and
`claude` on your PATH. **Zero runtime dependencies** — crew is Node built-ins only,
including its own parallel process runner.

### Update

Self-update in place:

```sh
crew upgrade                      # runs npm i -g @pinkynrg/crew@latest for you
```

Or reinstall manually (npm has no "upgrade one global" command):

```sh
npm i -g @pinkynrg/crew@latest
crew --version                    # confirm
```

`npx @pinkynrg/crew@latest …` always fetches the newest without installing. Your
`~/.config/crew/config.json` is untouched by upgrades (and self-heals any dropped fields
on first load of a newer version).

## The three-tab workflow

The three surfaces are **separate commands** on purpose — each wants its own terminal /
lifecycle. crew never spawns terminals; arrange the tabs (or aliases / npm scripts)
yourself:

| Tab | Command | Owns |
| --- | --- | --- |
| 1 | `crew start` | the dev servers (streams until Ctrl-C) |
| 2 | `crew workspace` | one multi-root VSCode window |
| 3 | `crew claude` | an interactive Claude Code session |

Each opens a **multiselect picker** (preselected with your last pick) and remembers the
selection, so tabs 2 and 3 open the same set you started.

## Quick start

```sh
crew add          # wizard: create a project (run once per project)
crew install      # pick projects, install them (waits, reports pass/fail)
crew start        # pick projects to run locally (remembers your pick)
crew start env=qa # same, passing a placeholder value to the start task
crew workspace    # open the remembered set as one VSCode window
crew claude       # launch Claude Code over the remembered set
crew edit         # wizard: change a project later
```

## Concepts

- **Projects** are the only building block — there are **no named groups**. You choose a
  **set of projects per run** from an interactive **multiselect** (preselected with your
  last pick); projects are never named on the CLI.
- The chosen set is **remembered globally** (machine-local `local.json`) and reused across
  `start`/`install`/`workspace`/`claude` — so `crew workspace` right after `crew start`
  opens the same set. `crew list` shows the current remembered selection.
- Paths are `~`-expanded and resolved relative to the current directory. Before any command
  acts, crew verifies each selected project's `path` exists and fails naming the offender.
- Folder lists (workspace folders, `claude --add-dir`) are **deduped by resolved absolute
  path**, so a project selected twice is never listed twice.

## The runner / tasks model

A task name becomes a command per project, with **no duplication**:

1. `project.tasks[<task>]` if present — an explicit override.
2. else `project.runner` with `{task}` substituted (e.g. `make {task}` → `make build`).
3. else the project is **run-less** for that task and is skipped (with a one-line note).
   Run-less projects still appear in `workspace` and `claude`.

If, after resolution, **no** project in the target can run the task, crew errors and
runs nothing.

### Example config

`~/.config/crew/config.json`:

```json
{
  "version": 2,
  "workspaceName": "crew",
  "longRunning": ["start", "dev", "watch"],
  "projects": {
    "api": {
      "path": "~/code/api",
      "type": "backend",
      "defaultBranch": "main",
      "runner": "make {task}"
    },
    "web": {
      "path": "~/code/web",
      "type": "frontend",
      "runner": "npm run {task}"
    },
    "worker": {
      "path": "~/code/worker",
      "type": "backend",
      "tasks": {
        "start": "AWS_PROFILE=pre_bee ./scripts/run.sh {env}"
      }
    },
    "docs": {
      "path": "~/code/docs",
      "type": "other"
    }
  }
}
```

Here `api` runs any task through `make {task}`, `web` through `npm run {task}`, `worker`
has an explicit `tasks.start` override with an `{env}` placeholder, and `docs` is
run-less (skipped for that task, kept for `workspace`/`claude`).

`defaultBranch` (optional) records the branch new work is cut from — repos differ
(`main`/`master`/`develop`/`trunk`). It's pure metadata: `crew list` shows it as a `branch`
line and `crew add`/`edit` prefills it from the repo (`origin/HEAD`, else current branch);
crew runs no git with it.

### Placeholders & args (strict)

Resolved commands may contain `{name}` placeholders. `{task}` is filled automatically from
the task name; `{envfile}` is filled by crew (see wiring below); everything else comes from
your `key=value` args (`key=value` fills `{key}` by name). Projects are chosen in the
picker — any bare command-line token is ignored (with a yellow warning).

Resolution rules:

- every placeholder must be satisfied, else a **red error** lists the unresolved ones and
  nothing runs;
- a `key=value` that matches no placeholder is **skipped with a yellow warning** (so
  `crew start env=local` still runs when nothing has an `{env}`);
- substituted values are shell-quoted, so spaces and metacharacters are safe.

```sh
crew start env=qa   # opens the picker, then fills {env} in each project's start
```

crew hardcodes no task names or values beyond the `longRunning` list — no baked-in
`local`/`pre`/`qa`/`pro` vocabulary.

**Per-project env — derived from the chain.** You pass one env to the selection
(`crew start env=pre`); crew works out what env each project *actually* runs at by following
the dependency graph. The **entry** (the product you're running — the thing nothing else in
the selection depends on) runs at your selection env. Every other project inherits the
env-variant its consumer's env file points at — read straight from the files, via the
env-labeled `match` (below). So the answer is context-dependent, which a static per-project
setting can never be:

- `crew start env=pre` with **beepro-frontend** as entry → its qa loader is referenced, so
  `bee-loader`/`sdk-frontend`/`sdk-api` resolve to **qa**, while beepro's own backend chain runs **pre**.
- `crew start env=pre` with **sdk-frontend** as entry (the SDK team's product) → its pre env
  points at `pre-bee-message-api`, so `sdk-api` and friends resolve to **pre**.

Same shared config, both teams correct. This matters because a caller's env file carries the
dependency's **credentials** too; crew rewrites the URL to localhost, so the local dependency
must run the env those creds are for.

Preview it without starting anything:

```
crew resolve <env> [project…]   # dry-run: prints the env each project resolves to
```

Disagreements between consumers, a missing env file, or a project unreachable from any entry
are reported as warnings (by `crew resolve`, and again at `crew start`) — never silently
mis-resolved. Cycles (a frontend↔backend reference loop) collapse into one entry cluster, so
there's nothing extra to configure. Env names are free-form — crew has no baked-in vocabulary.

**Env overrides (`local.json`).** URL swapping isn't always enough — sometimes a *value*
must change when you run locally: a dev API key the local peer accepts, or a Temporal queue
name so your local worker consumes `orchestra-local-ai` instead of the shared `orchestra-ai`.
`overrides` upsert extra `KEY=value` lines into a project's **wired** env file (the one crew
builds for `{envfile}`). They live in **`local.json`** (machine-local, untracked) so secrets
and personal values never touch the shared `config.json`:

```json
{
  "overrides": {
    "bee-orchestra": {
      "TEMPORAL_ORCHESTRA_AI_QUEUE": "orchestra-local-ai"
    },
    "beepro-frontend": {
      "whenLocal": {
        "bee-loader": { "REACT_APP_BEEPLUGINURL": "http://localhost:8088/v2/api/loader" }
      }
    }
  }
}
```

Each `overrides["<project>"]` table has two kinds of entry:

- **bare `VAR: value`** — applied **whenever that project starts** (crew builds a wired env only
  then). Use for a value that's always different locally: the `orchestra` queue name above so
  your local worker consumes `orchestra-local-ai` rather than the shared `orchestra-ai`.
- **`whenLocal: { "<peer>": { VAR: value } }`** — applied **only when `<peer>` is also being
  started**. Use when the override only makes sense while a local dependency is up — e.g. point
  `REACT_APP_BEEPLUGINURL` at your local `bee-loader` (exact host **and** path, which the
  host-only URL swap can't do), but leave it remote when the loader isn't running.

Manage them without hand-editing:

```
crew overrides            list every override (grouped by project; whenLocal shown separately)
crew overrides set        pick a project, VAR, an optional "only when <peer> is local", value
crew overrides remove     pick a project, then an entry to drop (or the whole project)
```

- Overrides win over the base env file **and** the localhost URL swap; `whenLocal` wins over bare.
- Upsert = replace an existing `VAR=` / `export VAR=` line in place, else append it.
- Bare entries apply on every start of that project, so keep them to values that always hold
  locally; reach for `whenLocal` when the value should track another service being up.

crew stays agnostic: it's a plain per-project table, no service knowledge. (This is also the
escape hatch when env derivation + the URL swap don't cover a case — inject the exact key/value
your wired env file needs.)

## Dependency graph

`crew graph` derives a **read-only dependency graph** from each project's env files —
who calls whom — with no manual edge list. It powers the connectivity check `crew start`
does on a co-running set.

crew finds a project's env files from its **`env`** template: it globs the `{env}` placeholder
(captured consistently across every occurrence) to enumerate the variants — so `.envs/{env}`,
`.envs/{env}-api.env`, `.envs/.env.{env}`, and nested monorepo layouts like
`../.envs/<app>/{env}/{env}-foo.env` all work. `env` is the single source of truth for env-file
location — the same field drives `{envfile}` wiring. No `env` → the default `<dir>/.envs` scan.

Give each project a `match`: an **env-labeled map** of the **host(s)** it's served under —
**exact strings**, one entry per environment, each **optionally narrowed by a path**. An edge
`P → T` is drawn when a URL in P's env files matches one of T's `match` hosts; the env *key* of
the matched host is what env derivation reads to decide which env T runs at.

```json
"projects": {
  "api": {
    "path": "api", "runner": "make {task}",
    "match": { "pro": "api.example.com", "qa": "qa-api.example.com", "pre": "pre-api.example.com" }
  }
}
```

- **Exact match**, so `api.example.com` matches only that host — never
  `rge-api.example.com` or `vpc-…-api-….amazonaws.com`. No globs, no collisions.
- **Env keys are free-form and partial** — label only the envs a project actually has (a loader
  served only to `qa`/`pro` lists just those two). A value may be a single host or an array.
- **Host+path** tokens (`cdn.example.com/plugin/v2/BeePlugin.js`) match only URLs on that host
  under that path — for two services sharing a host but differing by path. In **wiring**, a
  host-only token swaps just the origin (path kept); a host+path token replaces the whole URL
  with the peer's full `local` (so set `local` to the full local URL, path included — useful
  when the local path differs from the deployed one).
- A project with no `match` has no id, so nothing can point at it — `crew graph` flags it.
  crew derives nothing from folder/file/env names; the exact hosts are the whole rule.
- **Reference edges.** A URL from a **non-frontend into a `type: frontend`** project (a backend
  embedding the app's public URL — a link-back, allowed origin, redirect base) is treated as a
  *reference*, not a dependency: shown in `crew graph` as `⇢ … (ref — not a dep)`, but excluded
  from connectivity and env derivation. So a backend that merely links to your frontend can't
  make an unrelated selection look "connected." Only `frontend→frontend` edges (one app embedding
  another) count. Uses the declared `type` — no per-edge marker.

When you `crew start` a set, crew warns if the selection isn't connected in this graph
(`crew graph` restricted to the chosen projects) — i.e. you're running projects that won't
actually talk to each other locally. It's a warning, not a block.

**Drawn diagram.** `crew graph` renders the graph as a laid-out ASCII diagram (boxes, per-source
colored edges, dependency arrows solid, reference arrows dashed) — a zero-dependency layered-DAG
renderer (`bin/graph.js`), no external tool needed:

On a TTY it opens in an alternate-screen pager (scroll `↑↓`/`jk`, page `space`/`b`, `g`/`G`;
`f` filters which nodes to show via a multiselect; `q` quits and leaves nothing in scrollback).
Piped or redirected, it prints the diagram plainly.

```sh
crew graph              # drawn top-down diagram, paged (default)
crew graph list         # or the plain adjacency-list text
crew graph | less -R    # or pipe it (plain print)
```

## Two execution modes

The mode is decided by whether the task is in `config.longRunning`:

- **Long-running** (`start`, `dev`, `watch`, …): parallel and streamed with labelled,
  per-project-colored output. Ctrl-C — or any one process exiting — tears the whole group
  down. crew owns the terminal and exits with an aggregate code.
- **Run-to-completion** (`install`, `build`, `test`, …): parallel, but crew **waits for
  all** to finish (it does not kill the others when one finishes), then prints a
  per-project pass/fail summary and exits non-zero if any project failed.

### How teardown works (and why it's reliable)

crew runs each command via `/bin/sh -c` in **its own process group** (`spawn` detached).
On teardown it signals the whole group by pgid (`kill(-pgid)`) — SIGTERM, then SIGKILL
after a grace period (`CREW_KILL_GRACE_MS`, default 5000ms). A second Ctrl-C force-kills
immediately.

This is the key reason crew rolls its own runner instead of a ppid-walking tree-kill:
**reparented grandchildren** — a dev server's autoreload child, a `supervisord`, anything
that daemonizes — get orphaned to init and escape a ppid walk, leaving a port bound. A
process-group signal reaches them regardless of reparenting. POSIX only (macOS + Linux).

### Interactive controls (streamed runs)

When `crew start` streams to a TTY it opens a **full-screen log viewer** (an alternate screen,
like `less`/`htop`) showing only the selected projects' recent output, with a footer pinned to
the bottom row: `crew: [f] filter logs   [Ctrl-C] stop   (N/M shown)`.

- **`f`** — open the multiselect picker to choose which projects are **shown**. The view
  repaints to only those (from a kept line history, so re-showing a project brings its recent
  lines back). **Select none → blank screen.** Hidden projects keep running; their output is
  captured to history, just not displayed.
- **`Ctrl-C`** (or **`q`**) — graceful teardown; a second Ctrl-C within 10s force-kills.

History is bounded by `CREW_LOG_HISTORY` lines (default 5000). On exit crew leaves the
alternate screen and restores your terminal — so the run's logs aren't left in scrollback (it
was a live view). Piped/CI runs are unaffected: no viewer, output streams with `[name]`
prefixes as before. Inside the `f` picker, `Esc` cancels the filter (doesn't stop the run).

## Commands

Actions:

```
crew help                       usage (also: no args)
crew list                       list projects                      (alias: ls)
crew install [project]          install one project (named, or single-select pick)
crew start [args]               pick projects, run their start task (local wiring)
crew workspace                  pick projects, open one VSCode window (alias: code)
crew claude                     pick projects, launch Claude Code once (--add-dir)
crew graph                      dependency graph derived from .envs files
crew resolve <env> [proj…]      dry-run: the env each project resolves to for a selection
```

`start`/`workspace`/`claude` always open the interactive multiselect (preselected with your
last pick); the selection is remembered globally. `install` is single-project: name it
(`crew install sdk-api`) or pick one from a single-select list.

Config:

```
crew add                               wizard: create a new project
crew edit [name]                       wizard: modify an existing project
crew remove <name>                     delete a project (confirm) (alias: rm)
crew guards [project]                  list/manage guards (add/remove/link/unlink)
crew overrides [set|remove]            list/set/remove per-project env overrides (local.json)
crew dir [path]                        show/set the projects dir (relative paths resolve here)
crew config [path|edit]                print merged config / its path / open in $EDITOR
crew check                             validate config + local.json; list errors/warnings (alias: validate)
crew pull <url>                        fetch config.json from a URL, install it (backs up current)
```

Global flags: `--config <path>`, `-v/--version`.

### Validating the config

`crew check` is a built-in, **zero-dependency** validator (no JSON-Schema library — crew has
no runtime deps). It reads the merged config plus `local.json` and reports:

- **errors** (exit 1) — wrong types, a missing `path`, a `local` that isn't an http(s) URL, a
  project referencing an undefined guard, `{envfile}` used with no `env` field;
- **warnings** (exit 0) — unknown keys, a `match` entry that looks like a glob or carries a
  scheme/path (matching is exact-host only), `match` with no `local` (a wiring target nothing
  can reach locally), a guard missing its `comment`, `overrides`/`lastSelection` pointing at an
  unknown project, a path that doesn't exist on disk.

```
$ crew check
Checking ~/.config/crew/config.json
  ✓ no problems found
```

It's a good pre-commit / CI gate for a shared config: `crew check` exits non-zero only on
errors, so warnings won't fail a pipeline.

## Guards

A project can require named **guards** — preconditions verified before `crew start`
does anything. crew stays agnostic: a guard is just a shell command, and it **passes iff
it exits 0**. Each guard carries a required `comment` explaining what it verifies (printed
in faint gray beside its result), a `command`, and a failure `message`. Guards live in a
top-level registry and attach to projects many-to-many:

```json
{
  "guards": {
    "aws": {
      "comment": "AWS SSO token still valid for the app's credential resolution.",
      "command": "aws sts get-caller-identity --profile pre_bee >/dev/null 2>&1",
      "message": "AWS SSO expired — run: aws sso login --profile pre_bee"
    },
    "vpn": {
      "comment": "VPN connected: an interface holds a corp-subnet address.",
      "command": "ifconfig | grep -qE 'inet (10\\.11\\.12\\.|172\\.27\\.)'",
      "message": "VPN not connected."
    }
  },
  "projects": {
    "backend":   { "path": "~/code/backend",   "type": "backend", "guards": ["aws"] },
    "orchestra": { "path": "~/code/orchestra",  "type": "backend", "guards": ["aws", "vpn"] }
  }
}
```

Before a run, crew collects the **union** of the target's guards, **deduped by name** — a
guard shared by several projects runs **once**, not per project. All run in parallel; if
any fails, crew prints each failure's `message` in red and **aborts before anything
starts**:

```
guards:
  ✓ aws  AWS SSO token still valid for the app's credential resolution.
  ✗ vpn  VPN connected: an interface holds a corp-subnet address.
      VPN not connected.
crew: guard failed — nothing started.
```

(The faint gray line is each guard's `comment`; the red line under a `✗` is its `message`.)

Guards run before `crew start`.

### Managing guards

All wizard/select-driven — no hand-editing:

```
crew guards [project]    list guards (all, or just a project's), with which projects use each
crew guards add          wizard: name + comment + command + failure message, then attach to projects
crew guards remove       pick a guard to delete (also detaches it from every project)
crew guards link         pick a guard, then toggle which projects use it (multi-select)
crew guards unlink       pick a guard, then pick linked projects to detach
```

You can also attach guards from the project side in `crew edit <project>` (the guards
multi-select). Both sides write the same `project.guards` list.

## The hidden workspace file

`crew workspace` generates the multi-root `.code-workspace` file inside crew's own config
dir — **not** your project — at:

```
~/.config/crew/workspaces/<selection>.code-workspace
```

`<selection>` is the sorted member names joined — the same set produces the same file
regardless of pick order. crew opens it with `code <that file>`. This keeps the workspace file invisible in your
project explorer and out of git, while staying deterministic and reopenable: the file is
regenerated on every invocation to reflect the current config, and `code <file>` focuses
an existing window for that workspace instead of duplicating it.

**Workspace settings.** A top-level `workspaceSettings` object in the config is written
verbatim into the generated `.code-workspace`'s `settings`. Use it to tame extensions that
misbehave across a multi-root window — e.g. stop the Jest extension from auto-running (and
spamming terminals) in every folder:

```json
{ "workspaceSettings": { "jest.enable": false } }
```

crew injects nothing by default.

## Claude sessions (stable history)

Claude Code stores its per-directory history under `~/.claude/projects/<cwd-slug>/`, keyed
by the directory it's launched in. So `crew claude` launches Claude with a **stable,
crew-managed working directory** per selection:

```
~/.config/crew/sessions/<selection>/
```

Every project is still passed via `--add-dir`, so the whole set is fully accessible. Because
the cwd is fixed to the *sorted set of names* — not the first member — your Claude history
for a given set is stable: picking the same projects in any order reuses the same history,
and it never lives inside one project's folder.

Name the chat history with an optional **session name**: `crew claude billing-work` keeps
history in `~/.config/crew/sessions/billing-work/`. Omit it to get a name auto-derived from
the selected projects. (It's a name, not a path — always kept under crew's sessions dir.)

Note: the working dir is a crew-owned folder, not a project checkout, so there's no cwd
`CLAUDE.md`/git at the root — each project brings its own via `--add-dir`. Switching to
this scheme starts history under the new stable path; any prior history under a project's
slug isn't deleted, just no longer auto-loaded.

## Config

- User-level: `~/.config/crew/config.json` (created on first write).
- Project-local: a `./.crew.json` in the current directory merges **on top** of the
  user config (its `projects`/`guards` override by name).
- `--config <path>` points at a specific config file instead.

On load, a config with a missing or `< 2` version is migrated to v2 in memory and
written back. A v1 project's single `start` block becomes `tasks.start`.

## Projects directory (shareable config)

A project's `path` can be **relative** — it resolves against a machine-local
**projects directory**. Set it once per machine:

```sh
crew dir ~/Projects     # set it
crew dir                # show it
```

The projects dir is stored in **`local.json`** (next to the config — `~/.config/crew/local.json`),
**never** in `config.json`. That keeps `config.json` fully shareable. Project paths are
then short and portable:

```json
{
  "projects": {
    "backend":  { "path": "bee-beepro-backend", "type": "backend", "runner": "make {task}" },
    "frontend": { "path": "bee-beepro-frontend", "type": "frontend", "runner": "npm run {task}" }
  }
}
```

`~…`/absolute paths are still honoured as-is (escape hatch for a repo living outside the
projects dir). A relative path with no projects dir set is a clear error pointing you at
`crew dir`.

### Sharing a config with your team

Because `config.json` never contains machine-specific data, it's directly committable:

1. Keep `projects`/`guards` on relative paths (`crew dir` + `crew add`/`edit` do this).
2. Commit `config.json` (in a repo, or `git init` inside `~/.config/crew`). **Gitignore
   `local.json`** (and `workspaces/`, `sessions/`, `tmp/`) — those are machine-local/generated,
   and `local.json` may hold `overrides` secrets (dev API keys), so it must never be committed.
3. A teammate installs it — clone/symlink to `~/.config/crew/config.json`, or fetch it
   straight from the repo with `crew pull <raw-url>` (backs up any current config; a private
   repo needs a token/PAT in the URL). Then `crew dir <their-path>` once and everything
   resolves; no absolute paths are ever shared.

`--config <path>` works too: `local.json` is always read from **beside** the config file,
so an isolated config keeps its own machine settings.

## Known limitations (by design)

- **No task dependency graph and no ordering.** crew fans out one task at a time.
  Need "install before start"? That's two commands typed in sequence. No caching, no
  build-system behavior — that's `make` / `turbo` / `nx` territory.
- **No startup ordering within a run.** All projects start simultaneously; long-running
  services must tolerate their dependencies coming up in any order (retry / reconnect).
- No `up`/bundler command, no terminal or pane spawning, no tmux, no self-built process
  manager, no health-check / wait-for-ready, no port-conflict detection, no plugin
  system, telemetry, or auto-update.

## License

MIT
