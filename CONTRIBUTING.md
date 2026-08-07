# Contributing to crew

Thanks for helping out! crew is deliberately small — the biggest contribution is keeping it that
way. Please read these ground rules before opening a PR.

## Hard constraints (don't break these)

- **Zero runtime dependencies.** Node built-ins only (`node:fs`, `node:path`, `node:child_process`, …).
  No new entries under `dependencies` in `package.json`.
- **No build step.** The source *is* what runs — `bin/crew.js` plus the one allowed split,
  `bin/graph.js`. Don't add a bundler or break `crew.js` into more modules.
- **POSIX only** (macOS + Linux). Teardown relies on process groups (`setsid` / `kill(-pgid)`).
- **No raw stack traces on expected errors** — throw `CrewError` (one-line message, non-zero exit).

## Dev loop

No install needed — it's zero-dep, so you run the file directly:

```sh
node --check bin/crew.js                     # syntax check
npm test                                     # graph snapshots + expect-driven E2E
node bin/crew.js --config /tmp/x.json list   # try it against a throwaway config
```

## Commits & PRs

- **Single-line commit messages**, no body.
- **No tool/agent attribution anywhere** — not in the commit author/committer, the message, or the
  PR body. Commit as yourself.
- Keep PRs focused. If you change behavior, update `README.md`; if you add a config field, update
  `crew check`'s key sets (`TOP_KEYS` / `PROJECT_KEYS` / `GUARD_KEYS`) so validation stays in sync.
- Please check the README's **Non-goals** before proposing features — crew intentionally has no task
  dependency graph, ordering, caching, or build-system behavior (that's make/turbo/nx territory).

## Reporting bugs / ideas

Open an issue using the templates. For questions or design discussion, a GitHub Discussion is great.
