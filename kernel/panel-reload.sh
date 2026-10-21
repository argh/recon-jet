#!/bin/sh
# Swap the Kopin panel module on the running mainline Jet without a reboot:
#   kernel/panel-reload.sh [insmod params, e.g. a16_frame=1 pwm_rearm=0]
# Unbinds omapfb (releases the display), rmmods, pushes refs/linux/out-6.18/panel-kopin-a230.ko
# over ssh, insmods it with the given params, rebinds omapfb and prints the relevant dmesg.
cd "$(dirname "$0")/.."
KO=refs/linux/out-6.18/panel-kopin-a230.ko
J="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 root@${JET_HOST:-jet.local}"
$J "cat > /android-data/panel.ko; echo omapfb > /sys/bus/platform/drivers/omapfb/unbind 2>/dev/null; sleep 1; rmmod panel-kopin-a230 2>/dev/null; dmesg -c >/dev/null; insmod /android-data/panel.ko $*; echo insmod-rc=\$?; sleep 1; echo omapfb > /sys/bus/platform/drivers/omapfb/bind; sleep 2; ls /dev/fb0; dmesg | grep -i -E 'kopin|omapfb|SYNC|L3 Standard|WARNING' | grep -v GPIO | tail -8" < $KO
