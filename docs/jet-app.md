# jet-app: the Node application layer (`device/jet-app/`)

Phases 1-2 of the Node port (`work/node-port-plan.md`). jet-app runs on the Jet, inside the Alpine
chroot (Node 22, armv7), connects to `jetd` over its TCP line protocol (`docs/jetd.md`) as the
hub, takes jetd's external pixel surface and draws only while jetd's remote mode is showing.
jetd's own modes (log, shell, setup, the front-hold chooser) are untouched; jet-app is just the
hub that happens to live on the device.


Runtime: Node 22 (Alpine 3.22 `nodejs` package) in the Jet's Alpine chroot; Node 22 has the iterator
helpers that `@versionzero/module-manager` 1.0.0 uses (no shim).

## What exists

| module (`src/modules/`) | job | events / API |
|---|---|---|
| `device-link` | TCP client to jetd (or acceptor when `listen=true`), line + binary framing (`f` frames, `a` audio chunks), reconnect with dial timeout, request/reply helpers | emits `connected`, `disconnected`, `hello`, `key`, `rel`, `mode`, `log`, `glance`, `view`, `captureChunk`, `captureEnd`, `playDone`, `pong`, `power`, `surface`, `frame`, `jetError`; methods `send`, `clear`, `text`, `rect`, `colour`, `flush`, `flushRect`, `surface`, `viewfinder`, `viewfinderStop`, `backlight`, `setMode`, `captureStart/Stop`, `play`/`playEnd`, `ping`, `power`, `glance`, `snapshot` |
| `surface` | jetd's external pixel surface: `E 1` on connect, an RGB565 back buffer sized from the reply, canvas-style drawing, PSF fonts, dirty tracking, `flush()` writes the changed rectangle to `/dev/fb0` and sends `F x y w h`; `viewfinder()` hands a rectangle to jetd's camera stream; `E 0` at shutdown | emits `ready`; API below |
| `input` | sends `K 1` on connect (jetd forwards every key down/up at once and keeps its chooser off while in remote mode) and `K 0` when the run aborts; gestures from the raw stream: `press:front|rear|tap`, `hold:front|rear` (`holdMs`, 1 s: the hold fires while the button is still down; a release before that is the press; events may carry a timestamp `t`, and the release classifies from `t_up - t_down`), `swipe:up|down|left|right` from the key DOWN of the driver's swipe keys (103/108/105/106) only, debounced (`swipeDebounceMs`, 250 ms: a second swipe inside the window is dropped); the summed motion `r dx dy` is logged and re-emitted as `motion` but never navigates; raw keys and motion are logged at debug with timestamps | emits `press`, `hold`, `swipe`, `gesture` (name string) and `motion` |
| `power` | polls `Q` every `pollMs` (2 s) while connected and jetd is in remote mode, parses the `q` line; `smoothed` = median of the last `samples` (8) polls of battery mV and mA, every mV/mA rounded to `roundStep` (10) | `last`, `smoothed`, `ingest(reading)`, emits `update` |
| `ui` | screen stack + nested menu overlay; routes gestures (only while jetd is in remote mode); renders at most once per tick (clear, `render(surface)`, `flush()`) and only while `surface.active` (connected, jetd mode `remote`, surface acquired); full repaint on every hello and on `ready`; `leaveTo(mode)` hands the panel to a jetd mode and goes silent until `m remote` + hello | `show(screen)`, `openMenu()`, `closeMenu()`, `toggleMenu()`, `leaveTo(mode)`, `requestRender()`; `Screen` base (`render(surface)`, `onGesture(name)`, `onShow/onHide`), `Menu` (items may have `children`, `back`, `live` or `action`; `enter(item)`, `back()`, `depth`, `title`, `items`, `selected` of the current level), `StatusScreen`; palette `C` in `screen.js` |
| `jet` (`src/jet.js`) | main module (`AppModule`): references every subsystem, which is what instantiates them; heartbeat tick with link state and RSS | |

Screens: **Status** (heading and clock in the big font; link state and geometry, a 60x8 battery
strip with the charge bolt, smoothed battery mV/mA, VSYS/VBUS, charger and limit registers, UDC
state and gadget MaxPower, last glance event, last new-view event in the small font; its 1 s
clock timer runs only while it is showing and not covered by the menu, and a power poll
re-renders only when the rounded readout changed) and the **menu**: a vertical list in a
bordered box laid out like jetd's mode chooser, with the selection drawn as a filled bar and a
`>` marker, next to the 160x120 camera thumbnail. A sub-menu replaces the list in the same box,
titled by the item that opened it; the parent keeps its selection for when you come back.

| menu item | effect |
|---|---|
| `Camera: on/off` | toggles jetd's live viewfinder in the thumbnail; closing the menu stops it |
| `Kernel log` | `M log`: jetd's own log viewer |
| `System` > | opens the sub-menu below |
| &nbsp;&nbsp;`Status` | closes the menu, shows the status screen |
| &nbsp;&nbsp;`Setup` | `M setup`: jetd's own setup menu (pad/glance calibration, brightness, power) |
| &nbsp;&nbsp;`Back` | up to the top level |

Button semantics (jetd raw keys, `K 1`): **hold front** (~1 s) opens the menu, and closes it
again from any level; **swipe up/down** moves the selection; **front press** (or a pad tap)
picks; **rear press** goes up one level, and closes the menu at the top level. Plain presses
outside the menu do nothing (screens may consume them).

Gesture rules for the touchpad: jetd forwards, for one swipe, the driver's summed motion
(`r dx dy`) and then the swipe key as a down/up pair, and a long swipe can make the driver emit
two keys. Only the key down counts as a move; the key up and the motion never do (the motion is
still logged at debug and emitted as `motion`); and a second swipe key within
`input.swipeDebounceMs` (250 ms) of the previous one is dropped, so one swipe is one step.
Raw `key` and `motion` events are logged at debug level with their timestamps
(`JET_LOG_LEVEL=debug`), so the next pad complaint can be read off `/tmp/jet-app.log`.
While jetd is in one of its own modes (log, shell, setup) raw keys are off, jetd handles the
buttons itself (front hold = its chooser, rear = back) and jet-app draws nothing and sends
nothing; jetd's `m remote` plus the hello that follows it trigger the repaint.

### Surface API (`src/modules/surface/`)

The surface owns the panel from jetd's `E 1` reply (`{w, h, bpp, stride}`, 428x240, 16 bpp,
stride 856 on this panel; nothing is hardcoded) until the app exits (`E 0`, sent when the run is
aborted, before the link closes). Drawing goes to a `Raster` (`raster.js`: pure JS, no device
knowledge, `pitch` from the stride so rows are written as-is); the module delegates:

| call | meaning |
|---|---|
| `clear(colour)`, `fillRect(x, y, w, h, colour)`, `strokeRect(x, y, w, h, colour, {width})`, `line(x0, y0, x1, y1, colour)` | colours are `0xRRGGBB` or `[r, g, b]`, packed to 565 once per call |
| `text(x, y, str, {font, colour, align, maxWidth, background})` -> box | `font` = `surface.fonts.main` (10x20 bold `ter-u20b`) or `.small` (6x12 `Lat2-Terminus12x6`), default main; `align` `left`/`center`/`right` makes `x` that edge; `maxWidth` truncates with `~`; `background` fills the cell |
| `measureText(str, {font, maxWidth})` -> `{w, h, chars}` | monospace layout |
| `blitRGB565(buf, x, y, w, h, {pitch})` | raw 565 pixels |
| `blitImage(image, x, y, {w, h})` | `{width, height, data}` RGBA or RGB (e.g. `surface.decodeJpeg(buf)`, jpeg-js), nearest-neighbour scaled when `w`/`h` differ |
| `icon(x, y, icon, colour, {scale})` | 1 bpp icons: `icons.js` (`parseIcon(['#..', ...])`, `surface.icons.battery/bolt/camera/usb`) |
| `flush()` -> rect or null | union of everything drawn since the last flush, narrowed to the pixels that actually differ from what the panel shows (`diffRect`), written to the device with positional `writeSync` (whole rows in one write; rows crossing the viewfinder as spans), then `F x y w h`; rate-limited by `minFlushMs` |
| `invalidate()` | full rewrite on the next flush (hello: jetd's other modes drew over us) |
| `viewfinder(x, y, w, h, fps)` -> `{w, h}` source size, `stopViewfinder()` | `Z`/`z`; while active the rectangle belongs to jetd and is never written; on stop it is forced back on the next flush |
| `active`, `ready`, `width`, `height`, `geometry`, `viewfinderRect`, `fonts`, `icons`, `raster` | state |

Fonts are PSF1 or PSF2 (`psf.js`, unicode tables honoured, missing glyphs render `?`) loaded from
`assets/fonts/` (copied from `agent/font/`; `surface.fontDir`, `.mainFont`, `.smallFont`).

Measured on the Jet (Node 22, Cortex-A9): clear 0.1 ms, a 42-character big-font row 3.6 ms, a
71-character small row 2.6 ms, the status screen (2 big + 12 small rows, bars) ~10 ms to raster,
diff of a full frame ~2.5 ms, one full-frame write to `/dev/fb0` ~4 ms, a 160x120 thumbnail
from 640x480 RGBA 6.5 ms. A full repaint through `ui` (render + flush) is 15-30 ms; a clock
tick is ~5 ms.

Library bits: `src/lib/logger.js` (JSON lines on stdout, `JET_LOG_LEVEL`), `src/lib/config.js`
(layering below).

Tests (`npm test`, `node --test`, no device): protocol parser incl. split binary payloads, PSF1/2
parsing, 565 packing, rectangle algebra, `diffRect`, text layout and alignment, blits (jpeg-js
round trip), the surface flush against a file standing in for `/dev/fb0` (changed rows only,
viewfinder rectangle untouched), press/hold/swipe detection from timestamped `k` events (`K 1`/`K 0`
too; a key pair plus its motion is one move, two key downs 100 ms apart are one move and 400 ms
apart two), the median/rounding smoother and remote-only polling, menu nesting against a stub
ui (`test/menu.test.js`: enter/back/close, per-level selection), and the menu state machine
through the real input/surface/ui stack against a stub link (open/close/move/pick, rear up one
level vs close at the top, `M log`/`M setup` hand-over with no renders or commands until
`m remote` + hello, camera toggle, power updates repainting only on a changed readout). `test/fake-jetd.js` is a protocol stand-in (hello,
`P/Q/G/M/E/Z` replies, event injection) used by the tests and runnable standalone.

## Configuration

Layers, lowest first (each deep-merged over the previous, then handed to the configurator as
`defaults`, so environment and command line still win):

1. `config/jet-app.default.json` (committed, generic)
2. `/android-data/mainline/jet-app.json` (per device, optional; `JET_DEVICE_CONFIG` overrides the path)
3. `personal/jet-app.json` (gitignored; copy `personal/jet-app.example.json`)
4. environment `JET_<PATH>` (`JET_DEVICE_LINK_HOST`, `JET_POWER_POLL_MS`, `JET_LOG_LEVEL`, ...)
5. command line (`--device-link-host`, `--power-poll-ms`, ...); `--help` lists everything with
   defaults, `--dump=-` prints the effective configuration

`personal/index.js` (gitignored, optional) may export `modules: [Class, ...]` which `main.js`
registers additively (future providers) without editing core.

| key | default | meaning |
|---|---|---|
| `deviceLink.host` / `.port` | `127.0.0.1` / `7777` | jetd to dial |
| `deviceLink.listen` / `.bind` | `false` / `0.0.0.0` | accept jetd dialling us (put our address in `mainline/hub`) instead |
| `deviceLink.reconnectMs` / `.dialTimeoutMs` / `.replyTimeoutMs` | `2000` / `5000` / `5000` | link timing |
| `surface.device` / `.minFlushMs` / `.viewfinderFps` | `/dev/fb0` / `30` / `10` | framebuffer to write; flush rate limit; default camera rate |
| `surface.fontDir` / `.mainFont` / `.smallFont` | `assets/fonts` / `ter-u20b.psf` / `Lat2-Terminus12x6.psf` | PSF fonts |
| `input.holdMs` / `.swipeDebounceMs` / `.tapCode` | `1000` / `250` / `28` | hold threshold; minimum gap between two swipes; pad tap code |
| `input.rawKeys` | `true` | send `K 1` on connect (false: jetd's chooser and press pairs, so holds never arrive) |
| `power.pollMs` / `.samples` / `.roundStep` | `2000` / `8` / `10` | `Q` interval (0 disables); median window; display rounding (mV, mA) |
| `ui.menuGestures` / `.clockMs` | `["hold:front"]` / `1000` | menu trigger; status refresh |
| `jet.logLevel` / `jet.deviceConfig` | `info` / `/android-data/mainline/jet-app.json` | logging; device layer path |

Secrets (none yet) belong in `/android-data/mainline/jet-app.env`, sourced by `deploy/jet-app.sh`.

## Running

On the Mac against the stand-in: `node test/fake-jetd.js 7790` in one terminal,
`JET_DEVICE_LINK_PORT=7790 JET_SURFACE_DEVICE=/tmp/fb0 npm start` in another (the surface writes a
file instead of the panel). Against a real jetd the app must run on the Jet: it writes that
machine's `/dev/fb0`.

On the device (`/opt/jet-app` inside the chroot = `/android-data/alpine/opt/jet-app`):

```sh
sh device/jet-app/deploy/bundle.sh        # npm ci --omit=dev + tar -> work/jet-app.tgz (pure JS, arch-agnostic)
JET_HOST=... sh device/jet-app/deploy/install.sh   # scp -O, extract, chown 0:0, restart
tools/jsh.sh '/opt/jet-app/deploy/jet-app.sh start|stop|restart|status'   # log: /tmp/jet-app.log (JSON lines)
```

No npm on the device, so dependencies come from the Mac's `node_modules` (pure JS only: `jpeg-js` is
the one runtime dependency beyond the `@versionzero/*` packages).
Startup is ~2 s to the first dial, RSS ~55 MB on the Jet (the Node baseline is most of it).

## Status (2026-10-22)

Phase 2b: jetd's raw keys (`K 1`) make the front hold reach the app, so the menu works like jetd's
chooser (hold front, swipe, front picks, rear backs out one level) and `Kernel log` / `System >
Setup` hand the panel to jetd's own screens and take it back on the next hello. Hands-on testing
found the pad "jumpy": one swipe arrived as motion plus a key pair and moved twice; swipes now
come from swipe-key downs only, debounced. The battery readout is a median over the
last 8 polls, rounded to 10 mV / 10 mA, on a 60x8 strip.

Phase 2 runs on the Jet against the real jetd (loopback is up, jetd listens on 7777): `E 1` is
answered with `428 240 16 856`, the status screen and menu are rasterised and flushed as
rectangles, the camera thumbnail streams through `Z` and stops with `z`, and `E 0` goes out on
SIGTERM before the link closes. Phase 1 (process supervision, config layering, reconnect loop,
gestures, `Q` polling, mode changes and hello-triggered redraws) was exercised the same way.
Note that jetd holds up to four hub sockets and `E` is a jetd-global flag: a Mac hub drawing with
`T`/`B` while jet-app owns the surface is ignored until `E 0`.

## Deferred (later phases)

`modes` (log/shell/setup rendered by the app itself rather than handed to jetd), `sensors`
policies, `voice`, `vision`, `providers/*`, `hub` HTTP API on the device, init supervision line,
the `--config` file option (available but unused; layering is done in `src/lib/config.js`), ESLint
config, decoding camera `S` frames (UYVY) into the surface.
