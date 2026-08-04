#!/bin/sh
echo 'cache ready to accept connections :3009'
echo 'loaded 1284 keys from dump.rdb'
sleep 0.8
while :; do
  echo 'GET session:8213  HIT'; sleep 0.4
  echo 'SET cart:8213  EX 900'; sleep 0.5
  echo 'keyspace hits 98.2%'; sleep 0.6
  echo 'GET product:552   MISS'; sleep 0.4
  echo 'evicted 3 keys (lru)'; sleep 0.6
done
