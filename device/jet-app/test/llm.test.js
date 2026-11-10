// The llm module's pure parts (wav, multipart, SSE, resampler) and the module itself against a
// fake OpenAI-compatible server on loopback: the multipart upload, reasoning deltas ignored,
// the thinking switches sent, the TTS wav -> 48 kHz stereo, errors, cancel and timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { wavHeader, pcmToWav, parseWav } from '../src/modules/llm/wav.js';
import { multipart } from '../src/modules/llm/multipart.js';
import { SseParser } from '../src/modules/llm/sse.js';
import { toStereo48k, createStereo48kStream } from '../src/modules/llm/resample.js';
import { Llm } from '../src/modules/llm/index.js';

const sine = (hz, rate, frames, amp = 10000) => { const b = Buffer.alloc(frames * 2); for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / rate) * amp), i * 2); return b; };

test('wav: header fields, pcmToWav round trip, chunk walking, overrun data size', () => {
  const h = wavHeader(1000, 16000, 1, 16);
  assert.equal(h.length, 44);
  assert.equal(h.toString('latin1', 0, 4), 'RIFF'); assert.equal(h.readUInt32LE(4), 1036);
  assert.equal(h.readUInt32LE(24), 16000); assert.equal(h.readUInt32LE(28), 32000); assert.equal(h.readUInt16LE(32), 2);
  assert.equal(h.readUInt32LE(40), 1000);
  const pcm = Buffer.from([1, 2, 3, 4]);
  const w = parseWav(pcmToWav(pcm, 24000));
  assert.deepEqual({ rate: w.rate, channels: w.channels, bits: w.bits }, { rate: 24000, channels: 1, bits: 16 });
  assert.deepEqual(w.data, pcm);
  // a LIST chunk (odd size, padded) before data, and a data size of 0xffffffff (streamed writer)
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([5, 0, 0, 0]), Buffer.from('abcde'), Buffer.alloc(1)]);
  const head = wavHeader(0, 24000, 2, 16).subarray(0, 36);
  const data = Buffer.concat([Buffer.from('data'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from([9, 9, 8, 8, 7, 7, 6, 6])]);
  const w2 = parseWav(Buffer.concat([head, list, data]));
  assert.equal(w2.channels, 2); assert.equal(w2.data.length, 8); assert.equal(w2.data[0], 9);
  assert.throws(() => parseWav(Buffer.from('not a wav at all')), /not a wav/);
  assert.throws(() => parseWav(Buffer.concat([wavHeader(0, 8000, 1, 8).subarray(0, 36), Buffer.from('data'), Buffer.alloc(4)])), /8-bit/);
});

test('multipart: fields and a file, boundary in the content type', () => {
  const { body, contentType } = multipart([{ name: 'model', value: 'qwen3-asr' }, { name: 'file', filename: 'jet.wav', type: 'audio/wav', data: Buffer.from('RIFFxx') }], 'B0UND');
  assert.equal(contentType, 'multipart/form-data; boundary=B0UND');
  assert.equal(body.toString(), '--B0UND\r\nContent-Disposition: form-data; name="model"\r\n\r\nqwen3-asr\r\n--B0UND\r\nContent-Disposition: form-data; name="file"; filename="jet.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFFxx\r\n--B0UND--\r\n');
  assert.match(multipart([]).contentType, /boundary=----jet/);
});

test('sse: data lines, comments, [DONE], a JSON object and a UTF-8 character split over chunks', () => {
  const p = new SseParser();
  assert.deepEqual(p.feed('data: {"a":1}\n\ndata: {"a":2}\r\n'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(p.feed('data: {"a"'), []);
  assert.deepEqual(p.feed(':3}\n: keepalive\n'), [{ a: 3 }]);
  const euro = Buffer.from('data: {"t":"€"}\n');
  assert.deepEqual(p.feed(euro.subarray(0, 12)), []);
  assert.deepEqual(p.feed(euro.subarray(12)), [{ t: '€' }]);
  assert.deepEqual(p.feed('data: [DONE]\ndata: {"a":4}\n'), []);
  assert.equal(p.done, true);
});

test('resample: 24 kHz mono -> 48 kHz stereo doubles the frames, keeps the tone, stereo passes through', () => {
  const inFrames = 2400;   // 100 ms
  const out = toStereo48k(sine(1000, 24000, inFrames), { rate: 24000 });
  assert.equal(out.length, inFrames * 2 * 4, '2x frames, 2 channels, 2 bytes');
  let err = 0, crossings = 0, prev = 0;
  for (let i = 0; i < inFrames * 2; i++) {
    const l = out.readInt16LE(i * 4), r = out.readInt16LE(i * 4 + 2);
    assert.equal(l, r);
    if (i < inFrames * 2 - 1) err = Math.max(err, Math.abs(l - Math.sin(2 * Math.PI * 1000 * i / 48000) * 10000));   // the last half-sample holds
    if (i && (l >= 0) !== (prev >= 0)) crossings++;
    prev = l;
  }
  assert.ok(err < 10000 * 0.09, `max error ${err}`);   // linear interpolation of a 1 kHz tone at 24 kHz
  assert.ok(crossings >= 199 && crossings <= 201, `${crossings} zero crossings in 100 ms of 1 kHz`);
  const stereoIn = Buffer.alloc(16); for (let i = 0; i < 4; i++) { stereoIn.writeInt16LE(100 * i, i * 4); stereoIn.writeInt16LE(-100 * i, i * 4 + 2); }
  const st = toStereo48k(stereoIn, { rate: 48000, channels: 2 });
  assert.deepEqual(st, stereoIn, 'same rate stereo is unchanged');
  const up = toStereo48k(Buffer.from([0, 0, 0x10, 0x27]), { rate: 16000 });   // 0 -> 10000 over three output frames, then held
  assert.equal(up.length, 6 * 4); assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => up.readInt16LE(i * 4)), [0, 3333, 6666, 10000, 10000, 10000]);
  assert.equal(toStereo48k(Buffer.alloc(0), { rate: 24000 }).length, 0);
  assert.throws(() => toStereo48k(Buffer.alloc(4), { rate: 24000, channels: 3 }), /3-channel/);
});

test('resample stream: chunked 24k->48k matches the whole-buffer result, no seam clicks or drift', () => {
  const inFrames = 2400;
  const tone = sine(1000, 24000, inFrames);   // 100 ms of 1 kHz, mono 24k
  // feed it in uneven chunks (odd frame counts, including a tiny one) through the stateful resampler
  const stream = createStereo48kStream({ rate: 24000, channels: 1 });
  const parts = [];
  for (let off = 0, n = 0; off < tone.length; n++) {
    const frames = [17, 1, 300, 83, 999][n % 5];            // uneven, and a 1-frame chunk
    const end = Math.min(off + frames * 2, tone.length);
    parts.push(stream(tone.subarray(off, end)));
    off = end;
  }
  const streamed = Buffer.concat(parts);
  // length matches the whole-buffer 2x within the final held sample or two: a causal stream cannot
  // emit a sample that needs a not-yet-arrived input, so the last ~2 output frames (~0.04 ms, at a
  // sentence boundary) are dropped. Constant, not drift (that is the point of feeding uneven chunks).
  assert.ok(streamed.length <= inFrames * 2 * 4 && inFrames * 2 * 4 - streamed.length <= 8, `len ${streamed.length} vs ${inFrames * 2 * 4}`);
  // every seam is continuous: no sample jumps bigger than the whole-buffer resample ever produces
  const whole = toStereo48k(tone, { rate: 24000 });
  let maxStep = 0; for (let i = 1; i < whole.length / 4; i++) maxStep = Math.max(maxStep, Math.abs(whole.readInt16LE(i * 4) - whole.readInt16LE((i - 1) * 4)));
  for (let i = 1; i < streamed.length / 4; i++) {
    assert.equal(streamed.readInt16LE(i * 4), streamed.readInt16LE(i * 4 + 2), 'L==R');
    assert.ok(Math.abs(streamed.readInt16LE(i * 4) - streamed.readInt16LE((i - 1) * 4)) <= maxStep + 1, `seam jump at ${i}`);
  }
  assert.throws(() => createStereo48kStream({ rate: 96000 }), /upsample-only/);
});

/** A fake OpenAI-compatible server; `script` decides each route's reply. */
async function fakeServer(script) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const call = { url: req.url, headers: req.headers, body: Buffer.concat(parts) };
      calls.push(call);
      script(call, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, calls, base: `http://127.0.0.1:${server.address().port}/v1` };
}

function makeLlm(base, overrides = {}) {
  return Object.assign(new Llm(), { base, asrModel: 'asr-m', chatModel: 'chat-m', ttsModel: 'tts-m', ttsVoice: 'v', visionModel: 'vis-m', thinkingKwarg: true, reasoningEffort: 'none', maxTokens: 50, visionMaxTokens: 20, asrTimeoutMs: 2000, chatTimeoutMs: 2000, ttsTimeoutMs: 2000, ...overrides });
}

test('llm: transcribe uploads a wav as multipart; short captures do not hit the server', async (t) => {
  const { server, calls, base } = await fakeServer((call, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: '  hello there \n' })); });
  t.after(() => server.close());
  const llm = makeLlm(base); await llm.start(); t.after(() => llm.stop());
  assert.equal(await llm.transcribe(Buffer.alloc(100)), ''); assert.equal(calls.length, 0, 'under 100 ms: no request');
  const pcm = Buffer.alloc(32000, 3);
  assert.equal(await llm.transcribe(pcm), 'hello there');
  assert.equal(calls[0].url, '/v1/audio/transcriptions');
  const boundary = calls[0].headers['content-type'].match(/boundary=(.+)$/)[1];
  const body = calls[0].body.toString('latin1');
  assert.ok(body.includes(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nasr-m\r\n`));
  const fileAt = body.indexOf('Content-Type: audio/wav\r\n\r\n') + 'Content-Type: audio/wav\r\n\r\n'.length;
  const wav = parseWav(calls[0].body.subarray(fileAt, fileAt + 44 + pcm.length));
  assert.equal(wav.rate, 16000); assert.equal(wav.data.length, pcm.length);
  assert.equal(+calls[0].headers['content-length'], calls[0].body.length);
});

test('llm: chatStream ignores reasoning deltas, sends the thinking switches, resolves with the text', async (t) => {
  const { server, calls, base } = await fakeServer((call, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const ev = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    res.write(ev({ role: 'assistant', content: null }) + ev({ reasoning_content: 'thinking' }) + ev({ reasoning_content: ' hard' }));
    setTimeout(() => { res.write(ev({ content: 'It is ' })); setTimeout(() => res.end(ev({ content: 'noon.' }) + 'data: [DONE]\n\n'), 10); }, 10);
  });
  t.after(() => server.close());
  const llm = makeLlm(base); await llm.start(); t.after(() => llm.stop());
  const tokens = [];
  const text = await llm.chatStream([{ role: 'user', content: 'time?' }], (tok) => tokens.push(tok));
  assert.equal(text, 'It is noon.'); assert.deepEqual(tokens, ['It is ', 'noon.']);
  const req = JSON.parse(calls[0].body.toString());
  assert.equal(calls[0].url, '/v1/chat/completions');
  assert.deepEqual(req, { model: 'chat-m', stream: true, max_tokens: 50, messages: [{ role: 'user', content: 'time?' }], chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none' });
  // both switches off
  llm.thinkingKwarg = false; llm.reasoningEffort = '';
  await llm.chatStream([{ role: 'user', content: 'x' }], () => {});
  const req2 = JSON.parse(calls[1].body.toString());
  assert.ok(!('chat_template_kwargs' in req2) && !('reasoning_effort' in req2));
  // describe: the vision model, the data URI, its own budget
  const answer = await llm.describe(Buffer.from('JPG'), 'what?', () => {});
  assert.equal(answer, 'It is noon.');
  const req3 = JSON.parse(calls[2].body.toString());
  assert.equal(req3.model, 'vis-m'); assert.equal(req3.max_tokens, 20);
  assert.deepEqual(req3.messages[0].content, [{ type: 'text', text: 'what?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,SlBH' } }]);
});

test('llm: speak turns the 24 kHz mono wav into 48 kHz stereo; errors, cancel and timeout', async (t) => {
  let mode = 'ok';
  const { server, calls, base } = await fakeServer((call, res) => {
    if (mode === 'error') { res.statusCode = 503; return res.end('model is loading, please wait a bit'); }
    if (mode === 'hang') return;   // never answers
    res.setHeader('Content-Type', 'audio/wav'); res.end(pcmToWav(sine(440, 24000, 2400), 24000));
  });
  t.after(() => server.close());
  const llm = makeLlm(base, { ttsTimeoutMs: 100 }); await llm.start(); t.after(() => llm.stop());
  const pcm = await llm.speak('hello');
  assert.equal(pcm.length, 4800 * 4);
  assert.equal(JSON.parse(calls[0].body.toString()).model, 'tts-m');
  assert.equal(JSON.parse(calls[0].body.toString()).voice, 'v');
  mode = 'error';
  await assert.rejects(llm.speak('x'), /audio\/speech: 503 model is loading/);
  mode = 'hang';
  const ac = new AbortController();
  const p = llm.speak('x', ac.signal);
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, /cancelled/);
  await assert.rejects(llm.speak('x'), /timeout after 100 ms/);
  const off = makeLlm(''); await off.start();
  assert.equal(off.configured, false);
  await assert.rejects(off.speak('x'), /llm.base is not set/);
});
