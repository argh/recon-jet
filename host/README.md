# host/: remote developer tools (nothing here runs the glasses)

The Jet is self-sufficient: jetd and `device/jet-app` run on the device, and every heavy request
(ASR, chat, TTS, vision, map tiles) goes from the device to outbound services (`llm.base` in the
device config; `docs/networking.md`). Nothing on a Mac is in that path, and nothing in this
directory is required for the glasses to work.

What lives here is the other direction: tools that reach **into** the device from a workstation
for development and debugging — as opposed to `tools/`, which is build, install and on-device
helpers. No dependencies; plain Node.

| tool | what it is |
|---|---|
| `jet-hub.js` | live remote view/drive of the glass: jetd protocol client/acceptor on 7777 plus an HTTP control API on 7778 (`/screen`, `/raw`, `/mode`, `/console`, `/snapshot[.jpg\|.uyvy]`, `/look`, `/glance`, `/log`, `/state`); `--look`, `--ptt`, `--live`. Draws only while no jet-app holds the surface (`E`), so attaching to a running device is read-mostly by default |
| `vision.js` | the VLM call behind the hub's `/look` (`LLM_BASE`, sends `enable_thinking: false` or the VLM burns its budget thinking) |

Pointed at the device with `JET_HOST` (default `jet.local`), at the inference server with
`LLM_BASE` / `LLM_*_MODEL` — `. work/env.sh` (written by `./setup.sh`) sets all of it.
One-shot equivalents without the hub: `tools/jetshot.sh` (screenshot via jet-app, or the
framebuffer over ssh), `tools/jsh.sh` (ssh with a hard timeout), `tools/postmortem.sh` (pull
crash/boot records).

The retired host-side voice path (the Mac ran ASR/LLM/TTS and streamed audio over a WebSocket)
was removed when the loop moved on-device; it lives in git history with its per-stage latency
harness (`host/voice-session.js`, `host/voice-client.js`, pre-2026-11 trees).
