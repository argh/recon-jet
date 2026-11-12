// The Assistant mode through the real input/surface/ui/modes stack, over fakes for its models
// (feed, operator, voice): the feed as a message thread (who is on which side), the gesture
// tree (front talks, swipes select, swipe right or front opens and replays, swipe left or rear
// closes, the order rear steps back in), the pending bubbles while a turn runs and for a turn
// no operator took, the raise for a wake-word question nobody answered, that it follows its
// models only while showing, and the DI shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ModuleManager, Schema } from '@versionzero/module-manager';
import { AssistantMode } from '../src/modes/assistant/index.js';
import { Feed } from '../src/modules/feed/index.js';
import { C } from '../src/modules/ui/style.js';
import { stack, fakeMode, fakeLink, settle } from './helpers.js';

const TAP = 330;   // a pad tap of its own: the default tap code (28) is also Enter, which input reads as a front press
const T0 = 1_000_000;

const fakeVoice = () => Object.assign(new EventEmitter(), {
  state: 'idle', transcript: '', answer: '', configured: true,
  set(state, extra = {}) { Object.assign(this, extra, { state }); this.emit('state', { to: state }); },
});
const fakeOperator = () => ({ calls: [], talk() { this.calls.push('talk'); }, cancel() { this.calls.push('cancel'); }, replay(id) { this.calls.push(`replay:${id}`); return true; } });
/** The feed's contract and no more: items oldest first (copies), `get`, `post`; `amend` is an item gaining something (`change`), `drop` the ring letting one go. */
class FakeFeed extends EventEmitter {
  #items = []; #seq = 0;
  get items() { return this.#items.map((x) => ({ ...x })); }
  get(id) { const x = this.#items.find((i) => i.id === id); return x ? { ...x } : null; }
  post(post) { const item = { id: `f${++this.#seq}`, t: T0 + this.#seq * 60_000, ...post }; this.#items.push(item); this.emit('post', { ...item }); return { ...item }; }
  amend(id, extra) { const item = Object.assign(this.#items.find((i) => i.id === id), extra); this.emit('change', { ...item }); }
  drop(id) { this.#items = this.#items.filter((i) => i.id !== id); }
}

/** The mode over the real stack, with another mode after it. `frame()` is what the panel says after the pending render. */
async function make(t) {
  const s = await stack(); t.after(s.stop);
  s.input.tapCode = TAP;
  const feed = new FakeFeed(), voice = fakeVoice(), operator = fakeOperator();
  const assistant = Object.assign(new AssistantMode(), { modes: s.modes, ui: s.ui, feed, operator, voice });
  const other = fakeMode('other');
  await assistant.start(); s.modes.register(other);
  await s.modes.begin(); await settle();
  const texts = [], draw = s.surface.text.bind(s.surface);
  s.surface.text = (x, y, str, options) => { texts.push(str); return draw(x, y, str, options); };
  // the ui draws its status strip last: it is not the mode's, so it is left out
  const frame = async () => { texts.length = 0; s.ui.requestRender(); await settle(); return s.ui.strip ? texts.slice(0, -1) : [...texts]; };
  let now = 10_000;
  const g = async (name) => { if (name === 'tap') s.key(TAP, 1, now); else s.k[name](now); now += 2000; await settle(); };
  return { s, feed, voice, operator, assistant, other, frame, g };
}
const hintOf = (texts) => texts.at(-1);
const thread = (texts) => texts.slice(0, -1);   // what the mode wrote, less the hint
const stamp = (item) => new Date(item.t).toTimeString().slice(0, 5);

test('assistant: the feed as a message thread, the wearer on the right and Jet on the left; front talks, swipe right or front opens the selected message and replays it, swipe left or rear closes', async (t) => {
  const { s, feed, voice, operator, assistant, frame, g } = await make(t);
  assert.equal(s.modes.current, assistant);
  assert.deepEqual([assistant.id, assistant.label, assistant.spoken], ['assistant', 'Assistant', ['radio', 'jet', 'comms']]);
  assert.equal(s.modes.spoken('comms'), assistant, '"open comms" still lands here');
  let f = await frame();
  assert.deepEqual(f, ['press front = talk', 'front: talk'], 'an empty feed says what to do');
  const heard = feed.post({ kind: 'heard', body: 'what is this meter reading', audio: true });
  const said = feed.post({ kind: 'said', body: 'Two point two one kilohms.', audio: true });
  const photo = feed.post({ kind: 'photo', image: { width: 4, height: 3, data: new Uint8Array(48).fill(128) } });
  const card = feed.post({ kind: 'card', title: 'Fluke 117', body: 'Ohms to 40M\nContinuity under 20 ohms', image: { width: 4, height: 3, data: new Uint8Array(48).fill(128) } });
  const fills = [], fill = s.surface.fillRect.bind(s.surface);
  s.surface.fillRect = (x, y, w, h, colour) => { if (h > 1) fills.push({ x, y, w, h, colour }); return fill(x, y, w, h, colour); };
  f = await frame();
  assert.deepEqual(thread(f), ['what is this meter reading', stamp(heard), 'Two point two one kilohms.', stamp(said), stamp(photo), 'Fluke 117', 'Ohms to 40M', 'Continuity under 20 ohms', stamp(card)], 'oldest first, newest at the bottom; a card has its title line, a photo needs no words');
  const bubbles = fills.filter((x) => [C.you, C.jet].includes(x.colour));
  assert.deepEqual(bubbles.map((x) => x.colour), [C.you, C.jet, C.you, C.jet], 'heard and photo are the wearer\'s, said and card are Jet\'s');
  assert.deepEqual(bubbles.map((x) => (x.colour === C.you ? x.x + x.w : x.x)), [422, 2, 422, 2], 'the wearer against the right edge, Jet against the left');
  assert.equal(bubbles.at(-1).y + bubbles.at(-1).h, 226, 'the newest sits on the hint line: the thread has the panel from the strip down');
  assert.equal(hintOf(f), 'front: talk   swipe: select');

  await g('frontPress'); await g('right'); await g('left');
  assert.deepEqual(operator.calls, ['talk'], 'front = talk while following the newest');
  assert.equal(assistant.opened, null, 'nothing selected: neither front nor a swipe right opens anything');
  await g('up');
  assert.equal(assistant.selected.id, 'f4', 'the first swipe selects the newest');
  fills.length = 0;
  assert.equal(hintOf(await frame()), 'right: open   rear: newest');
  assert.deepEqual(fills.filter((x) => x.colour === C.ok && x.h === 66).map((x) => x.x), [2], 'the selected bubble is the green bar, where Jet\'s card was');
  await g('up'); await g('up'); await g('down');
  assert.equal(assistant.selected.id, 'f3', 'swipes walk the thread');
  await g('right');
  assert.equal(assistant.opened.id, 'f3', 'swipe right opens the selected message');
  assert.deepEqual(operator.calls, ['talk', 'replay:f3'], 'and replays its audio, once');
  f = await frame();
  assert.deepEqual(f, [stamp(photo), 'photo', '', 'up/down: scroll   left: close'], 'the open photo has the panel; no clip, no replay hint');
  await frame();
  await g('right'); await g('down');
  assert.deepEqual(operator.calls, ['talk', 'replay:f3'], 'a repaint, a second swipe right or a scroll replays nothing');
  assert.equal(assistant.opened.id, 'f3');
  await g('frontPress'); await g('tap');
  assert.deepEqual(operator.calls.slice(2), ['replay:f3', 'replay:f3'], 'front inside the open message replays it again (the pad tap is the same button)');
  await g('left');
  assert.equal(assistant.opened, null); assert.equal(assistant.selected.id, 'f3', 'swipe left closed it; the selection stays');
  await g('left');
  assert.equal(assistant.selected.id, 'f3', 'a swipe left at the thread does nothing');
  await g('frontPress');
  assert.equal(assistant.opened.id, 'f3', 'front on a selected message opens it too');
  assert.equal(operator.calls.at(-1), 'replay:f3'); assert.equal(operator.calls.length, 5);

  // a running turn owns both buttons: front is the talk button, rear cancels and nothing else
  voice.set('thinking', { transcript: 'and the range' });
  assert.equal(hintOf(await frame()), 'front: interrupt   rear: cancel');
  await g('frontPress'); await g('rearPress');
  assert.deepEqual(operator.calls.slice(5), ['talk', 'cancel']); assert.equal(assistant.opened.id, 'f3', 'the open message stays');
  voice.set('idle', { transcript: '' });
  // rear: the open message, then the selection, then the root
  await g('rearPress');
  assert.equal(assistant.opened, null); assert.equal(assistant.selected.id, 'f3', 'rear closed the message; the selection stays');
  voice.set('speaking'); await g('frontPress');
  assert.equal(assistant.opened, null); assert.equal(operator.calls.at(-1), 'talk', 'with a turn running front talks even on a selected message');
  voice.set('idle');
  await g('rearPress');
  assert.equal(assistant.selected, null, 'rear let go of the selection: following the newest again');
  assert.equal(s.modes.switcher, null);
  await g('rearPress');
  assert.notEqual(s.modes.switcher, null, 'rear at the root ascends to the switcher');
  assert.deepEqual(operator.calls.filter((x) => x === 'cancel').length, 1, 'an idle rear cancels nothing');
});

test('assistant: an opened message is shown whole, with its picture enlarged; an item the ring dropped falls back to the thread', async (t) => {
  const { s, feed, operator, assistant, frame, g } = await make(t);
  const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ');
  feed.post({ kind: 'card', title: 'Fluke 117', body: 'Ohms to 40M', image: { width: 160, height: 120, data: new Uint8Array(160 * 120 * 4).fill(255) } });
  const said = feed.post({ kind: 'said', body: long, audio: true });
  let f = await frame();
  const rows = thread(f).slice(3, -1);
  assert.equal(rows.length, 4, 'four rows in the thread'); assert.ok(rows[3].endsWith('~') && long.startsWith(rows.slice(0, 3).join(' ')), 'cut, and marked');
  await g('up'); await g('right');
  assert.equal(assistant.opened.id, 'f2'); assert.deepEqual(operator.calls, ['replay:f2']);
  f = await frame();
  assert.deepEqual(f.slice(0, 2), [stamp(said), 'Jet'], 'headed by who said it and when');
  assert.equal(f.slice(2, -1).join(' '), long, 'every word of it');
  assert.equal(hintOf(f), 'front: replay   up/down: scroll   left: close');

  await g('left'); await g('up'); await g('tap');
  assert.equal(assistant.opened.id, 'f1'); assert.equal(operator.calls.at(-1), 'replay:f1', 'the operator is asked whatever the item holds: no clip is its answer to give');
  f = await frame();
  assert.ok(f.includes('Fluke 117') && f.includes('Ohms to 40M'));
  const px = (x, y) => s.surface.raster.px[y * s.surface.raster.pitch + x], body = 14 + 20 + 6;
  assert.deepEqual([px(8, body), px(8 + 225, body + 169), px(8 + 226, body + 80), px(8 + 100, body + 170)], [0xffff, 0xffff, 0, 0], 'the picture is as large as the panel under the heading allows: 226x170 from 160x120');
  feed.drop('f1');
  assert.equal(assistant.opened, null);
  assert.ok(thread(await frame()).includes(stamp(said)), 'the thread again');
});

test('assistant: the running turn is pending bubbles under the thread until the feed holds it', async (t) => {
  const { s, feed, voice, assistant, frame, g } = await make(t);
  const count = (f, str) => f.filter((x) => x === str).length;
  const earlier = feed.post({ kind: 'said', body: 'Earlier answer.' });
  const fills = [], fill = s.surface.fillRect.bind(s.surface);
  s.surface.fillRect = (x, y, w, h, colour) => { if (h > 1 && [C.you, C.jet].includes(colour)) fills.push(colour); return fill(x, y, w, h, colour); };
  const sides = async () => { fills.length = 0; await frame(); return fills.map((c) => (c === C.you ? 'you' : 'jet')); };
  voice.set('listening');
  let f = await frame();
  assert.equal(f.at(-2), 'listening...'); assert.equal(hintOf(f), 'front: done   rear: cancel');
  assert.deepEqual(await sides(), ['jet', 'you'], 'the wearer is speaking: a pending bubble on the right');
  voice.transcript = 'how long should I';   // a partial: the voice module repaints, no state event
  assert.equal((await frame()).at(-2), 'how long should I');
  await g('up');
  assert.equal(assistant.selected.id, earlier.id, 'a pending bubble is not for selecting: the newest item is');
  await g('down');
  voice.set('thinking', { transcript: 'how long should I hold it' });
  assert.deepEqual((await frame()).slice(-3, -1), ['how long should I hold it', 'thinking...'], 'the final transcript, not filed yet');
  assert.deepEqual(await sides(), ['jet', 'you', 'jet'], 'and Jet thinking on the left');
  const heard = feed.post({ kind: 'heard', body: 'how long should I hold it' });
  f = await frame();
  assert.equal(count(f, 'how long should I hold it'), 1, 'filed: the feed item replaces the live transcript');
  assert.deepEqual(f.slice(-3, -1), [stamp(heard), 'thinking...']);
  feed.post({ kind: 'photo', image: { width: 4, height: 3, data: new Uint8Array(48).fill(128) } });   // it looked
  assert.equal((await frame()).at(-2), 'thinking...', 'a photo in between is not the answer');
  voice.set('speaking', { answer: 'Two to three' });
  assert.equal((await frame()).at(-2), 'Two to three', 'the answer as it streams');
  assert.deepEqual((await sides()).slice(-3), ['you', 'you', 'jet']);
  voice.answer = 'Two to three seconds.';
  const said = feed.post({ kind: 'said', body: 'Two to three seconds.' });
  feed.post({ kind: 'card', title: 'Solder', body: '2-3 s per joint' });   // and a card after it, while still speaking
  f = await frame();
  assert.equal(count(f, 'Two to three seconds.'), 1, 'filed while still speaking: shown once');
  voice.set('idle');
  f = await frame();
  assert.deepEqual(f.slice(-6, -1), ['Two to three seconds.', stamp(said), 'Solder', '2-3 s per joint', stamp(feed.get('f5'))], 'idle: the feed holds all of it, nothing is pending');
  assert.equal(hintOf(f), 'front: talk   swipe: select');
  voice.configured = false;
  assert.equal(hintOf(await frame()), 'voice: not configured');
});

test('assistant: a wake-word question no responder took raises the mode and stays on it as pending bubbles; an operator-answered one switches nothing', async (t) => {
  const { s, feed, voice, assistant, other, frame, g } = await make(t);
  const said = feed.post({ kind: 'said', body: 'Earlier answer.' });
  s.modes.switchTo('other'); await settle();
  voice.emit('question', { turn: 1, text: 'what time is it', wake: true, responder: 'operator' });
  assert.equal(s.modes.current, other, 'the operator answers wherever the wearer is: no screen change');
  voice.emit('question', { turn: 2, text: 'what time is it', wake: false, responder: null });
  assert.equal(s.modes.current, other, 'a push-to-talk question from elsewhere is not ours to show either');
  voice.set('thinking', { transcript: 'what time is it' });
  voice.emit('question', { turn: 3, text: 'what time is it', wake: true, responder: null });
  assert.equal(s.modes.current, assistant, 'voice\'s own one-shot answer is seen nowhere else: the mode raises itself');
  let f = await frame();
  assert.deepEqual(thread(f), ['Earlier answer.', stamp(said), 'what time is it', 'thinking...']);
  voice.set('speaking', { answer: 'Ten past nine.' });
  assert.deepEqual(thread(await frame()).slice(-2), ['what time is it', 'Ten past nine.'], 'the feed never files this turn: question and answer are the live bubbles');
  voice.set('idle');
  f = await frame();
  assert.deepEqual(thread(f).slice(-2), ['what time is it', 'Ten past nine.'], 'and they stay once it is over');
  assert.equal(hintOf(f), 'front: talk   swipe: select');
  await g('up');
  assert.equal(assistant.selected.id, said.id, 'still pending: the selection steps over them');
  await g('rearPress');
  voice.set('listening', { transcript: '', answer: '' });   // the next turn clears the voice state
  assert.deepEqual(thread(await frame()).slice(-3), ['Earlier answer.', stamp(said), 'listening...']);
  voice.set('idle');
  voice.emit('question', { turn: 4, text: 'again', wake: true, responder: null });
  assert.equal(s.modes.current, assistant, 'already showing: nothing to do');
});

test('assistant: follows the feed (post, change) and the voice state only while showing; a change repaints', async (t) => {
  const { s, feed, voice, frame, g } = await make(t);
  const subs = () => [feed.listenerCount('post'), feed.listenerCount('change'), voice.listenerCount('state'), voice.listenerCount('question')];
  let asked = 0; const request = s.ui.requestRender.bind(s.ui);
  s.ui.requestRender = () => { asked++; request(); };
  const quiet = async (act) => { await settle(); asked = 0; act(); return asked; };
  assert.deepEqual(subs(), [1, 1, 1, 1]);
  const said = feed.post({ kind: 'said', body: 'The clip is still being written.' });
  let f = await frame();
  assert.ok(f.includes('The clip is still being written.'));
  const icons = [], icon = s.surface.icon.bind(s.surface);
  s.surface.icon = (...args) => { icons.push(args[3]); return icon(...args); };
  await frame();
  assert.deepEqual(icons, [], 'no clip yet: no sound mark');
  assert.equal(await quiet(() => feed.amend(said.id, { audio: true })), 1, 'an item gaining its audio asks for a repaint');
  await frame();
  assert.deepEqual(icons, [C.dim], 'and the bubble now carries the mark');
  assert.equal(await quiet(() => feed.post({ kind: 'heard', body: 'next' })), 1);
  assert.equal(await quiet(() => voice.set('listening')), 1);
  voice.set('idle');
  await g('up'); await g('up'); await g('right');
  feed.amend(said.id, { audio: false });
  assert.equal(hintOf(await frame()), 'up/down: scroll   left: close');
  assert.equal(await quiet(() => feed.amend(said.id, { audio: true })), 1, 'an open message repaints on its change too');
  assert.equal(hintOf(await frame()), 'front: replay   up/down: scroll   left: close');

  s.modes.switchTo('other'); await settle();
  assert.deepEqual(subs(), [0, 0, 0, 1], 'another mode: it let go of everything but the wake-question listener');
  assert.equal(await quiet(() => { feed.amend(said.id, { audio: false }); feed.post({ kind: 'said', body: 'unseen' }); voice.set('thinking'); voice.set('idle'); }), 0, 'and asks for nothing');
  s.modes.switchTo('assistant'); await settle();
  assert.deepEqual(subs(), [1, 1, 1, 1]);
  f = await frame();
  assert.ok(f.includes('unseen'), 'entering draws the feed as it stands');
  assert.equal(hintOf(f), 'front: talk   swipe: select', 'and comes back to the thread, following the newest');
});

test('assistant: a DI module, built and wired by the container', async () => {
  const s = Schema.create;
  // class instances, not plain objects: injection deep-merges plain objects but assigns instances
  const inst = (shape) => Object.assign(new (class Fake {})(), shape);
  const f = {
    ui: inst({ requestRender() {} }), modes: Object.assign(new EventEmitter(), { registered: [], register(m) { this.registered.push(m.id); } }),
    feed: Object.assign(new Feed(), { dir: '', maxItems: 10 }), operator: inst(fakeOperator()), voice: fakeVoice(),
  };
  class Harness { static moduleInfo = { name: 'harness', isMain: true, schema: s().property('assistantMode', s('AssistantMode').required()) }; assistantMode; }
  const mm = new ModuleManager();
  for (const [name, instance] of Object.entries(f)) mm.registerInstance(instance, { name, lifecycle: false });
  mm.registerInstance(fakeLink(), { name: 'device-link', lifecycle: false });
  mm.register(Harness).register(AssistantMode);
  await mm.initModules(await mm.configure({ argv: [], env: {}, defaults: {} }));
  const mode = mm.getModuleInstance('harness').assistantMode;
  assert.ok(mode instanceof AssistantMode);
  assert.deepEqual([mode.modes, mode.ui, mode.feed, mode.operator, mode.voice], [f.modes, f.ui, f.feed, f.operator, f.voice], 'its models and the registry are injected');
  await mode.start();
  assert.deepEqual(f.modes.registered, ['assistant'], 'the mode registers itself');
  assert.equal(f.voice.listenerCount('state'), 0, 'not showing: no view subscription');
});
