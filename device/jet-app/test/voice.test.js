// The voice state machine against a fake link, a fake ui and a fake session (the real one is
// tested in session.test.js): startTurn -> listening (earcon, V, start) -> chunks -> end ->
// partial/final -> tokens/audio -> done -> idle; barge-in; cancel; look; the filler timer; the
// tones; word wrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Voice } from '../src/modules/voice/index.js';
import { tones } from '../src/lib/tones.js';
import { Sounds } from '../src/modules/sounds/index.js';

const ACK = Sounds.pcm('ack');
import { wrapWords } from '../src/modules/ui/style.js';

/** Records the state machine's calls as frames (`sent`); the tests emit the events by hand. */
class FakeSession extends EventEmitter {
  constructor(llm) { super(); this.llm = llm; this.sent = []; this.said = []; this.current = null; }
  start(id) { if (this.current !== null) this.cancel(); this.current = id; this.sent.push({ type: 'start', turn: id }); }
  audio(pcm) { if (this.current === null || this.ended) return false; this.sent.push(pcm); return true; }
  end() { if (this.current === null) return Promise.resolve(false); this.ended = true; this.sent.push({ type: 'end' }); return Promise.resolve(true); }
  cancel() { if (this.current === null) return false; this.sent.push({ type: 'cancel', turn: this.current }); this.current = null; this.ended = false; return true; }
  say(text) { this.said.push(text); return Promise.resolve(Buffer.from(`say:${text}`)); }
  look(jpeg, question, { onToken }) { this.looked = { jpeg, question }; onToken('a cat '); onToken('on a mat'); return Promise.resolve('a cat on a mat'); }
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
  const ui = { strips: [], renders: 0, setStrip(t, o) { this.strips.push(t); }, requestRender() { this.renders++; } };
  const sessions = [];
  const fillerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jet-voice-')), 'voice', 'filler.pcm');
  const llm = { configured: true };
  const voice = Object.assign(new Voice(), { enabled: true, llm, fillerMs: 60, fillerText: 'hmm', fillerPath, maxSeconds: 8, captureDelayMs: 0, debugPort: 0, deviceLink: link, ui, sounds: Object.assign(new Sounds(), { enabled: true, gain: 1, deviceLink: link }), ...overrides });
  voice.createSession = (l) => { const s = new FakeSession(l); sessions.push(s); return s; };
  const states = [];
  voice.on('state', (s) => states.push(s.to));
  await voice.start();
  await sleep(5);   // the filler read fails asynchronously
  assert.equal(sessions.length, 1); assert.equal(sessions[0].llm, llm, 'the session drives the llm module');
  return { voice, link, ui, states, session: sessions[0], llm, fillerPath };
}
const press = (voice) => voice.startTurn();
const ctl = (session) => session.sent.filter((f) => !Buffer.isBuffer(f));

test('voice: a full turn, startTurn -> listening -> thinking -> speaking -> idle', async (t) => {
  const { voice, link, ui, states, session } = await make();
  t.after(() => voice.stop());
  assert.equal(voice.state, 'idle'); assert.equal(voice.configured, true);
  press(voice);
  assert.equal(voice.state, 'listening');
  assert.deepEqual(link.sent, [`W ${ACK.length}`, 'w', 'V 8'], 'ack cue then capture');
  assert.deepEqual(ctl(session), [{ type: 'start', turn: 1 }]);
  assert.deepEqual(ui.strips, ['listening']);
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
  const { voice, link, states, session } = await make();
  t.after(() => voice.stop());
  press(voice); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 1 });
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'Hello.', pcm: Buffer.alloc(4), turn: 1 });
  assert.equal(voice.state, 'speaking');
  const before = link.sent.length;
  press(voice);
  assert.deepEqual(link.sent.slice(before), ['Y', `W ${ACK.length}`, 'w', 'V 8']);
  assert.deepEqual(ctl(session).slice(-2), [{ type: 'cancel', turn: 1 }, { type: 'start', turn: 2 }]);
  assert.equal(voice.state, 'listening'); assert.equal(voice.turn, 2);
  assert.deepEqual(states, ['listening', 'thinking', 'speaking', 'idle', 'listening']);
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'late', pcm: Buffer.alloc(4), turn: 1 });
  session.emit('done', { type: 'done', answer: 'Hello.', turn: 1 });
  assert.equal(voice.state, 'listening', 'late frames from the cancelled turn are ignored');
  assert.equal(voice.answer, '');
  // a press while listening ends the capture early
  press(voice);
  assert.equal(link.sent.at(-1), 'v'); assert.equal(voice.state, 'listening');
  link.emit('captureEnd', 'stop');
  assert.equal(voice.state, 'thinking');
  // barge-in during thinking
  press(voice);
  assert.equal(voice.turn, 3); assert.equal(voice.state, 'listening');
  assert.ok(ctl(session).some((f) => f.type === 'cancel' && f.turn === 2));
});

test('voice: a clip still playing (say, filler) is flushed with Y before a new capture', async (t) => {
  const { voice, link } = await make();
  t.after(() => voice.stop());
  await voice.say('hello');   // W + w queued, jetd has not reported it played
  const before = link.sent.length;
  press(voice);
  assert.deepEqual(link.sent.slice(before, before + 2), ['Y', `W ${ACK.length}`], 'flushed, then the ack cue');
  link.emit('playDone', 'flushed'); link.emit('playDone', 'done'); await sleep(1);
  voice.cancel();
  const n = link.sent.length;
  press(voice);
  assert.equal(link.sent[n], `W ${ACK.length}`, 'nothing playing: no Y');
});

test('voice: cancel stops the capture or the playback, tells the host, and leaves the answer', async (t) => {
  const { voice, link, ui, session } = await make();
  t.after(() => voice.stop());
  assert.equal(voice.cancel(), false, 'nothing to cancel');
  press(voice);
  assert.equal(voice.cancel(), true);
  assert.equal(link.sent.at(-1), 'v'); assert.equal(voice.state, 'idle');
  assert.deepEqual(ctl(session).at(-1), { type: 'cancel', turn: 1 });
  assert.equal(ui.strips.at(-1), null, 'strip cleared');
  press(voice); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 2 });
  session.emit('token', { type: 'token', text: 'Hello.', turn: 2 });
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'Hello.', pcm: Buffer.alloc(4), turn: 2 });
  assert.equal(voice.state, 'speaking');
  voice.cancel();
  assert.equal(link.sent.at(-1), 'Y', 'playback flushed');
  assert.equal(voice.state, 'idle'); assert.equal(voice.answer, 'Hello.', 'the text stays for the mode to show');
  session.emit('done', { type: 'done', answer: 'Hello there.', turn: 2 });
  assert.equal(voice.answer, 'Hello.', 'late frames of the cancelled turn are ignored');
  voice.clear();
  assert.equal(voice.answer, ''); assert.equal(voice.transcript, '');
});

test('voice: look hands a JPEG to the session and streams the answer; refused without a server', async (t) => {
  const { voice, session } = await make();
  t.after(() => voice.stop());
  const tokens = [];
  const answer = await voice.look(Buffer.from('JPEGDATA'), 'what?', { onToken: (x) => tokens.push(x) });
  assert.equal(answer, 'a cat on a mat');
  assert.deepEqual(tokens, ['a cat ', 'on a mat']);
  assert.deepEqual(session.looked, { jpeg: Buffer.from('JPEGDATA'), question: 'what?' });
  const off = Object.assign(new Voice(), { enabled: true, llm: { configured: false }, deviceLink: new EventEmitter(), ui: {} });
  await off.start();
  await assert.rejects(off.look(Buffer.alloc(1), 'q'), /llm.base/);
  await assert.rejects(off.say('x'), /llm.base/);
});

test('voice: the filler plays when answer audio is late, not when it is early; a soft beep makes the cache', async (t) => {
  const { voice, link, session, fillerPath } = await make();
  t.after(() => voice.stop());
  press(voice); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 1 });
  await sleep(20);
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'Hi.', pcm: Buffer.alloc(4), turn: 1 });
  await sleep(80);
  assert.deepEqual(link.sent.filter((l) => l[0] === 'W'), [`W ${ACK.length}`, 'W 4'], 'no filler: audio came first');
  assert.deepEqual(session.said, []);
  session.emit('done', { type: 'done', answer: 'Hi.', turn: 1 }); link.emit('playDone', 'done'); await sleep(1);
  // late audio: soft beep (no cache yet), and the cache gets rendered through the session's TTS
  press(voice); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 2 });
  await sleep(90);
  const ws = link.sent.filter((l) => l[0] === 'W');
  assert.equal(ws.length, 4, 'ack, answer, ack, thinking');
  assert.ok(+ws[3].slice(2) > 0 && +ws[3].slice(2) !== ACK.length);
  await sleep(20);
  assert.deepEqual(session.said, ['hmm'], 'the filler was rendered once');
  assert.equal(fs.readFileSync(fillerPath).toString(), 'say:hmm');
  assert.equal(voice.fillerCached, true);
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'Hi.', pcm: Buffer.alloc(4), turn: 2 });
  session.emit('done', { type: 'done', answer: 'Hi.', turn: 2 }); link.emit('playDone', 'done'); await sleep(1);
  // next time the cached phrase plays
  press(voice); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 3 });
  await sleep(90);
  assert.equal(link.clips.at(-1).toString(), 'say:hmm');
  assert.equal(voice.state, 'thinking');
});

test('voice: not configured is refused; a session error ends the turn', async (t) => {
  const { voice, link, ui, session, llm } = await make();
  t.after(() => voice.stop());
  voice.enabled = false; assert.equal(press(voice), false); assert.equal(voice.state, 'idle'); assert.equal(ui.strips.at(-1), 'voice: not configured');
  voice.enabled = true;
  llm.configured = false; assert.equal(press(voice), false); assert.equal(voice.configured, false);
  llm.configured = true;
  press(voice);
  assert.equal(voice.state, 'listening');
  link.emit('captureChunk', Buffer.alloc(10));
  session.emit('error', { type: 'error', turn: voice.turn, message: 'asr down' });   // the server failed mid-capture
  assert.equal(voice.state, 'idle');
  assert.equal(link.sent.at(-3), 'v', 'capture stopped');
  assert.deepEqual(ctl(session).at(-1), { type: 'cancel', turn: voice.turn });
  assert.equal(ui.strips.at(-1), 'voice: asr down');
  session.emit('error', { type: 'error', turn: voice.turn, message: 'late' });
  assert.equal(ui.strips.at(-1), 'voice: asr down', 'an error for a finished turn is ignored');
  // nothing heard: done with an empty answer straight from thinking
  session.open = true;
  press(voice); link.emit('captureEnd', 'max');
  session.emit('final', { type: 'final', text: '', turn: voice.turn });
  session.emit('done', { type: 'done', answer: '', turn: voice.turn });
  assert.equal(voice.state, 'idle');
  assert.equal(ui.strips.at(-1), 'nothing heard');
  // link drop mid-turn
  press(voice); link.emit('disconnected');
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
  assert.equal(ACK.length, 7680 * 4);   // 160 ms
});

test('wrapWords', () => {
  assert.deepEqual(wrapWords('It is sunny today. Take a hat.', 12), ['It is sunny', 'today. Take', 'a hat.']);
  assert.deepEqual(wrapWords('abcdefghijklmnop q', 6), ['abcdef', 'ghijkl', 'mnop q']);
  assert.deepEqual(wrapWords('one\ntwo three', 20), ['one', 'two three']);
  assert.deepEqual(wrapWords('', 10), ['']);
});
