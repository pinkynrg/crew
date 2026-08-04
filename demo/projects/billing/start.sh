#!/bin/sh
echo 'billing ready on :3004 · stripe test mode'
sleep 0.8
while :; do
  echo 'charge   cus_Nz8   $49.00  ok'; sleep 0.5
  echo 'webhook  invoice.paid  processed'; sleep 0.6
  echo 'refund   ch_3P1k    $12.00  ok'; sleep 0.7
done
