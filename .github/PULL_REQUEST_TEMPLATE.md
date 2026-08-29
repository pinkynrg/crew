## What & why

<!-- What does this change, and why? Link any related issue. -->

## How it was tested

- [ ] `make test` (graph goldens + expect-driven E2E incl. screen snapshots)
- [ ] `go vet ./...` + `gofmt -l` clean
- [ ] Tried manually against a throwaway config

## Checklist

- [ ] No new runtime dependencies (Node built-ins only)
- [ ] No new dependencies beyond stdlib + x/term + x/sys; no TUI frameworks
- [ ] `README.md` updated if behavior changed
- [ ] `crew check` key sets updated if a config field was added
- [ ] Single-line commit messages, no tool/agent attribution
