#!/usr/bin/env node
// jet-hub — host side of the Jet agent protocol (see agent/jetd.c).
//
//   node host/jet-hub.js            # TCP :7777 for jetd, HTTP :7778 for control
//
// HTTP control API (JSON):
//   POST /screen   {"lines":["..",".."], "center":true, "color":[r,g,b], "clear":true}
//   POST /raw      {"cmds":["C","T 0 hello","F"]}
//   POST /mode     {"mode":"remote"|"log"|"shell"|"setup"}
//   POST /console  {"text":"ls -l\n"}          (typed into the Jet's local shell)
//   POST /snapshot [{"w":640,"h":480}]           -> image/jpeg of one camera frame (needs ffmpeg)
//   GET  /snapshot.jpg | /snapshot.uyvy           last frame
//   GET  /glance                                 last glance event {worn, raw}
//   POST /listen {maxSeconds}                   record on the Jet until silence -> {text}
//   POST /say {text}                            TTS -> Jet speaker
//   --live: a look on every gyro new-view event (rate-limited to one per 8 s)
//   POST /converse {maxSeconds}                 one voice turn (listen, LLM, say); --ptt binds it to the front click
//   POST /look [{"question":"..."}]              snapshot -> local vision model -> answer on the glass
// `node host/jet-hub.js jet.local --look` also runs a look on every FRONT button press.
//   GET  /state    -> {connected, hello, mode, keys:[...recent], motion:[...recent]}
//   GET  /log      -> kernel log lines streamed by the Jet (text)
// The last /screen is re-sent whenever the Jet says hello again (it does so each time
// its remote mode is (re)entered).
// Key events from the Jet are logged and kept in a ring buffer; a listener can be
// attached via onKey() when this module is required instead of run.

const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const state = { conn: null, hello: null, keys: [], motion: [], mode: 'remote', lastScreen: null, log: [], frame: null, frameWaiters: [], lastError: null };
const keyListeners = [];

function send(cmds) {
  if (!state.conn) return false;
  state.conn.write(cmds.map((c) => c + '\n').join(''));
  return true;
}

// Word-wrap lines to the Jet's column count and push a full screen.
function screen({ lines = [], center = false, color = [255, 255, 255], clear = true }) {
  const cols = state.hello ? state.hello.cols : 26;
  const rows = state.hello ? state.hello.rows : 7;
  const wrapped = [];
  for (const line of lines) {
    const words = String(line).split(/\s+/);
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > cols) { wrapped.push(cur.trim()); cur = w; }
      else cur = (cur + ' ' + w).trim();
    }
    wrapped.push(cur);
  }
  state.lastScreen = { lines, center, color, clear };
  const cmds = [];
  if (clear) cmds.push('C');
  cmds.push(`R ${color.join(' ')}`);
  wrapped.slice(0, rows).forEach((l, i) => cmds.push(`${center ? 'A' : 'T'} ${i} ${l}`));
  cmds.push('F');
  return send(cmds);
}

function attach(sock) {
  console.log(`[hub] jet connected from ${sock.remoteAddress}`);
  state.conn = sock;
  let buf = Buffer.alloc(0);
  let pending = null;   // { w, h, fmt, len } while a binary frame is being received
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (pending) {
        if (buf.length < pending.len) return;
        const data = buf.subarray(0, pending.len); buf = buf.subarray(pending.len);
        if (pending.kind === 'a') { if (state.capture) state.capture.chunks.push(Buffer.from(data)); pending = null; continue; }
        state.frame = { ...pending, data, t: Date.now() }; pending = null;
        console.log(`[hub] frame ${state.frame.w}x${state.frame.h} ${state.frame.len} bytes`);
        state.frameWaiters.splice(0).forEach((f) => f(state.frame));
        continue;
      }
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString('latin1'); buf = buf.subarray(nl + 1);
      const [t, ...a] = line.split(' ');
      if (t === 'f') { pending = { kind: 'f', w: +a[0], h: +a[1], fmt: a[2], len: +a[3] }; continue; }
      if (t === 'a') { pending = { kind: 'a', len: +a[0] }; continue; }
      if (t === 'A') { const c = state.capture; state.capture = null; if (c) c.done(a[0]); continue; }
      if (t === 'w') { const w = state.playWaiters.splice(0); w.forEach((f) => f(a[0])); continue; }
      if (t === 'e') { state.lastError = a.join(' '); console.log('[hub] jet error:', state.lastError); state.frameWaiters.splice(0).forEach((f) => f(null)); continue; }
      if (t === 'h') {
        state.hello = { w: +a[0], h: +a[1], cols: +a[2], rows: +a[3] }; console.log('[hub] hello', state.hello);
        if (state.lastScreen) { const ls = state.lastScreen; setImmediate(() => screen(ls)); }
      }
      else if (t === 'm') { state.mode = a[0]; console.log('[hub] mode', state.mode); }
      else if (t === 'j') { state.log.push(line.slice(2)); if (state.log.length > 1000) state.log.shift(); }
      else if (t === 'r') { const ev = { dx: +a[0], dy: +a[1], t: Date.now() }; state.motion.push(ev); if (state.motion.length > 50) state.motion.shift(); console.log('[hub] motion', ev); }
      else if (t === 'k') { const ev = { code: +a[0], value: +a[1], t: Date.now() }; state.keys.push(ev); if (state.keys.length > 50) state.keys.shift(); console.log('[hub] key', ev); keyListeners.forEach((f) => f(ev)); }
      else if (t === 'g') { state.glance = { worn: +a[0], raw: +a[1], t: Date.now() }; console.log('[hub] glance', state.glance); glanceListeners.forEach((f) => f(state.glance)); }
      else if (t === 'n') { state.view = { degrees: +a[0], t: Date.now() }; console.log('[hub] new view', state.view); viewListeners.forEach((f) => f(state.view)); }
      else if (t === 'p') console.log('[hub] pong');
    }
  });
  sock.on('close', () => { console.log('[hub] jet disconnected'); if (state.conn === sock) state.conn = null; });
  sock.on('error', () => {});
}

state.capture = null; state.playWaiters = [];   // voice: in-flight capture { chunks, done }, playback end waiters
const viewListeners = [];     // (ev) => void, ev = { degrees, t } from the gyro new-view detector
const glanceListeners = [];   // (ev) => void, ev = { worn, raw, t }
const tcp = net.createServer(attach);

// Optional dial-out: `node host/jet-hub.js jet.local` keeps a connection to a jetd that listens
// (the Jet's USB address is stable, the Mac's is leased). Reconnects every 3 s while absent.
function dial(host, port = 7777) {
  const tryOnce = () => {
    if (state.conn) return;
    const s = net.connect(port, host);
    s.once('connect', () => attach(s));
    s.once('error', () => {});
  };
  tryOnce(); setInterval(tryOnce, 3000);
}

const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === 'GET' && req.url === '/log') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(state.log.join('\n') + '\n'); }
      if (req.method === 'GET' && req.url === '/snapshot.uyvy') { if (!state.frame) return reply(404, { error: 'no frame yet' }); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Frame': `${state.frame.w}x${state.frame.h} UYVY` }); return res.end(state.frame.data); }
      if (req.method === 'GET' && req.url === '/snapshot.jpg') { if (!state.frame) return reply(404, { error: 'no frame yet' }); return toJpeg(state.frame).then((j) => { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(j); }).catch((e) => reply(500, { error: String(e) })); }
      if (req.method === 'POST' && req.url === '/look') { const j = body ? JSON.parse(body) : {}; return look(j.question).then((answer) => reply(200, { answer })).catch((e) => reply(500, { error: String(e.message || e) })); }
      if (req.method === 'GET' && req.url === '/glance') return reply(200, state.glance || { worn: -1, raw: -1 });
      if (req.method === 'POST' && req.url === '/listen') { const j = body ? JSON.parse(body) : {}; return listen({ maxSeconds: j.maxSeconds || 8 }).then((r) => reply(200, { text: r.text, seconds: r.seconds, reason: r.reason })).catch((e) => reply(500, { error: String(e.message || e) })); }
      if (req.method === 'POST' && req.url === '/say') { const j = body ? JSON.parse(body) : {}; return say(String(j.text || '')).then((r) => reply(200, { played: r })).catch((e) => reply(500, { error: String(e.message || e) })); }
      if (req.method === 'POST' && req.url === '/converse') { const j = body ? JSON.parse(body) : {}; return converse({ maxSeconds: j.maxSeconds || 8 }).then((r) => reply(200, r)).catch((e) => reply(500, { error: String(e.message || e) })); }
      if (req.method === 'POST' && req.url === '/snapshot') {
        const j = body ? JSON.parse(body) : {};
        return snapshot(j).then((fr) => { if (!fr) return reply(504, { error: state.lastError || 'no frame' }); return toJpeg(fr).then((jp) => { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'X-Frame': `${fr.w}x${fr.h}` }); res.end(jp); }); }).catch((e) => reply(500, { error: String(e) }));
      }
      if (req.method === 'GET' && req.url === '/state') return reply(200, { connected: !!state.conn, hello: state.hello, mode: state.mode, keys: state.keys.slice(-10), motion: state.motion.slice(-10) });
      const j = body ? JSON.parse(body) : {};
      if (req.method === 'POST' && req.url === '/screen') return reply(200, { ok: screen(j) });
      if (req.method === 'POST' && req.url === '/raw') return reply(200, { ok: send(j.cmds || []) });
      if (req.method === 'POST' && req.url === '/mode') return reply(200, { ok: send([`M ${j.mode || 'remote'}`]) });
      if (req.method === 'POST' && req.url === '/console') return reply(200, { ok: send([`I ${String(j.text || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}`]) });
      reply(404, { error: 'no such route' });
    } catch (e) { reply(400, { error: String(e) }); }
  });
});

function onKey(f) { keyListeners.push(f); }

// Ask the Jet for a frame; resolves with the frame object (or null on error/timeout).
function snapshot({ w = 640, h = 480, skip = 6, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!send([`S ${w} ${h} ${skip}`])) return resolve(null);
    const timer = setTimeout(() => { const i = state.frameWaiters.indexOf(done); if (i >= 0) state.frameWaiters.splice(i, 1); resolve(null); }, timeoutMs);
    const done = (fr) => { clearTimeout(timer); resolve(fr); };
    state.frameWaiters.push(done);
  });
}

// One look: snapshot, ask the local vision model, show the answer. Serialised; returns the answer.
let looking = null;
function look(question = 'Describe what you see in one short sentence. If there is readable text, quote it.') {
  if (looking) return looking;
  const fs = require('fs'), os = require('os'), path = require('path');
  const { askLocal } = require('./vision.js');
  const t0 = Date.now();
  looking = (async () => {
    screen({ lines: ['', 'looking...'], center: true, color: [255, 200, 0] });
    const fr = await snapshot({ skip: 8 });
    if (!fr) { screen({ lines: ['', 'camera: no frame', state.lastError || ''], center: true, color: [255, 80, 80] }); throw new Error(state.lastError || 'no frame'); }
    const jpg = await toJpeg(fr);
    const file = path.join(os.tmpdir(), `jet-look-${Date.now()}.jpg`); fs.writeFileSync(file, jpg);
    let answer;
    try { answer = await askLocal(file, question); } finally { fs.unlink(file, () => {}); }
    screen({ lines: answer.split(/\n+/).filter(Boolean), center: false, color: [255, 255, 255] });
    console.log(`[hub] look ${Date.now() - t0} ms: ${answer}`);
    return answer;
  })().finally(() => { looking = null; });
  return looking;
}

// ---- voice: listen (jetd V/a/A), speak (W/w), one conversational turn -------------------------
const LLM = { base: process.env.LLM_BASE || '',   // OpenAI-compatible base URL (required for voice); see docs/networking.md
   asr: process.env.LLM_ASR_MODEL || 'qwen3-asr', tts: process.env.LLM_TTS_MODEL || 'kokoro', voice: process.env.LLM_TTS_VOICE || 'af_heart', chat: process.env.LLM_CHAT_MODEL || 'qwen-27b' };
const httpsAgent = new (require('https').Agent)({ rejectUnauthorized: process.env.LLM_INSECURE_TLS ? false : undefined });   // LLM_INSECURE_TLS=1 for a private CA
function llmRequest(path, { headers = {}, body, raw = false }) {
  const https = require('https');
  if (!LLM.base) return Promise.reject(new Error('LLM_BASE is not set (OpenAI-compatible base URL)'));
  return new Promise((resolve, reject) => {
    const u = new URL(`${LLM.base}${path}`);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST', headers, agent: httpsAgent }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c));
      res.on('end', () => { const b = Buffer.concat(parts); if (res.statusCode !== 200) return reject(new Error(`${path}: ${res.statusCode} ${b.toString().slice(0, 200)}`)); resolve(raw ? b : JSON.parse(b.toString())); });
    });
    req.on('error', reject); req.end(body);
  });
}
function wavHeader(dataLen, rate, channels, bits) {
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * bits / 8, 28); h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34); h.write('data', 36); h.writeUInt32LE(dataLen, 40); return h;
}
// Record on the Jet until silence/max; resolves { pcm (16 kHz mono S16), seconds, reason }.
function listenRaw({ maxSeconds = 8 } = {}) {
  return new Promise((resolve, reject) => {
    if (state.capture) return reject(new Error('capture busy'));
    const chunks = [];
    const timer = setTimeout(() => { if (state.capture && state.capture.chunks === chunks) { state.capture = null; send(['v']); finish('timeout'); } }, (maxSeconds + 3) * 1000);
    const finish = (reason) => { clearTimeout(timer); const pcm = Buffer.concat(chunks); resolve({ pcm, seconds: pcm.length / 32000, reason }); };
    state.capture = { chunks, done: finish };
    if (!send([`V ${maxSeconds}`])) { state.capture = null; clearTimeout(timer); reject(new Error('jet not connected')); }
  });
}
async function transcribe(pcm) {
  if (pcm.length < 3200) return '';
  const boundary = '----jet' + Date.now();
  const wav = Buffer.concat([wavHeader(pcm.length, 16000, 1, 16), pcm]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${LLM.asr}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="jet.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await llmRequest('/audio/transcriptions', { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }, body });
  return (r.text || '').trim();
}
async function listen(opts) { const r = await listenRaw(opts); const text = await transcribe(r.pcm); console.log(`[hub] listen ${r.seconds.toFixed(1)} s (${r.reason}): ${text}`); return { ...r, text }; }
// Text -> TTS -> 48 kHz stereo S16 raw (ffmpeg) -> jetd speaker. Resolves when the Jet reports the clip played.
async function say(text) {
  const t0 = Date.now();
  const wav = await llmRequest('/audio/speech', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: LLM.tts, input: text, voice: LLM.voice, response_format: 'wav' }), raw: true });
  const pcm = await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '2', '-ar', '48000', 'pipe:1']);
    const out = []; ff.stdout.on('data', (d) => out.push(d)); ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exit ${code}`))));
    ff.stdin.end(wav);
  });
  const done = new Promise((resolve) => state.playWaiters.push(resolve));
  const CH = 48000;   // 0.25 s per chunk
  for (let o = 0; o < pcm.length; o += CH) { const c = pcm.subarray(o, Math.min(o + CH, pcm.length)); if (!state.conn) throw new Error('jet not connected'); state.conn.write(`W ${c.length}\n`); state.conn.write(c); }
  send(['w']);
  const r = await Promise.race([done, new Promise((res) => setTimeout(() => res('timeout'), pcm.length / 192000 * 1000 + 10000))]);
  console.log(`[hub] say ${(pcm.length / 192000).toFixed(1)} s audio, ${Date.now() - t0} ms total (${r})`);
  return r;
}
async function chat(question) {
  const r = await llmRequest('/chat/completions', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: LLM.chat, max_tokens: 120, chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: 'system', content: 'You are a voice assistant on a pair of smart glasses. Answer in one or two short spoken sentences.' }, { role: 'user', content: question }] }) });
  return r.choices[0].message.content.trim();
}
// One turn: listen -> chat -> say, with the transcript and answer on the glass. Serialised.
let conversing = null;
function converse({ maxSeconds = 8 } = {}) {
  if (conversing) return conversing;
  conversing = (async () => {
    screen({ lines: ['', 'listening...'], center: true, color: [0, 255, 128] });
    const heard = await listen({ maxSeconds });
    if (!heard.text) { screen({ lines: ['', '(nothing heard)'], center: true, color: [255, 200, 0] }); return { heard: '', answer: '' }; }
    screen({ lines: ['you:', ...heard.text.match(/.{1,42}(\s|$)/g), '', 'thinking...'], color: [200, 200, 200] });
    const answer = await chat(heard.text);
    screen({ lines: answer.match(/.{1,42}(\s|$)/g) || [answer], color: [255, 255, 255] });
    await say(answer);
    return { heard: heard.text, answer };
  })().finally(() => { conversing = null; });
  return conversing;
}

// UYVY -> JPEG via ffmpeg (on the host).
function toJpeg(frame) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'uyvy422', '-s', `${frame.w}x${frame.h}`, '-i', 'pipe:0', '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1']);
    const out = []; ff.stdout.on('data', (c) => out.push(c)); ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exit ${code}`))));
    ff.stdin.end(frame.data);
  });
}

if (require.main === module) {
  const JPORT = +(process.env.HUB_JET_PORT || 7777), HPORT = +(process.env.HUB_HTTP_PORT || 7778);
  tcp.listen(JPORT, () => console.log(`[hub] jetd port ${JPORT}`));
  const dialHost = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (dialHost) dial(dialHost);
  if (process.argv.includes('--look')) onKey((ev) => { if (ev.code === 86 && ev.value === 1 && state.mode === 'remote') look().catch(() => {}); });
  if (process.argv.includes('--live')) { let last = 0; viewListeners.push(() => { if (state.mode === 'remote' && Date.now() - last > 8000) { last = Date.now(); look().catch(() => {}); } }); }   // describe whenever the head settles on a new view
  if (process.argv.includes('--ptt')) onKey((ev) => { if (ev.code === 86 && ev.value === 1 && state.mode === 'remote') converse().catch((e) => console.log('[hub] converse:', e.message)); });   // front click = one voice turn
  api.listen(HPORT, () => console.log(`[hub] control http://localhost:${HPORT}`));
}

module.exports = { send, screen, onKey, dial, snapshot, toJpeg, look, listen, say, converse, state, tcp, api };
