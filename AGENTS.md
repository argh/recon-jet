# Recon Jet on mainline Linux: map for agents and humans

A Recon Jet HMD (OMAP4430, 428x240 Kopin display, camera, mics, speaker, IMU, WiFi/BT) running
mainline Linux (6.18) from eMMC as a thin I/O peripheral for an AI assistant that runs elsewhere.
The device does capture, display and audio; the heavy work (vision, ASR, LLM, TTS) runs on a host.
This file is the index. Facts live in `docs/` (one topic per file); the chronological engineering log
is private and not in the repo. Keep docs to known truths and explicit open questions.

## Docs
`docs/status.md` (executive summary of the current state), `docs/setup.md` (your own Jet, start
to finish), `docs/recovery.md` (every way back; why nothing here bricks), `docs/hardware.md`,
`docs/boot.md`, `docs/kernel.md`, `docs/rootfs.md`, `docs/jetd.md`, `docs/jet-app.md`,
`docs/interaction-design.md`, `docs/power.md`, `docs/audio.md`, `docs/networking.md`,
`docs/vpn.md`, `docs/gps.md`, `docs/open-questions.md`.

## Layout
- `./setup.sh` personalisation wizard (writes only gitignored files; answers persist in
  `work/setup.json`); `./install.sh` state-machine installer (any device state -> mainline,
  re-runnable, `--status` to inspect); `./recover.sh` restore the stock backups. All three print
  uniform `[name N]` / `ok:` / `FAIL:` lines via `tools/steps.sh`; see `docs/setup.md`,
  `docs/recovery.md`.
- `kernel/`   mainline build: `build.sh` (Docker, source in a named volume), `jet.config`
              (config fragment), `omap4-recon-jet.dts` (board DT), `overlay/` (drivers added or
              patched: Kopin panel, RFBI, touchpad `jet-ofm`, `omap4iss` camera, McBSP/DMIC
              audio fixes, restart with reboot reason), `patches/apply.sh` (sed-level patches),
              `initramfs/init` (PID 1: USB gadget, ssh, WiFi, modules, boot guard, jetd),
              `mkboot.sh` (boot images: `boot-mainline.img` for RAM boots, `boot-emmc.img` to
              flash), `boot.sh` (fastboot RAM boot).
- `agent/`    `jetd.c`: the on-device daemon (framebuffer text UI, modes, touchpad/buttons,
              camera snapshots, glance sensor, log viewer, dead-man recovery chooser). Static musl build via
              zig (`build.sh`). Line protocol over TCP 7777, documented at the top of jetd.c.
- `device/doom/` Doom: doomgeneric's engine (fetched to `refs/doomgeneric`, pinned) + `doomgeneric_jet.c`
              (fb0 + panel update, keys from jetd), `i_jetsound.c` (sfx mixer into aplay), `opl_jet.c` (driver for
              Chocolate Doom's OPL music player, fetched to `refs/chocolate-doom`); `build.sh`, `deploy.sh`.
- `host/`     the `jet` CLI, never in the runtime path (the device needs nothing on a Mac): a
              one-shot jetd client (`jet state|snapshot|screenshot|log|events|console|mode|backlight|raw|live`),
              structured with @versionzero/module-manager (one command module per file). Inert by
              default: attaching never disturbs jet-app. See `host/README.md`.
- `tools/`    static ARM helpers (`regdump` /dev/mem dumper, `reboot2`, `fbfill`, `wdt`, `su`),
              `jsh.sh` (ssh with a hard timeout), `cam.sh` (external camera check of the
              display), `bootimg.js`/`cpio-newc.js` (Android boot image packing), `wavstats.py`.
- `refs/`     (gitignored) stock sources (`reconos/`: AOSP, u-boot, kernel), firmware, partition
              backups, mainline build output (`linux/out-6.18`: zImage, dtb, modules.tar).
- `work/`     (gitignored) build staging and private config (WiFi credentials live here only).
- `bridge/`   earlier approach (our userspace on the stock Android kernel); superseded.
- `notes/`    reference material (user manual, activation notes, forum threads).

## How the device boots and how to reach it
- eMMC `boot` partition = mainline (`boot-emmc.img`, must stay <= 8 MB); `recovery` = rooted
  stock Android (`reboot2 recovery` from mainline, `adb reboot` from Android returns).
- `reboot2` (plain) = cold reset + "reboot" reason -> normal boot. `reboot2 bootloader` ->
  fastboot. Warm resets occasionally hang in the stock u-boot (power cycle recovers).
- Flash from mainline: scp the image, `dd of=/dev/mmcblk1p8`, verify sha256, `reboot2`
  (`./install.sh` does exactly this, plus syncing modules/config, and skips what is current).
  Kernel modules (BT, ALSA, ...) and firmware live on userdata at `/android-data/mainline/`
  (`modules/`, `firmware/`), installed from `refs/linux/out-6.18/modules.tar`.
  Back to stock = `./recover.sh` (verified backups in `refs/backup/`; `docs/recovery.md`).
- USB: CDC ECM with the Jet at `.1` of the USB subnet (init's `USBNET`, overridable with the
  userdata file `mainline/usbnet`), ssh root (dropbear in the Debian rootfs chroot on userdata); the Jet
  announces `jet.local` over mDNS on USB and WiFi, which every host tool uses by default
  (`JET_HOST` overrides). WiFi joins the network configured in the chroot's wpa_supplicant.conf.
- Boot guard (`/android-data/mainline/bootfail`): failed boots degrade to safe levels (no
  camera/touchpad, then no panel, then fastboot). Front button held at boot = safe level 2.
- Userdata flags: `mainline/panel-off`, `camera-off`, `safe`, `hub` (hub host list),
  `ofm-args`, `glance`, `backlight`, `panel-args`.

## Working rules learned the hard way
- Never rmmod the camera ISS module; never read ISS registers without an active stream; reading
  an unclocked module via /dev/mem gives an L3 abort.
- Anything that only ever ran after Android had configured hardware is suspect: two cold-boot
  bugs (display pixel-clock mux, PMIC 32 kHz clock for WiFi) only showed after a true power
  cycle. Test new hardware bring-up with a real power-off at least once.
- WiFi power save must stay off (init keeps it off); Bluetooth up pins WiFi rx at 1 Mbit/s
  (coexistence untuned) so keep hci0 down unless in use.
- Cap remote commands at ~2 min; if it is not instant it is probably hung.
- Speaker path wants 48 kHz stereo S16; mics deliver 96 kHz S32 only (downmix on the host).
- Debian has no `killall`: restart jetd with `kill $(pidof jetd)`. A Bluetooth keyboard's
  Ctrl+Alt+Enter opens jetd's shell (bash in the rootfs, vi/mg work) from any screen.

## Personalisation vs generic client
Another person can take this repo, run `./setup.sh` + `./install.sh`, and have their own Jet on
mainline without editing anything tracked (`docs/setup.md`). Rules: no addresses, hostnames or
credentials in committed files, ever; tests are hermetic (fixtures only). Everything personal is
generated by `./setup.sh` into gitignored places — `work/` on the host (WiFi conf as derived WPA
hex, ssh key, `setup.json` answers, `env.sh`, optional WireGuard) and `device/jet-app/personal/`
— and pushed by `./install.sh` to the Jet's userdata under `mainline/` (device config, WireGuard,
calibration land there too). Host-side services are configured by environment only — `LLM_BASE`
(OpenAI-compatible base URL), `LLM_*_MODEL`, `LLM_INSECURE_TLS`, `JET_HOST` — and
`. work/env.sh` sets them from the setup answers. On the device, model names, voices and the
inference server live in `mainline/jet-app.json` (per-module config of jet-app, see
`docs/jet-app.md`); the host scripts in `host/` are developer tools and keep reading the
environment.
