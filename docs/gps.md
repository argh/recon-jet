# GPS

The Jet's GPS is inside the WL1283 combo chip: no separate receiver, no UART of its own. The
chip computes fixes itself; a host daemon uploads a firmware patch and aiding data, starts fix
sessions and receives reports. On stock Android that daemon is TI's closed `navd` (NaviLink /
GPSC stack, 2013, armv5 bionic), and the kernel side was TI's "shared transport" (`ti-st`): BT,
FM and GPS multiplexed over one HCILL UART, with GPS as channel 9 exposed to user space as
`/dev/tigps`. None of that user space is portable, and `ti-st` was removed from mainline — but
the protocol on each side of `navd` is small, so mainline runs the stock binary unmodified.

## How it works on mainline

```
mainline kernel                         stock chroot (/android-data/stock)
hci_ll.c (+ GPS channel 9) ── /dev/tigps ──> navd ──┬── /data/gps/recongps   NMEA out (FIFO)
  = hci0, same HCILL link                           └── /data/gps/gps4121    command socket
```

- **Kernel**: `kernel/overlay/drivers/bluetooth/hci_ll.c` is mainline's TI HCILL serdev driver
  plus the GPS channel (search `LL_GPS`). Channel-9 frames (`[0x09][opcode u8][plen le16]
  [payload]`) ride the Bluetooth UART beside ACL/event traffic: opcode 1 = host write, 2 = GPS
  report, 3 = write-completed credit (one write in flight, as the chip requires). `/dev/tigps`
  reproduces the stock `gps_drv.c` contract navd expects: packet-per-read, `FIONREAD` returns
  the next packet's size, `TCFLSH` purges, unknown ioctls succeed. The chip is powered and its
  firmware loaded by `hci0 up`, so GPS needs hci0 up for as long as it runs.
- **navd**: the stock system partition is mounted read-only into a chroot with `/data`, `/dev`
  and `/proc` bound; `device/gps/gps.sh start` does all of it. navd opens `/dev/tigps`, uploads
  `wl128x_sp11p97_128.ce` (the chip's GPS patch, from the stock partition, visible in dmesg as a
  burst of ~140-byte channel-9 writes), reads its config and aiding files from
  `/android-data/gps/`, and serves clients.
- **Client protocol** (recovered from `gps.omap4.so`, the stock Android HAL): codecs in
  `device/jet-app/src/lib/navl.js`, exercised by `device/jet-app/tools/gps-probe.js`.
  - `/data/gps/gps4121` (Unix socket): requests are `[f0 f1 f2 f3][has-payload u8][opcode u8]
    [len le16][payload]`; responses use the same magic header with an event code in the opcode
    byte. Opcode 0x01 starts the baseband, 0x10/0x11 start/stop a fix session (0x38-byte
    session config; `navl.js` carries the HAL's defaults), 0x02 stops the baseband. Event 1 is
    command-complete `{opcode, result}`, 2 a report bundle, 9 the engine/version banner.
  - `/data/gps/recongps` (FIFO): `[code u32][len u32][text]` records, code 0x10, text =
    one NUL-terminated NMEA sentence. GGA, RMC, GLL, VTG, GSA and GSV all arrive at 1 Hz
    during a fix session. **This is the stream to consume**; the gps4121 report bundles are
    TI-internal structures there is no need to parse.

## Bring-up and verification (2026-10-30)

On-device, from this repo: install the module tree (`hci_uart.ko` from `kernel/build.sh module`
into `/android-data/mainline/modules/.../bluetooth/`), then

```sh
device/gps/gps.sh start       # mounts, hci0 up, navd
node tools/gps-probe.js 40    # from device/jet-app, copied to the device: baseband + fix session
device/gps/gps.sh status      # shows the live NMEA tail
```

Verified end to end indoors: baseband start and fix start both complete with result 0, the
patch upload is visible on the channel, and NMEA streams at 1 Hz — with empty fields and
`GSV ... 00` satellites, as expected with no view of the sky. An outdoor fix is the remaining
test.

## Caveats

- **BT/WiFi coexistence is untuned**: hci0 up pins WiFi rx at ~1 Mbit/s, and GPS keeps hci0 up.
  Fine on the move; toggle GPS off on the desk.
- navd and its libraries stay on the stock partition and run in place; nothing closed is copied
  or redistributed. The chroot mounts do not survive a reboot; `gps.sh start` redoes them.
- First fix after a long power-off can take minutes (the 2013-era aiding data is stale and the
  RXN prediction service is long dead); the chip's own ephemeris cache in
  `/android-data/gps/aiding/` warms repeat fixes.
- The capture scripts and raw logs from bring-up live in `work/gps/` (not in the repo).
