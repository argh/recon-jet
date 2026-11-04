# host/: the `jet` CLI (nothing here runs the glasses)

The Jet is self-sufficient: jetd and `device/jet-app` run on the device, and every heavy request
(ASR, chat, TTS, vision, map tiles) goes from the device to outbound services (`llm.base` in the
device config; `docs/networking.md`). Nothing on a Mac is in that path. What lives here reaches
**into** the device for development and debugging — as opposed to `tools/`, which is build,
install and on-device helpers.

`jet.js` is a one-shot client of jetd's line protocol (TCP 7777, spec at the top of
`agent/jetd.c`): connect, do one thing, exit. It opens no ports and is inert by default —
attaching to a live device never disturbs jet-app; only `mode`/`backlight`/`console` (and `live`'s user-driven injections) send
anything that changes device state, because that is what you asked for.

```
cd host && npm install           # @versionzero/module-manager + configurator + schema (public npm)
node jet.js state                # hello geometry, pong RTT, glance, wear, power snapshot (--json)
node jet.js snapshot [out.png]   # camera frame -> PNG
node jet.js screenshot [out.png] # the glass as shown, assembled from the mirror
node jet.js log [-n N] [--follow]
node jet.js events               # stream key/motion/mode/glance/wear/view events (Ctrl-C exits)
node jet.js console $'uname -a\n'  # type into the on-device shell pty
node jet.js mode <remote|log|shell|setup>
node jet.js backlight <0-1023>
node jet.js raw P Q              # protocol lines verbatim (power-user escape hatch)
node jet.js live                 # the glass in a browser: mirror + audio + controls (docs/live.md)
```

`JET_HOST` / `--host` pick the device (default `jet.local`; `. work/env.sh` sets it), `JET_PORT`
and `--timeout-ms` exist for odd setups. The code is structured with `@versionzero/module-manager`
(each command is a module in `modules/`, selected by the app schema — the command pattern from
`docs.v0.net/configurator/guide/commands`); `lib/client.js` owns the socket, framing and parsing.
`npm test` runs an offline suite against a fake jetd (`test/fake-jetd.js`).

The retired predecessors — `jet-hub.js` (a standing server from the era when the device dialed
out to a Mac-side brain) and the host-side voice path — live in git history (pre-2026-11 trees).
