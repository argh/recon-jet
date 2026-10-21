#!/bin/zsh
prev=""
while true; do
  cur=$(ioreg -p IOUSB -l -w 0 | grep -E '"(USB Product Name|USB Vendor Name|idVendor|idProduct)"' | paste - - - - | sort)
  if [[ "$cur" != "$prev" ]]; then
    echo "=== $(date '+%H:%M:%S') ==="
    diff <(echo "$prev") <(echo "$cur") | grep -E '^[<>]'
    prev="$cur"
  fi
  sleep 2
done
