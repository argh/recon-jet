#!/bin/sh
# Put the stock software back on the Jet, from the backups ./install.sh made of YOUR device.
#
#   ./recover.sh                     restore the stock boot image to p8 (device boots stock Android)
#   ./recover.sh --status            say what it would do, change nothing
#   ./recover.sh --recovery-slot-too also restore p7 to the STOCK recovery image (drops the
#                                    rooted-Android fallback that `reboot2 recovery` relies on)
#   ./recover.sh --clean-userdata    also delete the mainline files from userdata (rootfs, modules,
#                                    app, config) after the flash — a full return to stock
#   ./recover.sh --yes               skip confirmations
#
# Why this is safe (docs/recovery.md has the full story):
#   - It only writes a partition when the file it is writing was checksum-verified against
#     refs/backup/SHA256SUMS.txt, recorded when the backup was taken. No verified backup, no write.
#   - Every write is read back from the device and compared before you are asked to reboot.
#   - The bootloader partitions are never touched, here or anywhere else in this repo: the device
#     keeps its ability to boot and to RAM-boot rescue images (fastboot) no matter what.
#   - Works from mainline (ssh) or from the rooted Android fallback (adb) — whichever answers.
#     From mainline you can always reach the fallback first: ssh in and `reboot2 recovery`.
set -e
cd "$(dirname "$0")"
. tools/steps.sh
STEPS_NAME=recover

MODE=run; [ "$1" = "--status" ] && MODE=status
P7=0; CLEAN=0; YES=0
for a in "$@"; do case $a in --recovery-slot-too) P7=1;; --clean-userdata) CLEAN=1;; --yes) YES=1;; esac; done
[ -f work/env.sh ] && . ./work/env.sh
HOST=${JET_HOST:-jet.local}

SSHOPT="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=6"
jsh() { T=$1; shift; perl -e 'alarm shift; exec @ARGV or die' "$T" ssh $SSHOPT "root@$HOST" "$@"; }
jscp() { scp -O $SSHOPT "$@"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
BB=/data/local/busybox
asu() { adb shell "su -c '$*'" </dev/null; }
confirm() { # a tty asks; otherwise only --yes proceeds
  [ $YES = 1 ] && { info "--yes: $1"; return 0; }
  [ -t 0 ] || die "confirmation needed but not running on a terminal" "re-run with --yes to approve: $1"
  printf '  %s [type yes]: ' "$1"; read -r r; [ "$r" = yes ] || die "not confirmed" "re-run when ready (or --yes)"
}

step "checking the backups (nothing is written unless these verify)"
[ -s refs/backup/SHA256SUMS.txt ] || die "no refs/backup/SHA256SUMS.txt" "these are the backups ./install.sh takes before ever flashing; without them there is no verified stock image to restore (docs/recovery.md covers the factory-OTA fallback)"
verify_backup() { # verify_backup <file name under refs/backup>
  [ -s "refs/backup/$1" ] || die "refs/backup/$1 missing" "restore it from wherever you archived refs/backup/"
  (cd refs/backup && grep " $1\$" SHA256SUMS.txt | shasum -a 256 -c - >/dev/null 2>&1) \
    || die "refs/backup/$1 does not match the checksum recorded at backup time" "the file is damaged; restore refs/backup/ from your archive"
  ok "$1 verified against its recorded checksum"
}
verify_backup mmcblk0p8-boot.bin
[ $P7 = 1 ] && verify_backup mmcblk0p7-recovery.bin

step "finding the device"
WHERE=
if jsh 8 'uname -r' >/dev/null 2>&1; then WHERE=mainline; info "mainline answers over ssh ($HOST)"
elif adb devices 2>/dev/null | grep -qE "[[:space:]]device$" && adb shell "su -c 'id'" </dev/null 2>/dev/null | grep -q uid=0; then
  WHERE=android; info "rooted Android answers over adb"
else
  die "no device: neither ssh ($HOST) nor rooted adb" "power the Jet on. From mainline this script uses ssh directly; if mainline is broken, get the fallback with ssh + 'reboot2 recovery', or power-cycle and re-run while it can still be reached. docs/recovery.md lists every route in order."
fi
[ $MODE = status ] && { ok "status only: would restore p8$( [ $P7 = 1 ] && printf ' and p7')$( [ $CLEAN = 1 ] && printf ', then clean userdata') via $WHERE"; exit 0; }

restore_from_mainline() { # $1 backup file, $2 partition number, $3 label
  IMG=refs/backup/$1; WANT=$(sha "$IMG"); SZ=$(stat -f%z "$IMG")
  CUR=$(jsh 30 "dd if=/dev/mmcblk1p$2 bs=1M 2>/dev/null | head -c $SZ | sha256sum" | cut -d' ' -f1)
  [ "$CUR" = "$WANT" ] && { ok "p$2 ($3) already holds the stock image"; return 0; }
  jscp "$IMG" "root@$HOST:/tmp/restore.img"
  [ "$(jsh 30 'sha256sum /tmp/restore.img' | cut -d' ' -f1)" = "$WANT" ] || die "copy corrupted in transit" "re-run"
  jsh 60 "dd if=/tmp/restore.img of=/dev/mmcblk1p$2 bs=1M conv=fsync 2>/dev/null; sync; rm /tmp/restore.img"
  BACK=$(jsh 30 "dd if=/dev/mmcblk1p$2 bs=1M 2>/dev/null | head -c $SZ | sha256sum" | cut -d' ' -f1)
  [ "$BACK" = "$WANT" ] || die "read-back mismatch on p$2" "re-run; do not reboot until it verifies"
  ok "p$2 ($3) restored and verified"
}

restore_from_android() { # $1 backup file, $2 partition number, $3 label
  adb shell ls $BB >/dev/null 2>&1 || { adb push work/alpine/busybox $BB >/dev/null && asu "chmod 755 $BB"; }
  IMG=refs/backup/$1; WANT=$(sha "$IMG"); SZ=$(stat -f%z "$IMG")
  CUR=$(asu "$BB dd if=/dev/block/mmcblk0p$2 bs=1M 2>/dev/null | $BB head -c $SZ | $BB sha256sum" | cut -d' ' -f1)
  [ "$CUR" = "$WANT" ] && { ok "p$2 ($3) already holds the stock image"; return 0; }
  adb push "$IMG" /data/local/restore.img >/dev/null
  [ "$(asu "$BB sha256sum /data/local/restore.img" | cut -d' ' -f1)" = "$WANT" ] || die "copy corrupted in transit" "re-run"
  asu "$BB dd if=/data/local/restore.img of=/dev/block/mmcblk0p$2 bs=1M conv=fsync 2>/dev/null; sync; rm /data/local/restore.img"
  BACK=$(asu "$BB dd if=/dev/block/mmcblk0p$2 bs=1M 2>/dev/null | $BB head -c $SZ | $BB sha256sum" | cut -d' ' -f1)
  [ "$BACK" = "$WANT" ] || die "read-back mismatch on p$2" "re-run; do not reboot until it verifies"
  ok "p$2 ($3) restored and verified"
}

step "restoring"
info "p8 boot <- your stock backup$( [ $P7 = 1 ] && printf '; p7 recovery <- your stock recovery backup')"
[ $P7 = 1 ] && warn "after --recovery-slot-too the rooted-Android fallback is gone: getting back to mainline later means starting from ./install.sh's stock path again"
confirm "write the stock image(s) now?"
if [ $WHERE = mainline ]; then
  restore_from_mainline mmcblk0p8-boot.bin 8 "stock boot"
  [ $P7 = 1 ] && restore_from_mainline mmcblk0p7-recovery.bin 7 "stock recovery"
else
  restore_from_android mmcblk0p8-boot.bin 8 "stock boot"
  [ $P7 = 1 ] && restore_from_android mmcblk0p7-recovery.bin 7 "stock recovery"
fi

if [ $CLEAN = 1 ]; then
  step "cleaning the mainline files off userdata"
  confirm "delete the Debian rootfs, modules, firmware, app and config from userdata?"
  if [ $WHERE = mainline ]; then
    warn "cannot remove the running rootfs from inside it: rebooting to stock first, then re-run './recover.sh --clean-userdata' — it will finish over adb once stock Android is up (enable adb if needed: docs/setup.md)"
  else
    asu "$BB rm -rf /data/debian /data/alpine /data/rootfs /data/mainline /data/rootfs-debian.tar /data/local/busybox"
    ok "userdata cleaned (Android's own data was not touched)"
  fi
fi

step "rebooting into stock"
info "expect the stock Recon boot; first boot after a long time can sit on the charge screen — hold POWER ~2 s"
info "a black screen with nothing on USB is the known bootloader hang (docs/boot.md), not damage: hold POWER ~10 s, power on"
if [ $WHERE = mainline ]; then jsh 10 '/usr/local/bin/reboot2 >/dev/null 2>&1 & exit 0' || true
else adb reboot </dev/null 2>/dev/null || true; fi
ok "done — the Jet reboots into the stock software. ./install.sh brings mainline back any time."
