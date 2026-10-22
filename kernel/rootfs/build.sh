#!/bin/sh
# Build the Debian armhf rootfs tarball for the Jet's userdata (needs Docker with arm/v7 emulation).
#   kernel/rootfs/build.sh  ->  work/rootfs-debian.tar  (then: kernel/rootfs/install.sh)
set -e
cd "$(dirname "$0")/../.."
NODE_TAR=${NODE_TAR:-$(curl -s https://nodejs.org/dist/latest-v22.x/ | grep -o 'node-v22\.[0-9.]*-linux-armv7l\.tar\.xz' | head -1)}
[ -n "$NODE_TAR" ] || { echo "could not resolve the Node 22 armv7l tarball name"; exit 1; }
docker build --platform linux/arm/v7 --build-arg NODE_TAR="$NODE_TAR" -t jet-rootfs kernel/rootfs
C=$(docker create --platform linux/arm/v7 jet-rootfs)
mkdir -p work
docker export "$C" -o work/rootfs-debian.tar
docker rm "$C" >/dev/null
ls -la work/rootfs-debian.tar
