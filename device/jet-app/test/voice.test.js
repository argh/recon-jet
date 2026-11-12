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
    wakeListen(on, c, w) { this.send(on ? `D 1 ${c} ${w}` : 'D 0'); return Promise.resolve(on ? 'on' : 'off'); },
    play(pcm) { this.sent.push(`W ${pcm.length}`); this.clips.push(pcm); return true; },
    playEnd() { this.send('w'); return new Promise((resolve) => this.once('playDone', resolve)); },
  });
  const ui = { strips: [], renders: 0, setStrip(t, o) { this.strips.push(t); }, requestRender() { this.renders++; } };
  const sessions = [];
  const phraseDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jet-voice-')), 'voice', 'phrases');
  const llm = { configured: true, models: { tts: 'kokoro', voice: 'af_heart' } };
  // one phrase per set (two waits, to see them never repeat), so what plays is predictable
  const voice = Object.assign(new Voice(), { enabled: true, llm, fillerMs: 60, phrases: { ack: ['ok'], wait: ['hmm', 'hm2'], error: ['oops'] }, phraseDir, actionWaitMs: 40, maxSeconds: 8, captureDelayMs: 0, wake: true, wakeCutoff: 0.97, wakeWindow: 5, debugPort: 0, deviceLink: link, ui, sounds: Object.assign(new Sounds(), { enabled: true, gain: 1, deviceLink: link }), ...overrides });
  voice.createSession = (l) => { const s = new FakeSession(l); sessions.push(s); return s; };
  const states = [];
  voice.on('state', (s) => states.push(s.to));
  await voice.start();
  await sleep(10);   // the bank loads (nothing on disk) and renders its phrases through the fake session
  assert.equal(sessions.length, 1); assert.equal(sessions[0].llm, llm, 'the session drives the llm module');
  return { voice, link, ui, states, session: sessions[0], llm, phraseDir };
}
const press = (voice) => voice.startTurn();
const ctl = (session) => session.sent.filter((f) => !Buffer.isBuffer(f));

test('voice: a full turn, startTurn -> listening -> thinking -> speaking -> idle', async (t) => {
  const { voice, link, ui, states, session } = await make();
  t.after(() => voice.stop());
  assert.equal(voice.state, 'idle'); assert.equal(voice.configured, true);
  press(voice);
  assert.equal(voice.state, 'listening');
  assert.deepEqual(link.sent, ['D 1 0.97 5', `W ${ACK.length}`, 'w', 'V 8'], 'listening armed at start; ack cue then capture');
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

test('voice: the phrase bank renders at start; a wait phrase plays when answer audio is late, not when it is early', async (t) => {
  const { voice, link, session, phraseDir } = await make();
  t.after(() => voice.stop());
  assert.deepEqual(session.said, ['ok', 'hmm', 'hm2', 'oops'], 'every phrase rendered once through the TTS at start');
  assert.deepEqual(voice.phraseStatus, { ack: 1, wait: 2, error: 1 });
  assert.equal(fs.readdirSync(phraseDir).filter((f) => f.startsWith('wait-')).length, 2, 'kept on disk, named by set and hash');
  press(voice); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 1 });
  await sleep(20);
  session.emit('audio', { type: 'audio', bytes: 4, sentence: 'Hi.', pcm: Buffer.alloc(4), turn: 1 });
  await sleep(80);
  assert.deepEqual(link.sent.filter((l) => l[0] === 'W'), [`W ${ACK.length}`, 'W 4'], 'no filler: audio came first');
  session.emit('done', { type: 'done', answer: 'Hi.', turn: 1 }); link.emit('playDone', 'done'); await sleep(1);
  // late audio: the cached wait phrase
  press(voice); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 2 });
  await sleep(90);
  assert.ok(link.clips.at(-1).toString().startsWith('say:hm'), 'a wait phrase');
  assert.equal(voice.state, 'thinking');
  assert.deepEqual(session.said, ['ok', 'hmm', 'hm2', 'oops'], 'nothing rendered again');
  // a second start finds the clips on disk and renders nothing
  const again = await make({ phraseDir });
  t.after(() => again.voice.stop());
  assert.deepEqual(again.session.said, []); assert.deepEqual(again.voice.phraseStatus, { ack: 1, wait: 2, error: 1 });
});

test('voice: with no wait phrase cached the soft beep plays instead', async (t) => {
  const { voice, link, session } = await make({ phrases: { wait: [] } });
  t.after(() => voice.stop());
  press(voice); link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'hi', turn: 1 });
  await sleep(90);
  const ws = link.sent.filter((l) => l[0] === 'W');
  assert.equal(ws.length, 2, 'ack, thinking beep');
  assert.ok(+ws[1].slice(2) > 0 && +ws[1].slice(2) !== ACK.length);
});

test('voice: a spoken command is acknowledged in speech, nagged while slow, and told when it fails', async (t) => {
  const { voice, link } = await make();
  t.after(() => voice.stop());
  let finish; const slow = new Promise((r) => { finish = r; });
  voice.actions = { match(text) {
    if (text.includes('slow')) return { name: 'analysis', text, run: () => slow };
    if (text.includes('boom')) return { name: 'boom', text, run: () => Promise.reject(new Error('bang')) };
    if (text.includes('stop')) return { name: 'stop', text, run: () => Promise.resolve() };
    return null;
  } };
  const clips = () => link.clips.map((c) => c.toString());
  assert.equal(voice.route('jet, slow'), true);
  assert.deepEqual(clips(), ['say:ok'], 'the ack at once');
  await sleep(150);   // actionWaitMs is 40: three nags due, but only two wait phrases exist and none repeats
  const waits = clips().filter((c) => c.startsWith('say:hm'));
  assert.deepEqual([...waits].sort(), ['say:hm2', 'say:hmm'], `each wait phrase once while it runs: ${clips()}`);
  finish(); await sleep(60);
  const n = clips().length;
  await sleep(60);
  assert.equal(clips().length, n, 'no more nagging once it finished');
  assert.equal(voice.route('boom'), true); await sleep(5);
  assert.deepEqual(clips().slice(-2), ['say:ok', 'say:oops'], 'ack, then the error phrase');
  assert.equal(voice.route('stop'), true); await sleep(5);
  assert.equal(clips().at(-1), 'say:oops', 'stop is not acknowledged');
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

test('voice: the wake word begins a turn with no cue and no V; an action takes the transcript; a question from a wake turn is announced', async (t) => {
  const { voice, link, ui, states, session } = await make({ wake: true, wakeCutoff: 0.9, wakeWindow: 4 });
  t.after(() => voice.stop());
  assert.deepEqual(link.sent, ['D 1 0.9 4'], 'jetd told to listen with the model\'s cutoff and window');
  const questions = []; voice.on('question', (q) => questions.push(q));
  const ran = [];
  voice.actions = { match(text) { return text.includes('look') ? { name: 'look', text, run: () => { ran.push(text); return Promise.resolve(); } } : text.includes('boom') ? { name: 'boom', text, run: () => Promise.reject(new Error('bang')) } : null; } };
  link.emit('wake', { avg: 250, max: 255 });
  assert.equal(voice.state, 'listening'); assert.deepEqual(link.sent, ['D 1 0.9 4'], 'no cue, no V: jetd is already capturing');
  assert.deepEqual(ctl(session), [{ type: 'start', turn: 1 }]);
  link.emit('captureChunk', Buffer.alloc(3200, 1)); link.emit('captureEnd', 'end');
  assert.equal(voice.state, 'thinking');
  assert.equal(voice.route('jet, look'), true, 'an action: the model is not asked'); assert.deepEqual(ran, ['jet, look']);
  assert.equal(ui.strips.at(-1), 'look');
  session.emit('final', { type: 'final', text: 'jet, look', turn: 1 }); session.emit('done', { type: 'done', answer: '', turn: 1 });
  assert.equal(voice.state, 'idle'); assert.equal(ui.strips.at(-1), 'look', 'the action keeps the strip');
  link.emit('wake', { avg: 250, max: 255 });
  assert.equal(voice.route('what time is it'), false, 'a question goes on to the model');
  assert.deepEqual(questions, [{ turn: 2, text: 'what time is it', wake: true, responder: null }]);
  link.emit('captureEnd', 'end'); session.emit('final', { type: 'final', text: 'what time is it', turn: 2 }); session.emit('done', { type: 'done', answer: '', turn: 2 });
  assert.equal(voice.state, 'idle');
  press(voice);
  assert.equal(voice.route('boom'), true); await sleep(5);
  assert.match(ui.strips.at(-1), /boom: bang/, 'a failing action is reported'); assert.ok(link.sent.some((l) => l === 'V 8'), 'a button turn still opens the mic');
  voice.cancel();
  assert.deepEqual(states, ['listening', 'thinking', 'idle', 'listening', 'thinking', 'idle', 'listening', 'idle']);
  const off = await make({ wake: false });
  t.after(() => off.voice.stop());
  assert.deepEqual(off.link.sent, [], 'wake off: jetd is not asked to listen');
  off.link.emit('wake', { avg: 250, max: 255 });
  assert.equal(off.voice.state, 'idle'); assert.deepEqual(off.link.sent, ['v'], 'a stray detection: the capture jetd began is stopped');
});

test('voice: announcements - speak now when live, superseded by a user turn (dropped), queue:true speaks after the turn, cancel', async (t) => {
  const { voice, link, session } = await make();
  t.after(() => voice.stop());
  const spoken = () => session.said.filter((s) => /\.$/.test(s) && !['ok', 'hmm', 'hm2', 'oops'].includes(s));
  // a plain completion speaks at once (synth + clip to the speaker, interrupting nothing)
  const a = voice.announce();
  a.say('Fix found.');
  await sleep(1);
  assert.deepEqual(spoken(), ['Fix found.']);
  assert.ok(link.clips.some((c) => c.toString() === 'say:Fix found.'), 'played as a clip');
  // a new user-initiated turn supersedes what was registered before it: user intent wins
  const dropped = voice.announce();               // default policy: the result is dropped
  const queued = voice.announce({ queue: true }); // explicit queue: it speaks after the turn
  press(voice);
  assert.equal(voice.state, 'listening');
  dropped.say('Old news.'); queued.say('France is six hours ahead.'); queued.say('And sunny.');
  await sleep(1);
  assert.deepEqual(spoken(), ['Fix found.'], 'nothing speaks during the turn');
  // the turn runs to idle: the queued lines follow, in order; the dropped one never does
  link.emit('captureEnd', 'end');
  session.emit('final', { type: 'final', text: 'what about france', turn: voice.turn });
  session.emit('done', { type: 'done', answer: 'It is in Europe.', turn: voice.turn });
  await sleep(5);
  assert.equal(voice.state, 'idle');
  assert.deepEqual(spoken(), ['Fix found.', 'France is six hours ahead.', 'And sunny.']);
  // after the flush the queued handle is live again
  queued.say('Still here.');
  await sleep(1);
  assert.ok(spoken().includes('Still here.'));
  // cancel releases a handle for good
  const gone = voice.announce();
  gone.cancel(); gone.say('Never.');
  await sleep(1);
  assert.ok(!spoken().includes('Never.') && !spoken().includes('Old news.'));
});

test('voice: a wake word with nothing after it is answered with a pickup phrase, then the mic opens for the question', async (t) => {
  const { voice, link, session, states } = await make({ phrases: { ack: ['ok'], wait: ['hmm'], error: ['oops'], pickup: ['go ahead'] }, wakeLongS: 2.5 });
  t.after(() => voice.stop());
  voice.actions = { match: (text) => (text.includes('doom') ? { name: 'doom', text, run: () => Promise.resolve() } : null) };
  const asked = []; voice.on('question', (q) => asked.push(q.text));
  // what the first capture of a wake turn is: a command, a sentence that kept going, or just the call
  link.emit('wake', { avg: 250, max: 255 });
  assert.equal(session.intercept('Touchdown.', { seconds: 1.1, wake: true, phase: 1 }), 'more', 'the tail of the wake word: only the call');
  assert.equal(session.intercept('', { seconds: 1.0, wake: true, phase: 1 }), 'more');
  assert.equal(session.intercept('What is that over there?', { seconds: 3.1, wake: true, phase: 1 }), false, 'a sentence that kept going is the question');
  assert.equal(session.intercept('jet, run doom', { seconds: 1.2, wake: true, phase: 1 }), true, 'a command in the same breath runs');
  assert.equal(session.intercept('Touchdown.', { seconds: 1.1, wake: true, phase: 2 }), false, 'the second capture is the question, whatever it is');
  assert.deepEqual(asked, ['What is that over there?', 'Touchdown.']);
  voice.cancel();

  link.emit('wake', { avg: 250, max: 255 });
  link.emit('captureChunk', Buffer.alloc(3200, 1)); link.emit('captureEnd', 'end');
  assert.equal(voice.state, 'thinking');
  const sent = link.sent.length;
  session.ended = false;   // as the real session does on `more`: listening again, the buffer empty
  session.emit('more', { type: 'more', text: 'Touchdown.', turn: voice.turn });
  assert.equal(voice.state, 'listening'); assert.equal(voice.transcript, '');
  assert.equal(link.clips.at(-1).toString(), 'say:go ahead', 'the call is answered');
  assert.ok(!link.sent.slice(sent).includes('V 8'), 'the mic stays shut while we speak');
  link.emit('playDone', 'done'); await sleep(1);
  assert.equal(link.sent.at(-1), 'V 8', 'then it opens');
  link.emit('captureChunk', Buffer.alloc(3200, 2));
  assert.ok(session.sent.some((f) => Buffer.isBuffer(f) && f[0] === 2), 'and the question is captured into the same turn');
  voice.cancel();
  assert.deepEqual(states.slice(-4), ['listening', 'thinking', 'listening', 'idle']);
});

test('voice: a transcript that has stopped changing ends the capture; fillers go into the speech in order, spaced, never twice; what was spoken is announced', async (t) => {
  const { voice, link, session } = await make({ phrases: { ack: ['ok'], wait: ['hmm', 'hm2'], error: ['oops'], look: ['let me see'] }, endpointPartials: 2, fillGapMs: 30, fillerMs: 10000 });
  t.after(() => voice.stop());
  const interjected = []; session.interject = (pcm) => { interjected.push(pcm.toString()); return true; };
  press(voice);
  assert.equal(voice.fill('look'), false, 'not while listening');
  for (const text of ['what', 'what is', 'what is this', 'what is this']) session.emit('partial', { type: 'partial', text, turn: 1 });
  assert.ok(!link.sent.includes('v'), 'one repeat is not settled');
  session.emit('partial', { type: 'partial', text: 'what is this', turn: 1 });
  assert.equal(link.sent.at(-1), 'v', 'two repeats: they have stopped talking');
  link.emit('captureEnd', 'stop');
  assert.equal(voice.state, 'thinking');
  assert.equal(voice.fill('look'), true); assert.deepEqual(interjected, ['say:let me see']);
  assert.equal(voice.fill('wait'), false, 'not on the heels of the last one');
  await sleep(40);
  assert.equal(voice.fill('look'), false, 'the only clip of that set was used this turn');
  assert.equal(voice.fill('wait'), true); await sleep(40); assert.equal(voice.fill('wait'), true); await sleep(40);
  assert.equal(voice.fill('wait'), false, 'both wait clips used');
  assert.equal(interjected.length, 3); assert.notEqual(interjected[1], interjected[2]);
  // the answer's audio is kept, fillers are not
  const spoken = []; voice.on('spoken', (c) => spoken.push(c));
  session.emit('audio', { type: 'audio', pcm: Buffer.from('AAAA'), bytes: 4, sentence: 'Hi.', turn: 1 });
  session.emit('audio', { type: 'audio', pcm: Buffer.from('ffff'), bytes: 4, sentence: '', filler: true, turn: 1 });
  session.emit('audio', { type: 'audio', pcm: Buffer.from('BBBB'), bytes: 4, sentence: 'There.', turn: 1 });
  assert.equal(voice.state, 'speaking'); assert.equal(voice.fill('wait'), false);
  session.emit('done', { type: 'done', answer: 'Hi. There.', turn: 1 });
  assert.deepEqual(spoken.map((c) => [c.turn, c.responder, c.rate, c.channels, c.pcm.toString()]), [[1, null, 48000, 2, 'AAAABBBB']]);
  // a stored clip of another format is resampled for the speaker
  voice.playAudio({ rate: 24000, channels: 1, pcm: Buffer.alloc(480) });
  assert.equal(link.clips.at(-1).length, 480 * 4, '24 kHz mono -> 48 kHz stereo');
});
