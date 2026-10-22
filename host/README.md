# host/: Mac-side developer tools (legacy host path)

Everything the Jet needs at runtime now runs on the Jet (`device/jet-app`): the voice loop and
the vision look talk to the inference server from the device over WiFi (`llm.base`), and jetd
draws for jet-app. Nothing in this directory is required for the glasses to work. These are
tools for developing against the Jet from a Mac and for measuring the server:

| tool | what it is |
|---|---|
| `jet-hub.js` | the hub: jetd protocol client/acceptor on 7777 plus an HTTP control API on 7778 (`/screen`, `/snapshot`, `/look`, `/listen`, `/say`, `/converse`, `/log`, ...); `--look`, `--ptt`, `--live`. Draws only while no jet-app holds the surface (`E`) |
| `vision.js` | the VLM call the hub's `/look` uses (`LLM_BASE`, `enable_thinking: false`) |
| `voice-session.js`, `voice-client.js`, `test/` | **the retired host voice path**: the WebSocket session jet-app's `voice` module used to stream a turn through before the loop moved on-device (ASR / chat / TTS on the Mac with ffmpeg for the resample). `voice-client.js` drives a turn from a wav file and prints every stage timing, which is still the easiest way to measure the server's ASR/LLM/TTS latencies from a Mac |
| `listen.sh`, `say.sh`, `converse.sh`, `look.sh`, `look-android.sh` | ssh-based CLI equivalents (arecord/aplay over ssh; the oldest path) |

Environment: `LLM_BASE` (OpenAI-compatible base URL), `LLM_ASR_MODEL`, `LLM_TTS_MODEL`,
`LLM_TTS_VOICE`, `LLM_CHAT_MODEL` / `VOICE_CHAT_MODEL`, `LLM_VISION_MODEL`; `HUB_JET_PORT`,
`HUB_HTTP_PORT`, `VOICE_PORT`. `npm install` here for `ws` (voice-session only); `npm test`.

The device-side equivalents are `device/jet-app/src/modules/llm/` (server calls) and
`src/modules/voice/` (the session and state machine); see `docs/jet-app.md` and `docs/audio.md`.
