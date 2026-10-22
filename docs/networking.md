# Networking reference

Private addresses, SSIDs and host lists are deliberately absent here; they live in the
gitignored `work/` directory (WiFi credentials, hub host lists) and in flag files on the Jet's
userdata (`mainline/hub`, `mainline/usbnet`).

## USB gadget (configfs, set up by the initramfs init)

- Composite "Jet mainline" (VID 0x1d6b / PID 0x0104), one configuration "acm+ecm",
  MaxPower 500: CDC ACM (`ttyGS0`, a root autologin shell via getty) + CDC ECM (`usb0`).
- The Jet takes `.1` of the USB subnet (`mainline/usbnet` holds the first three octets; a
  default is built into init). `udhcpd` in the chroot hands the host `.10`-`.20`. jetd dials the
  pool addresses as hub candidates unless `mainline/hub` lists hosts.
- Host side (macOS): a CDC ECM Ethernet interface appears with a DHCP address, plus
  `/dev/cu.usbmodem*`. Use the `cu.` node: `tty.` blocks on carrier and wedges later openers.
  If the interface self-assigned before udhcpd was up: `sudo ipconfig set <enX> DHCP`.
  A device moved to a new port may need accessory approval in Privacy & Security.
- `CONFIG_USB_G_SERIAL` must stay off or the legacy gadget steals the UDC.
- Measured TCP over ECM: ~105 Mbit/s Jet -> host, ~59 Mbit/s host -> Jet.

## Shell access

| Service | Where it runs | Port |
|---|---|---|
| dropbear ssh (root, no password) | Alpine chroot on userdata (`/mnt/data/alpine`), supervised by init | 22 |
| telnetd | chroot | 23 |
| getty | initramfs, on `ttyGS0` | USB serial |

- The chroot sees userdata as `/android-data`; the initramfs as `/mnt/data`. The initramfs
  `/bin` (jetd, reboot2, regdump, fbfill) is not on the chroot's PATH; `reboot2` is also at
  `/usr/local/bin/reboot2` in the chroot.
- No sftp: push binaries with `scp` or `ssh root@jet.local 'cat > /tmp/x; chmod 755 /tmp/x' < x`.
- Daemons started over ssh must be `setsid nohup ... &` with stdio closed, or they die with the
  session (`udhcpc -b` holding stdio kept sessions open).
- `tools/jsh.sh` wraps ssh with a hard timeout and falls back to `jet.local` when the USB
  address is silent. Rule: cap remote commands at ~2 min; if it is not instant it is hung.
- The Alpine chroot has `apk` (over WiFi): i2c-tools, v4l-utils, alsa-utils, bluez, avahi,
  nodejs (armv7, 39 MB RSS, sub-second start) all install fine.

## mDNS

avahi in the chroot (`host-name=jet`, usb0 + wlan0, no dbus), started by init: the Jet is
**`jet.local`** on both links (`dns-sd -G v4 jet.local` on macOS returns both addresses).

## WiFi (WL1283 via wlcore, built in)

- Firmware `wl128x-fw-5-sr.bin`/`-mr.bin` from linux-firmware (stock blobs are API 4 and do
  not work), NVS as `ti-connectivity/wl128x-nvs.bin` (the stock `wl1271-nvs.bin` renamed; carries
  the MAC), `regulatory.db` + `.p7s`. The NVS is read once at probe: if it was missing, re-probe
  with `echo wl12xx.2.auto > /sys/bus/platform/drivers/wl12xx_driver/{unbind,bind}`.
- Expected log line: "firmware booted (Rev 7.3.10.0.142)"; association ~6 s after boot.
- Init runs `wpa_supplicant` + `udhcpc` in the chroot if `/etc/wpa_supplicant/wpa_supplicant.conf`
  exists there (copied from `work/`, never committed).
- The PMIC CLK32KG output must be on (DT `regulator-fixed-clock`); without it the card never
  initialises after a real power cycle. See boot.md.
- **Rule: WiFi power save must stay off.** The wl1283 re-enables it on (re)association, after
  which rx sits at 1 Mbit/s and it cannot even ping the gateway. Init re-runs
  `iw dev wlan0 set power_save off` every 30 s (through the chroot: `iw` is not in the initramfs).
  With it off: MCS 5/6 links, ~81 Mbit/s host -> Jet, ~67 Mbit/s Jet -> host, socket RTT to
  jetd a few ms (120-180 ms with power save on, which makes the hub feel sluggish).
- Raw 640x480 UYVY at 30 fps (147 Mbit/s) does not fit over WiFi; 15 fps or JPEG/tiles do.

## Bluetooth (modules on userdata)

- `hci_uart` with TI HCI-LL over uart2 (`ti,wl1283-st`, enable gpio 46); `hciconfig hci0 up`
  loads `TIInit_7.2.31.bts` (329 commands) from `mainline/firmware/ti-connectivity/`.
- **Coexistence problem (rule): keep hci0 down unless in use.** With hci0 up, even idle, WiFi rx
  bitrate pins at 1 Mbit/s (50 % ping loss, multi-second RTT); `hciconfig hci0 down` restores
  MCS6 immediately. No bluetoothd/dbus is set up yet (hciconfig/hcitool only).

## What the Jet reaches over WiFi

- **The inference server** (jet-app's `llm.base`, an OpenAI-compatible `https://<server>/v1`):
  `/audio/transcriptions`, `/chat/completions`, `/audio/speech`, and the vision model through
  chat completions. The voice and vision loops run from the device against it; no Mac is
  involved. The certificate is a public chain (Let's Encrypt), so plain `https` verifies on the
  Jet's rootfs: no insecure TLS options anywhere. One keep-alive connection pool, so a turn's
  ASR, chat and TTS calls reuse the TLS session. The address is per-device configuration
  (`mainline/jet-app.json`), never in the repo.
- The Jet sits on an IoT VLAN; the LLM, web and npm endpoints are opened to it there (a 403 from
  the server is a proxy ACL, not TLS). mDNS does not cross VLANs: from the Mac on the main VLAN
  `jet.local` resolves only over USB, so without USB use the Jet's IoT address
  (`JET_HOST=<address>` for `tools/jsh.sh` and the deploy scripts; the lease can change).
- Avahi, `apk`/`apt` and the deploy `scp` as before; the hub below is optional.

## Hub (`host/jet-hub.js`, Node, no dependencies)

- TCP **7777**: jetd protocol (listen for the Jet dialling in, or dial the Jet:
  `node host/jet-hub.js <jet address or jet.local> [--look] [--ptt] [--live]`).
- HTTP **7778**: control API (`/screen`, `/raw`, `/mode`, `/console`, `/snapshot[.jpg|.uyvy]`,
  `/look`, `/glance`, `/listen`, `/say`, `/converse`, `/state`, `/log`).
- `HUB_JET_PORT` / `HUB_HTTP_PORT` override the ports so a second hub can run beside another.
- `LLM_BASE` etc. point at the local LLM server (OpenAI-compatible); `host/vision.js` sends
  `chat_template_kwargs: {enable_thinking: false}` to the VLM or it burns its budget thinking.
- The hub, `host/voice-session.js` and the scripts are developer tools now (`host/README.md`):
  the device talks to the inference server itself.

## Known link problems (see open-questions.md)

The USB ECM link has dropped several times with VBUS still present (Jet logs "reset config /
ecm deactivated", UDC "not attached"); a Jet-side UDC unbind/rebind does not recover it, a
physical replug does. Over-current was one confirmed cause (power.md); the rest is open.
