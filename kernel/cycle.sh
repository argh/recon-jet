#!/bin/sh
# One mainline iteration without thumbs: emergency-restart the running mainline kernel over
# ssh (sysrq-b: a plain `reboot` can hang in device shutdown), RAM-boot the current image
# from fastboot (reissuing the `fastboot boot` that sometimes hangs right after the SAR
# reset), wait for the USB gadget, then print the lines of dmesg that match $1.
#   kernel/cycle.sh ['dmesg grep pattern'] [image]
set +e
cd "$(dirname "$0")/.."
PAT=${1:-"omapfb|omapdss|rfbi|kopin|SYNC|error|fail"}
IMG=${2:-work/mainline/boot-mainline.img}
J="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8"
if ! fastboot devices 2>/dev/null | grep -q . && adb devices 2>/dev/null | grep -q "device$"; then
  echo "stock Android via adb: rebooting to bootloader"; adb reboot bootloader
  for i in $(seq 1 60); do sleep 1; fastboot devices 2>/dev/null | grep -q . && { echo "fastboot after ${i}s"; break; }; done
fi
if ! fastboot devices 2>/dev/null | grep -q .; then
  # orderly reboot first (runs the panel's shutdown hook so the DSS is idle), sysrq-b only as
  # a fallback: an emergency restart with the display active has hard-wedged the SoC
  $J -o ServerAliveInterval=2 -o ServerAliveCountMax=2 root@${JET_HOST:-jet.local} 'reboot -f' >/dev/null 2>&1
  for i in $(seq 1 30); do sleep 1; fastboot devices 2>/dev/null | grep -q . && { echo "fastboot after ${i}s (reboot -f)"; break; }; done
  if ! fastboot devices 2>/dev/null | grep -q .; then
    echo "reboot -f did not get to fastboot; trying sysrq-b"
    $J -o ServerAliveInterval=2 -o ServerAliveCountMax=2 root@${JET_HOST:-jet.local} 'echo 1 > /proc/sys/kernel/sysrq; echo b > /proc/sysrq-trigger' >/dev/null 2>&1
    for i in $(seq 1 60); do sleep 1; fastboot devices 2>/dev/null | grep -q . && { echo "fastboot after ${i}s (sysrq)"; break; }; done
  fi
fi
fastboot devices 2>/dev/null | grep -q . || { echo "no fastboot device (adb: $(adb devices | tail -n +2 | tr -d '\n'))"; exit 1; }
sleep 6
L=/tmp/claude-501/fb.log; mkdir -p /tmp/claude-501; : > $L
(fastboot boot "$IMG" > $L 2>&1 &)
sleep 8
grep -q Finished $L || { echo "fastboot boot hung; reissuing"; pkill -f "fastboot boot"; sleep 1; fastboot boot "$IMG" 2>&1 | tail -1; }
tail -1 $L
T0=$(date +%s)
for i in $(seq 1 100); do
  sleep 1
  n=$(ioreg -p IOUSB -l 2>/dev/null | grep -o '"USB Product Name" = "[^"]*"' | grep -i -E "jet|gadget" | head -1)
  [ "$n" = '"USB Product Name" = "Jet mainline"' ] && { echo "gadget at t+$(( $(date +%s) - T0 ))s"; break; }
  fastboot devices 2>/dev/null | grep -q . && [ $i -gt 40 ] && { echo "fell back to fastboot (watchdog?)"; exit 1; }
done
sleep 22
$J root@${JET_HOST:-jet.local} "cat /proc/uptime; ls -la /dev/fb0 2>&1; dmesg | grep -i -E '$PAT' | grep -v -E 'GPIO|dependency' | tail -16" 2>&1 | tail -20
