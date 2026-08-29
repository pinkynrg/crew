#!/bin/sh
# TUI golden suite: drive $CREW in a PTY (expect), record raw output between `snap` points, render
# each recording to a character grid (render.mjs) and compare against the golden SCREEN. Regenerate
# with -u. Portable like tests/e2e: `CREW=./crew-go sh tests/tui/run.sh` must reproduce the screens.
set -u
cd "$(dirname "$0")/../.." || exit 2
export CREW="${CREW:-node $(pwd)/bin/crew.js}"
update=0; [ "${1:-}" = "-u" ] && update=1
pass=0; fail=0
for exp in tests/tui/cases/*.exp; do
  [ -f "$exp" ] || continue
  name=$(basename "$exp" .exp)
  fixture=${name%%__*}
  tmp=$(mktemp -d /tmp/crew-tui.XXXXXX)  # short root: paths must never display-clip before the __TMP__ normalization
  cp -R "tests/e2e/fixtures/$fixture/." "$tmp/"
  if [ -f "$tmp/local.json" ]; then sed "s|__DIR__|$tmp|g" "$tmp/local.json" > "$tmp/.l" && mv "$tmp/.l" "$tmp/local.json"; fi
  export CONFIG="$tmp/config.json" TMP="$tmp"
  if ! expect -f "$exp" > "$tmp/log" 2>&1; then
    fail=$((fail + 1)); echo "FAIL $name (driver)"; sed 's/^/    /' "$tmp/log" | tail -8
    command rm -rf "$tmp"; continue
  fi
  got="$tmp/got"; : > "$got"
  n=1
  while [ -f "$tmp/raw.$n" ]; do
    if [ ! -s "$tmp/raw.$n" ]; then n=$((n + 1)); continue; fi
    cap=""; [ -f "$tmp/cap.$n" ] && cap=" · $(cat "$tmp/cap.$n")"
    printf '── screen %s%s ──\n' "$n" "$cap" >> "$got"
    node tests/tui/render.mjs 100x30 < "$tmp/raw.$n" | sed "s|$tmp|__TMP__|g" >> "$got"
    n=$((n + 1))
  done
  gold="tests/tui/golden/$name.txt"
  if [ "$update" = 1 ]; then
    cp "$got" "$gold"; echo "UPDATED $name"
  elif [ ! -f "$gold" ]; then
    fail=$((fail + 1)); echo "FAIL $name (no golden — run with -u)"
  elif diff -u "$gold" "$got" > "$tmp/diff" 2>&1; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); echo "FAIL $name"; sed 's/^/    /' "$tmp/diff" | head -30
  fi
  command rm -rf "$tmp"
done
[ "$update" = 1 ] && exit 0
echo "tui: $pass passed, $fail failed"
[ "$fail" = 0 ]
