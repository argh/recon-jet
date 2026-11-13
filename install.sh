#!/bin/sh
# Take a Recon Jet from wherever it is to mainline Linux — or bring an installed one up to date.
#
#   ./install.sh             do the next right thing, start to finish
#   ./install.sh --status    say what it would do (device state + artifact freshness), change nothing
#   ./install.sh --build-only  stop after building; do not touch the device
#   ./install.sh --yes       skip the confirmation before the first-ever flash
#
# Run ./setup.sh first. The script detects the device's state every run (powered off, stock
# Android over MTP, adb, fastboot, or mainline over ssh) and continues from there, so it is safe
# to re-run after any interruption: finished work is detected and skipped, not repeated.
#
# What keeps your device safe (docs/recovery.md has the full story):
#   - The bootloader partitions (p1 xloader, p2 u-boot) are NEVER written. They are what makes
#     the device recoverable, and nothing here touches them.
#   - Before anything is flashed, every partition except userdata is backed up to refs/backup/
#     with checksums. ./recover.sh restores stock from exactly those files.
#   - Test images are RAM-booted (`fastboot boot`): a bad one costs a power cycle, not a reflash.
#   - Only p7 (recovery -> rooted stock Android, the fallback) and p8 (boot -> mainline) are
#     flashed, each verified by reading the partition back and comparing checksums.
#   - This bootloader sometimes hangs at a reset ("boot lottery", docs/boot.md): black screen,
#     nothing on USB. That is a hang, not damage — hold POWER ~10 s (or pull the battery), power
#     on, and re-run this script.
set -e
cd "$(dirname "$0")"
. tools/steps.sh
STEPS_NAME=install

VER=${VER:-6.18}
OUT=refs/linux/out-$VER
MODE=run; [ "$1" = "--status" ] && MODE=status; [ "$1" = "--build-only" ] && MODE=build
YES=0; for a in "$@"; do [ "$a" = "--yes" ] && YES=1; done
[ -f work/env.sh ] && . ./work/env.sh
HOST=${JET_HOST:-jet.local}

SSHOPT="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=6"
jsh() { T=$1; shift; perl -e 'alarm shift; exec @ARGV or die' "$T" ssh $SSHOPT "root@$HOST" "$@"; }
jscp() { scp -O $SSHOPT "$@"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
have() { command -v "$1" >/dev/null 2>&1; }
confirm() { # confirm "question"  (a tty asks; otherwise only --yes proceeds)
  [ $YES = 1 ] && { info "--yes: $1"; return 0; }
  [ -t 0 ] || die "confirmation needed but not running on a terminal" "re-run with --yes to approve: $1"
  printf '  %s [type yes]: ' "$1"; read -r r; [ "$r" = yes ] || die "not confirmed" "re-run when ready (or --yes)"
}

# Android-side helpers. The RAM-booted rooted image runs adbd as root; `su -c` also covers the
# flashed rooted image. BB is our static busybox pushed to the device (stock toolbox has no
# tar/sha256sum/dd worth having). The command is single-quoted for the device shell because
# /sbin/su execs exactly argv[2]; this old adbd also never propagates exit codes, which is why
# every critical operation below is verified by reading back a checksum, not by exit status.
BB=/data/local/busybox
asu() { adb shell "su -c '$*'" </dev/null; }
push_busybox() {
  adb shell ls $BB >/dev/null 2>&1 && asu "$BB sha256sum $BB" | grep -q "$(sha work/alpine/busybox)" && return 0
  adb push work/alpine/busybox $BB >/dev/null && asu "chmod 755 $BB"
}

# ---------------------------------------------------------------------------------------------
step "prerequisites"
if [ $MODE != build ]; then   # --build-only needs no personalisation; everything else does
  [ -s work/setup.json ] || die "no answers from ./setup.sh" "run ./setup.sh first (asks WiFi, ssh key, services; writes only gitignored files)"
  [ -s work/wifi/wpa_supplicant.conf ] && [ -s work/ssh/authorized_keys ] || die "setup outputs missing" "re-run ./setup.sh"
fi
for t in node docker adb fastboot; do have $t || die "$t not found" "install it (macOS: brew install $t; adb/fastboot are in android-platform-tools)"; done
docker info >/dev/null 2>&1 || die "docker is not running" "start Docker and re-run"
ZIG=${ZIG:-$(command -v zig || echo /opt/homebrew/bin/zig)}
[ -x "$ZIG" ] || die "zig not found (cross-compiler for the on-device tools)" "brew install zig, or ZIG=/path/to/zig ./install.sh"
ok "node, docker (running), adb, fastboot, zig"

step "public firmware (WiFi needs files from linux-firmware and wireless-regdb)"
mkdir -p refs/firmware/ti-connectivity
LF=https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain
RD=https://git.kernel.org/pub/scm/linux/kernel/git/sforshee/wireless-regdb.git/plain
fw() { # fw <dest-under-refs/firmware> <url>
  [ -s "refs/firmware/$1" ] && { info "$1 present"; return 0; }
  [ $MODE = status ] && { warn "$1 missing (would download)"; return 0; }
  curl -fsSL -o "refs/firmware/$1" "$2" || die "download failed: $1" "fetch $2 manually into refs/firmware/$1"
  head -c5 "refs/firmware/$1" | grep -qi "<" && die "$1 downloaded as HTML, not binary" "fetch it manually from $2"
  ok "fetched $1"
}
fw ti-connectivity/wl128x-fw-5-sr.bin "$LF/ti-connectivity/wl128x-fw-5-sr.bin"
fw ti-connectivity/wl128x-fw-5-mr.bin "$LF/ti-connectivity/wl128x-fw-5-mr.bin"
fw regulatory.db "$RD/regulatory.db"
fw regulatory.db.p7s "$RD/regulatory.db.p7s"
info "device-specific firmware (WiFi calibration, BT init) is pulled from YOUR device later"

# ---------------------------------------------------------------------------------------------
# Builds. Each one is skipped when its output is newer than its inputs, so re-runs are fast.
newer_than() { # newer_than <output> <input...>: true if output exists and no input is newer
  o=$1; shift; [ -f "$o" ] || return 1
  [ -z "$(find "$@" -newer "$o" -type f -not -name '.DS_Store' 2>/dev/null | head -1)" ]
}
BLOG=work/install-build.log
mkdir -p work; [ $MODE != status ] && : > $BLOG   # one log per run
run_logged() { # run_logged "label" cmd...: full output to $BLOG; on failure show the tail and stop
  L=$1; shift
  printf '\n===== %s: %s =====\n' "$(date '+%H:%M:%S')" "$L" >> $BLOG
  if "$@" >> $BLOG 2>&1; then return 0; fi
  tail -8 $BLOG | sed 's/^/    /'
  die "$L failed" "full log: $BLOG"
}

step "kernel (Docker; first build fetches the source and takes a while)"
if newer_than $OUT/zImage kernel/jet.config kernel/omap4-recon-jet.dts kernel/overlay kernel/patches; then
  ok "zImage current ($OUT/zImage)"
elif [ $MODE = status ]; then warn "zImage stale or missing (would build)"
else
  run_logged "kernel source fetch" sh kernel/build.sh fetch
  run_logged "kernel configure" sh kernel/build.sh defconfig
  run_logged "kernel build" sh kernel/build.sh zimage
  [ -s $OUT/zImage ] && newer_than $OUT/zImage kernel/jet.config || die "kernel build produced no fresh zImage" "read $BLOG"
  ok "built $OUT/zImage"
fi

step "kernel modules (Bluetooth, WireGuard, audio, ... live on userdata)"
if newer_than $OUT/modules.tar kernel/jet.config kernel/overlay kernel/patches; then ok "modules.tar current"
elif [ $MODE = status ]; then warn "modules.tar stale or missing (would build)"
else
  run_logged "module build" sh kernel/build.sh modules
  [ -s $OUT/modules.tar ] && newer_than $OUT/modules.tar kernel/jet.config || die "module build produced no fresh modules.tar" "read $BLOG"
  ok "built $OUT/modules.tar"
fi

step "Debian rootfs (Docker arm/v7 emulation)"
if newer_than work/rootfs-debian.tar kernel/rootfs/Dockerfile kernel/rootfs/udhcpc-default.script kernel/rootfs/settime kernel/rootfs/wireguard/on-wifi.sh; then
  ok "rootfs tarball current"
elif [ $MODE = status ]; then warn "rootfs tarball stale or missing (would build)"
else
  run_logged "rootfs build" sh kernel/rootfs/build.sh
  [ -s work/rootfs-debian.tar ] && newer_than work/rootfs-debian.tar kernel/rootfs/Dockerfile || die "rootfs build produced no fresh tarball" "read $BLOG"
  ok "built work/rootfs-debian.tar"
fi

step "on-device tools (static ARM via zig) and the jet-app bundle"
zcc() { # zcc <out> <src>
  if newer_than "$1" "$2"; then info "$(basename $1) current"
  elif [ $MODE = status ]; then warn "$(basename $1) stale or missing (would build)"
  else "$ZIG" cc -target arm-linux-musleabihf -mcpu=cortex_a9 -static -O2 -s -o "$1" "$2" && info "built $(basename $1)"; fi
}
zcc tools/reboot2/reboot2 tools/reboot2/reboot2.c
zcc tools/regdump/regdump tools/regdump/regdump.c
zcc tools/fbfill/fbfill   tools/fbfill/fbfill.c
zcc tools/su/su           tools/su/su.c
if newer_than agent/jetd agent/jetd.c; then info "jetd current"
elif [ $MODE != status ]; then ZIG="$ZIG" run_logged "jetd build" sh agent/build.sh; info "built jetd"
else warn "jetd stale (would build)"; fi
if newer_than work/jet-app.tgz device/jet-app/src device/jet-app/package.json; then info "jet-app bundle current"
elif [ $MODE != status ]; then run_logged "jet-app bundle" sh device/jet-app/deploy/bundle.sh; info "bundled jet-app"
else warn "jet-app bundle stale (would build)"; fi
if [ -s work/alpine/busybox ]; then info "static busybox present"
elif [ $MODE != status ]; then
  mkdir -p work/alpine
  docker run --rm --platform linux/arm/v7 alpine:3.20 sh -c 'apk add -q busybox-static && cat /bin/busybox.static' > work/alpine/busybox.tmp 2>>$BLOG \
    || die "busybox fetch failed" "read $BLOG"
  file work/alpine/busybox.tmp | grep -q "ARM" || die "fetched busybox is not an ARM binary" "read $BLOG"
  mv work/alpine/busybox.tmp work/alpine/busybox && chmod 755 work/alpine/busybox && info "fetched static busybox (Alpine arm/v7)"
else warn "static busybox missing (would fetch via Docker)"; fi
ok "tools ready"

# Boot images need work/curboot/info.json: the header fields of YOUR device's stock boot image.
# It appears automatically once the stock boot partition has been backed up (below).
bootimgs() {
  if [ ! -s work/curboot/info.json ]; then
    [ -s refs/backup/mmcblk0p8-boot.bin ] || return 1
    [ $MODE = status ] && { warn "boot-image header not yet unpacked from your stock backup (would do it)"; return 0; }
    node tools/bootimg.js unpack refs/backup/mmcblk0p8-boot.bin work/curboot >/dev/null
    info "boot image header taken from your stock backup"
  fi
  if newer_than work/mainline/boot-emmc.img $OUT/zImage kernel/initramfs/init agent/jetd work/alpine/busybox; then
    info "boot images current"
  elif [ $MODE = status ]; then warn "boot images stale or missing (would build)"
  else
    run_logged "boot image pack" sh kernel/mkboot.sh
    [ -s work/mainline/boot-emmc.img ] || die "mkboot produced no boot-emmc.img" "read $BLOG"
    grep -q "fits the 8 MB boot partition" $BLOG || die "boot-emmc.img exceeds the 8 MB boot partition" "trim the initramfs (kernel/mkboot.sh)"
    info "packed boot-mainline.img (RAM boots) and boot-emmc.img (flash)"
  fi
}
step "boot images"
if bootimgs; then ok "work/mainline/boot-emmc.img ready"
else info "waiting on the stock-boot backup from your device (made below) — built after that"; fi

[ $MODE = build ] && { ok "build-only: stopping before any device contact"; exit 0; }

# ---------------------------------------------------------------------------------------------
# Device states. Probe fresh each time; every path either advances the device or exits with
# exactly one physical action to take, and the script re-run picks up from the new state.
probe() {
  jsh 8 'uname -r' >/dev/null 2>&1 && { echo mainline; return; }
  if adb devices 2>/dev/null | grep -qE "[[:space:]]device$"; then
    adb shell "su -c 'id'" </dev/null 2>/dev/null | grep -q uid=0 && echo rooted || echo stock; return
  fi
  fastboot devices 2>/dev/null | grep -q fastboot && { echo fastboot; return; }
  have mtp-detect && perl -e 'alarm 15; exec @ARGV' mtp-detect 2>/dev/null | grep -qiE "recon|0x2523" && { echo mtp; return; }
  echo none
}

backup_partitions() { # from rooted Android; skip everything already backed up and verified
  mkdir -p refs/backup; push_busybox
  set -- 1-xloader 2-bootloader 3-ubootenv 4-misc 5-efs 6-crypto 7-recovery 8-boot 9-system 10-cache
  if [ ! -s refs/backup/gpt-primary.bin ]; then
    asu "$BB dd if=/dev/block/mmcblk0 of=/data/local/gpt.bin bs=512 count=34 2>/dev/null"
    adb pull /data/local/gpt.bin refs/backup/gpt-primary.bin >/dev/null; asu "rm /data/local/gpt.bin"
    info "backed up GPT"
  fi
  for p in "$@"; do
    n=${p%%-*}; f=refs/backup/mmcblk0p$p.bin
    if [ -s "$f" ] && grep -q "mmcblk0p$p.bin" refs/backup/SHA256SUMS.txt 2>/dev/null \
       && (cd refs/backup && grep "mmcblk0p$p.bin" SHA256SUMS.txt | shasum -a 256 -c - >/dev/null 2>&1); then
      info "p$n (${p#*-}) already backed up and verified"; continue
    fi
    info "backing up p$n (${p#*-}) ..."
    asu "$BB dd if=/dev/block/mmcblk0p$n of=/data/local/part.bin bs=1M 2>/dev/null"
    DEV=$(asu "$BB sha256sum /data/local/part.bin" | cut -d' ' -f1)
    adb pull /data/local/part.bin "$f" >/dev/null; asu "rm /data/local/part.bin"
    [ "$(sha "$f")" = "$DEV" ] || { rm -f "$f"; die "p$n backup checksum mismatch after pull" "re-run; nothing was written to the device"; }
    grep -v "mmcblk0p$p.bin" refs/backup/SHA256SUMS.txt 2>/dev/null > refs/backup/SHA256SUMS.tmp || true
    printf '%s  mmcblk0p%s.bin\n' "$DEV" "$p" >> refs/backup/SHA256SUMS.tmp
    mv refs/backup/SHA256SUMS.tmp refs/backup/SHA256SUMS.txt
    ok "p$n (${p#*-}) backed up, checksum recorded"
  done
}

pull_device_firmware() {
  F=refs/firmware/ti-connectivity
  [ -s $F/wl1271-nvs.bin ] && { info "device firmware already pulled"; return 0; }
  for f in wl1271-nvs.bin TIInit_7.2.31.bts TIInit_10.6.15.bts TIInit_7.6.15.bts; do
    adb pull /system/etc/firmware/ti-connectivity/$f $F/$f >/dev/null 2>&1 || warn "$f not on this build (ok unless WiFi/BT misbehaves later)"
  done
  [ -s $F/wl1271-nvs.bin ] || die "could not pull the WiFi calibration (wl1271-nvs.bin)" "it holds your MAC + radio tuning; find it under /system/etc/firmware and copy it to $F/"
  ok "pulled your device's WiFi calibration and BT init scripts"
}

build_rooted_image() { # $1 = source boot image -> work/boot-root.img (ramdisk: adb as root + /sbin/su)
  [ -s work/boot-root.img ] && newer_than work/boot-root.img "$1" tools/su/su && { info "rooted image current"; return 0; }
  R=work/rootboot; rm -rf $R; mkdir -p $R/ramdisk
  node tools/bootimg.js unpack "$1" $R >/dev/null
  (cd $R/ramdisk && gzip -dc ../ramdisk.gz | cpio -idm --quiet 2>/dev/null) || true
  [ -f $R/ramdisk/default.prop ] || die "unexpected ramdisk layout in $1" "unpack it with tools/bootimg.js and look around"
  for kv in ro.secure=0 ro.debuggable=1 persist.sys.usb.config=mtp,adb; do
    k=${kv%%=*}
    grep -q "^$k=" $R/ramdisk/default.prop && sed -i '' "s|^$k=.*|$kv|" $R/ramdisk/default.prop || echo "$kv" >> $R/ramdisk/default.prop
  done
  cp tools/su/su $R/ramdisk/sbin/su && chmod 6755 $R/ramdisk/sbin/su
  awk '1; /^on boot$/ && !done { print "    write /proc/sys/kernel/dmesg_restrict 0"; print "    chmod 0755 /sbin"; done=1 }' \
    $R/ramdisk/init.rc > $R/ramdisk/init.rc.new && mv $R/ramdisk/init.rc.new $R/ramdisk/init.rc
  node tools/cpio-newc.js $R/ramdisk $R/ramdisk-root.gz
  node tools/bootimg.js pack $R work/boot-root.img --ramdisk $R/ramdisk-root.gz >/dev/null
  ok "built work/boot-root.img (stock kernel, adb-as-root ramdisk, /sbin/su)"
}

flash_from_android() { # $1 local image, $2 partition number, $3 label
  push_busybox
  WANT=$(sha "$1")
  CUR=$(asu "$BB dd if=/dev/block/mmcblk0p$2 bs=1M 2>/dev/null | $BB head -c $(stat -f%z "$1") | $BB sha256sum" | cut -d' ' -f1)
  [ "$CUR" = "$WANT" ] && { ok "p$2 ($3) already holds this image"; return 0; }
  adb push "$1" /data/local/flash.img >/dev/null
  [ "$(asu "$BB sha256sum /data/local/flash.img" | cut -d' ' -f1)" = "$WANT" ] || die "push of $3 corrupted in transit" "re-run"
  asu "$BB dd if=/data/local/flash.img of=/dev/block/mmcblk0p$2 bs=1M conv=fsync 2>/dev/null; sync"
  BACK=$(asu "$BB dd if=/dev/block/mmcblk0p$2 bs=1M 2>/dev/null | $BB head -c $(stat -f%z "$1") | $BB sha256sum" | cut -d' ' -f1)
  asu "rm /data/local/flash.img"
  [ "$BACK" = "$WANT" ] || die "p$2 read-back does not match after writing $3" "re-run (the write is repeatable); do not reboot until it verifies"
  ok "p$2 ($3) written and verified"
}

stage_userdata_from_android() {
  push_busybox
  info "staging the Debian rootfs on userdata (one-time, a few minutes)"
  adb push work/rootfs-debian.tar /data/rootfs-debian.tar >/dev/null
  asu "rm -rf /data/debian; $BB mkdir -p /data/debian && $BB tar -xf /data/rootfs-debian.tar -C /data/debian && rm /data/rootfs-debian.tar"
  asu "echo 127.0.1.1 jet >> /data/debian/etc/hosts"   # Docker cannot bake this (its /etc/hosts is a build-time mount)
  adb push work/wifi/wpa_supplicant.conf /data/debian/etc/wpa_supplicant/wpa_supplicant.conf >/dev/null
  adb push work/ssh/authorized_keys /data/debian/root/.ssh/authorized_keys >/dev/null
  asu "$BB chmod 600 /data/debian/root/.ssh/authorized_keys /data/debian/etc/wpa_supplicant/wpa_supplicant.conf; $BB chown -R 0:0 /data/debian/root /data/debian/etc/wpa_supplicant"
  info "rootfs + your WiFi + your ssh key in place"
  asu "$BB mkdir -p /data/mainline/modules /data/mainline/firmware/ti-connectivity /data/debian/opt/jet-app"
  adb push $OUT/modules.tar /data/modules.tar >/dev/null
  asu "$BB tar -xf /data/modules.tar -C /data/mainline/modules && rm /data/modules.tar"
  for f in refs/firmware/ti-connectivity/TIInit_*.bts; do adb push "$f" /data/mainline/firmware/ti-connectivity/ >/dev/null; done
  adb push work/jet-app.tgz /data/jet-app.tgz >/dev/null
  asu "$BB tar -xzf /data/jet-app.tgz -C /data/debian/opt/jet-app && rm /data/jet-app.tgz && $BB chown -R 0:0 /data/debian/opt/jet-app"
  adb push work/device/jet-app.json /data/mainline/jet-app.json >/dev/null 2>&1 || true
  if [ -s work/wireguard/wg0.conf ]; then
    asu "$BB mkdir -p /data/mainline/wireguard"
    for f in wg0.conf trusted routes; do [ -s work/wireguard/$f ] && adb push work/wireguard/$f /data/mainline/wireguard/$f >/dev/null; done
    asu "$BB chmod 600 /data/mainline/wireguard/wg0.conf"
  fi
  [ -s work/usbnet ] && adb push work/usbnet /data/mainline/usbnet >/dev/null
  asu "cd /data && $BB ln -sfn debian rootfs"
  ok "userdata staged: rootfs, modules, firmware, app, your config"
}

mainline_sync() { # keep an installed device current; every piece skipped unless changed
  sync_file() { # sync_file <local> <remote> [mode]
    L=$(sha "$1"); R=$(jsh 20 "sha256sum '$2' 2>/dev/null | cut -d' ' -f1" || true)
    [ "$L" = "$R" ] && { info "$(basename $2) current"; return 0; }
    jscp "$1" "root@$HOST:$2" && [ -n "$3" ] && jsh 10 "chmod $3 '$2'"; ok "pushed $(basename $2)"
  }
  jsh 10 'mkdir -p /android-data/mainline/wireguard /etc/wpa_supplicant' >/dev/null
  sync_file work/wifi/wpa_supplicant.conf /etc/wpa_supplicant/wpa_supplicant.conf 600
  sync_file work/ssh/authorized_keys /root/.ssh/authorized_keys 600
  # the rootfs's own scripts: small, and a fix to one should not need a rootfs rebuild + reinstall
  sync_file kernel/rootfs/settime /usr/local/sbin/settime 755
  sync_file kernel/rootfs/udhcpc-default.script /usr/share/udhcpc/default.script 755
  sync_file kernel/rootfs/wireguard/on-wifi.sh /etc/wireguard/on-wifi.sh 755
  [ -s work/device/jet-app.json ] && sync_file work/device/jet-app.json /android-data/mainline/jet-app.json
  if [ -s work/wireguard/wg0.conf ]; then
    sync_file work/wireguard/wg0.conf /android-data/mainline/wireguard/wg0.conf 600
    sync_file work/wireguard/trusted /android-data/mainline/wireguard/trusted
    [ -s work/wireguard/routes ] && sync_file work/wireguard/routes /android-data/mainline/wireguard/routes
  fi
  MT=$(sha $OUT/modules.tar)
  if [ "$(jsh 10 'cat /android-data/mainline/.modules.sha256 2>/dev/null' || true)" = "$MT" ]; then info "modules current"
  else
    jscp $OUT/modules.tar "root@$HOST:/tmp/modules.tar"
    jsh 60 'mkdir -p /android-data/mainline/modules && busybox tar -xf /tmp/modules.tar -C /android-data/mainline/modules && rm /tmp/modules.tar'
    jsh 10 "echo $MT > /android-data/mainline/.modules.sha256"; ok "modules updated (active after the next reboot)"
  fi
  AT=$(sha work/jet-app.tgz)
  if [ "$(jsh 10 'cat /android-data/mainline/.jet-app.sha256 2>/dev/null' || true)" = "$AT" ]; then info "jet-app current"
  else JET_HOST=$HOST sh device/jet-app/deploy/install.sh >/dev/null && jsh 10 "echo $AT > /android-data/mainline/.jet-app.sha256" && ok "jet-app updated"; fi
}

flash_from_mainline() {
  IMG=work/mainline/boot-emmc.img; WANT=$(sha $IMG); SZ=$(stat -f%z $IMG)
  CUR=$(jsh 30 "dd if=/dev/mmcblk1p8 bs=1M count=8 2>/dev/null | head -c $SZ | sha256sum" | cut -d' ' -f1)
  [ "$CUR" = "$WANT" ] && { ok "boot partition already holds this image — no flash, no reboot"; return 0; }
  jscp $IMG "root@$HOST:/tmp/boot-emmc.img"
  jsh 60 "dd if=/tmp/boot-emmc.img of=/dev/mmcblk1p8 bs=1M conv=fsync 2>/dev/null; sync"
  BACK=$(jsh 30 "dd if=/dev/mmcblk1p8 bs=1M count=8 2>/dev/null | head -c $SZ | sha256sum" | cut -d' ' -f1)
  [ "$BACK" = "$WANT" ] || die "read-back mismatch after writing p8" "re-run; do not reboot until it verifies"
  ok "new boot image written and verified"
  info "rebooting into it (cold reset; ~1 in 7 hang before the kernel — black glass = hold POWER ~10 s, power on, re-run)"
  jsh 10 '/usr/local/bin/reboot2 >/dev/null 2>&1 & exit 0' || true
  wait_mainline 90
}

wait_mainline() {
  i=0; while [ $i -lt "$1" ]; do
    jsh 6 'uname -r' >/dev/null 2>&1 && return 0
    i=$((i + 5)); sleep 5
  done
  return 1
}

verify_mainline() {
  R=$(jsh 15 'echo "kernel=$(uname -r) uptime=$(cut -d. -f1 /proc/uptime)s jetd=$([ -n "$(pidof jetd)" ] && echo up || echo DOWN)"')
  ok "$R"
  case "$R" in *jetd=up*) : ;; *) warn "jetd not up (yet) — the glass shows the boot log; give it a minute or check docs/boot.md" ;; esac
}

# ---------------------------------------------------------------------------------------------
step "finding the device"
LAST=
for pass in 1 2 3 4 5 6 7 8; do
  STATE=$(probe)
  [ "$STATE" != "$LAST" ] && info "device state: $STATE"; LAST=$STATE
  [ $MODE = status ] && { ok "status only — stopping here"; exit 0; }
  case $STATE in
  mainline)
    step "device is on mainline: syncing config, modules and the app"
    mainline_sync
    step "boot image"
    bootimgs || die "no stock-boot backup and no boot images" "this device predates the installer's backups; copy your backups into refs/backup/ (docs/recovery.md)"
    flash_from_mainline || die "the device did not come back in 90 s" "boot lottery or slow WiFi: if the glass is black, hold POWER ~10 s, power on, re-run; otherwise just re-run"
    step "verifying"
    verify_mainline
    ok "done — the Jet is current. ssh root@$HOST"
    exit 0 ;;
  rooted)
    step "rooted Android reachable: backups first, then the one-time install"
    backup_partitions
    pull_device_firmware
    step "building the images that needed your device's files"
    build_rooted_image refs/backup/mmcblk0p8-boot.bin
    bootimgs || die "boot image build failed" "run kernel/mkboot.sh and read its errors"
    step "flashing (recovery slot first, then mainline)"
    info "p7 recovery <- rooted stock Android (your fallback: 'reboot2 recovery' always gets you adb back)"
    info "p8 boot     <- mainline Linux"
    confirm "write p7 and p8 now? backups are verified in refs/backup/"
    flash_from_android work/boot-root.img 7 "rooted stock Android (fallback)"
    flash_from_android work/mainline/boot-emmc.img 8 "mainline Linux"
    step "staging userdata (rootfs, modules, firmware, app, your config)"
    stage_userdata_from_android
    step "first boot of mainline"
    info "rebooting; first boot takes ~30 s to ssh (~1 in 7 resets hang in the stock bootloader: black glass = hold POWER ~10 s, power on — the flash is done and verified, nothing is lost)"
    adb reboot </dev/null 2>/dev/null || true
    if wait_mainline 120; then step "verifying"; verify_mainline; ok "done — mainline is on your Jet. ssh root@$HOST"; exit 0
    else die "no ssh after 2 min" "black glass: power-cycle and re-run. Glass shows a boot log: WiFi may still be joining; re-run. Either way the install itself is complete."; fi ;;
  stock)
    step "stock Android with adb: getting root without flashing anything"
    info "the factory OTA on your device carries a boot image; a patched copy is RAM-booted (fastboot boot), so the flash stays untouched"
    if [ ! -s refs/factory/factory.bin ]; then
      mkdir -p refs/factory
      adb pull /factory/factory.bin refs/factory/factory.bin >/dev/null 2>&1 || die "could not pull /factory/factory.bin" "see docs/setup.md 'getting root' for the alternative route"
      ok "pulled the factory OTA"
    fi
    unzip -p refs/factory/factory.bin boot.img > work/stock-ota-boot.img 2>/dev/null || die "no boot.img inside the factory OTA" "see docs/setup.md 'getting root'"
    build_rooted_image work/stock-ota-boot.img
    info "entering fastboot (adb reboot bootloader) and RAM-booting the rooted image"
    adb reboot bootloader </dev/null 2>/dev/null || true
    i=0; while [ $i -lt 30 ]; do fastboot devices 2>/dev/null | grep -q fastboot && break; i=$((i+2)); sleep 2; done
    fastboot devices 2>/dev/null | grep -q fastboot || die "device did not reach fastboot" "if the glass is black it hung at the warm reset (docs/boot.md): hold POWER ~10 s, power on, re-run"
    sleep 5   # a boot command in the first seconds of fastboot can hang (docs/boot.md)
    fastboot boot work/boot-root.img >/dev/null 2>&1 || die "fastboot boot failed" "power-cycle the device and re-run"
    info "waiting for adb as root (~15 s)"
    adb wait-for-device </dev/null; sleep 3 ;;   # loop re-probes: should now be 'rooted'
  fastboot)
    if [ -s work/boot-root.img ]; then
      info "device is in fastboot: RAM-booting the rooted image"
      sleep 5; fastboot boot work/boot-root.img >/dev/null 2>&1 || die "fastboot boot failed" "power-cycle and re-run"
      adb wait-for-device </dev/null; sleep 3
    else
      action "device is in fastboot but no rooted image is built yet: power-cycle it (hold POWER ~10 s, then power on) and re-run"
      exit 1
    fi ;;
  mtp)
    step "fresh Jet detected (MTP only): enabling adb via the documented ReconOS backdoor"
    if have mtp-sendfile; then
      : > work/PleaseEnableADB
      mtp-sendfile work/PleaseEnableADB ReconApps/Debug/PleaseEnableADB >/dev/null 2>&1 \
        && ok "dropped ReconApps/Debug/PleaseEnableADB" \
        || action "mtp-sendfile failed: copy an empty file named PleaseEnableADB into ReconApps/Debug/ with any MTP client (e.g. OpenMTP)"
    else
      action "copy an empty file named PleaseEnableADB into ReconApps/Debug/ on the device with an MTP client (brew install libmtp, or OpenMTP)"
    fi
    action "then reboot the Jet (hold POWER ~10 s, power back on) and re-run ./install.sh"
    exit 1 ;;
  none)
    [ $pass = 1 ] && { action "no device found: charge the Jet, power it on (hold POWER ~2 s until the LED lights), connect USB"; info "waiting 20 s and looking again ..."; }
    sleep 20 ;;
  esac
done
die "device state kept changing without converging" "re-run ./install.sh; it continues from the current state (--status shows what it sees)"
