#!/usr/bin/env node
// voice-client — drive one turn of host/voice-session.js from a file, printing every event
// with its time since `end` (what the Jet would experience, minus the USB hop).
//
//   node host/voice-client.js question.wav [ws://localhost:7779] [--say "text"] [--out answer.pcm]
//
// The wav must be 16 kHz mono S16 (ffmpeg -i x.wav -ar 16000 -ac 1 -f wav q.wav); it is sent as
// 100 ms chunks in real time, like jetd's `a` stream. --say skips the turn and asks for TTS only.
// --out writes the received answer audio (48 kHz stereo S16 raw: `ffplay -f s16le -ar 48000 -ac 2`).

const fs = require('fs');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const say = opt('--say'), out = opt('--out');
const [file, url = 'ws://localhost:7779'] = args;
if (!file && !say) { console.error('usage: voice-client.js question.wav [ws://host:7779] [--say text] [--out answer.pcm]'); process.exit(2); }

const ws = new WebSocket(url);
const t0 = performance.now();
let tEnd = t0, pending = null, answer = '';
const audio = [];
const stamp = () => `${String(Math.round(performance.now() - tEnd)).padStart(6)} ms`;

ws.on('open', async () => {
  if (say) { ws.send(JSON.stringify({ type: 'say', text: say })); return; }
  const pcm = fs.readFileSync(file).subarray(44);   // past the wav header
  ws.send(JSON.stringify({ type: 'start', turn: 1 }));
  const CH = 3200;   // 100 ms
  for (let o = 0; o < pcm.length; o += CH) { ws.send(pcm.subarray(o, o + CH), { binary: true }); await new Promise((r) => setTimeout(r, 100)); }
  tEnd = performance.now();
  console.log(`sent ${(pcm.length / 32000).toFixed(1)} s of audio; end`);
  ws.send(JSON.stringify({ type: 'end' }));
});
ws.on('message', (data, isBinary) => {
  if (isBinary) { audio.push(Buffer.from(data)); console.log(`${stamp()} audio ${data.length} bytes (${(data.length / 192000).toFixed(2)} s) "${pending?.sentence}"`); pending = null; return; }
  const m = JSON.parse(data.toString());
  if (m.type === 'audio') { pending = m; return; }
  if (m.type === 'token') { answer += m.text; process.stdout.write(answer.length === m.text.length ? `${stamp()} token: ${m.text}` : m.text); return; }
  if (answer) { process.stdout.write('\n'); answer = ''; }
  console.log(`${stamp()} ${m.type}${m.text !== undefined ? `: ${JSON.stringify(m.text)}` : ''}${m.answer !== undefined ? `: ${JSON.stringify(m.answer)}` : ''}${m.message ? `: ${m.message}` : ''}`);
  if (m.type === 'done' || m.type === 'error') {
    if (out) { fs.writeFileSync(out, Buffer.concat(audio)); console.log(`wrote ${out}`); }
    ws.close();
  }
});
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
