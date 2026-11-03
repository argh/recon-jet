# Recon Jet on mainline Linux

A 2013 Recon Jet heads-up display (OMAP4430) running mainline Linux 6.18 from its eMMC as a thin
I/O peripheral: display, camera, mics, speaker, IMU, glance sensor, WiFi and Bluetooth, driven by
a small on-device daemon and a Node application, talking to an OpenAI-compatible inference server
you point it at. The stock software is long abandoned (activation servers are gone); the hardware
is a complete wearable computer that deserves better.

## Run it on your own Jet

```
./setup.sh      # your WiFi, your ssh key, your inference server — writes only gitignored files
./install.sh    # builds everything, finds the device in whatever state it is, takes it to mainline
```

`install.sh` is a state machine: it detects where the device is (fresh out of the box on MTP,
stock Android over adb, fastboot, or already on mainline over ssh) and does the next right thing,
so re-running after any interruption continues instead of starting over. The full journey, stage
by stage, is `docs/setup.md`.

Your device stays recoverable the whole way — `docs/recovery.md` is the short proof:

- The bootloader partitions are **never written**, by anything in this repo.
- Before the first flash, every partition except userdata is **backed up with checksums** to
  `refs/backup/` (archive that directory somewhere safe).
- Test images are **RAM-booted**; a bad one costs a power cycle, not a reflash.
- Every flash is **read back and checksum-verified** before a reboot is even suggested.
- `./recover.sh` restores your own verified stock backups. The rooted-Android fallback stays in
  the recovery slot: `reboot2 recovery` from mainline always gets you adb back.

## Map

- `AGENTS.md` is the orientation for people and agents; `docs/` holds the facts by topic
  (`docs/status.md` is the executive summary of what works).
- `kernel/` builds the kernel, device tree, rootfs and boot image (Docker); `agent/` is the
  on-device daemon; `device/jet-app/` the Node application layer; `host/` host-side developer
  tools; `tools/` helpers.
- Private configuration (networks, credentials, host lists) never lives in the repo: `./setup.sh`
  generates it all into gitignored files. See the personalisation section of `AGENTS.md`.
