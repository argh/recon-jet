# Interaction design

One owner of the screen after boot, one gesture vocabulary, modes as plugins. This document is
the contract between jetd (device server), jet-app (application layer) and mode authors.

## Lifecycle

| Phase | Who draws | What the user sees |
|---|---|---|
| Kernel + init (0 to ~3 s) | nobody | black |
| jetd up, no client (~3 s to ~5 s) | jetd | boot log scrolling (jetd's own renderer, fallback only) |
| jet-app connected | jet-app (`E 1`, `K 1`) | log mode continues seamlessly from jetd's backlog, then the start mode |
| first use (no calibration or network config) | jet-app | the System wizard: pad calibration, glance calibration, brightness, network, done |
| normal | jet-app | the last used mode (persisted) or the configured default |
| jet-app gone (crash, upgrade) | jetd | log with a "jet-app down" banner; jetd's recovery chooser (front hold) returns |

jetd keeps exactly two screens: the boot/fallback log and its recovery chooser, both only while no
client owns the surface. Everything else (setup screens included) lives in jet-app; jetd's
setup mode and `M setup` stay for recovery and go away once the Node System screens exist.

## Gesture vocabulary

Global, identical in every mode:

| Gesture | Meaning |
|---|---|
| front hold (~1 s) | mode switcher (full-screen list, chooser style); hold again or rear closes it |
| rear press | back: close the top overlay, go up one level, leave a sub-screen; at a mode's root, nothing |
| rear hold | never used (PMIC power path) |

Inside a mode (the mode decides, but these defaults keep modes consistent):

| Gesture | Default meaning |
|---|---|
| swipe up / down | move selection in a list; previous / next page or item in a view |
| swipe left / right | secondary axis: adjust a value, scrub history, switch tabs |
| front press | primary action: select, trigger ("look now", "talk"), confirm |
| pad tap | same as front press |

Rules: one physical swipe is one step (key-down events only, 250 ms debounce); nothing fires
on release except where a hold is being measured; no gesture has a different meaning in two
places that look alike.

## Visual grammar

- Full-screen mode content, plus a 10 px status strip the system layer may draw along the top:
  link state, charging bolt, listening/looking indicator, transient notices (3 s, then gone).
- Overlays (mode switcher, menus, confirmations) are chooser-style boxes: 2 px border, title in
  yellow, selected row as a filled green bar with black text, hint line at the bottom.
- Two fonts: 10x20 bold for headings and the one thing that matters, 6x12 for detail. Colour
  carries meaning: green = selected/active/ok, yellow = title/attention, red = problem, grey = hint.
- Nothing jitters: numbers are smoothed and rounded before display; animation only for
  progress (looking, listening).

## Modes

A mode is a plugin: `{ id, label, enter(ctx), leave(), onGesture(g), render(surface), tick() }`
registered with the mode registry (module-manager module; private modes register from
`personal/`). The switcher lists registered modes in registration order; the first registered
is the default unless `ui.defaultMode` says otherwise; the last used mode is persisted on the
device (`mainline/jet-app.json` state file) and restored at boot.

Shipped (public):

| Mode | Purpose |
|---|---|
| Log | kernel log from jetd's `j` stream with scrollback and horizontal offset; the first thing shown after boot; also the crash diagnostics view |
| Demo | a small, readable example others extend: clock, sensor readouts, camera thumbnail, "front press = describe what I see" through the configured LLM |
| System | Status (power, link, sensors), Pad calibration, Glance calibration, Brightness, Network (addresses, WiFi state), About (versions); also runs as the first-use wizard |

Private (examples of what `personal/` adds; not in the repo):

| Mode | Idea |
|---|---|
| Location intel | "what is extra intel about where I am": location from the phone or WiFi, OSINT tools behind the host agent, a short refreshed digest |
| Assistant | wake word or front press to talk; transcript and answer on the glass; audio out |
| Live | continuous augmented senses: camera scene + sensors + location + time, analysed on change (new view, glance, voice), each analysis refining the last (belief with confidence and recency), quiet when nothing is new |

## Setup and first use

First use = no pad calibration file, no glance calibration, or no network config. The System
wizard walks the same screens in order with a progress hint ("2 of 4"); each screen is also
reachable on its own later. Calibration values are written to the same userdata files jetd
reads (`mainline/ofm-args`, `mainline/glance`), so jetd's drivers pick them up on the next boot;
jet-app applies them live through sysfs / jetd commands.

## What jetd owes the app for this

- Raw keys (`K 1`) and the external surface (`E 1`): done.
- A reload command for calibration files (glance thresholds, view thresholds) so the app's
  System screens take effect without a restart.
- A "client present" flag so jetd's chooser is disabled while a client holds the surface, and
  re-enabled when the client drops (recovery).
- Log backlog on connect (`j` lines): done; add a count parameter so the Log mode can request the
  full ring.

## Open questions

- Persisting "last mode" across a jet-app restart vs across a reboot: both, in the state file.
- Mode-local gestures that collide with the global ones (a mode wanting front hold) are not
  allowed; a mode may ask for a confirmation overlay instead.
- Wake word: on device (small engine) or host (stream audio): decide with the Assistant mode.
