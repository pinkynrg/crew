#!/bin/sh
# Portable black-box E2E for crew, driven by expect (real PTY). Runs the crew BINARY ($CREW) — never
# imports internals — so a port to another language keeps the suite: `CREW=./crew-rs sh tests/e2e/run.sh`.
# Coverage flows through automatically: expect spawns the binary, which inherits NODE_V8_COVERAGE (Node),
# GOCOVERDIR (Go -cover), or coverage.py's env — so `npm run test:cov` measures whatever $CREW is.
#
# Each cases/<fixture>__<scenario>.exp is run against a fresh copy of fixtures/<fixture>/.
set -u
cd "$(dirname "$0")/../.." || exit 2
export CREW="${CREW:-node $(pwd)/bin/crew.js}"
pass=0; fail=0
for exp in tests/e2e/cases/*.exp; do
  [ -f "$exp" ] || continue
  name=$(basename "$exp" .exp)
  fixture=${name%%__*}
  tmp=$(mktemp -d)
  cp -R "tests/e2e/fixtures/$fixture/." "$tmp/"
  if [ -f "$tmp/local.json" ]; then sed "s|__DIR__|$tmp|g" "$tmp/local.json" > "$tmp/.l" && mv "$tmp/.l" "$tmp/local.json"; fi
  export CONFIG="$tmp/config.json" TMP="$tmp"
  if expect -f "$exp" > "$tmp/log" 2>&1; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); echo "FAIL $name"; sed 's/^/    /' "$tmp/log" | tail -12
  fi
  command rm -rf "$tmp"
done
echo "e2e: $pass passed, $fail failed"
[ "$fail" = 0 ]
