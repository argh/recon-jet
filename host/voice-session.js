#!/usr/bin/env node
// voice-session — streaming push-to-talk turns for the Jet over a WebSocket.
//
//   LLM_BASE=https://... node host/voice-session.js        # ws://0.0.0.0:7779 (VOICE_PORT)
//
// One client, one turn at a time. Text frames are JSON control/events, binary frames are audio.
//
// client -> server
//   {type:"start", turn?}      begin a turn; `turn` (any id) is echoed on every event of that turn
//   <binary>                   16 kHz mono S16 capture chunks
//   {type:"end"}               capture finished: transcribe, answer, speak
//   {type:"cancel"}            abort everything in flight (barge-in)
//   {type:"say", text}         synthesise `text` only (audio frames, then done); not during a turn
//   {type:"look", jpeg, question}  ask the vision model about a base64 JPEG (tokens, then done
//                              with the answer; no audio); not during a turn
// server -> client
//   {type:"partial", text}     transcript so far (about once a second while listening)
//   {type:"final", text}       the transcript the answer is based on
//   {type:"token", text}       answer text as the model streams it
//   {type:"audio", bytes, sentence} + <binary>   one spoken sentence, 48 kHz stereo S16 raw
//   {type:"done", answer}      the turn (or say) is complete
//   {type:"error", message}
//
// Env: LLM_BASE (required, OpenAI-compatible base URL), LLM_ASR_MODEL (qwen3-asr), LLM_TTS_MODEL
// (kokoro), LLM_TTS_VOICE (af_heart), VOICE_CHAT_MODEL (qwen-27b), LLM_VISION_MODEL (qwen-vision),
// LLM_INSECURE_TLS=1 (private CA),
// VOICE_PARTIAL_MS (1000), VOICE_PARTIAL_WINDOW_S (10: partials transcribe the last N seconds).
// Stage timings go to stdout as JSON lines.

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const SYSTEM_PROMPT = 'You are a voice assistant on a pair of smart glasses. Reply as spoken words: one to three short plain sentences, no lists, no markdown, no preamble.';

function log(fields) { process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...fields }) + '\n'); }
const ms = (t0) => Math.round(performance.now() - t0);

// ---- sentence splitter -------------------------------------------------------------------
// Feeds streamed tokens; emits a sentence at ". ", "! ", "? " (closing quotes allowed) or a
// newline. A boundary inside the first `minChars` characters is skipped ("No. 5 is fine."), and
// "3.5" never splits because the dot is not followed by whitespace. `flush()` returns the rest.
class SentenceSplitter {
  constructor({ minChars = 12 } = {}) { this.buf = ''; this.minChars = minChars; }
  /** @param {string} text @returns {string[]} complete sentences */
  push(text) {
    this.buf += text;
    const out = [];
    const re = /[.!?…]+["')\]]*(?=\s)|\n+/g;
    let start = 0, m;
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length;
      const s = this.buf.slice(start, end).trim();
      if (s.length < this.minChars && !m[0].includes('\n')) continue;
      if (s) out.push(s);
      start = end;
    }
    this.buf = this.buf.slice(start);
    return out;
  }
  /** @returns {string|null} whatever is left */
  flush() { const s = this.buf.trim(); this.buf = ''; return s || null; }
}

// ---- upstream: OpenAI-compatible ASR / chat / TTS + ffmpeg --------------------------------
function wavHeader(dataLen, rate, channels, bits) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * bits / 8, 28); h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

/** Parse SSE text into the JSON payloads of `data:` lines; `[DONE]` ends the stream. Stateful across chunks. */
class SseParser {
  constructor() { this.buf = ''; this.done = false; }
  /** @returns {object[]} */
  feed(chunk) {
    this.buf += chunk;
    const out = [];
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, ''); this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { this.done = true; break; }
      try { out.push(JSON.parse(data)); } catch { /* keep-alive or partial garbage: skip */ }
    }
    return out;
  }
}

function realUpstream(env = process.env) {
  const base = env.LLM_BASE || '';
  const models = { asr: env.LLM_ASR_MODEL || 'qwen3-asr', tts: env.LLM_TTS_MODEL || 'kokoro', voice: env.LLM_TTS_VOICE || 'af_heart', chat: env.VOICE_CHAT_MODEL || env.LLM_CHAT_MODEL || 'qwen-27b', vision: env.LLM_VISION_MODEL || 'qwen-vision' };
  const agent = base.startsWith('https') ? new https.Agent({ rejectUnauthorized: env.LLM_INSECURE_TLS ? false : undefined, keepAlive: true }) : new http.Agent({ keepAlive: true });

  /** POST; `onChunk` streams the body as text, otherwise the whole body is resolved as a Buffer. */
  function request(path, { headers = {}, body, signal, onChunk }) {
    return new Promise((resolve, reject) => {
      const u = new URL(base + path);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'POST', headers: { 'Content-Length': body.length, ...headers }, agent, signal }, (res) => {
        const parts = [];
        res.on('data', (c) => (onChunk && res.statusCode === 200 ? onChunk(c.toString()) : parts.push(c)));
        res.on('end', () => {
          const b = Buffer.concat(parts);
          if (res.statusCode !== 200) return reject(new Error(`${path}: ${res.statusCode} ${b.toString().slice(0, 200)}`));
          resolve(b);
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  return {
    models,
    /** 16 kHz mono S16 -> text */
    async transcribe(pcm, signal) {
      if (pcm.length < 3200) return '';   // under 100 ms: nothing to hear
      const boundary = '----jet' + Date.now();
      const wav = Buffer.concat([wavHeader(pcm.length, 16000, 1, 16), pcm]);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${models.asr}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="jet.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
        wav, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const r = JSON.parse((await request('/audio/transcriptions', { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, signal })).toString());
      return (r.text || '').trim();
    },
    /** Streams the answer through `onToken`; resolves with the whole text. */
    async chat(messages, { signal, onToken, model = models.chat, maxTokens = 200 }) {
      const sse = new SseParser();
      let text = '';
      const body = JSON.stringify({ model, stream: true, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false }, messages });
      await request('/chat/completions', { headers: { 'Content-Type': 'application/json' }, body, signal, onChunk: (chunk) => {
        for (const ev of sse.feed(chunk)) {
          const tok = ev.choices?.[0]?.delta?.content;
          if (tok) { text += tok; onToken(tok); }
        }
      } });
      return text;
    },
    /** A JPEG (base64) and a question -> the vision model's answer, streamed through `onToken` (as host/vision.js does it). */
    look(jpegBase64, question, { signal, onToken }) {
      const content = [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } }];
      return this.chat([{ role: 'user', content }], { signal, onToken, model: models.vision, maxTokens: 150 });
    },
    /** Text -> TTS wav -> 48 kHz stereo S16 raw (ffmpeg). Resolves `{pcm, ttsMs, ffmpegMs}`. */
    async speak(text, signal) {
      const t0 = performance.now();
      const wav = await request('/audio/speech', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: models.tts, input: text, voice: models.voice, response_format: 'wav' }), signal });
      const ttsMs = ms(t0), t1 = performance.now();
      const pcm = await toPcm48kStereo(wav, signal);
      return { pcm, ttsMs, ffmpegMs: ms(t1) };
    },
  };
}

function toPcm48kStereo(wav, signal) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '2', '-ar', '48000', 'pipe:1']);
    const out = [];
    const onAbort = () => ff.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    ff.stdout.on('data', (d) => out.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => { signal?.removeEventListener('abort', onAbort); code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(signal?.aborted ? 'cancelled' : `ffmpeg exit ${code}`)); });
    ff.stdin.on('error', () => {});
    ff.stdin.end(wav);
  });
}

// ---- one connection: turns and says ----------------------------------------------------------
class Connection {
  constructor(ws, upstream, { partialMs = 1000, partialWindowS = 10 } = {}) {
    this.ws = ws; this.up = upstream; this.partialMs = partialMs; this.partialWindowS = partialWindowS;
    this.job = null;   // { kind: 'turn'|'say', abort, turn, chunks, ... }
    ws.on('message', (data, isBinary) => (isBinary ? this.#audio(data) : this.#control(data)));
    ws.on('close', () => this.#cancel('closed'));
    ws.on('error', () => {});
  }

  #emit(obj) { if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(this.job?.turn !== undefined ? { ...obj, turn: this.job.turn } : obj)); }
  #emitAudio(pcm, sentence) { this.#emit({ type: 'audio', bytes: pcm.length, sentence }); if (this.ws.readyState === this.ws.OPEN) this.ws.send(pcm, { binary: true }); }
  #error(message) { log({ stage: 'error', message }); this.#emit({ type: 'error', message }); }

  #control(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return this.#error('bad json'); }
    switch (msg.type) {
      case 'start': return this.#start(msg);
      case 'end': return this.#end();
      case 'cancel': return this.#cancel('cancel');
      case 'say': return this.#say(msg);
      case 'look': return this.#look(msg);
      default: return this.#error(`unknown type ${msg.type}`);
    }
  }

  #audio(data) {
    const j = this.job;
    if (!j || j.kind !== 'turn' || j.state !== 'listening') return;
    j.chunks.push(Buffer.from(data)); j.bytes += data.length;
  }

  #start(msg) {
    this.#cancel('restart');
    const j = this.job = { kind: 'turn', turn: msg.turn, state: 'listening', chunks: [], bytes: 0, abort: new AbortController(), t0: performance.now(), transcribing: false, partials: 0 };
    log({ stage: 'start', turn: j.turn });
    j.partialTimer = setInterval(() => this.#partial(j), this.partialMs);
  }

  async #partial(j) {
    if (j.transcribing || j.bytes < 3200) return;
    const window = this.partialWindowS * 32000;
    const pcm = Buffer.concat(j.chunks);
    const slice = pcm.length > window ? pcm.subarray(pcm.length - window) : pcm;
    j.transcribing = true;
    const t0 = performance.now();
    try {
      const text = await this.up.transcribe(slice, j.abort.signal);
      if (this.job !== j || j.state !== 'listening') return;
      j.partials++;
      log({ stage: 'partial', ms: ms(t0), seconds: +(slice.length / 32000).toFixed(2), chars: text.length });
      this.#emit({ type: 'partial', text });
    } catch (e) { if (this.job === j && !j.abort.signal.aborted) log({ stage: 'partial-error', message: e.message }); }
    finally { j.transcribing = false; }
  }

  async #end() {
    const j = this.job;
    if (!j || j.kind !== 'turn' || j.state !== 'listening') return this.#error('end without a turn');
    clearInterval(j.partialTimer); j.state = 'thinking';
    const { signal } = j.abort;
    const tEnd = performance.now();
    try {
      const pcm = Buffer.concat(j.chunks);
      const t0 = performance.now();
      const text = await this.up.transcribe(pcm, signal);
      if (signal.aborted) return;
      log({ stage: 'final', ms: ms(t0), seconds: +(pcm.length / 32000).toFixed(2), partials: j.partials, text });
      this.#emit({ type: 'final', text });
      if (!text) { log({ stage: 'turn', ms: ms(j.t0), answer: '' }); this.#emit({ type: 'done', answer: '' }); this.job = null; return; }

      // answer: stream tokens; synthesise each sentence in order while the model is still talking
      const splitter = new SentenceSplitter();
      const queue = []; let firstToken = null, firstAudio = null, sentences = 0;
      let drain = Promise.resolve();
      const speakQueued = () => { drain = drain.then(async () => {
        while (queue.length && !signal.aborted) {
          const sentence = queue.shift();
          const t = performance.now();
          const { pcm, ttsMs, ffmpegMs } = await this.up.speak(sentence, signal);
          if (signal.aborted) return;
          sentences++;
          firstAudio ??= ms(tEnd);
          log({ stage: 'tts', ms: ms(t), ttsMs, ffmpegMs, bytes: pcm.length, audioS: +(pcm.length / 192000).toFixed(2), sentence });
          this.#emitAudio(pcm, sentence);
        }
      }).catch((e) => { if (!signal.aborted) this.#error(`tts: ${e.message}`); }); };
      const tChat = performance.now();
      let tokens = 0;
      const answer = await this.up.chat([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }], { signal, onToken: (tok) => {
        tokens++; firstToken ??= ms(tChat);
        this.#emit({ type: 'token', text: tok });
        const ready = splitter.push(tok);
        if (ready.length) { queue.push(...ready); speakQueued(); }
      } });
      if (signal.aborted) return;
      log({ stage: 'llm', ms: ms(tChat), firstTokenMs: firstToken, tokens, chars: answer.length });
      const rest = splitter.flush();
      if (rest) { queue.push(rest); speakQueued(); }
      await drain;
      if (signal.aborted) return;
      log({ stage: 'turn', ms: ms(j.t0), sinceEndMs: ms(tEnd), firstAudioMs: firstAudio, sentences, answer });
      this.#emit({ type: 'done', answer });
    } catch (e) {
      if (!signal.aborted) this.#error(e.message);
    } finally { if (this.job === j) this.job = null; }
  }

  async #say(msg) {
    if (this.job) return this.#error('busy');
    const j = this.job = { kind: 'say', turn: msg.turn, abort: new AbortController() };
    const t0 = performance.now();
    try {
      const { pcm, ttsMs, ffmpegMs } = await this.up.speak(String(msg.text || ''), j.abort.signal);
      if (j.abort.signal.aborted) return;
      log({ stage: 'say', ms: ms(t0), ttsMs, ffmpegMs, bytes: pcm.length, text: msg.text });
      this.#emitAudio(pcm, msg.text);
      this.#emit({ type: 'done', answer: msg.text });
    } catch (e) { if (!j.abort.signal.aborted) this.#error(`say: ${e.message}`); }
    finally { if (this.job === j) this.job = null; }
  }

  async #look(msg) {
    if (this.job) return this.#error('busy');
    if (typeof msg.jpeg !== 'string' || !msg.jpeg) return this.#error('look needs a base64 jpeg');
    const j = this.job = { kind: 'look', turn: msg.turn, abort: new AbortController() };
    const t0 = performance.now();
    let tokens = 0;
    try {
      const answer = await this.up.look(msg.jpeg, String(msg.question || 'Describe what is in this image in one short sentence.'), { signal: j.abort.signal, onToken: (tok) => { tokens++; this.#emit({ type: 'token', text: tok }); } });
      if (j.abort.signal.aborted) return;
      log({ stage: 'look', ms: ms(t0), jpegBytes: Math.round(msg.jpeg.length * 3 / 4), tokens, answer });
      this.#emit({ type: 'done', answer });
    } catch (e) { if (!j.abort.signal.aborted) this.#error(`look: ${e.message}`); }
    finally { if (this.job === j) this.job = null; }
  }

  #cancel(why) {
    const j = this.job;
    if (!j) return;
    clearInterval(j.partialTimer);
    j.abort.abort();
    this.job = null;
    log({ stage: 'cancel', why, turn: j.turn, ms: j.t0 ? ms(j.t0) : undefined });
  }
}

/** @returns {WebSocketServer} */
function createVoiceServer({ port = 0, host = '0.0.0.0', upstream, partialMs, partialWindowS } = {}) {
  const wss = new WebSocketServer({ port, host });
  wss.on('connection', (ws, req) => {
    log({ stage: 'connect', peer: req.socket.remoteAddress });
    new Connection(ws, upstream, { partialMs, partialWindowS });   // eslint-disable-line no-new
  });
  return wss;
}

if (require.main === module) {
  if (!process.env.LLM_BASE) { console.error('voice-session: LLM_BASE is not set (OpenAI-compatible base URL)'); process.exit(1); }
  const upstream = realUpstream();
  const port = +(process.env.VOICE_PORT || 7779);
  const wss = createVoiceServer({ port, upstream, partialMs: +(process.env.VOICE_PARTIAL_MS || 1000), partialWindowS: +(process.env.VOICE_PARTIAL_WINDOW_S || 10) });
  wss.on('listening', () => log({ stage: 'listening', port, models: upstream.models }));
  wss.on('error', (e) => { console.error(`voice-session: ${e.message}`); process.exit(1); });
}

module.exports = { SentenceSplitter, SseParser, wavHeader, realUpstream, createVoiceServer, toPcm48kStereo };
