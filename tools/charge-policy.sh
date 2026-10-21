#!/bin/sh
# Runs ON THE JET (Alpine chroot, i2c-tools): same USB charge policy as the initramfs init, for live use.
T0=0; while :; do sleep 3
  S1=$(i2cget -f -y 0 0x49 0xe3 2>/dev/null) || continue
  if [ $(( S1 & 4 )) -eq 0 ]; then T0=0; continue; fi
  NOW=$(cut -d. -f1 /proc/uptime); [ $T0 -eq 0 ] && T0=$NOW
  U=$(cat /sys/class/udc/*/state 2>/dev/null)
  if [ "$U" = configured ]; then L=0x08; elif [ $((NOW - T0)) -ge 15 ]; then L=0x29; else L=0x01; fi
  [ "$(i2cget -f -y 0 0x49 0xee)" = "$L" ] || i2cset -f -y 0 0x49 0xee $L
  [ "$(i2cget -f -y 0 0x49 0xf0)" = "0x04" ] || i2cset -f -y 0 0x49 0xf0 0x04
  [ "$(i2cget -f -y 0 0x49 0xed)" = "0x04" ] || i2cset -f -y 0 0x49 0xed 0x04
  [ "$(i2cget -f -y 0 0x49 0xe1)" = "0x30" ] || i2cset -f -y 0 0x49 0xe1 0x30
done
