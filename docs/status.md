# Status: the Jet on mainline Linux

Executive summary of the current state of the OS, drivers and hardware support, as of
2026-10-27. This is a snapshot, not a history; the per-topic references (`hardware.md`,
`kernel.md`, `boot.md`, `networking.md`, `audio.md`, `power.md`, `jetd.md`) hold the detail and
`open-questions.md` the unknowns. Application-level behaviour is in `jet-app.md` and is left out
here except for the console, the setup screens and the architecture for adding applications.

## In one paragraph

A Recon Jet (TI OMAP4430, 1 GiB, 8 GB eMMC, 428x240 Kopin microdisplay, camera, two mics,
speaker, IMU, WiFi/BT) boots mainline Linux 6.18 from its eMMC boot partition in under four
seconds to a live display, with the rooted stock Android kept in the recovery slot as a fallback.
Every piece of hardware the project needs works from mainline: display, touchpad, both buttons,
camera, WiFi, Bluetooth (LE keyboard paired), speaker, microphones, IMU, barometer, proximity
"glance" sensor, board temperature, charger and fuel gauge, power LED, watchdog, RTC. The wake
word ("heya jet", a microWakeWord model trained on the Mac, `agent/wake`) runs on the device
beside jetd for under 2 % of a core. Not ported:
FM (removed driver), the Apple MFi coprocessor, and the speaker's DSP tuning; GPS works
through the stock TI daemon in a chroot (docs/gps.md).
A small static C daemon (`jetd`) owns the panel and inputs and speaks a line protocol on
a local socket; a Node application (`jet-app`) on the device owns the user interface as a set of
mode plugins. The device is a thin I/O peripheral: vision, speech recognition, language models
and speech synthesis run on an inference server reached over WiFi.

## System architecture

```
 eMMC p8 "boot" (8 MB): zImage + DTB + xz initramfs           eMMC p7 "recovery": rooted stock Android
   |                                                              (reboot2 recovery / adb reboot back)
   v
 initramfs init (busybox, PID 1)
   watchdog -> USB gadget (ACM + ECM) -> modules from userdata -> chroot services
   -> ISS/tsl2772/jet-ofm/panel modules -> jetd -> boot guard
   |
   +-- chroot /android-data/rootfs -> Debian bookworm armhf (glibc)
         dropbear ssh, wpa_supplicant, avahi (jet.local), dbus + bluetoothd, alsa, v4l, Node 22
         /opt/jet-app (the application layer)         bash for the on-glass shell
   |
   +-- jetd (static musl binary in the initramfs): framebuffer, inputs, camera, audio, sensors,
         pty shell with a terminal emulator; TCP 7777 line protocol; up to 4 clients
```

Three layers, three repositories of state:

| Layer | Lives in | Changed by |
|---|---|---|
| kernel + DTB + initramfs (init, jetd, four display/camera/input modules, WiFi firmware) | `boot-emmc.img`, 7.5 of 8 MB | `kernel/build.sh`, `kernel/mkboot.sh`, `dd` to `/dev/mmcblk1p8`, `reboot2` |
| module tree (BT, ALSA, uhid, ...), BT firmware, flag files, calibration, pairings | userdata `/android-data/mainline/`, rootfs `/var/lib/bluetooth` | scp + `depmod`; the flag files are plain text |
| userland + application | userdata `/android-data/debian` (`rootfs` symlink; Alpine kept as a fallback tree) | `kernel/rootfs/build.sh` + `install.sh`; `device/jet-app/deploy/*` |

Design choices worth knowing: the panel console (`fbcon`/VT) is compiled out because its
deferred work deadlocks a manual-update display at reboot, so jetd is the only thing that
draws; the stock x-loader and u-boot are untouched and reached only through a reboot-reason
string in SAR RAM (there is no key combination); the kernel's plain reboot is a *cold* software
reset on purpose because warm resets hang in the stock bootloader about one time in five.

## Hardware support matrix

| Subsystem | State | Driver / mechanism | Omissions and idiosyncrasies |
|---|---|---|---|
| CPU, clocks, cpufreq, cpuidle | working | mainline OMAP4 | 300-800 MHz usable; the 1008 MHz OPP asks for more voltage than the TWL6032 table allows and is not applied |
| RAM | 1 GiB | | stock saw 627 MB after carveouts |
| eMMC | working, all partitions | mainline sdhci-omap | mainline names it `mmcblk1` (stock `mmcblk0`) |
| Display (Kopin A230 over RFBI) | working, 54 fps ceiling, backlight | RFBI re-added to omapfb from 4.19 + a ported panel driver (`kernel/overlay`) | manual-update only: pixels reach the glass through `OMAPFB_UPDATE_WINDOW`, plain fb writes do nothing. RFBI register readback is impossible (bus returns the address word). Backlight 16..1023, 208 is the lowest readable indoors. The panel module cannot be reloaded on a running system (reboot for driver changes). The pixel clock mux defaults to a wrong source after a true power cycle; the driver reparents it |
| Touchpad (Partron optical module) | working: swipe keys + raw motion, per-user threshold calibration | `jet-ofm.c` (new driver) | taps are implemented but off; its 2.9 V rail (ldo2) fails to register at ~26 s on most boots and init re-binds it (cause open) |
| Front button | working, KEY_102ND | gpio-keys | shares the pad of the stock console UART RX, so there is no serial console |
| Rear button | working, KEY_END | PMIC PWRON via a patched twl4030-pwrbutton | long hold is the PMIC power path (5 s off, 9 s forced) and can never be used by software |
| Camera (MT9M114, CSI-2) | working: 640x480 and 1280x960 UYVY, ~21 fps to memory, snapshots and a live viewfinder | `omap4iss` resurrected from v6.6 staging with DT glue, mainline mt9m114 | never rmmod the ISS; never read ISS registers without an active stream (L3 abort, hard hang); the CSI-2 reset needs idle-high lanes, so the sensor is powered fully off between streams; the first frames after start are dark/green (6 skipped) |
| Wake word ("heya jet") | working: `agent/wake/jetwake` (tflite-micro + the TFLite audio frontend, static), jetd `D 1` listen mode, hands-free look / question / switch-mode / bluetooth verified from the speaker loop and from rg's recorded voice | microWakeWord model trained with `agent/wake/train/` (piper positives spelled so espeak says "hey-uh jet" the way it is spoken, two sets of hard negatives, rg's own recordings as extra positives), judged on real mic recordings with `realtest.sh`; `agent/wake/models/heya_jet.tflite` is round 6 | <2 % of a core; cutoff 0.5, window 5 on the device; the first rounds were trained on "heya" as espeak says it ("hee-ya"), which nobody says, so they heard piper and not rg; the DMICs take seconds to settle after loud speech, so the VAD also ends a turn at 8 % of the speech peak; needs `mainline/wake.tflite` on userdata |
| WiFi (WL1283) | working: ~81/67 Mbit/s, auto-join at ~6 s | wlcore built in, linux-firmware blobs, stock NVS | power save must stay off (init re-disables every 30 s) or rx collapses to 1 Mbit/s; the PMIC 32 kHz output must be forced on or the card never initialises after a power cycle; stock firmware blobs are API 4 and unusable |
| Bluetooth (WL1283, HCI-LL on UART2) | working: controller, bluetoothd, LE HID keyboard paired and auto-reconnecting | `hci_uart` serdev, bluez 5.66, `uhid` (added to the config: omap2plus omits it) | **coexistence is untuned: hci0 up pins WiFi rx at 1 Mbit/s.** The radio is therefore off at boot unless a marker file says otherwise, and a menu toggle flips it live. bluetoothd needs ~5 s on this CPU before the controller exists |
| GPS | working: NMEA at 1 Hz from a fix session (indoor bring-up; outdoor fix untested) | GPS channel 9 added to mainline hci_ll (`/dev/tigps`, the stock contract), TI's closed navd runs from the stock partition in a chroot (`device/gps/gps.sh`, docs/gps.md) | the chip computes fixes itself; hci0 must be up (powers the chip), which pins WiFi rx at ~1 Mbit/s until coex is tuned |
| FM | not ported | the removed `wl128x` fmdrv is carriable; firmware is on the device | no use case yet |
| Speaker (TFA9895 on McBSP2 I2S) | working, audible, untuned | tfa989x + simple-audio-card; McBSP overlay derives a bit-clock divider the generic card never sets | 48 kHz stereo S16 only: a mono stream silences the amp. Android loaded NXP's DSP tuning with a closed tool; mainline is a plain I2S bypass |
| Microphones (OMAP4 DMIC) | working | omap-dmic + dmic-codec; overlay derives the mic clock | 96 or 192 kHz S32 only; downmix/decimate in software |
| IMU (LSM9DS0 accel/mag/gyro), barometer (LPS25H) | working (IIO) | st_sensors | never read the raw sysfs attributes in a UI loop (50 ms power-up per read); use the IIO buffer; ldo2/3/4 must be always-on or the bus dies at 30 s |
| Proximity "glance" sensor (APDS9900) | working: wear (on a head or not) from fixed thresholds, glance (eye at the glass) calibrated per user | tsl2772 as `tmd2771` | off the head it reads ~0, worn 130-320; looking at the glass reads lower than looking ahead; the LED current must be capped (25 mA) or it saturates; ALS reads 0 inside the pod |
| Board temperature (TMP102) | working | hwmon | |
| PMIC (TWL6032): regulators, RTC, GPADC, PWM LED, USB comparator | working | mainline twl + `ti,twl6032-gpadc` | PWRON interrupt must be unmasked by the consumer; pwm-twl lacks `get_state` (LED starts off) |
| Charger and fuel gauge | working: linear charging, current readout, USB-aware charge policy | overlay `twl6030_charger` (in-tree driver never enables the linear stage) + an init policy loop writing CINLIMIT/VICHRG | 100 mA before USB enumeration, 450 mA on a PC port, 1 A on a wall adapter; exceeding the host allocation makes macOS cut the port. On a PC port only ~50-130 mA reaches the cell while running. The original 10-year-old cell was dead; a 500 mAh cell on the stock protection board is fitted. A dead cell looks like a bricked device |
| USB (MUSB peripheral) | working: CDC ECM network (~105/59 Mbit/s) + CDC ACM root shell, gadget up at ~1 s | configfs composite from init; peripheral-only mode in the DT | **the ECM link to the Mac drops occasionally with VBUS still present** and only a physical replug recovers it (cause open, see `open-questions.md`); USB boot-on-plug is a u-boot behaviour we cannot change |
| Watchdog, RTC, HW RNG, pstore | working | omap_wdt (NOWAYOUT, fed by busybox), ramoops | a watchdog reset is a warm reset, so it can land in the bootloader hang below |
| Serial console | none | | UART3 RX is the front button; UART2 is the radio. Debug goes through the glass (boot log replay), USB ACM, ssh and pstore |
| MFi coprocessor (Apple iAP) | ignored | | useless without Apple's closed stack |

## Boot, recovery and stability

- Timeline on eMMC: watchdog 1.3 s, camera probed 2.9 s, panel 3.8 s, jetd and boot log on the
  glass from 4 s, WiFi associated 6 s, ssh 21 s.
- **Boot guard:** a boot that does not reach a healthy jetd within 60 s is counted on userdata;
  the second failure boots without camera and touchpad, the third without the panel, the fourth
  drops to fastboot. Holding the front button during init forces the camera-less level.
- **Fallback:** `reboot2 recovery` boots the rooted stock Android with adb; `adb reboot` returns.
  Images are written with `dd` and verified by hash; `fastboot flash` hangs the stock u-boot.
- **The boot lottery:** roughly one warm reset in five and one cold software reset in seven hangs
  inside the stock x-loader/u-boot before any kernel runs: black glass, nothing on USB, no
  watchdog recovery. Only a power cycle (battery pull or PMIC power-off) clears it. Plain
  reboots are cold on purpose, which brings the rate down but not to zero; it is the main
  reliability caveat of the platform and the reason test loops are planned around it.
- **Cold-boot rule:** anything that only ran after Android or u-boot had configured the hardware
  is suspect; two drivers were "working" for days until a true power cycle (display clock mux,
  PMIC 32 kHz output). Every bring-up step is now validated after a real power-off.
- Kernel panics fall back to the eMMC image after 5 s; pstore keeps the previous crash and init
  snapshots the log to userdata.

## Console, shell and setup

- **Boot log on the glass.** jetd replays the kernel backlog at 80 lines per second from ~4 s
  and streams `/dev/kmsg` live, with scrollback and the previous boot's pstore record; this is
  the only early console the device has.
- **Shell.** jetd runs bash as a login shell inside the Debian rootfs on a pty and renders it
  through its own terminal emulator: the Linux-console subset (`TERM=linux`) with cursor
  addressing, scroll regions, insert/delete, 16/256/true colour, alternate screen and the linux
  terminfo key sequences, in 71x20 or 42x12 cells (front button toggles and resizes the pty),
  400 lines of scrollback. vi/vim, mg (a small emacs), less and nano work on the glass. Input
  comes from a paired Bluetooth keyboard (Ctrl+Alt+Enter opens and closes the shell from any
  screen; Alt is Meta; Shift+PgUp pages the scrollback), from the pod (rear = Ctrl-C), or from a
  client over the socket. Keyboards that appear after boot are picked up live; a keyboard's own
  trackpad is ignored.
- **Remote access.** ssh as root over USB (`jet.local` via mDNS on both links) and WiFi, a root
  shell on the USB serial port, telnet in the chroot. No sftp (use `scp -O`). Daemons started
  from an ssh session must be detached or they die with it.
- **Setup.** First use runs a wizard (pad calibration, glance calibration, brightness); the same
  screens plus Power, Network, Bluetooth and About live in the System menu of the application
  layer. jetd keeps a minimal setup mode and a recovery chooser of its own that only appear when
  no application is connected, so calibration and a shell are reachable with the application
  layer dead. Calibration and preferences are plain files under `/android-data/mainline/`
  (`ofm-args`, `glance`, `backlight`, `bt`, `hub`, `usbnet`, `panel-off`, `camera-off`, `safe`);
  jetd re-reads them on a `U` command and applies most live.

## Architecture for adding applications

The device-side split is a thin C server and a Node application layer talking over a local TCP
socket; new functionality is a Node module, not a change to the C daemon.

- **jetd (C, static, ~2000 lines)** is the hardware server: it owns `/dev/fb0` and the panel
  flush, reads all input devices, runs the camera (snapshot and viewfinder into a rectangle),
  audio capture with voice activity detection and PCM playback, the glance sensor and gyro
  "new view" events, PMIC power readout, the kernel log and the shell. Its protocol is one text
  line per command (draw text and rectangles, flush, mode switch, camera `S`/`Z`, voice `V`/`W`,
  raw keys `K 1`, external surface `E 1` to let a client write the framebuffer itself) and one
  line per event (`k` key, `r` motion, `g` glance, `m` mode, `j` log line), with binary frames and
  PCM as length-prefixed payloads. Up to four clients share it; all receive every event. It is
  documented at the top of `agent/jetd.c` and in `jetd.md`.
- **jet-app (Node 22, module-manager modules)** connects on loopback at boot, takes raw keys and
  the framebuffer, and owns the screen. Infrastructure modules: `device-link` (protocol),
  `surface` (an RGB565 rasteriser with two PSF fonts, icons, partial flushes), `input` (raw keys
  to a fixed gesture vocabulary: press/hold front and rear, four swipes, tap; a keyboard's Enter,
  Esc and arrows map onto the same gestures), `ui` (render scheduling, a status strip, transient
  notices), `modes` (registry, switcher, persistence), `power`, `sensors`, `sounds` (a small cue
  vocabulary in one tonal language: power on/off, ack, success, error, worn/removed), `wear` (the
  backlight follows the glance sensor: dark 2 s after the glasses come off, back on when worn, any
  button relights), `llm` (OpenAI-compatible client for ASR, chat, TTS and vision), `voice`.
- **A new application is a mode plugin:** an object `{ id, label, enter(ctx), leave(), onGesture(g)
  -> handled, render(surface), tick?(), firstUse?() }` registered with `modes` from a module's
  `start()`. The switcher (front hold, or a held Enter on a keyboard) lists modes in registration
  order; the last used one is persisted unless the mode is `transient`. Private modes register
  from `device/jet-app/personal/` without touching the public tree. The gesture vocabulary and
  visual grammar are fixed by `interaction-design.md` so modes stay consistent.
- **A native program can own the panel:** a mode spawns it, calls `ui.suspend(true)` and swallows
  gestures; the program talks to jetd itself (`K 1`, `E 1`, keys as `k` lines, frames into fb0 plus
  the update ioctl, sound as 48 kHz stereo S16 into `aplay`). Doom (`device/doom`) is the worked
  example, with freeze/resume signals so the switcher can still be used over it.
- **Configuration and personalisation:** per-device settings (inference server base URL, model
  names, hub hosts) live in `/android-data/mainline/jet-app.json` and flag files, never in the
  repo; the host tools take the same values from environment variables. The goal is that another
  person can add their own services additively.
- **Deployment loop:** `device/jet-app/deploy/bundle.sh` + `install.sh` (seconds, no reboot);
  jetd changes are tested live by copying a binary and restarting (`kill $(pidof jetd)`, Debian
  has no `killall`), then baked into `boot-emmc.img`; kernel changes are RAM-booted with
  `fastboot boot` before anything is flashed. Long on-device jobs are detached and polled.

## Known gaps, by importance

1. The bootloader hang on reset (above): the reliability ceiling until a PMIC-side watchdog or a
   bootloader fix exists.
2. USB ECM link drops on the Mac side with VBUS present; WiFi is the fallback.
3. Bluetooth/WiFi coexistence: the two radios are effectively mutually exclusive today.
4. One unexplained death of jetd at a Bluetooth keyboard reconnect, not reproduced since a poll
   ordering fix; a fatal-signal logger and an unstripped build (`agent/jetd.dbg`) stay in place.
5. GPS and FM unported; speaker untuned; no on-device wake word.
