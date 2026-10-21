# jetd: the on-device daemon (`agent/jetd.c`)

Static musl binary built with `zig cc -target arm-linux-musleabihf -mcpu=cortex_a9`
(`agent/build.sh`, ~1.8 MB, embeds two PSF fonts via xxd). It owns the panel, input, sensors,
camera snapshots and audio, and speaks a line protocol to a hub. Init starts it as
`/bin/jetd <hosts> 7777 [boot-log-seconds]` from the initramfs; RSS ~0.5 MB, ~2 % CPU idle.


Multiple clients: jetd accepts up to 4 hub connections at once (the on-device app on loopback, the
host hub, debug sessions); all receive every event and payload, all may send commands. jetd dials
its host list only while no hub is connected. Loopback must be up (init does `ip link set lo up`).

## Modes (owned by jetd, so they work with the hub gone)

| Mode | Behaviour |
|---|---|
| `remote` | the hub draws; every key/motion event is forwarded. Default once a hub connects |
| `log` | live `/dev/kmsg` (600-line ring, timestamps) or the previous boot's pstore record (rear toggles). Boot mode: the kernel backlog is replayed at ~80 lines/s and held for `boot-log-seconds` (default 20) before auto-switching to remote |
| `shell` | `/bin/sh -i` on a pty rendered as a dumb terminal, 400-line scrollback; rear = Ctrl-C; the hub can type into it |
| `setup` | menu: Pad calibration, Glance calibration, Brightness, Power, WiFi via QR code (placeholder), Back to remote |

- Hold FRONT ~1 s: mode chooser overlay (swipe up/down, front or tap picks, rear cancels).
  Short presses and swipes belong to the mode. The REAR long hold is the PMIC power path.
- log/shell: swipes scroll (UP/DOWN 3 lines, LEFT/RIGHT 10 columns, left-most = oldest,
  right-most = follow); front toggles font. Fonts: 10x20 `ter-u20b` = 42x12 cells (remote,
  setup, chooser; the hub grid is always 42x12) and 6x12 `Lat2-Terminus12x6` = 71x20 (log/shell
  default; `JETD_LOG_FONT=1` selects the big one). PSF1 and PSF2 are parsed; `ter-u16b` is PSF1.
- Framebuffer: back buffer is always 0xRRGGBB, packed once at flush (RGB565 or 32-bit by
  `bits_per_pixel`), then `OMAPFB_UPDATE_WINDOW` on `/dev/graphics/fb0` or `/dev/fb0`.
- Buttons: FRONT = evdev code 86, REAR = 107. Touchpad: swipe keys 103/108/105/106 and raw
  `REL_X/REL_Y` sums from jet-ofm.

## Protocol (TCP, one command per line; jetd dials `<hosts>` in turn 2 s apart and also listens on 7777)

host -> jet:

| Line | Meaning |
|---|---|
| `C` | clear back buffer |
| `T <row> <text>` / `A <row> <text>` / `X <x> <y> <text>` | text at row, centred on row, at pixel |
| `R <r> <g> <b>` | text colour |
| `B <x> <y> <w> <h> <r> <g> <b>` | filled rectangle |
| `F` | flush to the panel |
| `L <0-1023>` | backlight |
| `P` | ping -> `p` |
| `M <remote\|log\|shell\|setup>` | switch mode |
| `I <text>` | type into the shell pty (`\n \t \\` escapes) |
| `S [w h [skip]]` | camera snapshot (default 640x480, skip 6 frames for exposure/AWB) -> `f <w> <h> UYVY <len>\n` + bytes, or `e <msg>` |
| `V [max_s]` / `v` | start / stop voice capture |
| `W <len>` + bytes / `w` | queue 48 kHz stereo S16 PCM; `w` ends the clip |
| `Q` | power snapshot -> `q vbat vsys vbus mA ctrl1 stat1 linsts cinlimit vichrg udc maxpower` |

Drawing commands are ignored unless remote mode is showing; the hub gets a fresh hello whenever
remote comes back and must redraw (the hub re-sends its last screen on hello).

jet -> host:

| Line | Meaning |
|---|---|
| `h <w> <h> <cols> <rows>` | hello |
| `k <code> <1\|0>` | key down/up |
| `r <dx> <dy>` | touchpad motion (summed per gesture) |
| `m <mode>` | mode changed |
| `j <text>` | kernel log line (last 60 on connect, then live) |
| `g <worn> <raw>` | glance state change |
| `n <degrees>` | head turned then held still ("new view") |
| `a <len>` + bytes | 16 kHz mono S16 capture chunk (100 ms); `A <end\|max\|stop\|error>` ends it |
| `w <done\|timeout\|error\|idle>` | playback finished |
| `p`, `q ...` | pong, power snapshot |

Binary payloads: after an `S` the hub must read `<len>` bytes after the `f` line; after a `W`
line jetd reads `<len>` bytes before parsing lines again (`bin_need`).

## Setup menu

- **Pad calibration**: 3 swipes per direction; thresholds = half the weakest axis median,
  clamped 8..60; written to the jet-ofm sysfs params and persisted as `mainline/ofm-args`.
- **Glance calibration**: at / away / at / away (away = looking forward with the pod on), 8
  reads averaged per press, thresholds at 60 % / 40 % of the span, saved as `mainline/glance`
  "on off"; either polarity accepted (on < off means inverted); a 40-count contrast check
  rejects a flat run. With the 25 mA IR current the calibrated values were roughly worn ~130-150,
  away ~230. Glance is an **event** (`g`, hub `GET /glance`), not display automation.
- **Brightness**: kopin-a230 backlight 16..1023 in steps of 48 with a bar; front saves to
  `mainline/backlight` (applied at start), rear reverts. 208 is the saved default.
- **Power**: 1 Hz readout of battery mV/mA, VSYS, VBUS, charger state, limits, VOREG, UDC state,
  gadget MaxPower (only visible when running from the initramfs), board temp. See power.md.

## Sensors it polls

- Glance: `in_proximity0_raw` of the IIO device named `tmd2771`.
- Gyro: "new view" detector at 20 Hz from the LSM9DS0 gyro, scale 0.000153 rad/s/LSB; zero-rate
  bias tracked while still (per-axis spread < 3 deg/s over 0.5 s); |omega - bias| > 5 deg/s
  accumulates degrees; >= 20 deg turned then 1 s still -> `n`; accumulator decays after 5 s.
  Thresholds in `mainline/view` ("deg still_ms").
- **Rule: read the IMU through the IIO buffer, never per-axis sysfs `_raw`.** The st_sensors raw
  path powers the sensor up, waits the settling time and powers down: ~50 ms per axis, so 3 axes
  at 20 Hz cost 150 ms per loop and made the whole UI sluggish. jetd enables `scan_elements`
  x/y/z, `buffer/enable`, reads `/dev/iio:deviceN` non-blocking (6 bytes per sample at 95 Hz),
  drains every 50 ms and uses the latest sample: 1-2 ms. Sysfs fallback at 2 Hz only if the
  buffer cannot be enabled. (busybox `date +%s%N` has no `%N`: do not time with it.)

## Voice

- `V`: spawns `arecord -D hw:0,1 -c 2 -r 96000 -f S32_LE` (the DMIC's only mode), downmixes and
  decimates by 6 to 16 kHz mono S16, streams `a` chunks every 100 ms. Energy VAD: floor from the
  first 300 ms; speech when rms > max(3 x floor, 300); ends after 0.8 s below max(1.5 x floor,
  150) following speech, or at `max_s` (default 8), or on `v`.
- `W`: queues 48 kHz stereo S16 for `aplay -D hw:0,0`, drained non-blocking from the poll loop;
  `w done` when played. Mono input must be upmixed on the host (see audio.md).
- ALSA tools are run via `chroot /mnt/data/alpine` when jetd runs from the initramfs, directly
  when it already runs inside the chroot.

## Networking rules inside jetd

- Hub writes are `MSG_DONTWAIT`; on EAGAIN the data is dropped and the socket is closed after
  5 s stuck. Binary payloads wait up to 2 s for room.
- Dial-out is a non-blocking `connect()` polled from the main loop with a 2 s deadline. A
  blocking connect on a usb0 with no peer sat in ARP/SYN timeouts and froze the UI for seconds.
- The log viewer and all modes never depend on the hub being reachable.

## Profiling

`JETD_PROF=1` prints per-phase maxima of the main loop every 5 s (e.g. "holds+glance+imu").

## Live testing (without a reboot or reflash)

1. Copy the new binary **first**: `scp agent/jetd root@jet.local:/android-data/jetd-new`
   (`killall jetd` blanks the display daemon, so never kill before the copy is in place).
2. `killall jetd`, then start the new one from the chroot over ssh with `setsid nohup ... &`
   (a plain background job dies with the dropbear session).
3. Paths: userdata is `/android-data` inside the chroot and `/mnt/data` in the initramfs; jetd
   tries both for every flag file. The next boot runs the baked-in `/bin/jetd` again; rebuild
   `boot-emmc.img` and flash to make a change permanent.
