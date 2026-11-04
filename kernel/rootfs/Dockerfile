# The Jet's userdata rootfs (Debian armhf, glibc): built on the host with Docker's arm/v7
# emulation and exported as a tarball; the initramfs chroots into it for ssh, WiFi, audio,
# mDNS, camera tools, i2c tools, Node and the application layer.
#   kernel/rootfs/build.sh  ->  work/rootfs-debian.tar
FROM --platform=linux/arm/v7 debian:bookworm-slim
ARG NODE_TAR
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      busybox dropbear-bin wpasupplicant iw wireless-tools iproute2 ethtool i2c-tools alsa-utils \
      bluez avahi-daemon libnss-mdns v4l-utils evtest curl ca-certificates xz-utils procps \
      kmod file less nano vim-tiny mg libatomic1 libstdc++6 openssh-client wireguard-tools \
    && rm -rf /var/lib/apt/lists/*
# busybox applets the initramfs init calls inside the chroot (Debian's busybox has no telnetd), and
# the udhcpc lease hook Debian does not ship
RUN for a in udhcpd udhcpc; do ln -sf /bin/busybox /usr/sbin/$a; done && mkdir -p /var/lib/misc /usr/share/udhcpc
COPY udhcpc-default.script /usr/share/udhcpc/default.script
RUN chmod 755 /usr/share/udhcpc/default.script
# colour for the interactive shells (the glass terminal and ssh); --color=auto keeps pipes clean
COPY bashrc /root/.bashrc
# the WireGuard auto-VPN hook (docs/vpn.md); init arms it with `wpa_cli -a` when a tunnel conf exists
COPY wireguard/on-wifi.sh /etc/wireguard/on-wifi.sh
RUN chmod 755 /etc/wireguard/on-wifi.sh
# Node 22 (official armv7l build) in /usr/local
RUN curl -fsSL "https://nodejs.org/dist/latest-v22.x/${NODE_TAR}" -o /tmp/node.tar.xz \
    && tar -C /usr/local --strip-components=1 -xJf /tmp/node.tar.xz && rm /tmp/node.tar.xz \
    && ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm && node --version
# mDNS: jet.local on usb0 + wlan0, no dbus needed with the daemon alone
# /etc/hosts is Docker-managed (a read-only mount during newer Docker builds) and docker export
# would not carry it anyway: the installers append '127.0.1.1 jet' when they extract the tar
RUN sed -i 's/^#host-name=.*/host-name=jet/; s/^#allow-interfaces=.*/allow-interfaces=wlan0,usb0/; s/^use-ipv6=yes/use-ipv6=no/; s/^#enable-dbus=.*/enable-dbus=no/; s/^enable-dbus=.*/enable-dbus=no/' /etc/avahi/avahi-daemon.conf \
    && mkdir -p /etc/wpa_supplicant /root/.ssh /etc/dropbear /android-data /opt && chmod 700 /root/.ssh \
    && echo jet > /etc/hostname
# the Bluetooth radio stays down until asked (coex: hci0 up degrades WiFi rx); init / jet-app power it
RUN sed -i 's/^#\?AutoEnable=.*/AutoEnable=false/' /etc/bluetooth/main.conf && grep -q '^AutoEnable=false' /etc/bluetooth/main.conf
# the init mounts /proc /sys /dev /tmp /run and binds userdata at /android-data; nothing else runs at boot
