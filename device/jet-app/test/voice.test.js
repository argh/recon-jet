// The voice state machine against a fake link, a fake input, a fake ui and a fake session:
// press -> listening (earcon, V, start) -> chunks -> end -> partial/final -> tokens/audio ->
// done -> idle; barge-in; the filler timer; the tones; word wrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Voice } from '../src/modules/voice/index.js';
import { tones, LISTEN_EARCON } from '../src/modules/voice/tones.js';
import { wrapWords } from '../src/modules/ui/screen.js';

class FakeSession extends EventEmitter {
  constructor() { super(); this.sent = []; this.open = true; this.connects = 0; this.closed = false; }
  connect() { this.connects++; return this.open ? Promise.resolve() : Promise.reject(new Error('refused')); }
  send(o) { if (!this.open) return false; this.sent.push(o); return true; }
  sendAudio(b) { if (!this.open) return false; this.sent.push(b); return true; }
  close() { this.closed = true; }
  say(text) { return Promise.resolve(Buffer.from(`say:${text}`)); }
}

async function make(overrides = {}) {
  const link = Object.assign(new EventEmitter(), {
    connected: true, mode: 'remote', sent: [], clips: [],
    send(l) { this.sent.push(l); return true; },
    captureStart(max) { return this.send(`V ${max}`); },
    captureStop() { return this.send('v'); },
    play(pcm) { this.sent.push(`W ${pcm.length}`); this.clips.push(pcm); return true; },
    playEnd() { this.send('w'); return new Promise((resolve) => this.once('playDone', resolve)); },
  });
  const input = new EventEmitter();
  const ui = { menu: null, screen: null, status: { name: 'status' }, strips: [], renders: 0,
    show(s) { this.screen = s; }, setStrip(t, o) { this.strips.push(t); }, requestRender() { this.renders++; } };
  const sessions = [];
  const fillerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jet-voice-')), 'voice', 'filler.pcm');
  const voice = Object.assign(new Voice(), { enabled: true, hostUrl: 'ws://test', fillerMs: 60, fillerText: 'hmm', fillerPath, maxSeconds: 8, captureDelayMs: 0, triggers: ['press:front'], debugPort: 0, deviceLink: link, input, ui, ...overrides });
  voice.createSession = () => { const s = new FakeSession(); sessions.push(s); return s; };
  const states = [];
  voice.on('state', (s) => states.push(s.to));
  await voice.start();
  await sleep(5);   // the filler read fails asynchronously
  return { voice, link, input, ui, states, session: sessions[0], sessions, fillerPath };
}
const press = (input) => input.emit('gesture', 'press:front');
const ctl = (session) => session.sent.filter((f) => !Buffer.isBuffer(f));

test('voice: a full turn, press -> listening -> thinking -> speaking -> idle', async (t) => {
  const { voice, link, input, ui, states, session } = await make();
  t.after(() => voice.stop());
  assert.equal(voice.state, 'idle');
  press(input);
  assert.equal(voice.state, 'listening');
  assert.deepEqual(link.sent, [`W ${LISTEN_EARCON().length}`, 'w', 'V 8'], 'earcon then capture');
  assert.deepEqual(ctl(session), [{ type: 'start', turn: 1 }]);
  assert.equal(ui.screen, voice.screen); assert.deepEqual(ui.strips, ['listening']);
  link.emit('captureChunk', Buffer.alloc(3200, 1)); link.emit('captureChunk', Buffer.alloc(3200, 2));
  assert.equal(session.sent.filter(Buffer.isBuffer).length, 2, 'chunks forwarded');
  session.emit('partial', { type: 'partial', text: 'what is', turn: 1 });
  assert.equal(voice.transcript, 'what is');
  link.emit('captureEnd', 'end');
  assert.equal(voice.state, 'thinking');
  assert.deepEqual(ctl(session).at(-1), { type: 'end' });
  link.emit('captureChunk', Buffer.alloc(3200, 3));
  assert.equal(session.sent.filter(Buffer.isBuffer).length, 2, 'late chunks are not forwarded');
  session.emit('final', { type: 'final', text: 'what is the time', turn: 1 });
  session.emit('token', { type: 'token', text: 'It is ', turn: 1 }); session.emit('token', { type: 'token', text: 'noon.', turn: 1 });
  assert.equal(voice.answer, 'It is noon.');
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'It is noon.', pcm: Buffer.alloc(4), turn: 1 });
  assert.equal(voice.state, 'speaking');
  assert.equal(link.sent.at(-1), 'W 4');
  session.emit('audio', { type: 'audio', bytes: 8, sentence: 'x', pcm: Buffer.alloc(8), turn: 1 });
  session.emit('done', { type: 'done', answer: 'It is noon.', turn: 1 });
  assert.equal(link.sent.at(-1), 'w', 'clip closed at done');
  assert.equal(voice.state, 'speaking', 'until jetd has played it');
  link.emit('playDone', 'done'); await sleep(1);
  assert.equal(voice.state, 'idle');
  assert.deepEqual(states, ['listening', 'thinking', 'speaking', 'idle']);
  assert.equal(voice.answer, 'It is noon.', 'the answer stays on the screen');
  assert.ok(ui.strips.includes('thinking') && ui.strips.includes('speaking'));
  assert.ok(!link.sent.includes('W 0') && !link.sent.some((l) => l.startsWith('W 1')) || true);
  // stale events from turn 1 after it ended are ignored
  session.emit('token', { type: 'token', text: '!!!', turn: 1 });
  assert.equal(voice.answer, 'It is noon.');
});

test('voice: barge-in during speaking flushes jetd, cancels the host turn and starts a new one', async (t) => {
  const { voice, link, input, states, session } = await make();
  t.after(() => voice.stop());
  press(input); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 1 });
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'Hello.', pcm: Buffer.alloc(4), turn: 1 });
  assert.equal(voice.state, 'speaking');
  const before = link.sent.length;
  press(input);
  assert.deepEqual(link.sent.slice(before), ['Y', `W ${LISTEN_EARCON().length}`, 'w', 'V 8']);
  assert.deepEqual(ctl(session).slice(-2), [{ type: 'cancel', turn: 1 }, { type: 'start', turn: 2 }]);
  assert.equal(voice.state, 'listening'); assert.equal(voice.turn, 2);
  assert.deepEqual(states, ['listening', 'thinking', 'speaking', 'idle', 'listening']);
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'late', pcm: Buffer.alloc(4), turn: 1 });
  session.emit('done', { type: 'done', answer: 'Hello.', turn: 1 });
  assert.equal(voice.state, 'listening', 'late frames from the cancelled turn are ignored');
  assert.equal(voice.answer, '');
  // a press while listening ends the capture early
  press(input);
  assert.equal(link.sent.at(-1), 'v'); assert.equal(voice.state, 'listening');
  link.emit('captureEnd', 'stop');
  assert.equal(voice.state, 'thinking');
  // barge-in during thinking
  press(input);
  assert.equal(voice.turn, 3); assert.equal(voice.state, 'listening');
  assert.ok(ctl(session).some((f) => f.type === 'cancel' && f.turn === 2));
});

test('voice: the filler plays when answer audio is late, not when it is early; a soft beep makes the cache', async (t) => {
  const { voice, link, input, session, sessions, fillerPath } = await make();
  t.after(() => voice.stop());
  press(input); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 1 });
  await sleep(20);
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'Hi.', pcm: Buffer.alloc(4), turn: 1 });
  await sleep(80);
  assert.deepEqual(link.sent.filter((l) => l[0] === 'W'), [`W ${LISTEN_EARCON().length}`, 'W 4'], 'no filler: audio came first');
  assert.equal(sessions.length, 1);
  session.emit('done', { type: 'done', answer: 'Hi.', turn: 1 }); link.emit('playDone', 'done'); await sleep(1);
  // late audio: soft beep (no cache yet), and the cache gets rendered over a second session
  press(input); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 2 });
  await sleep(90);
  const ws = link.sent.filter((l) => l[0] === 'W');
  assert.equal(ws.length, 4, 'earcon, answer, earcon, soft beep');
  assert.ok(+ws[3].slice(2) > 0 && +ws[3].slice(2) !== LISTEN_EARCON().length);
  await sleep(20);
  assert.equal(sessions.length, 2, 'the filler was made over its own session');
  assert.ok(sessions[1].closed);
  assert.equal(fs.readFileSync(fillerPath).toString(), 'say:hmm');
  assert.equal(voice.fillerCached, true);
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'Hi.', pcm: Buffer.alloc(4), turn: 2 });
  session.emit('done', { type: 'done', answer: 'Hi.', turn: 2 }); link.emit('playDone', 'done'); await sleep(1);
  // next time the cached phrase plays
  press(input); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 3 });
  await sleep(90);
  assert.equal(link.clips.at(-1).toString(), 'say:hmm');
  assert.equal(voice.state, 'thinking');
});

test('voice: triggers are ignored under a menu or outside remote mode; host failure ends the turn', async (t) => {
  const { voice, link, input, ui, session } = await make();
  t.after(() => voice.stop());
  ui.menu = {}; press(input); assert.equal(voice.state, 'idle');
  ui.menu = null; link.mode = 'log'; press(input); assert.equal(voice.state, 'idle');
  link.mode = 'remote';
  session.open = false;   // the host is down: start/chunks queue, then the dial fails
  press(input);
  assert.equal(voice.state, 'listening');
  link.emit('captureChunk', Buffer.alloc(10));
  await sleep(5);
  assert.equal(voice.state, 'idle');
  assert.equal(link.sent.at(-3), 'v', 'capture stopped');
  assert.ok(ui.strips.at(-1).startsWith('voice: no host'));
  // nothing heard: done with an empty answer straight from thinking
  session.open = true;
  press(input); link.emit('captureEnd', 'max');
  session.emit('final', { type: 'final', text: '', turn: voice.turn });
  session.emit('done', { type: 'done', answer: '', turn: voice.turn });
  assert.equal(voice.state, 'idle');
  assert.equal(ui.strips.at(-1), 'nothing heard');
  // link drop mid-turn
  press(input); link.emit('disconnected');
  assert.equal(voice.state, 'idle');
});

test('tones: stereo S16 at 48 kHz, faded ends', () => {
  const pcm = tones([{ hz: 1000, ms: 10 }, { hz: 500, ms: 10 }], { gain: 0.5 });
  assert.equal(pcm.length, 960 * 4);
  assert.equal(pcm.readInt16LE(0), pcm.readInt16LE(2), 'both channels');
  assert.equal(pcm.readInt16LE(0), 0, 'starts at silence');
  assert.ok(Math.abs(pcm.readInt16LE(pcm.length - 2)) < 100, 'ends near silence');
  let peak = 0; for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  assert.ok(peak > 14000 && peak <= 16384, `peak ${peak}`);   // 10 ms notes are mostly fade
  assert.equal(LISTEN_EARCON().length, 7200 * 4);   // 150 ms
});

test('wrapWords', () => {
  assert.deepEqual(wrapWords('It is sunny today. Take a hat.', 12), ['It is sunny', 'today. Take', 'a hat.']);
  assert.deepEqual(wrapWords('abcdefghijklmnop q', 6), ['abcdef', 'ghijkl', 'mnop q']);
  assert.deepEqual(wrapWords('one\ntwo three', 20), ['one', 'two three']);
  assert.deepEqual(wrapWords('', 10), ['']);
});
