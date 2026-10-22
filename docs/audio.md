# Audio reference

No twl6040 and no ABE codec on the Jet: the OMAP4 McBSP2 and DMIC blocks are used directly with
a `simple-audio-card`.

## ALSA card layout (card 0 "Jet", modules on userdata, loaded by init)

| Device | DAI link | Hardware | Format |
|---|---|---|---|
| `hw:0,0` playback | McBSP2 (bit/frame master, I2S) -> NXP TFA9895 (`snd-soc-tfa989x`, i2c3 0x34) | speaker | **48 kHz, 2 channels, S16_LE** |
| `hw:0,1` capture | OMAP DMIC (`snd-soc-omap-dmic`) -> `dmic-codec` | the digital mics | **96 kHz or 192 kHz, S32_LE** only |

Modules: `snd-soc-tfa989x`, `snd-soc-omap-mcbsp`, `snd-soc-dmic`, `snd-soc-omap-dmic`,
`snd-soc-simple-card` (plus `sound`/`snd-pcm` deps) from `/android-data/mainline/modules`.

## Speaker facts

- The TFA9895 wants 32/48/64 fs bit clocks; the stock-free McBSP ran CLKGDV=0 (24.576 MHz bit
  clock, 512 bits/frame) and the amp never locked (PLLS=0/CLKS=0). The overlay `omap-mcbsp.c`
  derives CLKGDV so a frame is wlen x channels bit clocks (16 at 48 kHz stereo S16); amp status
  0xd85f = PLLS+CLKS+SWS+AMPS afterwards.
- **Rule: play 2-channel streams.** A mono stream through `plughw` makes McBSP run a 16-bit frame,
  which the amp does not decode as I2S (silent with PLL locked). Upmix mono TTS to 48 kHz
  stereo S16 on the host (`ffmpeg -f s16le -ar 48000 -ac 2`) and play on `hw:0,0`.
- The amp runs **untuned**: Android loaded NXP's speaker/DSP config with the closed "climax"
  tool; mainline's tfa989x driver is a plain I2S bypass. Loud enough for TTS and alerts.
- Verified: `speaker-test -D hw:0,0 -t sine -f 440`; kokoro TTS clips.

## Microphone facts

- `arecord -D hw:0,1 -c 2 -r 96000 -f S32_LE` gives real audio (speech rms ~-36 dBFS, peaks
  ~-6 dBFS). A benign WARNING from `cpu_latency_qos_remove_request` fires at stream stop.
- Stock V2 looped fref_clk2_out (19.2 MHz) onto the DMIC fclk; mainline simply uses the DMIC
  block's own fck. The overlay `omap-dmic.c` derives the mic clock from it (19.2 MHz -> 2.4 MHz,
  3.84 MHz at 192 kHz; 24.576 MHz -> 3.072 MHz) because no machine driver sets it.
- The host (or jetd) downmixes and decimates 96 kHz stereo S32 to 16 kHz mono S16 for ASR.

## The voice loop

| Piece | Where | Does |
|---|---|---|
| `V`/`a`/`A` | jetd | capture with energy VAD, 16 kHz mono S16 chunks (see jetd.md) |
| `POST /listen {maxSeconds}` | hub | reassembles chunks, builds a WAV in memory, sends to the local LLM server's ASR model (qwen3-asr was used) -> `{text, seconds, reason}` |
| `POST /say {text}` | hub | TTS (kokoro was used; returns 24 kHz mono) -> ffmpeg to 48 kHz stereo S16 -> `W` chunks + `w`; resolves on `w done` |
| `POST /converse` | hub | listen -> chat model -> say, with transcript and answer on the glass; `--ptt` binds it to a front click |
| `host/listen.sh`, `host/say.sh`, `host/converse.sh` | host | CLI equivalents (arecord/aplay over ssh, older path) |
| `host/voice-session.js` + jet-app `voice` | host + device | the streaming turn: capture chunks go to the host over a WebSocket as they arrive, partial transcripts come back every second, the answer streams and each sentence is synthesised and queued to `W` while the model is still talking; `Y` + `cancel` for barge-in (see `docs/jet-app.md`) |

Endpoint and model names come from `LLM_BASE`, `LLM_ASR_MODEL`, `LLM_TTS_MODEL`,
`LLM_TTS_VOICE`, `LLM_CHAT_MODEL` (OpenAI-compatible API).

## Latency numbers (over WiFi, measured)

| Path | Time |
|---|---|
| ASR of 3 s audio | ~0.36 s |
| `/listen` 3.03 s of capture | 3.15 s end to end |
| `/say` 2.6 s of speech | 5.3 s total (TTS + transfer + play) |
| 1 s tone via `W`, `w done` back | 4.2 s (aplay drain latency, unoptimised) |
| Vision look (snapshot ~1 s + VLM ~7 s) | ~8 s |

## Stock-kernel notes (only relevant to the `bridge/` approach)

On the stock ABE kernel the working mic route was `MUX_UL10 DMic0L`, `MUX_UL11 DMic0R`, capture
on pcm device 1 at 48 kHz S16 with period 960; "DMIC1 UL Volume" 149 (max). None of this applies
on mainline.
