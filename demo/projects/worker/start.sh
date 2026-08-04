#!/bin/sh
echo 'worker online · concurrency 8'
sleep 0.8
while :; do
  echo 'job checkout.email  #4821  running'; sleep 0.5
  echo 'sent 3 emails via ses'; sleep 0.4
  echo 'job done  #4821  128ms'; sleep 0.6
  echo 'job invoice.render #4822  running'; sleep 0.5
  echo 'rendered invoice.pdf  41kb'; sleep 0.6
done
