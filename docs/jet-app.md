# jet-app: the Node application layer (`device/jet-app/`)

Phases 1-3 of the Node port (`work/node-port-plan.md`). jet-app runs on the Jet, inside the
userdata chroot (Node 22, armv7), connects to `jetd` over its TCP line protocol (`docs/jetd.md`),
takes jetd's external pixel surface (`E 1`) and its raw keys (`K 1`), and from then on owns every
screen: jetd stays in remote mode the whole time and its own chooser is off. jetd's own screens
(boot log, recovery chooser, setup) are only for the time no client holds the surface.
The interaction contract is `docs/interaction-design.md`; this file is the module map.

Runtime: Node 22 in the Jet's chroot; Node 22 has the iterator helpers that
`@versionzero/module-manager` 1.0.0 uses (no shim).

## Modules (`src/modules/`)

| module | job | events / API |
|---|---|---|
| `device-link` | TCP client to jetd (or acceptor when `listen=true`), line + binary framing (`f` frames, `a` audio chunks), reconnect with dial timeout, request/reply helpers | emits `connected`, `disconnected`, `hello`, `key`, `rel`, `mode`, `log`, `logBacklog`, `calibration`, `glance`, `worn`, `wake`, `listen`, `view`, `captureChunk`, `captureEnd`, `playDone`, `pong`, `power`, `surface`, `frame`, `jetError`; methods `send`, `clear`, `text`, `rect`, `colour`, `flush`, `flushRect`, `surface`, `viewfinder`, `viewfinderStop`, `backlight`, `setMode`, `captureStart/Stop`, `wakeListen(on, cutoff, window)` (`D`; `listen` is the acceptor flag), `play`/`playEnd`, `ping`, `power`, `glance`, `worn`, `logBacklog(n)` (`J`), `reloadCalibration()` (`U`), `snapshot` |
| `surface` | jetd's external pixel surface: `E 1` on connect, an RGB565 back buffer sized from the reply, canvas-style drawing, PSF fonts, dirty tracking, `flush()` writes the changed rectangle to `/dev/fb0` and sends `F x y w h`; `viewfinder()` hands a rectangle to jetd's camera stream, `pauseViewfinder()`/`resumeViewfinder()` hold it off while the display is dark and restart it; `E 0` at shutdown | emits `ready`; API below |
| `input` | sends `K 1` on connect (jetd forwards every key down/up at once and keeps its chooser off) and `K 0` when the run aborts; gestures from the raw stream: `press:front|rear|tap`, `hold:front|rear` (`holdMs`, 1 s: the hold fires while the button is still down; a release before that is the press), `swipe:up|down|left|right` from the key DOWN of the driver's swipe keys only, debounced (`swipeDebounceMs`, 250 ms); the summed motion `r dx dy` is re-emitted as `motion` (pad calibration measures it) but never navigates; nothing fires on a release. Keyboard aliases (a BT/USB keyboard's keys arrive the same way): Enter/keypad Enter = front (held = front hold), Esc/Backspace = rear, arrows = the pad's swipe keys (same codes); key repeats (value 2) are ignored | emits `press`, `hold`, `swipe`, `gesture` (name string) and `motion` |
| `power` | polls `Q` every `pollMs` (2 s) while connected and jetd is in remote mode; `smoothed` = median of the last `samples` (8) polls of battery mV and mA, rounded to `roundStep` (10) | `last`, `smoothed`, `ingest(reading)`, emits `update` |
| `sensors` | the last glance (`g at raw`), wear (`o worn raw`) and new-view (`n degrees`) events, timestamped | `glance`, `view`, emits `glance`, `view` |
| `sounds` | the cue vocabulary, one tonal language (A5 880 Hz is "1", 1320 its "5"): `powerOn` 1-5 rising, `powerOff` 5-1, `ack` 1-5-1 (something was sent), `success` a short octave-up beep, `error` a slow fall to the minor third below, `worn` a short high beep, `removed` a low boop, `thinking` a quiet single tone; each rendered once (`src/lib/tones.js`, 48 kHz stereo S16) and played as one `W` clip; `enabled`, `gain` | `play(name)` → jetd's result or false when off / link down; `Sounds.pcm(name)` |
| `actions` | the spoken-command registry: `register(name, pattern, run, {when?})` from any module, `match(text)` normalises (case, punctuation, the wake word's tail: "jet, run analysis" -> "run analysis"; a bare leading "jet" is tried without only if the rest is a command) and returns the first match whose `when` does not decline, with a promise-returning `run()`. **Spoken commands** are one verb per tier and one noun, no verb synonyms (the ASR never confused enable/disable in testing; nouns carry aliases only where it has misheard them): `open <mode or screen>` (Modes: id, label or a mode's `spoken` names: settings, console, analysis, radio; System: status, pad, glance, brightness, wear, bluetooth, location, aliases stages/glands/where/ware), `enable|disable bluetooth|wear|gps` (+ optional d: "enabled"; "location" = gps), `run analysis` (Describe: come to the mode, describe), `run doom` (also "random", what the ASR usually hears; refused with the reason when the binary or WAD is missing), `stop|cancel|never mind` (Voice: the turn ends, nothing asked). A transcript with no Latin letter (the ASR's near-silence output, "对。") is discarded before matching | `list`, `register`, `match` |
| `gps` | the position, from the NMEA stream TI's daemon writes while GPS is on (System > Location toggles it): `listen()` follows the FIFO with a non-blocking poll (reopening across daemon restarts), parses GGA/GSA/GSV/RMC into one snapshot (`state`: fix none/2d/3d, lat/lon/alt, hdop, satellites used and in view, speed, course, GPS time) and emits `update` at most 1/s; fix transitions and a 30 s satellite summary go to the log, every raw sentence to `logFile`. `stopListening()` keeps the last snapshot | `listen()`, `stopListening()`, `listening`, `state`, `update` |
| `wear` | the display follows the glasses: `o 0` from jetd (its wear classification of the proximity reading, 1 s hysteresis; `g` is the finer eye-at-the-glass event) starts `offDelayMs` (2 s), then dark: backlight sysfs 0, `surface.pauseViewfinder()` (the camera stream is ~85 mA, the backlight itself is not measurable), the white power LED pulsing on the kernel `timer` trigger (150 ms every 3 s), the `removed` cue; `o 1` restores all three with the `worn` cue (the levels it had, the saved backlight file as fallback); any gesture while dark relights without a cue and holds until the sensor reports a fresh not-worn (a sensor fault never locks you out); asks `O` on every connect; `stop()` relights; the ui and doom keep running. Off by default (`enabled`): the sensor is followed either way, System > Wear turns the behaviour on live and persists it in the per-device config layer | `worn`, `lit`, `setEnabled(on)`, emits `change(lit)` |
| `ui` | the system layer of the screen: renders at most once per tick (clear, `root.render(surface)`, the 10 px status strip, `flush()`) and only while `surface.active` (connected, jetd mode `remote`, surface acquired); full repaint on every hello and on `ready`; owns no screens | `root` (the mode registry), `setStrip(text, {colour, ms})`, `requestRender()`, `active`, `renders` |
| `modes` | the mode registry and switcher (below): modes register in their `start()`, `begin()` enters the start mode, front hold opens the chooser-style switcher, every other gesture goes to the current mode; the last mode is persisted in `stateFile` | `register(mode)`, `list`, `current`, `get(id)`, `switchTo(id)`, `begin()`, `openSwitcher/closeSwitcher`, `render`, emits `mode` |
| `llm` | the OpenAI-compatible inference server the Jet reaches over WiFi (`llm.base`, plain https): `transcribe(pcm16kMono)` (wav + multipart built in memory, `/audio/transcriptions`), `chatStream(messages, onToken, signal)` (`/chat/completions` with `stream: true`, SSE parsed as it arrives, `reasoning_content` deltas dropped, `chat_template_kwargs {enable_thinking: false}` + `reasoning_effort` sent), `speak(text, signal)` (`/audio/speech` wav → 24 kHz mono decoded and resampled in JS to the 48 kHz stereo S16 jetd plays), `describe(jpeg, question, onToken, signal)` (chat with an `image_url` data URI, the vision model); one keep-alive agent, a timeout per call, `AbortSignal` cancel | `configured`, `models`, the four calls |
| `voice` | push-to-talk and wake-word turns run on the device. With `wake` (default on) jetd is told `D 1 cutoff window` on every connect and a `d` hit is a turn with no cue and no `V` (jetd is already capturing); every final transcript is offered to `actions` first (`route()`: a match runs the action, names it on the strip and the model is not asked; a spoken command is answered from the phrase bank, `phrases.js`: an "ack" clip at once, a different "wait" clip every `actionWaitMs` while it runs, an "error" clip if it fails, all rendered once in the TTS voice and cached under `phraseDir`, a button-started action says nothing; otherwise `question` is emitted and the Assistant brings itself up for a wake-word one). Push-to-talk: `session.js` is an in-process `VoiceSession` over `llm` (no Mac in the loop): idle → listening (ack cue, `V`, every `a` chunk to the session, which transcribes the whole buffer every `partialMs`) → thinking (partial transcripts; a cached "wait" phrase `fillerMs` after the final transcript if no audio yet) → speaking (each sentence synthesised in order while the model streams, queued with `W`, `w` at `done`) → idle. Events `partial`, `final`, `token`, `audio`, `done`, `error`, each tagged with the turn; cancel/barge-in aborts the requests in flight through one `AbortController` per turn. No gesture is read here: the Assistant mode calls it. `look(jpeg, question)` is the vision request the Demo mode makes. Debug HTTP on `debugPort`: `POST /talk`, `/cancel`, `/say {text}`, `/phrases` (render the missing clips), `/look {question?}` (snapshot through jetd → JPEG → vision), `GET /state`, `GET /screen.png?scale=N` (the framebuffer as a PNG, `lib/screenshot.js`: everything the panel shows, from any process) | `startTurn()` (ends the capture while listening, barge-in while thinking/speaking), `cancel()`, `clear()`, `look()`, `say(text)`, `renderPhrases()`, `phraseStatus`, `state`, `turn`, `transcript`, `answer`, `configured`, emits `state` |
| `jet` (`src/jet.js`) | main module (`AppModule`): references every subsystem and the public modes, which is what instantiates them; `main()` calls `modes.begin()` once everything has started; heartbeat tick with link state and RSS | |

Shared drawing bits in `src/modules/ui/`: `style.js` (palette `C`, `MARGIN`, `STRIP_H`, `TOP`,
`wrapWords`, `hint`, `heading`, `row`, `paragraph`) and `chooser.js` (`Chooser`: the one list box,
2 px yellow border, yellow title, the selected row a filled green bar with black text, hint line at
the bottom; `move(d)`, `select(id)`, `item`, `render(s)`).

## Modes (`src/modes/`)

A mode is a plugin `{ id, label, enter(ctx), leave(), onGesture(g) -> handled, render(surface),
tick?() }`, optionally `firstUse()`; it is a module-manager module that injects `modes` and calls
`modes.register(this)` first thing in its `start()` (registration order = switcher order; register
before any `await`). `personal/index.js` may export `modules: [Class, ...]`; `main.js` registers
each as an instance, so it is configured and started like a core module without core referencing it.
`ctx.wizard` is true when the mode was entered as the first-use wizard. `tick()` runs once per
`modes.tickMs` (1 s) while the mode is current and the panel is ours, followed by a render.

Start mode (`modes.begin()`): a mode whose `firstUse()` resolves true (System, when a calibration
file is missing), else the mode in the state file `/android-data/mainline/jet-app-state.json`
(`{"mode": "demo"}`, written atomically on every switch), else `ui.defaultMode` (`demo` in the
default config), else the first registered. Until `begin()` has run, `modes.bootMode` (`log`) is
drawn, so the panel continues jetd's boot log without a gap.

Gestures: **front hold** opens the switcher (`MODE` list of every registered mode, current one
selected) and closes it again; in the switcher swipe up/down moves, front press or pad tap picks,
rear press cancels. Everything else goes to the mode's `onGesture`; **rear press** is "back"
inside a mode and does nothing at its root; jetd is never asked to change mode.

| mode | id | what it does |
|---|---|---|
| **Log** | `log` | the kernel log: `J` on connect and on enter (the whole ring; the 60 lines jetd sends by itself are deduplicated by taking the last `n` of the replay once `J n` arrives), live `j` lines always buffered (`lines`, 2000); small font, newest at the bottom, auto-follow unless scrolled; swipe up/down scroll by a page, left/right pan by 10 columns, rear returns to following; also the boot view |
| **Describe** | `demo` | the readable example: clock, glance / last new view / battery readouts, the camera live in a 160x120 rectangle (surface viewfinder), front press = describe: `S 640 480` (the next streamed frame), UYVY → RGBA at 320x240 (`uyvy.js`), jpeg-js at `jpegQuality` (60), `voice.look()` with `question`; the answer streams onto the glass, rear clears it. A spoken "run analysis" asks `spokenQuestion` instead: a first `SAY:` line, kept off the glass, whose TTS starts the moment the line is complete (the TTS was woken when the look began, `voice.warm()`), then the details; when the answer ends a "report" phrase ("Sent you the details.") plays and the remark follows it; the button's describe stays silent |
| **System** | `system` | a `SYSTEM` chooser of screens: **Status** (display-only, everything worth reading: clock, battery strip and smoothed readout, the rails on one line, WiFi with SSID/signal/address, the USB link, Bluetooth and GPS radio states, last glance and new view, jet-app/Node/kernel versions and uptime; addresses and radios refresh every 5 s; the charger/limit registers and gadget state are gone - ssh territory), **Pad calibration** (3 swipes per direction RIGHT/LEFT/DOWN/UP from the pad's summed motion, swipe keys swallowed meanwhile; thresholds = half the weaker direction's median per axis, clamped 8..60; written live to `/sys/module/jet_ofm/parameters/thr_x|thr_y` and to `mainline/ofm-args` as `thr_x=N thr_y=M`), **Glance calibration** (at / forward / at / away, front takes each reading as the average of 8 reads of the `tmd2771` IIO `in_proximity0_raw` 20 ms apart; on = away + 60 % of the span, off = away + 40 %, either polarity, span under 40 rejected; `mainline/glance` as `on off`, then `U`), **Brightness** (16..1023 by 48, swipe up/right and down/left, live on `/sys/class/backlight/kopin-a230/brightness`, front saves `mainline/backlight`, rear reverts), **Wear** (the sensor's live word and whether leaving the head darkens the display; front toggles `wear.setEnabled()` and writes `wear.enabled` into the per-device config `mainline/jet-app.json` via `patchLayer`), **Bluetooth** (radio on/off from `bluetoothctl show`, connected and paired devices, the boot default; front toggles the radio with `bluetoothctl power` and creates/removes `mainline/bt`, the marker init reads; refreshed every 5 s; pairing stays on ssh; powering off while GPS runs stops the GPS daemon first), **Location** (GPS on/off plus what it sees - satellites used/in view, fix and hdop, position, speed and GPS time from the `gps` module, live; front toggles by running `scripts/gps.sh start|stop` - chroot mounts, hci0 up, TI's navd, docs/gps.md - and off also powers the radio down unless `mainline/bt` says Bluetooth belongs on; no boot persistence yet). Every screen but Status controls something. Rear in a screen returns to the menu. First use (no `ofm-args` or `glance` on userdata): `firstUse()` is true and the mode is entered as the wizard: Pad calibration → Glance calibration → Brightness with "n of 3" in each title, then the menu and a "setup complete" notice |
| **Assistant** | `assistant` | push-to-talk: front press = `voice.startTurn()` (again while listening ends the capture, while thinking/speaking barges in); the answer wrapped in the big font (small when long), the transcript along the bottom, the strip saying listening/thinking/speaking; rear cancels a running turn or clears the answer; leaving the mode cancels. The only place a front press starts a voice turn |
| **Shell** | `shell` | the switcher entry for jetd's shell: entering sends `M shell` and jetd owns the panel (a keyboard types into the pty, the hub can `I`); when jetd returns to remote (Ctrl+Alt+Enter, or its front-hold chooser) the app goes back to the mode showing before (`returnTo`, default `system`, when there was none). `transient`: never persisted as the start mode |
| **Doom** | `doom` | launches the native `doom` (`device/doom`, a doomgeneric port) and suspends the ui (`ui.suspend`): doom is a jetd client of its own, taking `k` keys over the socket, writing frames into fb0 and playing its sound (sfx and OPL music) through `aplay` (`hw:0,0`, so it and the voice loop should not talk at once). Front = Enter/Fire, rear = Esc, swipes = arrows, a Bluetooth keyboard plays normally. Front hold still opens the switcher: doom is frozen meanwhile (SIGUSR1: paused, not drawing, keys dropped; SIGUSR2 resumes), picking another mode kills it, Esc > Quit returns to the mode before, a crash shows why (rear returns); without the binary or the IWAD the switcher lists it disabled (`no binary` / `no WAD`, the mode's `unavailable()`). `command` and `args` (`-stretch` fills the 16:9 glass instead of 4:3). `transient` |

Files written on userdata (`/android-data/mainline/`): `jet-app-state.json` (last mode),
`ofm-args`, `glance`, `backlight` (the files jetd and the init script already read at boot),
`voice/phrases/<set>-<hash>.pcm` (the spoken-reply clips). All paths are configuration (`modes.stateFile`,
`systemMode.*File`, `.ofmSysfs`, `.backlightSysfs`, `.iioDir`, `.netDir`), so tests point them at
temp files.

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
| `pauseViewfinder()`, `resumeViewfinder()`, `viewfinderPaused` | the display is dark: `z` now, the rectangle is ours again, but the mode's request is kept (a `viewfinder()` call while paused parks and resolves null) and `Z` goes out again on resume; `stopViewfinder()` while paused forgets it |
| `active`, `ready`, `width`, `height`, `geometry`, `viewfinderRect`, `fonts`, `icons`, `raster` | state |

Fonts are PSF1 or PSF2 (`psf.js`, unicode tables honoured, missing glyphs render `?`) loaded from
`assets/fonts/` (copied from `agent/font/`; `surface.fontDir`, `.mainFont`, `.smallFont`).

Measured on the Jet (Node 22, Cortex-A9): clear 0.1 ms, a 42-character big-font row 3.6 ms, a
71-character small row 2.6 ms, the status screen (2 big + 12 small rows, bars) ~10 ms to raster,
diff of a full frame ~2.5 ms, one full-frame write to `/dev/fb0` ~4 ms, a 160x120 thumbnail
from 640x480 RGBA 6.5 ms. A full repaint through `ui` (render + flush) is 15-30 ms; a clock
tick is ~5 ms.

Library bits: `src/lib/logger.js` (JSON lines on stdout, `JET_LOG_LEVEL`), `src/lib/config.js`
(layering below), `src/lib/tones.js` (tone sequences as 48 kHz stereo S16 with click-free fades),
`src/lib/sysfs.js` (write-if-present, read an integer).

Tests (`npm test`, `node --test`, no device): protocol parser incl. split binary payloads, PSF1/2
parsing, 565 packing, rectangle algebra, `diffRect`, text layout and alignment, blits (jpeg-js
round trip), the surface flush against a file standing in for `/dev/fb0` (changed rows only,
viewfinder rectangle untouched), press/hold/swipe detection from timestamped `k` events (`K 1`/`K 0`
too; a key pair plus its motion is one move, two key downs 100 ms apart are one move and 400 ms
apart two), the median/rounding smoother and remote-only polling; the mode registry and switcher
through the real input/surface/ui stack against a stub link (`test/modes.test.js`: boot mode drawn
until `begin()`, first-use wizard > persisted > `ui.defaultMode` > first registered, an unknown
persisted mode falls back, state file written on a switch and restored by a second stack, front
hold opens/closes the switcher, swipes move and wrap with the debounce, front or tap picks with
enter/leave, rear cancels, every other gesture reaches the mode and nothing fires on a key down,
jetd never asked to change mode; and, with the real Assistant/Demo/System modes over a stub voice,
that a front press starts a voice turn in Assistant only, is a look in Demo and navigation in
System); the Log buffer and mode (`test/log-mode.test.js`: scroll clamping, pan, follow, a scrolled
view holding still under new lines, the `J` backlog replacing the automatic 60 lines, `J` on
connect and on enter, repaint only while current); the calibration arithmetic and the network
parsers (`test/calibration.test.js`); the System mode against temp files (`test/system-mode.test.js`:
`firstUse()`, the wizard with "n of 3" titles, pad thresholds from motion sums into sysfs and
`ofm-args`, glance from scripted sensor values into `glance` plus `U`, a flat run rejected, a
missing sensor reported, brightness live/saved/reverted, every menu screen, Status repainting only
on a changed readout and showing the address rows); the Demo picture path (`test/demo.test.js`:
UYVY → RGBA, the snapshot → 320x240 JPEG → `look` flow, a second press swallowed, rear clearing,
a late answer after leaving dropped, a failing snapshot shown); the voice state machine against
a fake link, ui and session (`test/voice.test.js`: `startTurn` → ack cue + `V` + `start`, chunks
forwarded, `end` at `A`, partial/final/tokens/audio/done, stale frames ignored; barge-in = `Y` +
`cancel` + a new turn, press while listening = `v`; `cancel()` while listening or speaking;
`look()` through the session; the phrase bank (rendered at start, reused from disk, the wait phrase when audio is late, a spoken command acknowledged, nagged and told of failure); not-configured refused; a session
error or link drop ends the turn), the tone generator and word wrap; the cue vocabulary and the wear module (`test/sounds.test.js`, `test/wear.test.js`: every cue renders short and within gain, play is silent when off or unlinked; dark after the delay, relit on worn, a quick glance away is nothing, a gesture relights silently and holds, stop relights); the in-process session
against a fake llm (`test/session.test.js`: partials while listening, final → tokens → one audio
frame per sentence in order even when a later sentence synthesises faster → done; an empty
transcript; cancel mid-stream aborts the requests and emits nothing more; upstream failures as
one `error`; `say`/`look` independent of the turn; the sentence splitter); the `llm` module
(`test/llm.test.js`: wav header/parser incl. extra chunks and an overrun data size, the multipart
body, the SSE parser across split chunks and a split UTF-8 character, the resampler (24 kHz mono
→ 48 kHz stereo lengths and a 1 kHz tone), and the module against a fake OpenAI-compatible server
on loopback: the multipart upload, reasoning deltas ignored and the thinking switches sent, the
vision data URI, the TTS wav → 48 kHz stereo, a non-200, cancel and timeout). `test/fake-jetd.js` is a
protocol stand-in (hello, `P/Q/G/M/E/Z/J/U` replies, a kernel-log ring, event injection) used by
the tests and runnable standalone; `test/helpers.js` builds the real input/surface/ui/modes stack.

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
| `ui.defaultMode` | `demo` | start mode when nothing is persisted |
| `modes.stateFile` / `.tickMs` / `.bootMode` | `/android-data/mainline/jet-app-state.json` / `1000` / `log` | persisted state; mode tick (clock); what shows until the start mode is entered |
| `logMode.lines` | `2000` | scrollback kept |
| `demoMode.question` / `.spokenQuestion` / `.jpegQuality` | (a describe prompt) / (a `SAY:` remark line first, then the details) / `60` | the look request from the button / from a spoken command / the JPEG |
| `systemMode.ofmArgsFile` / `.glanceFile` / `.backlightFile` | `/android-data/mainline/ofm-args` / `glance` / `backlight` | what the calibration screens write |
| `systemMode.ofmSysfs` / `.backlightSysfs` / `.iioDir` / `.netDir` | `/sys/module/jet_ofm/parameters` / `/sys/class/backlight/kopin-a230/brightness` / `/sys/bus/iio/devices` / `/sys/class/net` | live hardware paths |
| `systemMode.gpsScript` | `/opt/jet-app/scripts/gps.sh` | the GPS bring-up script the Location screen runs (start\|stop) |
| `gps.fifo` / `.logFile` / `.retryMs` | `/android-data/gps/recongps` / `/android-data/gps/nmea.log` / `2000` | the NMEA FIFO the gps module follows while GPS is on; every sentence is appended raw to `logFile` (on eMMC: an outdoor test survives WiFi dropping), truncated at each listen |
| `llm.base` | (none) | the OpenAI-compatible base URL, `https://<server>/v1`; no default in the repo: set it in the device layer (`/android-data/mainline/jet-app.json`) or the personal layer; empty = voice and vision off |
| `llm.asrModel` / `.chatModel` / `.ttsModel` / `.ttsVoice` / `.visionModel` | `qwen3-asr` / `qwen-27b` / `kokoro` / `af_heart` / `qwen-vision` | the models |
| `llm.thinkingKwarg` / `.reasoningEffort` | `true` / `none` | send `chat_template_kwargs {enable_thinking: false}` (off for servers that reject unknown fields); `reasoning_effort` (empty = not sent). On llama.cpp with qwen-27b only `reasoning_effort: none` actually stops the reasoning stream; either way reasoning deltas are never spoken |
| `llm.maxTokens` / `.visionMaxTokens` | `200` / `150` | answer budgets |
| `llm.asrTimeoutMs` / `.chatTimeoutMs` / `.ttsTimeoutMs` | `20000` / `90000` / `30000` | per-call timeouts (the chat one covers the whole stream) |
| `voice.enabled` / `.maxSeconds` | `true` / `8` | turns allowed; longest capture |
| `voice.wake` / `.wakeCutoff` / `.wakeWindow` | `true` / `0.97` / `5` | hands-free: jetd listens for the wake word (needs `mainline/wake.tflite` on the device); the model manifest's cutoff and window |
| `voice.systemPrompt` / `.partialMs` | (spoken-answer prompt) / `1000` | the chat model's system prompt; partial transcript interval |
| `voice.fillerMs` / `.actionWaitMs` | `700` / `6000` | a wait phrase this long after the transcript with no answer audio / every this long while a spoken command runs (three at most, never the same clip twice in one command) |
| `voice.phrases` / `.phraseDir` | ack, wait, error sets (`phrases.js`) / `/android-data/mainline/voice/phrases` | the spoken replies, rendered once in the TTS voice (a hash of voice and text names each clip, so a new voice re-renders) / where the clips live |
| `voice.sentenceGapMs` | `400` | silence appended to each spoken sentence |
| `voice.debugPort` | `0` | `JET_VOICE_DEBUG_PORT`: debug HTTP (`POST /talk`, `/cancel`, `/say`, `/phrases`, `/look`, `/action` `{text}` = a spoken command without the mic; `GET /state`, `/screen.png`) |
| `jet.logLevel` / `jet.deviceConfig` | `info` / `/android-data/mainline/jet-app.json` | logging; device layer path |

Secrets (none yet) belong in `/android-data/mainline/jet-app.env`, sourced by `deploy/jet-app.sh`.

## Running

On the Mac against the stand-in: `node test/fake-jetd.js 7790` in one terminal,
`JET_DEVICE_LINK_PORT=7790 JET_SURFACE_DEVICE=/tmp/fb0 JET_MODES_STATE_FILE=/tmp/state.json npm start`
in another (the surface writes a file instead of the panel; point `JET_SYSTEM_MODE_*` at temp files
too, or the missing calibration files start the wizard). Against a real jetd the app must run on the Jet: it writes that
machine's `/dev/fb0`.

On the device (`/opt/jet-app` inside the chroot):

```sh
sh device/jet-app/deploy/bundle.sh        # npm ci --omit=dev + tar -> work/jet-app.tgz (pure JS, arch-agnostic)
JET_HOST=... sh device/jet-app/deploy/install.sh   # scp -O, extract, chown 0:0, restart
tools/jsh.sh '/opt/jet-app/deploy/jet-app.sh start|stop|restart|status'   # log: /tmp/jet-app.log (JSON lines)
tools/jetshot.sh [out.png] [scale]            # screenshot of the panel: GET /screen.png from the debug port, or /dev/fb0 over ssh when jet-app is down
```

No npm on the device, so dependencies come from the Mac's `node_modules` (pure JS only: `jpeg-js` is
the one runtime dependency beyond the `@versionzero/*` packages).
Startup is ~2 s to the first dial, RSS ~55 MB on the Jet (the Node baseline is most of it).

## Status (2026-10-22)

### Phase 3: one UI (2026-10-22)

The two-menu experience (jet-app's menu next to jetd's chooser, Status triggering the voice turn)
is gone: after it connects jet-app owns every screen, jetd stays in remote mode, and the front
hold always opens the same `MODE` switcher. Checked on the Jet against `jetd-new16`: a clean start
enters the persisted mode, the Log mode receives the full ring with `J` (no duplicate of the
automatic 60 lines), the switcher reaches Log / Demo / System / Assistant, the System screens read
the real sysfs/IIO/`ip`/`iw`, and a front press in System or Demo never starts a voice turn.
Deviations from `docs/interaction-design.md`: the state file is `mainline/jet-app-state.json`
(not `mainline/jet-app.json`, which is the per-device configuration layer); the first-use wizard
has three steps (pad, glance, brightness), not five: there is no network setup on the glass yet
(WiFi is configured in the chroot's wpa_supplicant.conf) and no "done" screen beyond the notice;
and the "client present" flag jetd owes the app is `K 1` for now (jetd's chooser returns with
`K 0`, which goes out when the app stops; a crash leaves jetd in remote mode with raw keys until
it notices the socket close).

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

### Voice on the device (2026-10-22)

The voice loop runs on the Jet: the `voice` module's session drives the `llm` module directly
over WiFi, and the Mac is no longer in the loop (the earlier path, `voice.hostUrl` →
`host/voice-session.js` over a WebSocket with ffmpeg for the resample, is retired; the host
scripts stay as developer tools, `host/README.md`). The only configuration is `llm.*`
(`llm.base` on the device in `mainline/jet-app.json`); the `ws` dependency is gone and the
wav/multipart/SSE/resample work is pure JS in `src/modules/llm/`.

Measured on the Jet over WiFi with the debug trigger (2026-10-22, `jetd-new16`, warm server
unless noted). `POST /say` of a 3.2 s phrase: 516 ms to the PCM (TTS + transfer + the JS
resample; 2.7 s the first time with kokoro cold), played 3.27 s later. A quiet-room turn: the
earcon plays 264 ms after the press, the capture runs to `A max` 8.5 s after the press, partials
every second at 167-396 ms (the whole buffer, 0.6 s → 7.6 s), the empty final 434 ms after the
capture ends, "nothing heard" 442 ms after it. A spoken turn (the question played through the
Jet's own speaker during the capture, so the mic heard it): transcript "What color is the sky on
a clear day?" exactly, partials 319-811 ms for 0.6-5.8 s of audio, final 505 ms for 7.2 s, the
filler rendered and cached in 464 ms, first LLM token 8.3 s (qwen-27b cold after a `look`
swapped the vision model in; ~0.6 s warm from the Mac), 17 tokens in 9.2 s, the one-sentence TTS
637 ms for 3.9 s of speech, first audio 10.3 s after the capture ended, idle 4.0 s after
`done` (jetd's `w`). `POST /look`: snapshot 866 ms (640x480 → 320x240 JPEG, 10 KB), vision
6.6 s with the first token at 6.0 s (qwen-vision loading), 30 tokens. The stages the device adds
over the host path (TLS, multipart, resample) are within the noise: a partial costs the same
~200-400 ms from the Jet as from the Mac. Neither `enable_thinking: false` nor
`reasoning_effort: none` reliably stops qwen-27b/qwen-vision from emitting a short
`reasoning_content` preamble (~110-130 characters, about a second); it is dropped, never spoken.

Found on the way: jetd's `spawn_pipe` does not set CLOEXEC, so an `arecord` started (`V`)
while a long clip is still playing inherits `aplay`'s stdin pipe; at the clip's end jetd blocks
in `waitpid(aplay)` (aplay never sees EOF), stops reading arecord, and both wedge: no `A`, `S`
times out. Barge-in is safe (`Y` SIGKILLs aplay first) and so is the earcon (drained before
`V` is read); a debug `say` followed by a `talk` within the clip is the trigger. jet-app now
sends `Y` before a capture whenever a clip it queued is still unreported; the jetd fix
(close-on-exec on the pipe fds, or kill before close) is in `docs/open-questions.md`. Recovery
without restarting jetd: SIGKILL the arecord child (SIGTERM is swallowed by alsa-utils' restarted
write).

Earlier, over the host path (USB, `host/voice-session.js`, for comparison): first LLM token 3.1 s,
first audio 6.0 s after `end` for a 3.7 s question, `say hello` 250 ms warm; the LLM-bound
stages are the same server either way.

## Deferred (later phases)

a shell mode (jetd's pty shell has no app equivalent), `sensors` policies, `providers/*`, a `hub`
HTTP API on the device, init supervision line, the `--config` file option (available but unused;
layering is done in `src/lib/config.js`), ESLint config, a network setup screen (WiFi credentials
on the glass), the wake word (interaction-design open question), status-strip link/charge icons.
