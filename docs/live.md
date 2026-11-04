# jet live: the glass in a browser

`jet live` mirrors the panel into a local web page, plays the device's audio, and drives the
real controls from surrogate ones — full remote operation of the menus, modes and the voice
loop, which is otherwise impossible to demo without the glasses on someone's head.

```
jet live                 # prints http://127.0.0.1:<port>/ and opens it; Ctrl-C stops
jet live --http-port N --open false
```

## How the mirror works (and why there is no encoder)

The Kopin panel is manual-update: nothing reaches it except explicit rectangle pushes
(`OMAPFB_UPDATE_WINDOW`), so **every change already names its bounding rectangle**. jetd's
mirror (`N 1` in the protocol) is a tee of raw framebuffer bytes at the two push sites —
jetd's own full flush and the external-surface/viewfinder rect path — reading back from the
live framebuffer *after* composition, so jet-app drawing and the camera blit are included.
At 428x240 a full frame is 205 KB and a typical text-UI delta a few KB: raw RGB565 is cheap
enough that MJPEG or any encoder would only add CPU and latency on a device with no hardware
codec available.

Mirroring never blocks the UI loop. A rect is written only when it wholly fits the socket's
free space (`SO_SNDBUF` − `TIOCOUTQ`); a client that falls behind is owed a **banded full
refresh** that drains as its socket empties — and because bands read the live framebuffer,
the picture converges on current content no matter what was dropped. jetd accepts up to 4
clients, so the mirror rides alongside jet-app and a debug session.

Audio comes along for free: capture chunks (`a`, 16 kHz mono) were always broadcast to every
client, and the mirror adds a tee of queued speaker PCM (`u`, 48 kHz stereo, whole sample
frames — a carry keeps TCP's arbitrary slicing out of the framing) — the page hears both sides
of a voice turn, every UI cue, and Doom's soundtrack (doom streams its mixer into jetd's `W`
too; jetd is the one speaker owner). The page plays it all through a single AudioWorklet ring
(48 kHz context, ~100 ms prebuffer, re-armed only by a sustained gap), and a stat line by the
sound toggle (`rx/played/out/ctx`, underruns, minimum buffer) tells the truth when something
sounds wrong — it found every bug in this path. Input goes the other way with `H k <code> <val>` (pod buttons,
real press/release so holds and the chooser work), `H r <dx> <dy>` (one summed pad gesture,
exactly what the touchpad driver emits) and `H t <code> <val>` (keyboard keys through the
BT-keyboard path — shell typing, modifiers, Ctrl+Alt+Enter — which the page's "keyboard"
toggle uses); injected input takes the same dispatch path as evdev, so jetd screens and
jet-app react identically.

## The page

`host/modules/live.js` holds one jetd connection and a loopback-only HTTP server for
`host/live/index.html`, bridged by a minimal built-in WebSocket layer (no dependencies):
JSON text per event, one binary message per payload, and whatever the page sends back is
written to jetd verbatim. The page renders rects to a canvas (RGB565→RGBA), schedules audio
chunks on a rolling WebAudio cursor, and maps drag/click/keyboard to `H` injections —
drag = swipe, click/Enter = front, Backspace = rear (held keys hold the real button), and
HOLD TO TALK runs a `V`/`v` push-to-talk turn through the on-device assistant.

## Limits

- ~50 ms added latency from the socket-fit check's drain cadence; fine for menus and demos.
- The mirror shows panel *pushes*: a mode that never redraws sends nothing until it changes
  (the subscribe-time full refresh covers the initial picture).
- Loopback only by design. To show a remote audience, share the browser tab, not the port.
