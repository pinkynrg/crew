#!/bin/sh
# Portable black-box E2E for crew, driven by expect (real PTY). Runs the crew BINARY ($CREW) — never
# imports internals — so a port to another language keeps the suite: `CREW=./crew-rs sh tests/e2e/run.sh`.
# Coverage flows through automatically: expect spawns the binary, which inherits NODE_V8_COVERAGE (Node),
# GOCOVERDIR (Go -cover), or coverage.py's env — so `npm run test:cov` measures whatever $CREW is.
#
# Each cases/<fixture>__<scenario>.exp is run against a FRESH copy of fixtures/<fixture>/. Interactive
# raw-mode cases (the config editor, the graph selector) drive a real PTY and can flake on a loaded/slow
# CI runner (a repaint lagging behind a keystroke reads as a spurious `must` timeout), so each case gets
# ONE retry on a fresh fixture — a genuine failure still fails both attempts, a transient flake passes.
set -u
cd "$(dirname "$0")/../.." || exit 2
export CREW="${CREW:-node $(pwd)/bin/crew.js}"
pass=0; fail=0
for exp in tests/e2e/cases/*.exp; do
  [ -f "$exp" ] || continue
  name=$(basename "$exp" .exp)
  fixture=${name%%__*}
  ok=0; lastlog=""; retried=""
  for attempt in 1 2; do
    tmp=$(mktemp -d)
    cp -R "tests/e2e/fixtures/$fixture/." "$tmp/"
    if [ -f "$tmp/local.json" ]; then sed "s|__DIR__|$tmp|g" "$tmp/local.json" > "$tmp/.l" && mv "$tmp/.l" "$tmp/local.json"; fi
    export CONFIG="$tmp/config.json" TMP="$tmp"
    if expect -f "$exp" > "$tmp/log" 2>&1; then ok=1; command rm -rf "$tmp"; break; fi
    lastlog=$(sed 's/^/    /' "$tmp/log" | tail -12)
    command rm -rf "$tmp"
    [ "$attempt" = 1 ] && retried=" (retried)"
  done
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1))
    [ -n "$retried" ] && echo "flaky-but-passed $name$retried"
  else
    fail=$((fail + 1)); echo "FAIL $name (failed twice)"; printf '%s\n' "$lastlog"
  fi
done
echo "e2e: $pass passed, $fail failed"
[ "$fail" = 0 ]
