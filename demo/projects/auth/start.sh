#!/bin/sh
echo 'auth ready on :3003'
echo 'JWKS rotated · 2 keys active'
sleep 0.8
while :; do
  echo 'issued JWT    user=8213  ttl=15m'; sleep 0.5
  echo 'verify        user=8213  ✓'; sleep 0.4
  echo 'token refresh user=1099'; sleep 0.6
  echo 'OAuth google  callback   ok'; sleep 0.5
  echo 'rate-limit    login  ip=… 3/10'; sleep 0.6
done
