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
- `package.json` — `bin.crew`, `type:module`, `engines.node >=18`.
- `.github/workflows/publish.yml` — npm publish CI (release / `v*` tag / dispatch).
- `instruction.md` — the original build spec (source of truth for behavior).

## Hard constraints (do not break)

- **One third-party dependency only: `concurrently`.** Everything else is Node built-ins
  (`node:fs`, `node:path`, `node:os`, `node:child_process`, `node:readline/promises`).
- **Single executable file.** Keep the CLI in `bin/crew.js`; don't split into modules.
- Resolve `concurrently` locally (via `createRequire` / dynamic import) — never `npx`.
- No raw stack traces on expected errors: throw `CrewError`, exit non-zero, one-line msg.
- `~` expansion + relative-to-cwd resolution everywhere; dedupe dir lists by resolved
  absolute path.
- Strict placeholders: every `{name}` must resolve; unknown `key=value` is an error;
  shell-quote every substituted value. Hardcode no task names/values beyond
  `config.longRunning`.

## Config

- User-level: `~/.config/crew/config.json` (v2 schema). Project-local `./.crew.json`
  merges on top. v1 configs migrate to v2 on load (`start.command` -> `tasks.start`).
- Task resolution per project: `tasks[task]` -> `runner` with `{task}` -> skip.
- Two execution modes by `config.longRunning`: long-running (`concurrently
  --kill-others`, streamed, Ctrl-C tears down) vs run-to-completion (wait all, no
  kill-others, pass/fail summary, non-zero if any failed).

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
