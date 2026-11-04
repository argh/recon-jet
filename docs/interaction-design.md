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

jetd keeps exactly two screens: the boot/fallback log and its dead-man chooser (RECOVERY:
log / shell / bluetooth toggle / reboot), both only while no client owns the UI. Everything
else lives in jet-app — jetd's setup mode is gone (the Node System screens own calibration,
brightness and the radios), and with a client alive a front hold in jetd's shell or log hands
straight back to the app's menu.

## Gesture vocabulary

Global, identical in every mode:

| Gesture | Meaning |
|---|---|
| front hold (~1 s) | mode switcher — a screen of its own, not an overlay (modes are modal: nothing shows behind the menu); hold again or rear returns to the mode |
| rear press | back, ascending one tree: close a menu, leave a sub-screen; at a mode's root it opens the mode switcher, and in the switcher it returns to the mode — rear-rear-rear always escapes. A mode whose content ended (shell left, doom quit) has concluded: the menu is the screen then, and rear has nowhere further to go |
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
- Menus (the mode switcher, in-mode menus, confirmations) are chooser-style boxes: 2 px border,
  title in yellow, selected row as a filled green bar with black text, hint line at the bottom.
  The mode switcher draws alone on a cleared screen: opening it is navigating out of the mode,
  not popping something up over it.
- Two fonts: 10x20 bold for headings and the one thing that matters, 6x12 for detail. Colour
  carries meaning: green = selected/active/ok, yellow = title/attention, red = problem, grey = hint.
- Nothing jitters: numbers are smoothed and rounded before display; animation only for
  progress (looking, listening).

## Modes

A mode is a plugin: `{ id, label, enter(ctx), leave(), onGesture(g), render(surface), tick() }`
registered with the mode registry (module-manager module; private modes register from
`personal/`). The System screens repeat the pattern inside their mode: `Screen`-providing modules
in a configurable array, with an enter/leave lifecycle from the mode and their own model
subscriptions - the mode never relays events into a child. The switcher lists registered modes in
registration order; the first registered
is the default unless `ui.defaultMode` says otherwise; the last used mode is persisted on the
device (`mainline/jet-app-state.json`) and restored at boot.

Shipped (public):

| Mode | Purpose |
|---|---|
| Log | kernel log from jetd's `j` stream with scrollback and horizontal offset; the first thing shown after boot; also the crash diagnostics view |
| Demo | a small, readable example others extend: clock, sensor readouts, camera thumbnail, "front press = describe what I see" through the configured LLM |
| System | a menu of screens: Status (power, link, addresses, radios, sensors, versions), Pad calibration, Glance calibration, Brightness, Wear, Bluetooth, Location; also runs as the first-use wizard. Screens are plugins like modes one level down: modules providing `Screen`, each owning its dependencies, listed (and extended from `personal/`) by the configurable `systemMode.screens` array; a screen is told enter/leave and watches its own models only while showing |
| Assistant | push-to-talk: front press to talk (the only mode where a press starts a voice turn); transcript and answer on the glass; audio out |

Private (examples of what `personal/` adds; not in the repo):

| Mode | Idea |
|---|---|
| Location intel | "what is extra intel about where I am": location from the phone or WiFi, OSINT tools behind the host agent, a short refreshed digest |
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

## Status (2026-10-22)

Implemented in jet-app phase 3 (`docs/jet-app.md`): the registry and switcher, Log, Demo, System
and Assistant, persistence, the first-use wizard. Where the implementation deviates from the text
above: the state file is `mainline/jet-app-state.json` (`mainline/jet-app.json` is the per-device
configuration layer); the wizard has three steps (pad, glance, brightness; "n of 3"), because
there is no network configuration on the glass yet (WiFi lives in the chroot's
wpa_supplicant.conf) and the "done" step is a 3 s notice; the "client present" flag is `K 1`
(jetd's chooser is off while raw keys are on, and `K 0` goes out when the app stops cleanly);
the status strip shows text notices and the voice/look indicator but no link/charge icons yet.
Assistant (voice) and Demo (describe) run against the inference server from the device over
WiFi (`llm.base`); the Mac-side voice session is retired, so the glasses work with no host
attached once the WiFi and `llm.base` are configured.

2026-11-04: spoken side effects are observers, not control flow. "Check my location" is an
observable fix pursuit on the gps module (acquiring → fixed | timeout) that the screens draw and
the voice layer narrates through announcements; a new user turn supersedes pending announcements
(their lines are dropped unless registered with `queue: true`, which holds them until the turn is
over) - so asking something else mid-hunt wins, and the stale fix report never interrupts the
answer.

## Open questions

- Persisting "last mode" across a jet-app restart vs across a reboot: both, in the state file.
- Mode-local gestures that collide with the global ones (a mode wanting front hold) are not
  allowed; a mode may ask for a confirmation overlay instead.
- Wake word: on device (small engine) or host (stream audio): decide with the Assistant mode.
