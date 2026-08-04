#!/bin/sh
echo 'admin (next) ready on :3001'
sleep 0.8
while :; do
  echo 'GET /admin/dashboard        200'; sleep 0.6
  echo 'GET /admin/users?page=2     200'; sleep 0.5
  echo 'GET /admin/orders/8842      200'; sleep 0.7
done
