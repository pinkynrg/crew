#!/bin/sh
echo 'queue up · broker redis://:6379'
echo '2 workers online'
sleep 0.7
while :; do
  echo 'enqueue  checkout.email    #4821'; sleep 0.4
  echo 'enqueue  invoice.render    #4822'; sleep 0.5
  echo '→ worker picked  #4821'; sleep 0.4
  echo 'ack  #4820   82ms'; sleep 0.6
  echo 'depth=3  oldest 0.4s'; sleep 0.5
done
