# crew

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

## The three-tab workflow

The three surfaces are **separate commands** on purpose — each wants its own terminal /
lifecycle. crew never spawns terminals; arrange the tabs (or aliases / npm scripts)
yourself:

| Tab | Command | Owns |
| --- | --- | --- |
| 1 | `crew start full` | the dev servers (streams until Ctrl-C) |
| 2 | `crew workspace full` | one multi-root VSCode window |
| 3 | `crew claude full` | an interactive Claude Code session |

## Quick start

```sh
crew add                        # wizard: create a project (run twice for two projects)
crew add                        # then create a group, picking its member projects
crew run install full           # install everything (waits, reports pass/fail)
crew start full                 # start every runnable member in parallel
crew workspace full             # open them all as one VSCode window
crew claude full                # launch Claude Code over the whole set
crew edit full                  # wizard: change a project or group later
```

## Concepts

- **Projects** are the building blocks. **Groups** are named, ordered sets of projects.
- Any `<target>` is a **group name OR a single project name** (a bare project = a group
  of one). Targets resolve **group-first**, then project. Names are **unique** across
  projects and groups — `init` and `group` error if a name is already taken by the other
  kind — so every name maps to exactly one thing.
- Paths are `~`-expanded and resolved relative to the current directory. Before any
  command acts, crew verifies each member's `path` and `relatedDirs` exist and fails
  naming the offending project.
- Folder lists (workspace folders, `claude --add-dir`) are **deduped by resolved absolute
  path**, so shared `relatedDirs` are never listed twice.

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
      "relatedDirs": ["~/code/shared"],
      "runner": "make {task}"
    },
    "web": {
      "path": "~/code/web",
      "type": "frontend",
      "relatedDirs": [],
      "runner": "npm run {task}"
    },
    "worker": {
      "path": "~/code/worker",
      "type": "backend",
      "relatedDirs": [],
      "tasks": {
        "start": "AWS_PROFILE=pre_bee ./scripts/run.sh {env}"
      }
    },
    "docs": {
      "path": "~/code/docs",
      "type": "other",
      "relatedDirs": []
    }
  },
  "groups": {
    "full": ["api", "web", "worker", "docs"]
  }
}
```

Here `api` runs any task through `make {task}`, `web` through `npm run {task}`, `worker`
has an explicit `tasks.start` override with an `{env}` placeholder, and `docs` is
run-less (skipped by `run`, kept for `workspace`/`claude`).

### Placeholders & args (strict)

Resolved commands may contain `{name}` placeholders. `{task}` is filled automatically
from the task name; everything else comes from your args:

- a bare positional fills a single remaining placeholder,
- `key=value` fills `{key}` by name.

Resolution is strict — nothing runs on error:

- every placeholder must be satisfied, else an error lists the unresolved ones;
- any `key=value` that matches no placeholder is an error (the unknown key is listed);
- substituted values are shell-quoted, so spaces and metacharacters are safe.

```sh
crew start worker env=qa      # fills {env} in worker's tasks.start
crew start checkout qa        # bare positional fills the single placeholder
```

crew hardcodes no task names or values beyond the `longRunning` list — no baked-in
`local`/`pre`/`qa`/`pro` vocabulary.

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

## Commands

Actions:

```
crew help                              usage (also: no args, -h, --help)
crew list                              list projects + groups            (alias: ls)
crew install <target>                  = crew run install <target>
crew start <target> [args]             = crew run start <target>
crew workspace <target> [--fileless]   open one multi-root VSCode window  (alias: code)
crew claude <target>                   launch Claude Code once, deduped --add-dir
crew run <task> <target> [args]        fan any <task> across the target (general form)
```

Config:

```
crew add                               wizard: create a new project or group
crew edit [name]                       wizard: modify an existing project or group
crew remove <name>                     delete a project or group (confirm; -y) (alias: rm)
crew config [path|edit]                print merged config / its path / open in $EDITOR
```

Global flags: `--dry-run`, `--config <path>`, `-y/--yes`, `-h/--help`, `-v/--version`.
Every acting command supports `--dry-run` to print what it would do without running.

## The hidden workspace file

`crew workspace <target>` generates the multi-root `.code-workspace` file inside crew's
own config dir — **not** your project — at:

```
~/.config/crew/workspaces/<target>.code-workspace
```

then opens it with `code <that file>`. This keeps the workspace file invisible in your
project explorer and out of git, while staying deterministic and reopenable: the file is
regenerated on every invocation to reflect the current config, and `code <file>` focuses
an existing window for that workspace instead of duplicating it.

`--fileless` is an alternative: it opens a new window on the first folder, then
`code --add`s the rest as an in-memory Untitled Workspace (attaches to the last active
instance; less deterministic).

## Config

- User-level: `~/.config/crew/config.json` (created on first write).
- Project-local: a `./.crew.json` in the current directory merges **on top** of the
  user config (its `projects`/`groups` override by name).
- `--config <path>` points at a specific config file instead.

On load, a config with a missing or `< 2` version is migrated to v2 in memory and
written back. A v1 project's single `start` block becomes `tasks.start` (and its `cwd`
is preserved).

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
