#!/bin/sh
echo 'db accepting connections on :3008'
echo 'autovacuum launcher started'
sleep 0.7
while :; do
  echo 'conn from api  (pid 4821)'; sleep 0.5
  echo 'SELECT orders  6ms'; sleep 0.4
  echo 'checkpoint complete  wrote 42 buffers'; sleep 0.7
  echo 'INSERT orders  1 row  3ms'; sleep 0.5
  echo 'vacuum orders  done'; sleep 0.6
done
