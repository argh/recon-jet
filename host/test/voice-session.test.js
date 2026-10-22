// voice-session: the sentence splitter, the SSE parser, and the frame protocol end to end
// against a fake upstream (no LLM server, no ffmpeg).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { SentenceSplitter, SseParser, createVoiceServer } = require('../voice-session.js');

test('sentence splitter: boundaries on streamed tokens, decimals and short fragments kept', () => {
  const s = new SentenceSplitter();
  const out = [];
  for (const tok of ['Hello', ' there', '.', ' It', ' is 3', '.5 degrees', ' today!', ' Really', '?', ' Yes', '.']) out.push(...s.push(tok));
  assert.deepEqual(out, ['Hello there.', 'It is 3.5 degrees today!']);   // "Really?" waits for the space; "Yes." for flush
  out.push(...s.push(' '));
  assert.deepEqual(out, ['Hello there.', 'It is 3.5 degrees today!', 'Really? Yes.']);   // "Really?" alone was under minChars
  assert.equal(s.flush(), null);
  const s2 = new SentenceSplitter();
  assert.deepEqual(s2.push('No. 5 is fine. "Sure!" she said.\nNext line'), ['No. 5 is fine.', '"Sure!" she said.']);
  assert.equal(s2.flush(), 'Next line');
  const s3 = new SentenceSplitter();
  assert.deepEqual(s3.push('one\ntwo\n'), ['one', 'two']);
});

test('sse parser: data lines, [DONE], split chunks', () => {
  const p = new SseParser();
  assert.deepEqual(p.feed('data: {"a":1}\n\ndata: {"a":2}\r\n'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(p.feed('data: {"a"'), []);
  assert.deepEqual(p.feed(':3}\n: keepalive\ndata: [DONE]\n'), [{ a: 3 }]);
  assert.equal(p.done, true);
});

/** A scripted upstream: the transcript is the byte count, the answer two sentences, audio = sentence length bytes. */
function fakeUpstream({ chatDelayMs = 0, speakDelayMs = 0 } = {}) {
  const sleep = (t, signal) => new Promise((resolve, reject) => { const h = setTimeout(resolve, t); signal?.addEventListener('abort', () => { clearTimeout(h); reject(new Error('aborted')); }, { once: true }); });
  const calls = { transcribe: [], chat: [], speak: [] };
  return { calls,
    async transcribe(pcm) { calls.transcribe.push(pcm.length); return pcm.length ? `heard ${pcm.length}` : ''; },
    async chat(messages, { signal, onToken }) {
      calls.chat.push(messages.at(-1).content);
      const toks = ['It is', ' sunny', '.', ' Take a', ' hat.'];
      let text = '';
      for (const t of toks) { await sleep(chatDelayMs, signal); text += t; onToken(t); }
      return text;
    },
    async speak(text, signal) { await sleep(speakDelayMs, signal); calls.speak.push(text); return { pcm: Buffer.alloc(text.length, 7), ttsMs: 1, ffmpegMs: 1 }; },
  };
}

async function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  const events = [];   // JSON frames, with audio payloads attached to their tag
  let pendingAudio = null;
  ws.on('message', (data, isBinary) => {
    if (isBinary) { pendingAudio.pcm = Buffer.from(data); pendingAudio = null; return; }
    const m = JSON.parse(data.toString()); events.push(m);
    if (m.type === 'audio') pendingAudio = m;
  });
  const send = (o) => ws.send(JSON.stringify(o));
  const until = (type, from = 0) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${type}; got ${events.map((e) => e.type).join(',')}`)), 3000);
    const poll = () => { const i = events.findIndex((e, k) => k >= from && e.type === type); if (i >= 0) { clearTimeout(t); resolve(i); } else setTimeout(poll, 5); };
    poll();
  });
  return { ws, events, send, until };
}

test('protocol: start, chunks, partial, end -> final, tokens, per-sentence audio, done', async (t) => {
  const up = fakeUpstream();
  const wss = createVoiceServer({ port: 0, host: '127.0.0.1', upstream: up, partialMs: 30 });
  await once(wss, 'listening');
  t.after(() => wss.close());
  const c = await client(wss.address().port);
  c.send({ type: 'start', turn: 7 });
  c.ws.send(Buffer.alloc(3200, 1)); c.ws.send(Buffer.alloc(3200, 2));
  await c.until('partial');
  assert.equal(c.events[0].text, 'heard 6400'); assert.equal(c.events[0].turn, 7);
  c.send({ type: 'end' });
  const done = await c.until('done');
  const types = c.events.slice(0, done + 1).map((e) => e.type);
  assert.equal(c.events[types.indexOf('final')].text, 'heard 6400');
  assert.deepEqual(c.events.filter((e) => e.type === 'token').map((e) => e.text).join(''), 'It is sunny. Take a hat.');
  const audio = c.events.filter((e) => e.type === 'audio');
  assert.deepEqual(audio.map((a) => a.sentence), ['It is sunny.', 'Take a hat.']);
  assert.ok(audio.every((a) => a.pcm.length === a.bytes), 'binary frame follows its tag');
  assert.equal(c.events[done].answer, 'It is sunny. Take a hat.');
  assert.equal(c.events[done].turn, 7);
  assert.ok(types.indexOf('final') < types.indexOf('token') && types.indexOf('token') < types.indexOf('audio'), types.join(','));
  assert.deepEqual(up.calls.chat, ['heard 6400']);
  // a second turn on the same connection; nothing heard -> done with an empty answer, no chat
  c.send({ type: 'start', turn: 8 }); c.send({ type: 'end' });
  const done2 = await c.until('done', done + 1);
  assert.equal(c.events[done2].answer, ''); assert.equal(c.events[done2 - 1].type, 'final'); assert.equal(c.events[done2 - 1].text, '');
  assert.equal(up.calls.chat.length, 1);
  c.ws.close();
});

test('protocol: cancel aborts the answer in flight; say returns audio and done', async (t) => {
  const up = fakeUpstream({ chatDelayMs: 40, speakDelayMs: 40 });
  const wss = createVoiceServer({ port: 0, host: '127.0.0.1', upstream: up, partialMs: 1000 });
  await once(wss, 'listening');
  t.after(() => wss.close());
  const c = await client(wss.address().port);
  c.send({ type: 'start', turn: 1 }); c.ws.send(Buffer.alloc(3200, 1)); c.send({ type: 'end' });
  await c.until('token');
  c.send({ type: 'cancel' });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!c.events.some((e) => e.type === 'done'), 'no done after cancel');
  assert.ok(!c.events.some((e) => e.type === 'audio'), 'no audio after cancel');
  assert.equal(up.calls.speak.length, 0, 'speak aborted before it returned');
  c.send({ type: 'say', text: 'hello' });
  const done = await c.until('done');
  assert.equal(c.events[done - 1].type, 'audio'); assert.equal(c.events[done - 1].sentence, 'hello'); assert.equal(c.events[done - 1].pcm.length, 5);
  assert.equal(c.events[done].answer, 'hello');
  c.send({ type: 'end' });
  await c.until('error', done + 1);
  c.ws.close();
});
