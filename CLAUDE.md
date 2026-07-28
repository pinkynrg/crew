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
  `crew pull <url>` fetches a `config.json` from a URL (zero-dep `node:http(s)`, follows
  redirects, validates it has `projects`) and installs it, backing up the current one to
  `config.json.bak`; `local.json` is untouched.
- `projectsDir` (machine-local — stored in `local.json` beside the config, set via
  `crew dir <path>`, never in the committable `config.json`): relative project `path`s
  resolve against it; `~`/absolute paths are used as-is. So `config.json`
  (projects/guards, relative paths) is directly committable; a legacy `projectsDir`
  in `config.json` auto-migrates to `local.json` on load. `local.json` reads from beside
  the resolved config (works with `--config`); gitignore it when committing. `local.json`
  also holds `lastSelection` (the remembered picker selection).
- No groups, no `run` command. `start`/`install`/`workspace`/`claude` act on a **selection**
  chosen via an interactive multiselect (`selectMembers`, preselected with `lastSelection`);
  projects are never named on the CLI (bare CLI tokens are ignored with a warning; only
  `key=value` args are consumed). The picked set is saved to `lastSelection` (global,
  machine-local) and reused across the four. A legacy `groups` key is dropped on load.
- `envMap` (optional, per project): remaps the selection env to the env THIS project runs
  at — `{ "<selEnv>": "<projEnv>", "default": "<fallback>" }` (see `mappedEnv`). `{env}`
  resolves per project (`envMap[sel] ?? envMap.default ?? sel`) before the start command,
  the `env` file path, and wiring. Used when a dependency is consumed at a fixed env (e.g.
  SDK projects `{"pro":"pro","default":"qa"}`: RGE at pre/qa talks to SDK@qa, pro→pro).
  Agnostic — a plain per-project table; crew has no service-mapping knowledge.
- `match` (per project): the project's complete deployed hostname(s) as **exact strings**
  (list every env variant); matched by exact host equality (`tokenMatchLen`) — no globs, no
  collisions (`api.getbee.io` never matches `rge-api.getbee.io`). `crew graph` derives edges
  from `.envs/*` URLs; `crew start` warns when a co-running selection isn't connected.
- Task resolution per project: `tasks[task]` -> `runner` with `{task}` -> skip.
- `guards`: top-level `guards: {name: {command, message}}` registry; a project lists names
  in `project.guards` (many-to-many). Before a run, the target's guards are deduped by
  name, run once each in parallel (pass = exit 0); any failure prints its message and
  aborts. `--skip-guards` bypasses. Only `start`/`install` gate on them. Managed via
  the `crew guards` command (list/add/remove/link/unlink, all select-driven). The v1
  `checks` key auto-migrates to `guards` on load.
- `workspaceSettings` (optional top-level object): written verbatim into the generated
  `.code-workspace` `settings` (e.g. `{"jest.enable": false}` to stop the Jest extension
  auto-running per folder). crew injects nothing by default.
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
node bin/crew.js --config /tmp/x.json graph            # read-only, no TTY needed
```

`start`/`install`/`workspace`/`claude` open the picker, so they need an interactive TTY
(non-TTY = clear error). Use `--dry-run` in a real terminal to inspect resolved commands
(incl. `{envfile}` wiring); `list`/`graph` work non-interactively.

## Non-goals

No task dependency graph, no ordering, no caching, no build-system behavior, no
terminal/pane spawning, no health checks. That is make/turbo/nx territory.
