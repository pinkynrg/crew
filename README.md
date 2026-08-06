# crew

![coverage](https://img.shields.io/badge/coverage-86%25-green)

**Quickly select and run the slice of your stack you're interested in - locally, wired to the rest.**

crew is a zero-dependency CLI for local dev on a distributed stack. Pick the few services
you're actually working on; crew runs them natively, rewires them to talk to each other, and
leaves everything else pointing at its real deployed environment. Then open that same set as
one VS Code workspace, or hand it to a single Claude Code session.

## What it does

<p align="center">
  <img src="docs/media/crew-start.gif" alt="crew start: pick a connected slice of services from the dependency graph, run it locally, watch the labelled logs" width="720">
</p>

You have fifteen services. Today you're touching two. `crew start` opens a picker over the
**dependency graph crew derived from your env files**, you tick the slice you care about, and
crew:

- runs each project's `start` task **natively** in parallel, with labelled, per-project-colored logs;
- **wires the slice together** - rewrites the URLs in each project's env file so a running peer
  points at your local copy instead of the deployed one;
- leaves everything you *didn't* pick on its resolved remote env (qa / staging / prod), so the
  rest of the stack is just… there.

The picked set is remembered, so the other two surfaces open the same thing:

| Command | What it opens |
| --- | --- |
| `crew start env=staging` | the dev servers (streams until Ctrl-C, tears the whole group down together) |
| `crew workspace` | one multi-root VS Code window with every picked repo side by side |
| `crew claude` | one Claude Code session over the set, with history kept per group of repos |

They're separate commands on purpose - each wants its own terminal tab and lifecycle. crew never
spawns terminals for you.

### Install

```sh
npx @pinkynrg/crew          # zero deps, lands instantly - nothing to install
```

Or install it globally (then the command is `crew`):

```sh
npm i -g @pinkynrg/crew
crew --version
```

Requires Node ≥ 18 on macOS or Linux, with `code` (the VS Code CLI) and `claude` on your PATH
for those two surfaces. **Zero runtime dependencies** - Node built-ins only, including crew's own
parallel process runner. Self-update with `crew upgrade`.

## How it's configured

<p align="center">
  <img src="docs/media/crew-config.gif" alt="crew config: add a frontend and a backend by picking their folders (crew auto-fills type, runner, env, local URL and start command), fill the deployed hosts, and create a guard" width="720">
</p>

**You don't hand-write the config.** `crew config` is a two-pane visual editor: pick a project's
folder and crew auto-detects its type, runner, env files, local URL and start command. You confirm,
fill in the deployed hosts, and out comes one readable `config.json` - committable, no secrets.

A project entry holds just a few things:

- **`path`** + **`tasks.start`** - where the repo lives and how to run it. Drop **`{envfile}`** in the
  command and crew injects the wired env file it materializes for the run.
- **`match`** - the host(s) the project is deployed under, per env. crew matches these against the
  URLs in your env files to **auto-discover who depends on whom** - no manual edge list.
- **`local`** - its local URL, so crew can rewrite a peer's env to point at your local copy.

```json
{
  "projects": {
    "web": {
      "path": "web",
      "type": "frontend",
      "tasks": { "start": "dotenv -e {envfile} -- npm run dev" },
      "env": ".envs/{env}.env",
      "match": { "staging": "web.staging.acme.dev", "prod": "web.acme.dev" },
      "local": "http://localhost:3000"
    },
    "api": {
      "path": "api",
      "tasks": { "start": "uvicorn app:main --reload --env-file {envfile}" },
      "env": ".envs/{env}.env",
      "match": { "staging": "api.staging.acme.dev", "prod": "api.acme.dev" },
      "local": "http://localhost:4000"
    },
    "auth": {
      "path": "auth",
      "tasks": { "start": "godotenv -f {envfile} go run ." },
      "env": ".envs/{env}.env",
      "match": { "staging": "auth.staging.acme.dev", "prod": "auth.acme.dev" },
      "local": "http://localhost:4500"
    }
  }
}
```

From those hosts and env files crew derives the dependency graph - here `web` → `api` → `auth` -
which drives the picker, connectivity warnings, and per-project env resolution. Preview it with
`crew graph` (a drawn ASCII diagram) and `crew resolve <env>` (a dry-run of what env each project
lands on). Because there are no secrets or machine paths in it, `config.json` is directly
committable and shareable across your team; the machine-local bits (your projects directory,
remembered selection) live in a gitignored `local.json` beside it.

The full field-by-field reference is in [Config reference](#config-reference) below.

## Why not just use Docker?

**Every service is a switch. On = local, off = remote. Flipping it re-wires the rest automatically.**

That's the whole idea:

- **On** → crew runs the service locally *and* rewrites every peer that talks to it to point at your
  `localhost`.
- **Off** → the service stays on its deployed environment (qa / staging / prod), and its consumers
  keep pointing at the real host.

The "slice" you run is nothing more than *which switches are on* - flip one on and the rest of the
stack is remote; flip them all on and you're running the whole cake locally; anything in between.
And the only magic is that **flipping a switch flips the wiring for you**: crew re-reads your env
files and swaps the URLs for whatever's currently on. No config edit, no second file to maintain.

```
crew start env=staging     web   [x] on  → http://localhost:3000
                           api   [x] on  → http://localhost:4000   (web now calls this)
                           auth  [ ] off → https://auth.staging.acme.dev
                           …     [ ] off → deployed staging
```

Docker Compose has no equivalent to that switch. A service is in the compose file or it isn't, and
"use the deployed one instead" is a manual env edit - so you tend to either run the *whole* graph
locally or maintain a second compose file full of stubs, and either way it drifts from production.
crew derives the graph from the `.env` files you already ship, so there's no parallel source of
truth to keep in sync.

Two more things fall out of running natively rather than in containers:

- **Real local dev.** Plain processes with your normal toolchain (`make`, `npm`, `uvicorn`, `go run`):
  real hot-reload, attach a debugger directly, native file watching. No daemon, no images, no
  rebuild-on-change, no volume latency.
- **Nothing to install or clean up.** One file, zero runtime deps.

**When Docker is still the right call:** you genuinely need full-stack isolation, byte-for-byte
prod/CI parity, or your services can't run natively on your machine at all - and you need a real
deployed stack to borrow the "off" services from in the first place. crew doesn't replace Docker
there. It replaces the daily loop of flipping a couple of services on and letting everything else
stay remote.

---

## Config reference

### Commands

```
crew list                       list projects (remembered selection, per-folder status)
crew install                    pick one project, install it (single-select)
crew start [env=…] [k=v …]      pick projects, run their start task (local wiring)
crew workspace                  pick projects, open one VS Code window
crew claude [name]              pick projects, launch one Claude Code session (--add-dir)
crew graph [list]               dependency graph derived from .envs files (drawn / adjacency)
crew resolve <env> [proj…]      dry-run: the env each project resolves to for a selection
crew config [path]              two-pane visual editor for everything (or print the config path)
crew check                      validate config + local.json; list errors / warnings
crew pull <url>                 fetch a config.json from a URL and install it (backs up current)
crew upgrade                    self-update (npm i -g @pinkynrg/crew@latest)
```

`start` / `workspace` / `claude` always open the interactive multiselect (preselected with your
last pick) and the selection is remembered globally; projects are never named on the CLI there.
`install` is the exception - single-project, and it doesn't touch the remembered set. Global flags:
`--config <path>`, `-v/--version`.

### The runner & tasks model

A task name becomes a command per project, with no duplication:

1. `project.tasks[<task>]` if present - an explicit override;
2. else `project.runner` with `{task}` substituted (e.g. `make {task}` → `make build`);
3. else the project is **run-less** for that task and skipped (it still shows up in `workspace` / `claude`).

Resolved commands may contain `{name}` placeholders. `{task}` is filled from the task name,
`{envfile}` by crew (the wired env file), and everything else from your `key=value` args. Every
placeholder must resolve or crew errors and runs nothing; an unused `key=value` is a yellow warning;
substituted values are shell-quoted. `crew start` **requires** `env=<name>` - the base env the
unselected projects point at.

**Two execution modes**, decided by whether the task is in `config.longRunning`:

- **Long-running** (`start`, `dev`, `watch`): parallel, streamed, per-project-colored output.
  Ctrl-C - or any one process exiting - tears the whole group down. On a TTY this is a full-screen
  log viewer (`f` to filter which projects are shown, `Ctrl-C` to stop).
- **Run-to-completion** (`install`, `build`, `test`): parallel, but crew waits for **all** to
  finish, prints a pass/fail summary, and exits non-zero if any failed.

Teardown is reliable because each command runs via `/bin/sh -c` in **its own process group**
(`spawn` detached); crew signals the whole group by pgid - SIGTERM, then SIGKILL after a grace
period (`CREW_KILL_GRACE_MS`, default 5000ms). Reparented grandchildren (autoreload children,
`supervisord`) that a ppid tree-kill would orphan get signalled anyway. POSIX only (macOS + Linux).

### Env derivation & the dependency graph

You pass one env to the selection (`crew start env=pre`); crew works out what env each project
*actually* runs at by following the graph. The **entry** (the thing nothing else in the selection
depends on) runs at your selection env; every other project inherits the env-variant its consumer's
env file points at - read straight from the files via the env-labeled `match`. So the same shared
config serves multiple teams correctly, because the answer is context-dependent in a way a static
per-project setting never could be. Disagreements, missing env files, and unreachable projects are
reported as warnings - never silently mis-resolved.

`crew graph` renders the derived graph as a laid-out ASCII diagram (boxes, per-source colored edges,
solid dependency arrows, dashed reference arrows) - a zero-dep layered-DAG renderer, no external
tool. On a TTY it opens in an alternate-screen pager (`f` filters nodes, `esc` quits leaving no
scrollback); piped, it prints plainly. `crew resolve <env>` is the read-only dry-run.

> A URL from a non-frontend into a `type: frontend` project (a backend embedding the app's public
> URL) is treated as a **reference**, not a dependency - shown in the graph but excluded from
> connectivity and env derivation.

### Env overrides

URL swapping isn't always enough - sometimes a *value* must change when you run locally (a Temporal
queue name, say). `overrides` upsert extra `KEY=value` lines into a project's wired env file. They
live as a top-level table in the committable `config.json` (keep secrets out):

```json
{
  "overrides": {
    "bee-orchestra": { "TEMPORAL_ORCHESTRA_AI_QUEUE": "orchestra-local-ai" },
    "beepro-frontend": {
      "whenLocal": {
        "bee-loader": { "REACT_APP_BEEPLUGINURL": "http://localhost:8088/v2/api/loader" }
      }
    }
  }
}
```

- **bare `VAR: value`** - applied whenever that project starts (a value that's always different locally);
- **`whenLocal: { "<peer>": { VAR: value } }`** - applied only when `<peer>` is also being started
  (e.g. point a URL at a local dependency's exact host **and** path, but only while it's up).

Overrides win over the base env file and the localhost URL swap; `whenLocal` wins over bare. Manage
them in `crew config` → a project's **Environment Overrides** block.

### Guards

A project can require named **guards** - preconditions verified before `crew start` does anything.
A guard is a shell command that passes iff it exits 0, with a required `comment` (what it checks)
and a failure `message`. They live in a top-level registry and attach to projects many-to-many:

```json
{
  "guards": {
    "aws": {
      "comment": "AWS SSO token still valid.",
      "command": "aws sts get-caller-identity --profile pre_bee >/dev/null 2>&1",
      "message": "AWS SSO expired - run: aws sso login --profile pre_bee"
    }
  },
  "projects": {
    "backend": { "path": "~/code/backend", "type": "backend", "guards": ["aws"] }
  }
}
```

Before a run crew collects the union of the target's guards (deduped by name - a shared guard runs
once), runs them in parallel, and if any fails prints its message in red and aborts before anything
starts. Manage them in `crew config` → the **Guards** section.

### Config files & sharing

- **User-level:** `~/.config/crew/config.json` (v2 schema; v1 migrates on load).
- **Project-local:** a `./.crew.json` in the current directory merges on top.
- **`--config <path>`** points at a specific file. `local.json` is always read from beside it.

`config.json` never contains machine-specific data, so it's directly committable - keep project
`path`s **relative** (they resolve against a machine-local **projects directory**, set once in
`crew config` → Settings, stored in `local.json`). A teammate installs it - clone it to
`~/.config/crew/config.json` or `crew pull <raw-url>` - sets their projects dir once, and everything
resolves with no absolute paths ever shared. **Gitignore `local.json`** (plus `workspaces/`,
`sessions/`, `tmp/`).

`crew check` is a built-in zero-dependency validator: errors (wrong types, missing `path`, undefined
guard, `{envfile}` with no `env`) exit 1; warnings (unknown keys, a glob-looking `match`, a `match`
with no `local`, a path missing on disk) exit 0. A good pre-commit / CI gate for a shared config.

### `crew workspace` & `crew claude` details

`crew workspace` generates a multi-root `.code-workspace` inside crew's own config dir
(`~/.config/crew/workspaces/<selection>.code-workspace`) - not your project, so it stays out of git -
and opens it with `code`. A top-level `workspaceSettings` object is written verbatim into its
`settings` (e.g. `{ "jest.enable": false }`).

`crew claude` launches Claude Code with a stable, crew-managed working directory per selection
(`~/.config/crew/sessions/<selection>/`), passing every project via `--add-dir`. Because the cwd is
the sorted set of names, history for a given set is stable regardless of pick order. Name it with an
optional session name: `crew claude billing-work`.

## Known limitations (by design)

- **No task dependency graph, no ordering.** crew fans out one task at a time; "install before start"
  is two commands. No caching, no build-system behavior - that's `make` / `turbo` / `nx` territory.
- **No startup ordering within a run.** All projects start simultaneously; services must tolerate
  their dependencies coming up in any order.
- No bundler command, no terminal/pane spawning, no tmux, no health-check / wait-for-ready, no
  port-conflict detection, no plugin system, no telemetry.

## License

MIT
