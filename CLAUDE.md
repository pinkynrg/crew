# CLAUDE.md

Guidance for working in this repo.

## What crew is

A single-file macOS CLI that fans a **named task** out across a group of local
projects — run tasks in parallel, open the set as one VSCode workspace, or hand it to
Claude Code. crew owns the fan-out (parallelism, labelled output, exit-code aggregation,
lifecycle); each **project** owns task semantics. crew never interprets a task beyond
`{placeholder}` substitution.

## Layout

- `bin/crew.js` — the entire CLI. Single ESM executable, `#!/usr/bin/env node`.
- `package.json` — `bin.crew`, `type:module`, `engines.node >=18`, zero deps.
- `.github/workflows/publish.yml` — npm publish CI (push to main; auto-bump patch).
- `README.md` — user-facing docs (behavior reference).

## Hard constraints (do not break)

- **Zero runtime dependencies.** Node built-ins only (`node:fs`, `node:path`, `node:os`,
  `node:child_process`, `node:https`, `node:readline` + `readline/promises`). The parallel
  runner is our own (`runFanout`).
- **Single executable file.** Keep the CLI in `bin/crew.js`; don't split into modules.
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
- Task resolution per project: `tasks[task]` -> `runner` with `{task}` -> skip.
- Two execution modes by `config.longRunning`: long-running (streamed, first exit or
  Ctrl-C tears the whole group down) vs run-to-completion (wait all, no kill-others,
  pass/fail summary, non-zero if any failed).
- Runner (`runFanout`): each command spawns `detached` in its own process group; teardown
  signals the group by pgid (`kill(-pgid)`) with SIGTERM -> grace -> SIGKILL escalation, so
  reparented grandchildren (autoreload children, supervisord) die too — unlike a ppid
  tree-kill. Grace via `CREW_KILL_GRACE_MS` (default 5000). Colored `[name]` prefixes reuse
  the `crew list` per-project colors; `FORCE_COLOR` is set for children when the parent is a
  TTY.

## Testing

No test framework. Verify manually against a throwaway config:

```sh
node --check bin/crew.js
node bin/crew.js --config /tmp/x.json list
node bin/crew.js --config /tmp/x.json run <task> <target> --dry-run
```

Prefer `--dry-run` to inspect resolved commands without executing.

## Non-goals

No task dependency graph, no ordering, no caching, no build-system behavior, no
terminal/pane spawning, no health checks. That is make/turbo/nx territory.
