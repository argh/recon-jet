#!/bin/sh
# Install doom and the IWAD into the Jet's rootfs (ssh lands in the Debian chroot).
#   device/doom/deploy.sh [path/to/IWAD]      JET_HOST overrides jet.local
# The binary goes to /usr/local/bin/doom, the WAD to /usr/local/share/doom/ (copied only when
# missing or a different size). Without an argument the shareware DOOM1.WAD is used: ~/Downloads/
# or work/DOOM1.WAD, fetched into work/ from Debian's doom-wad-shareware package when neither is
# there (byte-identical to id's 1.9 shareware release, sha1 5b2e249b…). Other IWADs work the same
# way: name them in the mode's args (`-iwad`).
set -e
cd "$(dirname "$0")"
HOST=${JET_HOST:-jet.local}
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8"
DEB=http://deb.debian.org/debian/pool/non-free/d/doom-wad-shareware/doom-wad-shareware_1.9.fixed-5_all.deb
SHA1=5b2e249b9c5133ec987b3ea77596381dc0d6bc1d
[ -x doom ] || { echo "build first: device/doom/build.sh"; exit 1; }

WAD=$1
if [ -z "$WAD" ]; then
  for w in "$HOME/Downloads/DOOM1.WAD" ../../work/DOOM1.WAD; do [ -f "$w" ] && WAD=$w && break; done
fi
if [ -z "$WAD" ]; then
  echo "no DOOM1.WAD at hand: fetching the shareware episode from Debian ($DEB)"
  tmp=$(mktemp -d); mkdir -p ../../work
  ( cd "$tmp" && curl -fsSL -o pkg.deb "$DEB" && ar x pkg.deb data.tar.xz && tar xf data.tar.xz ./usr/share/games/doom/doom1.wad )
  echo "$SHA1  $tmp/usr/share/games/doom/doom1.wad" | shasum -c - >/dev/null || { echo "unexpected doom1.wad in $DEB"; exit 1; }
  mv "$tmp/usr/share/games/doom/doom1.wad" ../../work/DOOM1.WAD; rm -rf "$tmp"
  WAD=../../work/DOOM1.WAD
fi
[ -f "$WAD" ] || { echo "no IWAD at $WAD"; exit 1; }
name=$(basename "$WAD")
size=$(stat -f %z "$WAD" 2>/dev/null || stat -c %s "$WAD")
scp -O $SSH_OPTS doom "root@$HOST:/tmp/doom"
remote=$(ssh $SSH_OPTS "root@$HOST" "stat -c %s /usr/local/share/doom/$name 2>/dev/null || echo 0")
if [ "$remote" != "$size" ]; then scp -O $SSH_OPTS "$WAD" "root@$HOST:/tmp/$name"; fi
ssh $SSH_OPTS "root@$HOST" "set -e; mkdir -p /usr/local/share/doom; mv /tmp/doom /usr/local/bin/doom; chmod 755 /usr/local/bin/doom
  [ -f /tmp/$name ] && mv /tmp/$name /usr/local/share/doom/
  ls -la /usr/local/bin/doom /usr/local/share/doom/"
