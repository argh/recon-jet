#!/bin/sh
# After a bridge or mainline boot died: pull the logs it left on userdata, from whatever is
# running now (rooted stock Android via adb+su, or the bridge via adb, or ssh).
#   tools/postmortem.sh            -> work/postmortem/<timestamp>/{bridge,mainline}-*.txt
set -e
cd "$(dirname "$0")/.."
D=work/postmortem/$(date +%Y%m%d-%H%M%S); mkdir -p $D
BB=/data/local/tmp/busybox
if adb devices | grep -q "device$"; then
  if adb shell "ls /mnt/data/bridge 2>&1" | grep -q -v -i "no such"; then base=/mnt/data; else base=/data; fi
  for f in bridge/log.txt bridge/dmesg.txt bridge/alpine-boot.log bridge/alpine-dmesg.txt mainline/init.log mainline/dmesg.txt; do
    adb shell "/sbin/su -c 'cat $base/$f'" 2>/dev/null | tr -d '\r' > "$D/$(echo $f | tr / -)" || true
  done
else
  echo "no adb; try tools/jsh.sh (ssh root@jet.local)" >&2; exit 1
fi
for f in "$D"/*; do [ -s "$f" ] || rm -f "$f"; done
ls -la $D
echo "=== bridge log"; cat $D/bridge-log.txt 2>/dev/null | tail -8
echo "=== bridge dmesg: last 30 lines + any traces"; tail -30 $D/bridge-dmesg.txt 2>/dev/null | cut -c1-150
grep -n -i -E "hung task|blocked for more|Oops|BUG|Unable to handle|WARNING|wl12xx.*(error|fail|recover)|musb" $D/bridge-dmesg.txt 2>/dev/null | tail -15 | cut -c1-150
