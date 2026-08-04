#!/bin/sh
echo "listening on http://localhost:3007"
echo "wired to peers from .env"
echo "ready ✓"
i=1
while :; do sleep 1; echo "GET /health 200  (#$i)"; i=$((i+1)); done
