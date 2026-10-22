# Userdata rootfs

The initramfs boots the device and then chroots into a full userland on the userdata partition
for ssh (dropbear), WiFi (wpa_supplicant), mDNS (avahi), audio (alsa-utils), camera tooling
(v4l-utils), i2c-tools, Bluetooth (bluez), Node 22 and the application layer (`/opt/jet-app`).

- Active tree: `/android-data/rootfs` (a symlink; init falls back to `debian`, then `alpine`).
  Switching is relinking plus a reboot. jetd runs the ALSA tools through the same path.
- Build: `kernel/rootfs/build.sh` makes `work/rootfs-debian.tar` from `kernel/rootfs/Dockerfile`
  (Debian bookworm armhf under Docker's arm/v7 emulation, official Node 22 armv7l build).
- Install: `JET_HOST=... kernel/rootfs/install.sh` copies the tar, extracts to
  `/android-data/debian`, carries the private files over from the current chroot (WiFi config,
  `authorized_keys`, dropbear host keys; none of these are in the repo), installs the jet-app bundle
  with `npm ci` inside the new chroot, links `rootfs` and asks for a reboot.
- Why Debian (glibc) rather than Alpine (musl): prebuilt ARM binaries for voice (Vosk, ONNX
  Runtime, Picovoice), canvas (@napi-rs/canvas) and most npm native modules are glibc-only; on
  Alpine each became a build project. Size does not matter with 6 GB of userdata.
- What init expects inside the tree: `/bin/sh`, `/usr/sbin/dropbear`, `/usr/sbin/avahi-daemon`,
  `/usr/sbin/iw`, `/usr/sbin/i2cget` and `i2cset`, `/usr/bin/media-ctl`, `/usr/bin/arecord` and
  `aplay`, busybox `udhcpd`/`udhcpc`/`telnetd` in `PATH`, `node` in `PATH`,
  `/opt/jet-app/deploy/jet-app.sh`, `/android-data` as the userdata mount point.
