// The operator against a fake agent, voice and feed: the responder contract, the feed record,
// tool fillers, the wake claim, and a superseding turn waiting for the aborted one to unwind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Operator } from '../src/modules/operator/index.js';

function build({ wake = true } = {}) {
  const agent = Object.assign(new EventEmitter(), {
    asks: [], gate: null,
    async ask(text, { onToken, signal }) {
      this.asks.push(text);
      if (this.gate) await this.gate;
      if (signal?.aborted) throw new Error('cancelled');
      onToken?.('Copy. '); onToken?.('It is a meter.');
      return { text: 'Copy. It is a meter.', steps: 1, usage: {} };
    },
  });
  const voice = Object.assign(new EventEmitter(), { state: 'idle', played: [], claimed: null, turns: [], fills: [], warmed: 0, cancelled: 0,
    playAudio(clip) { this.played.push(clip); },
    claimWake(r) { this.claimed = r; return () => { this.claimed = null; }; },
    startTurn(o) { this.turns.push(o); return true; }, cancel() { this.cancelled++; return true; },
    fill(set) { this.fills.push(set); return true; }, warm() { this.warmed++; } });
  const feed = { items: [], attached: [], clips: {},
    post(item) { item = { id: `f${this.items.length + 1}`, ...item }; this.items.push(item); return item; },
    get(id) { return this.items.find((i) => i.id === id) ?? null; },
    attach(id, parts) { this.attached.push([id, parts]); const i = this.get(id); if (i) i.audio = { rate: parts.audio.rate }; return i; },
    async audio(id) { return this.clips[id] ?? null; } };
  const camera = { holds: 0, streaming: true, hold() { this.holds++; } };
  const world = { focused: null, focus() { return this.focused; } };
  const op = Object.assign(new Operator(), { wake, fillers: { look: 'look', web_search: 'search' }, fillEveryMs: 20, hold: 'streaming', photoW: 160, photoH: 120, agent, voice, feed, camera, world });
  return { op, agent, voice, feed, camera, world };
}

test('operator: a question is asked of the agent, streamed, and recorded as heard + said', async () => {
  const { op, agent, voice, feed } = build();
  await op.start();
  assert.equal(voice.claimed, op, 'wake turns are claimed');
  const toks = [], turns = [];
  op.on('turn', (t) => turns.push(t));
  const answer = await op.respond('what is this', { onToken: (t) => toks.push(t), wake: true });
  assert.equal(answer, 'Copy. It is a meter.');
  assert.deepEqual(toks, ['Copy. ', 'It is a meter.']);
  assert.deepEqual(agent.asks, ['what is this']);
  assert.deepEqual(feed.items, [{ id: 'f1', kind: 'heard', body: 'what is this' }, { id: 'f2', kind: 'said', body: 'Copy. It is a meter.' }]);
  assert.deepEqual(turns, [{ text: 'what is this', wake: true }]);
  assert.equal(voice.warmed, 1);
  await op.stop();
  assert.equal(voice.claimed, null, 'the claim is released');
});

test('operator: wake off claims nothing; talk and cancel go through voice with this responder', async () => {
  const { op, voice } = build({ wake: false });
  await op.start();
  assert.equal(voice.claimed, null);
  op.talk(); op.cancel();
  assert.deepEqual(voice.turns, [{ responder: op }]);
  assert.equal(voice.cancelled, 1);
});

test('operator: a starting tool is the activity and gets its filler; unknown tools get none', async () => {
  const { op, agent, voice } = build();
  await op.start();
  const seen = []; op.on('activity', (a) => seen.push(a));
  agent.emit('tool', { name: 'look', phase: 'start' });
  assert.equal(op.activity, 'look');
  agent.emit('tool', { name: 'look', phase: 'end' });
  agent.emit('tool', { name: 'remember', phase: 'start' });
  agent.emit('tool', { name: 'remember', phase: 'end' });
  assert.deepEqual(voice.fills, ['look']);
  assert.deepEqual(seen, ['look', null, 'remember', null]);
  // a tool that drags on gets a wait phrase every fillEveryMs until it ends
  agent.emit('tool', { name: 'web_search', phase: 'start' });
  await new Promise((r) => setTimeout(r, 70));
  agent.emit('tool', { name: 'web_search', phase: 'end' });
  const fills = voice.fills.slice(1);
  assert.equal(fills[0], 'search'); assert.ok(fills.length >= 3 && fills.slice(1).every((f) => f === 'wait'), `wait phrases while it runs: ${fills}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(voice.fills.length, fills.length + 1, 'and none after it has ended');
});

test('operator: an aborted turn records no answer, and the next waits for it to unwind', async () => {
  const { op, agent, feed } = build();
  await op.start();
  let open; agent.gate = new Promise((r) => { open = r; });
  const abort = new AbortController();
  const first = op.respond('one', { signal: abort.signal });
  abort.abort();
  const second = op.respond('two', {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(agent.asks, ['one'], 'the second ask has not started while the first unwinds');
  agent.gate = null; open();
  await assert.rejects(first, /cancelled/);
  assert.equal(await second, 'Copy. It is a meter.');
  assert.deepEqual(feed.items.map((i) => `${i.kind}:${i.body}`), ['heard:one', 'heard:two', 'said:Copy. It is a meter.']);
  assert.equal(op.activity, null);
});

test('operator: the question is kept with its sound, the answer gets its sound when spoken, the photo joins the feed', async () => {
  const { op, agent, voice, feed, camera, world } = build();
  await op.start();
  const heard = { rate: 16000, channels: 1, pcm: Buffer.alloc(3200) };
  await op.respond('what is this', { heard });
  assert.deepEqual(feed.items[0], { id: 'f1', kind: 'heard', body: 'what is this', audio: heard });
  assert.equal(camera.holds, 1, 'a frame was taken as the question arrived');
  // 48 kHz stereo comes back as 24 kHz mono: every other frame, left sample
  const pcm = Buffer.alloc(32); for (let i = 0; i < 8; i++) pcm.writeInt16LE(i + 1, i * 4);
  voice.emit('spoken', { turn: 1, responder: 'operator', rate: 48000, channels: 2, pcm });
  assert.equal(feed.attached.length, 1);
  const [id, { audio }] = feed.attached[0];
  assert.equal(id, 'f2'); assert.equal(audio.rate, 24000); assert.equal(audio.channels, 1);
  assert.deepEqual([...new Int16Array(audio.pcm.buffer, audio.pcm.byteOffset, 4)], [1, 3, 5, 7]);
  voice.emit('spoken', { turn: 1, responder: 'operator', rate: 48000, channels: 2, pcm });
  voice.emit('spoken', { turn: 2, responder: null, rate: 48000, channels: 2, pcm });
  assert.equal(feed.attached.length, 1, 'once per answer, and only our own turns');
  // a selected item is "this": no frame is taken; nor is the sensor started just for a question
  world.focused = { id: 'e7' };
  await op.respond('and this one');
  assert.equal(camera.holds, 1);
  world.focused = null; camera.streaming = false;
  await op.respond('what time is it');
  assert.equal(camera.holds, 1, 'the camera is not streaming: no cold frame');
  op.hold = 'always'; await op.respond('again');
  assert.equal(camera.holds, 2);
  op.hold = 'streaming'; camera.streaming = true;
  // the picture a tool returned
  const jpegJs = (await import('jpeg-js')).default;
  const jpg = jpegJs.encode({ width: 640, height: 480, data: new Uint8Array(640 * 480 * 4).fill(128) }, 60).data;
  agent.emit('tool', { name: 'look', phase: 'start' }); agent.emit('tool', { name: 'look', phase: 'end', image: jpg });
  const photo = feed.items.at(-1);
  assert.equal(photo.kind, 'photo'); assert.deepEqual([photo.image.width, photo.image.height], [160, 120]);
});

test('operator: replay plays an item\'s clip, not during a turn and not without one', async () => {
  const { op, voice, feed } = build();
  await op.start();
  feed.items.push({ id: 'f1', kind: 'said', body: 'Copy.', audio: { rate: 24000 } }, { id: 'f2', kind: 'said', body: 'No clip.' });
  feed.clips.f1 = { rate: 24000, channels: 1, pcm: Buffer.alloc(480) };
  assert.equal(op.replay('f2'), false); assert.equal(op.replay('f9'), false);
  voice.state = 'speaking'; assert.equal(op.replay('f1'), false);
  voice.state = 'idle'; assert.equal(op.replay('f1'), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(voice.played, [feed.clips.f1]);
});
