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
  # one snap = one golden FILE: golden/<case>/<n>-<label>.txt — the file IS the screenshot
  # (pure rendered grid, no headers), so opening it in an editor shows the TUI at that moment.
  gdir="tests/tui/golden/$name"
  [ "$update" = 1 ] && rm -rf "$gdir"
  mkdir -p "$gdir"
  bad=0; n=1
  while [ -f "$tmp/raw.$n" ]; do
    if [ ! -s "$tmp/raw.$n" ]; then n=$((n + 1)); continue; fi
    cap="screen"; [ -f "$tmp/cap.$n" ] && cap=$(cat "$tmp/cap.$n" | tr 'A-Z ' 'a-z-' | tr -cd 'a-z0-9-')
    shot="$gdir/$n-$cap.txt"
    node tests/tui/render.mjs 100x40 < "$tmp/raw.$n" | sed "s|$tmp|__TMP__|g" > "$tmp/shot.$n"
    if [ "$update" = 1 ]; then
      cp "$tmp/shot.$n" "$shot"
    elif [ ! -f "$shot" ]; then
      bad=1; echo "FAIL $name: missing golden $shot (run with -u)"
    elif ! diff -u "$shot" "$tmp/shot.$n" > "$tmp/diff.$n" 2>&1; then
      bad=1; echo "FAIL $name: $(basename "$shot") differs"; sed 's/^/    /' "$tmp/diff.$n" | head -25
    fi
    n=$((n + 1))
  done
  if [ "$update" = 1 ]; then echo "UPDATED $name ($(ls "$gdir" | wc -l | tr -d ' ') screenshots)"
  elif [ "$bad" = 0 ]; then pass=$((pass + 1))
  else fail=$((fail + 1)); fi
  command rm -rf "$tmp"
done
[ "$update" = 1 ] && exit 0
echo "tui: $pass passed, $fail failed"
[ "$fail" = 0 ]
