#!/bin/sh
# GPS on the Jet (run on the device): the WL1283's GPS core over the Bluetooth UART, served by
# TI's closed navd from the stock Android system partition in a chroot (docs/gps.md).
#   gps.sh start    power the chip (hci0 up), mount the chroot, start navd
#   gps.sh stop     stop navd; hci0 stays up only if something else wants Bluetooth
#   gps.sh status   what is running, and the last NMEA sentences seen
# Needs the hci_uart.ko with the GPS channel (the stock /dev/tigps contract; kernel/overlay).
# navd logs nowhere by default: its Android logging has no logd to reach on mainline, and its
# stdout logger prints every protocol byte and will FILL tmpfs in minutes (it killed jet-app
# once). To debug, add --log_to_stdout and redirect to /android-data, never /tmp.
# While hci0 is up, WiFi rx drops to ~1 Mbit/s (coexistence is untuned) — expected on the move.
R=/android-data/stock
case "$1" in
  start)
    grep -q tigps /proc/misc || { modprobe hci_uart; sleep 1; }
    grep -q tigps /proc/misc || { echo "hci_uart.ko has no GPS channel"; exit 1; }
    mkdir -p $R/system $R/data $R/dev $R/proc
    mountpoint -q $R/system || mount -o ro /dev/mmcblk1p9 $R/system
    mountpoint -q $R/data   || mount --bind /android-data $R/data
    mountpoint -q $R/dev    || mount --bind /dev $R/dev
    mountpoint -q $R/proc   || mount -t proc proc $R/proc
    hciconfig hci0 up || exit 1
    sleep 2
    pgrep navd >/dev/null || {
      setsid nohup chroot $R /system/bin/navd --android_log NAVD -p3 \
        '-nav"-c/system/etc/gps/config/pathconfigfile.txt"' > /dev/null 2>&1 < /dev/null &
      sleep 3
    }
    pgrep -a navd || { echo "navd did not start (run it with --log_to_stdout to see why)"; exit 1; }
    ;;
  stop)
    # navd traps TERM and keeps running; escalate
    pkill navd; sleep 1
    pgrep navd >/dev/null && pkill -9 navd
    true
    ;;
  status)
    grep tigps /proc/misc || echo "no /dev/tigps"
    hciconfig hci0 | sed -n 3p
    pgrep -a navd || echo "navd not running"
    [ -p /android-data/gps/recongps ] && timeout 3 dd if=/android-data/gps/recongps bs=256 count=2 2>/dev/null | tr -c '[:print:]\n' . | grep '\$G' | tail -4
    ;;
  *) echo "usage: $0 start|stop|status"; exit 1;;
esac
