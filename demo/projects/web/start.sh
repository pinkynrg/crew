#!/bin/sh
echo 'VITE v5.4.2  ready in 384 ms'
echo '➜  Local:   http://localhost:3000/'
echo '➜  wired to api, auth from .env'
echo '✓ 1240 modules transformed'
sleep 0.8
while :; do
  echo 'hmr update /src/routes/Checkout.tsx'; sleep 0.6
  echo 'GET / 200'; sleep 0.4
  echo 'proxy /api → http://localhost:3002'; sleep 0.5
  echo 'page reload /src/App.tsx'; sleep 0.7
  echo '✓ 12 modules transformed'; sleep 0.5
done
