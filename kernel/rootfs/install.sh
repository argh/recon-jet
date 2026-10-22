#!/bin/sh
# Install work/rootfs-debian.tar on the Jet's userdata as /android-data/debian, carry over the
# private files from the current chroot (WiFi config, ssh keys, dropbear host keys), install the
# Node app into it, and make it the active rootfs (symlink /android-data/rootfs). Reboot after.
#   JET_HOST=<addr> kernel/rootfs/install.sh        (ssh lands in the CURRENT chroot)
# Revert: ssh in, `ln -sfn alpine /android-data/rootfs`, reboot.
set -e
cd "$(dirname "$0")/../.."
HOST=${JET_HOST:-jet.local}
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 root@$HOST"
[ -f work/rootfs-debian.tar ] || { echo "run kernel/rootfs/build.sh first"; exit 1; }
[ -f work/jet-app.tgz ] || sh device/jet-app/deploy/bundle.sh
echo "copying rootfs ($(du -h work/rootfs-debian.tar | cut -f1)) and jet-app bundle"
scp -O -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR work/rootfs-debian.tar work/jet-app.tgz "root@$HOST:/android-data/"
$SSH 'set -e; D=/android-data/debian
  rm -rf $D; mkdir -p $D; tar -C $D -xf /android-data/rootfs-debian.tar; rm /android-data/rootfs-debian.tar
  cp /etc/wpa_supplicant/wpa_supplicant.conf $D/etc/wpa_supplicant/ 2>/dev/null || true
  cp /root/.ssh/authorized_keys $D/root/.ssh/ 2>/dev/null || true
  cp /etc/dropbear/dropbear_* $D/etc/dropbear/ 2>/dev/null || true
  cp /etc/resolv.conf $D/etc/resolv.conf 2>/dev/null || true
  mkdir -p $D/opt/jet-app; tar -C $D/opt/jet-app -xzf /android-data/jet-app.tgz; rm /android-data/jet-app.tgz
  mount -t proc proc $D/proc; mount -t sysfs sys $D/sys; mount --bind /dev $D/dev
  chroot $D /bin/sh -c "cd /opt/jet-app && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2; node --version"
  umount $D/dev $D/sys $D/proc
  ln -sfn debian /android-data/rootfs; ls -la /android-data/rootfs
  echo "installed; reboot to switch (reboot2)"'
