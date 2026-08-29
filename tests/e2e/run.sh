#!/bin/sh
# Portable black-box E2E for crew, driven by expect (real PTY). Runs the crew BINARY ($CREW,
# default .build/crew — `make test` builds it first) and never imports internals, so any
# implementation that behaves the same passes. Coverage flows through automatically: expect spawns
# the binary, which inherits GOCOVERDIR (go build -cover) — `make cov` measures it.
#
# Each cases/<group>_<scenario>.exp declares its fixture in-file ("# fixture: <name>") and runs against
# a FRESH copy of fixtures/<name>/. Interactive raw-mode cases (the config editor, the graph selector)
# drive a real PTY and can flake on a loaded/slow CI runner (a repaint lagging behind a keystroke reads
# as a spurious `must` timeout), so each case gets ONE retry on a fresh fixture — a genuine failure
# still fails both attempts, a transient flake passes.
#
# SCREEN SNAPSHOTS: a case that calls `snap "<label>"` records the raw PTY output between capture
# points; after a passing drive each recording is rendered to a character grid (utils/render.mjs) and
# diffed against the golden folder BESIDE the case: cases/<case>.snaps/<n>-<label>.txt — one snap =
# one golden FILE, the file IS the screenshot (pure rendered grid, no headers). Run with -u to
# (re)write goldens. Geometry: the shared default in utils/lib.exp (100x40); a case that overrides
# `stty_init` gets its goldens rendered at ITS declared size. Golden diffs are deterministic, so a
# mismatch fails without a retry.
#
# Usage: sh tests/e2e/run.sh [-u] [name…]   — names filter cases by substring.
set -u
cd "$(dirname "$0")/../.." || exit 2
export CREW="${CREW:-$(pwd)/.build/crew}"
update=0; filters=""
for a in "$@"; do
  if [ "$a" = "-u" ]; then update=1; else filters="$filters $a"; fi
done
pass=0; fail=0
for exp in tests/e2e/cases/*.exp; do
  [ -f "$exp" ] || continue
  name=$(basename "$exp" .exp)
  if [ -n "$filters" ]; then
    hit=0
    for w in $filters; do case "$name" in *"$w"*) hit=1;; esac; done
    [ "$hit" = 1 ] || continue
  fi
  fixture=$(sed -n 's/^# fixture: //p' "$exp" | head -1)
  if [ -z "$fixture" ] || [ ! -d "tests/e2e/fixtures/$fixture" ]; then
    fail=$((fail + 1)); echo "FAIL $name (missing '# fixture: <name>' or fixtures/$fixture)"; continue
  fi
  ok=0; lastlog=""; retried=""; tmp=""
  for attempt in 1 2; do
    # short tmp root: snapshot paths must never display-clip to `…` before the __TMP__ normalization
    tmp=$(mktemp -d /tmp/crew-e2e.XXXXXX)
    cp -R "tests/e2e/fixtures/$fixture/." "$tmp/"
    if [ -f "$tmp/local.json" ]; then sed "s|__DIR__|$tmp|g" "$tmp/local.json" > "$tmp/.l" && mv "$tmp/.l" "$tmp/local.json"; fi
    export CONFIG="$tmp/config.json" TMP="$tmp"
    if expect -f "$exp" > "$tmp/log" 2>&1; then ok=1; break; fi
    lastlog=$(sed 's/^/    /' "$tmp/log" | tail -12)
    command rm -rf "$tmp"
    [ "$attempt" = 1 ] && retried=" (retried)"
  done
  if [ "$ok" != 1 ]; then
    fail=$((fail + 1)); echo "FAIL $name (failed twice)"; printf '%s\n' "$lastlog"; continue
  fi
  # golden screenshots — only for cases that snapped (a cap.N label beside each recording)
  bad=0
  if ls "$tmp"/cap.* > /dev/null 2>&1; then
    size=$(sed -n 's/^set stty_init "rows \([0-9]*\) cols \([0-9]*\)".*/\2x\1/p' "$exp" | head -1)
    size=${size:-100x40}   # keep in sync with the utils/lib.exp default
    gdir="tests/e2e/cases/$name.snaps"
    [ "$update" = 1 ] && rm -rf "$gdir"
    mkdir -p "$gdir"
    n=1
    while [ -f "$tmp/raw.$n" ]; do
      if [ ! -s "$tmp/raw.$n" ] || [ ! -f "$tmp/cap.$n" ]; then n=$((n + 1)); continue; fi
      cap=$(cat "$tmp/cap.$n" | tr 'A-Z ' 'a-z-' | tr -cd 'a-z0-9-')
      shot="$gdir/$n-$cap.txt"
      node tests/e2e/utils/render.mjs "$size" < "$tmp/raw.$n" | sed "s|$tmp|__TMP__|g" > "$tmp/shot.$n"
      if [ "$update" = 1 ]; then
        cp "$tmp/shot.$n" "$shot"
      elif [ ! -f "$shot" ]; then
        bad=1; echo "FAIL $name: missing golden $shot (run with -u)"
      elif ! diff -u "$shot" "$tmp/shot.$n" > "$tmp/diff.$n" 2>&1; then
        bad=1; echo "FAIL $name: $(basename "$shot") differs"; sed 's/^/    /' "$tmp/diff.$n" | head -25
      fi
      n=$((n + 1))
    done
  fi
  command rm -rf "$tmp"
  if [ "$bad" = 0 ]; then
    pass=$((pass + 1))
    [ -n "$retried" ] && echo "flaky-but-passed $name$retried"
  else
    fail=$((fail + 1))
  fi
done
echo "e2e: $pass passed, $fail failed"
[ "$fail" = 0 ]
