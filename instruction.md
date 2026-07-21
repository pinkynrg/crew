# Task
Build a single CLI tool called **crew** (macOS-focused) that lets developers work on
groups of local projects — run any task (start, install, build, test, …) across a whole
group in parallel, open them as one VSCode workspace, and hand the set to Claude Code —
driven by one persistent config. Runnable via `npx` with nothing for the user to
install by hand.

The three surfaces (run / workspace / claude) are DELIBERATELY separate commands: each
wants its own terminal/lifecycle. The tool does not bundle them or spawn terminals;
arranging them (tabs, aliases, npm scripts) is left to the user's shell.

# Design principle (read first)
crew fans a NAMED TASK out across a group of directories. It does NOT know what any task
means — "install", "build", "start" are just strings it forwards to each project's own
runner (make, npm, a shell script). crew owns the fan-out (parallelism, output labelling,
exit-code aggregation, lifecycle); the PROJECT owns task semantics. This boundary is what
keeps crew thin. Explicit NON-goals that would cross it: no task dependency graph, no
"install before start" ordering, no caching, no build-system behavior. That is make/turbo/
nx territory. Need install-then-start? That's two commands typed in sequence.

# Dependencies & constraints
- The tool MAY depend on ONE npm package: `concurrently` (the parallel-run engine).
  Everything else uses Node built-ins (node:fs, node:path, node:os, node:child_process,
  node:readline/promises). No other third-party deps.
- `concurrently` is a dependency of THIS package, so `npx crew` pulls it in
  automatically — the user installs nothing by hand. Do NOT `npx concurrently` at
  runtime; call the locally-resolved binary.
- Single executable file, `#!/usr/bin/env node`, ESM ("type":"module"). package.json
  with a `bin` entry. Node >= 18, include `engines`. Target macOS (assume `code`,
  `claude` on PATH; no tmux).
- Publish to the PUBLIC npm registry. README documents both `npx crew` and global
  install (`npm i -g crew`).
- No raw stack traces on expected errors (unknown project/group/task, missing config,
  `code`/`claude` not on PATH, missing paths). Clear one-line message + non-zero exit.

# Persistent config ("internal memory")
User-level at `~/.config/crew/config.json` (create dir if missing). A project-local
`./.crew.json`, if present, merges on top.

Schema:
{
  "version": 2,                         // config schema version, for migrations
  "workspaceName": "crew",              // default label for generated .code-workspace
  "longRunning": ["start", "dev", "watch"],  // tasks treated as long-lived services (see modes)
  "projects": {
    "<projectName>": {
      "path": "<absolute or ~-expanded path>",
      "type": "frontend | backend | fullstack | other",
      "relatedDirs": [],
      "cwd": null,                      // optional; defaults to path. Where tasks run.
      "runner": "npm run {task}",       // OPTIONAL template applied to ANY task by name
      "tasks": {                        // OPTIONAL explicit per-task overrides
        "start": "AWS_PROFILE=pre_bee ./scripts/django-run-server.sh {env}"
      }
      // A project with neither `runner` nor `tasks` is "run-less": skipped by `run`,
      // still included in `workspace` and `claude`.
    }
  },
  "groups": { "<groupName>": ["<projectName>", ...] }
}

- On load, if `version` is missing or < 2, migrate in memory and write back. (v1 used a
  single `start` block; if encountered, map `start.command` -> `tasks.start` and its
  `defaults`/`allowed` -> the placeholder rules below, then bump to v2.)

# Core concepts
- PROJECTS are building blocks. GROUPS are named sets of projects.
- Every command taking a <target> accepts a group name OR a single project name
  (bare project = group of one). Resolve GROUP FIRST, then project, else error listing
  valid names.
- NAME COLLISION: if a project and a group share a name, the group shadows the project
  (group-first). Warn at `init` and `group` creation time when a new name collides with
  an existing one of the other kind.
- DEDUPE: when building any folder/dir list (workspace folders, claude --add-dir), dedupe
  by RESOLVED ABSOLUTE PATH so shared relatedDirs aren't listed twice.
- PATH VALIDATION: before any command acts, verify each member's path (and relatedDirs)
  exists; on a missing path, fail naming the offending project — never a raw error.

# Task resolution — how a task name becomes a command (NO duplication)
For `crew run <task> <target> [args]`, resolve each project's command for <task> as:
  1. If `project.tasks[task]` exists  -> use that string.
  2. Else if `project.runner` exists  -> substitute `{task}` into it (e.g. `make {task}`).
  3. Else the project is run-less for this task -> SKIP it with a one-line note
     ("skipping <project> (no task '<task>')").
- If, after resolution, NO project in the target can run the task -> error, run nothing.
- The resolved string is an ARBITRARY shell command (make, npm, script, binary, with env
  prefixes). crew never interprets it beyond placeholder substitution.

## Placeholders & args (strict)
- Resolved commands may contain `{name}` placeholders (including `{task}` when using
  `runner`, plus any others like `{env}`).
- `{task}` is filled from the task name automatically.
- Other placeholders are filled from user args: a bare positional fills a single
  remaining placeholder; `key=value` fills `{key}` by name.
- STRICT (no partial runs): EVERY placeholder in a resolved command must be satisfied,
  else ERROR and run nothing (list the unresolved ones). Any `key=value` matching no
  placeholder in that command is an ERROR (list the unknown key). No silent ignore/append.
- QUOTE substituted values (shell-quote each) so spaces/metacharacters are safe.
- Never hardcode any task names or values beyond the `longRunning` list; do not bake in
  env/stage vocabularies (local/pre/qa/pro etc.).

# Two execution modes (same fan-out, opposite lifecycle)
Determined by whether the task is in `config.longRunning`:
- LONG-RUNNING (start/dev/watch/…): parallel via
    concurrently --kill-others --names <p1,p2,…> "cd \"<cwd>\" && <cmd>" …
  Streamed, labelled/colored output; Ctrl-C (or any one dying) tears the whole group
  down. Exit with concurrently's code. Owns the terminal.
- RUN-TO-COMPLETION (install/build/test/…): parallel, but WAIT for all to finish. Do
  NOT use --kill-others (one finishing must not kill the others). Aggregate results:
  print a per-project pass/fail summary; exit non-zero if ANY project failed. Use
  `concurrently` WITHOUT --kill-others (or `--kill-others-on-fail` only if you want a
  failure to abort the rest — default is DO NOT abort; run all, then report).
crew owns supervision in both modes; do NOT hand-roll process/signal handling.

# `workspace` handling — on-the-fly, hidden from the user
- Generate the multi-root `.code-workspace` (each project + its relatedDirs as folders,
  deduped) and write it to crew's OWN config dir, NOT the user's project:
    ~/.config/crew/workspaces/<group>.code-workspace
  Then open with `code <that file>`. Keeps the file invisible in the user's project
  explorer and git, while staying deterministic and reopenable.
- Regenerate each invocation to reflect current config. `code <file>` focuses an existing
  window for that workspace rather than duplicating it.
- `--fileless` flag (alternative): open a new window on the first folder, then `code --add`
  the rest as an in-memory Untitled Workspace (attaches to the last active instance; less
  deterministic).

# Command list

crew help
    Usage for all commands with examples. Default for no args / unknown command / wrong
    arg count. Aliases: (no args), -h, --help

crew list                                        # alias: ls
    List projects (name, type, path, path-exists, runner + explicit task overrides) and
    groups (name -> members). Empty config -> point to `crew init`.

crew run <task> <target> [value] [key=value ...] [--dry-run]
    Resolve <task> per project (tasks[task] -> runner{task} -> skip) and fan out across
    the target using the correct execution mode for that task. --dry-run prints each
    resolved command (and the chosen mode) without running.
    Examples:
      crew run install full
      crew run build api
      crew run test full
      crew run start checkout env=qa

# Task sugar (thin aliases over `crew run`, for ergonomics only)
crew start <target> [args]     ==  crew run start <target> [args]
crew install <target>          ==  crew run install <target>
    (Provide start + install as built-in aliases. Any other task uses `crew run <task>`.)

crew workspace <target> [--fileless] [--dry-run]  # alias: code
    Open the target's projects as one multi-root VSCode window via a hidden generated
    workspace file (see workspace handling). --dry-run prints the JSON + resolved path
    without writing/opening.

crew claude <target> [--dry-run]
    Launch Claude Code ONCE with --add-dir for every project in the target plus their
    relatedDirs (deduped). cwd = first project's path. Inherits stdio (interactive).
    --dry-run prints the resolved `claude` invocation.

crew init [project]
    Wizard to add/update a PROJECT: name, path (validated), type, relatedDirs, cwd, a
    default `runner` template (e.g. `make {task}` or `npm run {task}`, blank = run-less),
    and any explicit `tasks` overrides. Warn on name collision with a group. Merge into
    user-level config, print where saved. Re-running a name updates it.

crew group <groupName> <project ...>
    Create/update a GROUP as an ordered list of existing project names (validate each).
    Warn on name collision with a project. `crew group <name>` with no members prints
    the group's contents.

crew remove <project>            # alias: rm  — delete a project (confirm; -y to skip)
crew remove-group <groupName>    #            — delete a group (confirm; -y to skip)

crew config
    Print resolved config path + merged contents.
    crew config path -> just the path;  crew config edit -> open in $EDITOR

# Global flags
    --dry-run        show without executing
    --config <path>  use a specific config file
    -h, --help       global help, or `crew <cmd> --help`
    -v, --version    print version

# Acceptance criteria
- `npx crew` with no config runs and guides the user to `init`.
- ~ expansion and relative-to-cwd resolution everywhere.
- <target> resolves group-first, then single project; name collisions warn.
- `crew run <task> <group>` resolves per project (tasks -> runner{task} -> skip), runs in
  the mode dictated by `longRunning`, and: long-running tasks stream + --kill-others +
  Ctrl-C stops all; run-to-completion tasks wait for all, do NOT kill-others, print a
  pass/fail summary, and exit non-zero if any failed.
- Strict placeholders: missing OR unknown key -> error, nothing runs; values shell-quoted.
- Run-less projects are skipped by `run` but included in `workspace`/`claude`.
- `crew workspace <group>` opens ONE multi-root window and leaves NO workspace file in any
  project folder (file lives under ~/.config/crew/workspaces/); folders deduped.
- `crew claude <group>` launches Claude Code once with a deduped --add-dir per project.
- Missing member paths fail with a message naming the project.
- v1 configs migrate to v2 (start.command -> tasks.start).
- Only third-party dependency is `concurrently`.

# Non-goals / documented limitations
- NO task dependency graph, NO ordering (e.g. install-before-start), NO caching, NO
  build-system behavior. crew fans out ONE task at a time; projects own task semantics.
- Within a single task run there is NO startup ordering: all projects start
  simultaneously. Long-running services must tolerate dependencies coming up in any
  order (retry/reconnect). Document as a known limitation.
- No `up`/bundler command, no terminal/pane spawning, no tmux, no self-built process
  manager, no health-check/wait-for-ready, no port-conflict detection, no plugin system,
  telemetry, or auto-update.

# Deliverables
- The CLI file, package.json (with `concurrently` dep + `bin` + engines), and a README:
  install/usage (npx + global), config schema, the runner/tasks model with examples (one
  `make {task}` project, one `npm run {task}` project, one with a `tasks.start` override),
  the two execution modes, the three-tab workflow, how the hidden workspace file works,
  and the "no ordering / no dependency graph" limitations.