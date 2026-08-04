#!/bin/sh
echo 'api listening on :3002'
echo 'wired: auth→:3003  db→:3008  cache→:3009'
echo 'migrations up to date (24)'
echo 'ready ✓'
sleep 0.7
while :; do
  echo 'GET  /v1/orders/mine      200    9ms'; sleep 0.4
  echo 'POST /v1/orders           201   38ms'; sleep 0.6
  echo '→ auth verify token       ok     4ms'; sleep 0.4
  echo 'db  SELECT orders (12)           6ms'; sleep 0.6
  echo 'GET  /v1/users/8213       200   14ms'; sleep 0.5
  echo 'cache MISS product:552 → set'; sleep 0.5
done
