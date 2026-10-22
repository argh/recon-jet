# jet-app: the Node application layer (`device/jet-app/`)

Phase 1 of the Node port (`work/node-port-plan.md`). jet-app runs on the Jet, inside the Alpine
chroot (Node 20.15, armv7), connects to `jetd` over its TCP line protocol (`docs/jetd.md`) as
the hub, and draws only while jetd's remote mode is showing. jetd's own modes (log, shell, setup,
the front-hold chooser) are untouched; jet-app is just the hub that happens to live on the device.


Runtime: Node 22 (Alpine 3.22 `nodejs` package) in the Jet's Alpine chroot; Node 22 has the iterator
helpers that `@versionzero/module-manager` 1.0.0 uses (no shim).

## What exists

| module (`src/modules/`) | job | events / API |
|---|---|---|
| `device-link` | TCP client to jetd (or acceptor when `listen=true`), line + binary framing (`f` frames, `a` audio chunks), reconnect with dial timeout, request/reply helpers | emits `connected`, `disconnected`, `hello`, `key`, `rel`, `mode`, `log`, `glance`, `view`, `captureChunk`, `captureEnd`, `playDone`, `pong`, `power`, `frame`, `jetError`; methods `send`, `clear`, `text`, `rect`, `colour`, `flush`, `backlight`, `setMode`, `captureStart/Stop`, `play`/`playEnd`, `ping`, `power`, `glance`, `snapshot` |
| `display` | character grid (cols x rows from the hello, 42x12 with the main font) with per-row colour and alignment; `flush()` diffs against what jetd shows and resends only changed rows (`B` black rect + `T`/`A`, `F`), full `C` redraw when more than half changed or after a hello; `active` gates drawing | `grid.set(row, text, {colour, centre})`, `flush()`, `invalidate()`; `layout.js`: `wrap`, `spread`, `truncate` |
| `input` | gestures from raw events: `press:front|rear|tap`, `hold:front|rear` (`holdMs`, 1 s), `swipe:up|down|left|right` from the driver's swipe keys and from raw `r dx dy` (threshold, deduped against the key that follows) | emits `press`, `hold`, `swipe` and `gesture` (name string) |
| `power` | polls `Q` every `pollMs` (2 s) while connected, parses the `q` line | `last`, emits `update` |
| `ui` | screen stack + menu overlay; routes gestures; renders at most once per tick; keeps `display.active` = connected and jetd mode is `remote`; redraws on every hello | `show(screen)`, `openMenu()`, `closeMenu()`, `requestRender()`; `Screen` base (`render(grid)`, `onGesture(name)`), `Menu`, `StatusScreen` |
| `jet` (`src/jet.js`) | main module (`AppModule`): references every subsystem, which is what instantiates them; heartbeat tick with link state and RSS | |

Screens: **Status** (clock, link state and geometry, battery mV/mA, VSYS/VBUS, charger and
limit registers, UDC state and gadget MaxPower, last glance event, last new-view event) and the
**menu** (`Status`, `Back to jetd remote`). "Back to jetd remote" shows a passive screen that
draws nothing, so jetd's remote mode looks like a plain hub-less remote; the menu gesture brings
the menu back.

Menu gesture: `hold:front` is the design, but today's jetd consumes the front hold itself (its
mode chooser) and forwards buttons as a down/up pair at release, so holds never reach the hub.
Until jetd forwards raw keys (plan step 2), `press:rear` also opens the menu
(`ui.menuGestures`).

Library bits: `src/lib/logger.js` (JSON lines on stdout, `JET_LOG_LEVEL`), `src/lib/config.js`
(layering below), `src/lib/compat.js` (iterator-helper shim: `@versionzero/module-manager` 1.0.0
calls `map.values().find()`, which Node 20 lacks although the package declares `node >= 20.9`).

Tests (`npm test`, `node --test`, no device): protocol parser incl. split binary payloads, grid
diff and flush output, press/hold/swipe detection. `test/fake-jetd.js` is a protocol stand-in
(hello, `P/Q/G/M` replies, event injection) used by the tests and runnable standalone.

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
| `display.cols` / `.rows` / `.minFlushMs` | `42` / `12` / `50` | geometry before the first hello; flush rate limit |
| `input.holdMs` / `.swipeThreshold` / `.swipeDedupeMs` / `.tapCode` | `1000` / `20` / `300` / `28` | gesture detection |
| `power.pollMs` | `2000` | `Q` interval (0 disables) |
| `ui.menuGestures` / `.clockMs` | `["hold:front","press:rear"]` / `1000` | menu trigger; status refresh |
| `jet.logLevel` / `jet.deviceConfig` | `info` / `/android-data/mainline/jet-app.json` | logging; device layer path |

Secrets (none yet) belong in `/android-data/mainline/jet-app.env`, sourced by `deploy/jet-app.sh`.

## Running

On the Mac against a jetd that listens: `JET_DEVICE_LINK_HOST=jet.local npm start`.
Against the stand-in: `node test/fake-jetd.js 7790` in one terminal, `JET_DEVICE_LINK_PORT=7790 npm start` in another.

On the device (`/opt/jet-app` inside the chroot = `/android-data/alpine/opt/jet-app`):

```sh
sh device/jet-app/deploy/bundle.sh        # npm ci --omit=dev + tar -> work/jet-app.tgz (pure JS, arch-agnostic)
JET_HOST=... sh device/jet-app/deploy/install.sh   # scp -O, extract, chown 0:0, restart
tools/jsh.sh '/opt/jet-app/deploy/jet-app.sh start|stop|restart|status'   # log: /tmp/jet-app.log (JSON lines)
```

No npm on the device, so dependencies come from the Mac's `node_modules` (no native addons).
Startup is ~2 s to the first dial, RSS ~50 MB on the Jet (Node 20 baseline is most of it).

## Status of the device link (2026-10-21)

jet-app runs on the Jet (process supervision, logging, config layering, reconnect loop all
exercised there), and the whole protocol path was exercised from the device against the
stand-in on the Mac (`JET_DEVICE_LINK_HOST=<mac> JET_DEVICE_LINK_PORT=7790`): hello -> status
screen, `Q` polling, rear press -> menu, swipe from `r`+key deduped, front press -> passive
remote screen, `m log`/`m remote`+hello -> single redraw, glance/view on the status screen,
disconnect -> redial. Gesture-to-draw latency device -> Mac was 15-40 ms.

It could **not** connect to the real jetd, for two reasons outside this layer:

1. `lo` is DOWN on the device (initramfs init never brings it up), so every locally addressed TCP
   connection (127.0.0.1 and the device's own usb0/wlan0 addresses alike) is silently dropped.
   Fix: `ip link set lo up` in `kernel/initramfs/init` (and once by hand for the running system).
2. The running jetd has no listening socket on 7777 (only its outbound hub link; its bind must
   have failed at start), so nothing can connect inbound until jetd is restarted.

Both are one-line fixes but touch init/jetd, which phase 1 leaves alone. jet-app keeps dialling
(5 s dial timeout, 2 s pause) and will take over as soon as a listening jetd is reachable. Note
that jetd holds a single hub socket: an inbound jet-app displaces a connected Mac hub, and a Mac
hub dialling the Jet displaces jet-app; `listen=true` with `127.0.0.1` first in `mainline/hub`
is the intended steady state (plan section 3).

## Deferred (later phases)

`modes` (log/shell/setup in the app, needs `JETD_RAW_KEYS`/`N`/`K`/`O` in jetd), `sensors`
policies, `voice`, `vision`, `providers/*`, `hub` HTTP API on the device, init supervision line,
the `--config` file option (available but unused; layering is done in `src/lib/config.js`), ESLint
config, 71x20 small-font geometry (the grid already follows the hello).
