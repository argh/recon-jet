# Setting up your own Jet

The short version: `./setup.sh`, then `./install.sh`, then wear it. This file is what those two
scripts do, the manual equivalent of every stage, and what to do when a stage misbehaves.
`docs/recovery.md` is the companion: how to get back to stock, and why none of this can brick
the device.

## What you need

- A Recon Jet (HUD attached to the pod; the 2013–2017 "Jet" — Snow2 is a different board).
  A used one typically arrives factory-reset and stuck on the activation screen; the activation
  servers are gone, and that is fine — nothing here needs them.
- A USB cable on the pod's magnetic connector, and patience with its charge LED.
- A host machine (the scripts assume macOS; Linux works with minor `stat` edits) with:
  Docker (kernel + rootfs builds), Node 20+, zig (`brew install zig`, cross-compiles the
  on-device tools), `adb` + `fastboot` (`brew install android-platform-tools`), and — only for a
  factory-fresh device — an MTP client (`brew install libmtp`, or OpenMTP).
- Optional but what the project is for: an OpenAI-compatible inference server on your network
  (llama-swap, llama.cpp server, vLLM, ...) with a certificate that verifies publicly.

## setup.sh — personalisation

Asks for everything that is yours (WiFi, ssh public key, inference server, USB subnet, optional
off-home VPN) and writes only gitignored files; nothing personal can end up in a commit. Answers
persist in `work/setup.json`, so a re-run presents them as defaults. Agents can pipe answer lines
on stdin, or edit `work/setup.json` and regenerate with `tools/setup.js --from-answers`.

| It writes | Used for |
|---|---|
| `work/wifi/wpa_supplicant.conf` | the Jet's WiFi (passphrases stored as derived WPA hex) |
| `work/ssh/authorized_keys` | root ssh to the Jet |
| `work/device/jet-app.json` | per-device app config, pushed to `/android-data/mainline/jet-app.json` |
| `device/jet-app/personal/jet-app.json` | running jet-app from the host against the device |
| `work/wireguard/{wg0.conf,trusted,routes}` | optional off-home auto-VPN (`docs/vpn.md`) |
| `work/env.sh` | `. work/env.sh` points the host tools at your setup (`JET_HOST`, `LLM_*`) |

## install.sh — the whole journey

Re-run it whenever anything is unclear: it re-detects the device state and artifact freshness
every time and only does what is missing. `--status` reports without changing anything;
`--build-only` stops before device contact.

### Stage: builds (host only)

Kernel + modules (`kernel/build.sh`, Docker, source in a named volume), Debian armhf rootfs
(`kernel/rootfs/build.sh`, Docker arm/v7 emulation), static ARM tools (zig), jetd, the jet-app
bundle, a static busybox, and the WiFi regulatory + chip firmware from linux-firmware /
wireless-regdb. Everything skipped when current. The boot images themselves wait for one input
only your device can provide: the header fields of its stock boot image (taken from the backup
below).

### Stage: a factory-fresh Jet (MTP only)

A fresh or reset Jet boots to the activation screen with adb off; the Mac sees an MTP device.
ReconOS ships its own debug hook (found by the community after the servers died — see
github.com/recom3/api-hud-goggle issue 6): an empty file named `PleaseEnableADB` in
`ReconApps/Debug/` on the MTP storage enables adb at the next boot. install.sh drops it with
`mtp-sendfile` when libmtp is present, or tells you to copy it with any MTP client. Reboot
(hold POWER ~10 s, power on), re-run.

### Stage: stock Android with adb, no root

The device's own factory OTA (`/factory/factory.bin`, world-readable) contains a stock boot
image. install.sh pulls it, patches the ramdisk — `ro.secure=0` and `ro.debuggable=1` so adbd
runs as root, plus a minimal `/sbin/su` (`tools/su/su.c`) — and **RAM-boots** the result with
`fastboot boot`. Nothing is flashed: the patched image runs once from RAM, and a power cycle
returns the device to exactly what it was. This is the same boot image the device already runs,
with two prop lines changed.

### Stage: rooted Android (RAM-booted or from the recovery slot)

1. **Backups first.** GPT and partitions 1–10 (everything except userdata) are read off the
   device, checksummed on both sides, and recorded in `refs/backup/SHA256SUMS.txt`. ~1.1 GB;
   already-verified partitions are skipped on re-runs. These files are your way back to stock
   (`./recover.sh`) — archive the directory somewhere safe.
2. **Your device's firmware.** The WiFi calibration (`wl1271-nvs.bin`, carries your MAC and
   radio tuning) and the Bluetooth init scripts (`TIInit_*.bts`) are pulled from `/system`.
3. **Boot images.** The stock boot backup provides the header (load addresses, page size);
   `kernel/mkboot.sh` packs mainline + DTB + initramfs into `boot-emmc.img` (≤ 8 MB), and the
   rooted image is rebuilt from your real boot partition.
4. **Flash, both slots verified by read-back:** p7 recovery ← rooted stock Android (the
   fallback `reboot2 recovery` boots), p8 boot ← mainline. The one confirmation prompt of the
   whole install sits here.
5. **Userdata staging:** the Debian rootfs to `/data/debian` with your WiFi conf and ssh key
   inside, kernel modules and firmware to `/data/mainline/`, the jet-app bundle, your device
   config, the optional WireGuard files.
6. **Reboot.** Mainline comes up: boot log on the glass from ~4 s, WiFi ~6 s, ssh ~21 s. The
   script waits, verifies kernel + jetd, and prints `ssh root@jet.local`.

### Stage: already on mainline

The update path: syncs whatever changed (config, modules, firmware, app) by comparing
checksums, flashes p8 only when the built image differs from what the partition holds, and
reboots only when it flashed. Routine `./install.sh` after a `git pull` is a no-op in seconds
when nothing changed. The one deliberate exception: swapping the Debian rootfs itself is
`kernel/rootfs/install.sh` (it carries your keys and WiFi into the new tree; `docs/rootfs.md`) —
disruptive enough that it stays a command you choose to run.

## When a stage misbehaves

| Symptom | Meaning | Do |
|---|---|---|
| Black glass, nothing on USB after a reset | the stock bootloader's known hang (~1 in 7 cold resets, `docs/boot.md`) — not damage, nothing was lost | hold POWER ~10 s, power on, re-run |
| `fastboot boot` hangs | issued < 5 s after fastboot enumerated, or a second boot in one fastboot session | power-cycle, re-run |
| Boot log on the glass but no ssh | WiFi still joining, or the host resolves `jet.local` to a stale address | wait a minute; `JET_HOST=<address> ./install.sh` |
| `/factory/factory.bin` will not pull | unusual build | see "getting root, the long way" below |
| Repeated failed boots | the boot guard (`docs/boot.md`) degrades to safe levels and finally parks the device in fastboot by itself | re-run; it meets the device there |

**Getting root, the long way.** If the factory OTA route fails, ReconOS has a second documented
hook: any `.lxl` script dropped into `ReconApps/LispXML/Input/` over MTP is executed by a
privileged system service (verbs for file copy, settings, reboot). `tools/enableAdb.lxl` is a
working example. Between that and adb, a copy of the boot partition can be obtained and patched
exactly as above; the XDA Recon threads and the recom3 GitHub issues are the references.

## After the install

- `ssh root@jet.local` over USB or WiFi (mDNS; `JET_HOST=<addr>` when cross-VLAN, see
  `docs/networking.md`). `. work/env.sh` points the host tools at your device.
- The glass UI, modes and voice loop: `docs/jet-app.md`, `docs/interaction-design.md`.
- Off home, the optional WireGuard tunnel raises itself (`docs/vpn.md`).
- Updating after a `git pull` is `./install.sh` again. Back to stock any time: `./recover.sh`.
