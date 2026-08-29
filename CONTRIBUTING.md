# Contributing to crew

Thanks for helping out! crew is deliberately small — the biggest contribution is keeping it that
way. Please read these ground rules before opening a PR.

## Hard constraints (don't break these)

- **Single static binary; micro-deps only.** Go stdlib + `golang.org/x/term` + `golang.org/x/sys`.
  No frameworks (no bubbletea/cobra) — the hand-rolled TUIs are golden-snapshot-tested to the byte.
- **POSIX only** (macOS + Linux). Teardown relies on process groups (`Setpgid` / `kill(-pgid)`).
- **No raw stack traces on expected errors** — `fail()` a `CrewError` (one-line message, non-zero exit).

## Dev loop

Go builds it; Node + `expect` are dev-only tools the test harness uses:

```sh
make build                                     # -> .build/crew + .build/crew-graph
make test                                      # graph goldens + expect-driven E2E (screen snapshots)
.build/crew --config /tmp/x.json list          # try it against a throwaway config
```

## Commits & PRs

- **Single-line commit messages**, no body.
- **No tool/agent attribution anywhere** — not in the commit author/committer, the message, or the
  PR body. Commit as yourself.
- Keep PRs focused. If you change behavior, update `README.md`; if you add a config field, update
  `crew check`'s key sets (`topKeys` / `serviceKeys` / `guardKeys`) so validation stays in sync.
- Please check the README's **Non-goals** before proposing features — crew intentionally has no task
  dependency graph, ordering, caching, or build-system behavior (that's make/turbo/nx territory).

## Reporting bugs / ideas

Open an issue using the templates. For questions or design discussion, a GitHub Discussion is great.
