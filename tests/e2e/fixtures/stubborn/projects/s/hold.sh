trap '' TERM INT
i=1; while :; do echo "hold $i"; i=$((i+1)); sleep 1; done
