#!/bin/sh
echo 'search ready on :3005 · index=products'
sleep 0.8
while :; do
  echo 'query "wireless earbuds"  32 hits  8ms'; sleep 0.5
  echo 'reindex 1204 docs'; sleep 0.7
  echo 'query "usb-c cable"       11 hits  5ms'; sleep 0.6
done
