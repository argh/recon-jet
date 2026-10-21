#!/bin/sh
# RAM-boot the mainline image and watch the Mac's USB for the result.
#   kernel/boot.sh            expects the Jet in fastboot (or adb: it reboots to bootloader first)
set +e
cd "$(dirname "$0")/.."
IMG=${1:-work/mainline/boot-mainline.img}
for i in $(seq 1 90); do
  fastboot devices 2>/dev/null | grep -q . && break
  adb devices 2>/dev/null | grep -q "device$" && { adb reboot bootloader; sleep 3; }
  sleep 1
done
fastboot devices | grep -q . || { echo "no fastboot device"; exit 1; }
T0=$(date +%s)
fastboot boot "$IMG" 2>&1 | tail -1
for i in $(seq 1 120); do
  sleep 1
  name=$(ioreg -p IOUSB -l 2>/dev/null | grep -o '"USB Product Name" = "[^"]*"' | grep -v -i -E "hub|keyboard|webcam|receiver" | head -1)
  cu=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
  ecm=$(ifconfig 2>/dev/null | grep -B6 "inet ${USBNET:-10.42.0}\." | grep -o "^en[0-9]*" | head -1)
  fb=$(fastboot devices 2>/dev/null); ad=$(adb devices 2>/dev/null | grep "device$")
  [ -n "$name$cu$ecm$fb$ad" ] && echo "t+$(( $(date +%s) - T0 ))s: $name cu=[$cu] ecm=[$ecm] fastboot=[$fb] adb=[$ad]"
  [ -n "$ecm" ] && { echo "ECM up on $ecm: ssh root@jet.local"; break; }
  [ -n "$fb$ad" ] && [ $i -gt 20 ] && { echo "device fell back (watchdog/panic?)"; break; }
  [ -n "$cu" ] && [ $i -gt 60 ] && { echo "serial only, no ECM"; break; }
done
