// The Comms mode through the real input/surface/ui/modes stack, over fakes for its models
// (feed, operator, voice, world, scanner): the tab row and the swipe between screens, the
// Channel as a message thread (who is on which side, front talks or opens and replays, the
// order rear steps back in), its pending bubbles while a turn runs and its repaint when an
// item changes, the Scan screen's camera corner, detail and pin, that a screen
// follows its models only while it shows and stops what it started when it leaves, the 1 s
// tick repainting only on a changed age, and the DI shape: screens are modules providing
// `CommsScreen`, injected into CommsMode's `screens` array.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ModuleManager, Schema } from '@versionzero/module-manager';
import { CommsMode } from '../src/modes/comms/index.js';
import { ChannelScreen } from '../src/modes/comms/channel.js';
import { ScanScreen, age } from '../src/modes/comms/scan.js';
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
const fakeScanner = () => Object.assign(new EventEmitter(), {
  active: false, state: 'off', stops: 0,
  set(state) { this.state = state; this.emit('state', state); },
  start() { if (!this.active) { this.active = true; this.set('idle'); } },
  stop() { this.stops++; if (this.active) { this.active = false; this.set('off'); } },
  toggle() { if (this.active) this.stop(); else this.start(); return this.active; },
});
const entity = (id, name, kind, lastSeen, claims = [], extra = {}) => ({ id, name, kind, firstSeen: T0 - 600_000, lastSeen, seen: 3, pinned: false, claims: claims.map((text, i) => ({ t: T0 - 60_000 * (claims.length - i), text, source: 'scan' })), ...extra });
const fakeWorld = (list = []) => Object.assign(new EventEmitter(), {
  list, pins: [], thumbs: 0, focused: null,
  focus(id) { this.focused = id; },
  entities() { return this.list.toSorted((a, b) => b.lastSeen - a.lastSeen).map((e) => ({ ...e })); },
  get(id) { const e = this.list.find((x) => x.id === id); return e ? { ...e } : null; },
  pin(id, on) { this.pins.push([id, on]); this.list.find((x) => x.id === id).pinned = on; this.emit('change'); },
  thumb(id) { this.thumbs++; return id === 'e7' ? { width: 4, height: 3, data: new Uint8Array(48).fill(200) } : null; },
});

/** The mode over the real stack. `frame()` is what the panel says after the pending render. */
async function make(t, { entities = [] } = {}) {
  const s = await stack(); t.after(s.stop);
  s.input.tapCode = TAP;
  const feed = new FakeFeed(), voice = fakeVoice(), operator = fakeOperator(), world = fakeWorld(entities), scanner = fakeScanner();
  const channel = Object.assign(new ChannelScreen(), { feed, operator, voice, ui: s.ui });
  const scan = Object.assign(new ScanScreen(), { world, scanner, surface: s.surface, modes: s.modes, ui: s.ui, logger: null });
  const clock = { t: T0 }; scan.now = () => clock.t;
  const comms = Object.assign(new CommsMode(), { screens: [channel, scan], modes: s.modes, ui: s.ui, logger: null });
  const other = fakeMode('other');
  await comms.start(); s.modes.register(other);
  await s.modes.begin(); await settle();
  const texts = [], draw = s.surface.text.bind(s.surface);
  s.surface.text = (x, y, str, options) => { texts.push(str); return draw(x, y, str, options); };
  // the ui draws its status strip last: it is not the mode's, so it is left out
  const frame = async () => { texts.length = 0; s.ui.requestRender(); await settle(); return s.ui.strip ? texts.slice(0, -1) : [...texts]; };
  let now = 10_000;
  const g = async (name) => { if (name === 'tap') s.key(TAP, 1, now); else s.k[name](now); now += 2000; await settle(); };
  return { s, feed, voice, operator, world, scanner, channel, scan, comms, other, clock, frame, g };
}
const hintOf = (texts) => texts.at(-1);

test('comms: a mode with two tabs; swipe left/right moves between the screens, which follow their models only while showing', async (t) => {
  const { s, feed, voice, world, scanner, comms, channel, scan, frame, g } = await make(t);
  const base = { ready: s.surface.listenerCount('ready') - 0, switcher: s.modes.listenerCount('switcher') };
  const subs = () => [feed.listenerCount('post'), voice.listenerCount('state'), world.listenerCount('change'), scanner.listenerCount('state'), s.surface.listenerCount('ready') - base.ready, s.modes.listenerCount('switcher') - base.switcher];
  assert.equal(s.modes.current, comms); assert.deepEqual([comms.id, comms.label, comms.spoken], ['comms', 'Comms', ['comms']]);
  assert.equal(comms.screen, channel); assert.equal(comms.getScreen('scan'), scan);
  assert.deepEqual(subs(), [1, 1, 0, 0, 0, 0], 'the Channel is showing: it follows the feed and the voice state');
  assert.deepEqual((await frame()).slice(0, 2), ['CHANNEL', 'SCAN'], 'the tab row');
  await g('left');
  assert.equal(comms.screen, channel, 'the first tab: no wrap');
  await g('right');
  assert.equal(comms.screen, scan);
  assert.deepEqual(subs(), [0, 0, 1, 1, 1, 1], 'the Channel let go, the Scan screen follows the world, the scanner, the surface and the switcher');
  await g('right');
  assert.equal(comms.screen, scan, 'the last tab: no wrap');
  assert.equal(s.modes.switcher, null, 'a swipe never ascends');
  s.modes.switchTo('other'); await settle();
  assert.deepEqual(subs(), [0, 0, 0, 0, 0, 0], 'leaving the mode unsubscribes the open screen');
  s.modes.switchTo('comms'); await settle();
  assert.equal(comms.screen, scan, 'coming back returns to the tab last shown');
  assert.deepEqual(subs(), [0, 0, 1, 1, 1, 1]);
  assert.equal(comms.open('channel'), true); assert.equal(comms.open('nope'), false);
  assert.deepEqual(subs(), [1, 1, 0, 0, 0, 0]);
  feed.post({ kind: 'said', body: 'posted while showing' });
  assert.ok((await frame()).includes('posted while showing'));
});

test('comms: the mode gives a screen every gesture first, then its tick, and draws it under the tab row', async (t) => {
  const s = await stack(); t.after(s.stop);
  const screen = (id, consume = () => false) => ({ id, label: id, log: [], enter(ctx) { this.log.push(['enter', ctx.wizard]); }, leave() { this.log.push(['leave']); }, onGesture(g) { this.log.push(g); return consume(g); }, tick() { this.log.push('tick'); }, render(surface, rect) { this.rect = rect; } });
  const a = screen('a', (g) => g === 'swipe:right'), b = screen('b');
  const comms = Object.assign(new CommsMode(), { screens: [a, b], modes: s.modes, ui: s.ui, logger: null });
  await comms.start(); await s.modes.begin(); await settle();
  assert.deepEqual(a.log, [['enter', false]]);
  assert.deepEqual(a.rect, { x: 2, y: 28, w: 424, h: 198 }, 'the panel under the tab row, above the hint line');
  assert.equal(comms.onGesture('swipe:right'), true);
  assert.equal(comms.screen, a, 'a swipe the screen consumed does not switch tabs');
  assert.equal(comms.onGesture('press:front'), false); assert.equal(comms.onGesture('press:rear'), false, 'rear at a screen\'s root is the mode\'s root');
  comms.tick();
  assert.deepEqual(a.log.slice(1), ['swipe:right', 'press:front', 'press:rear', 'tick']);
  assert.equal(comms.open('b'), true);
  assert.deepEqual([a.log.at(-1), b.log], [['leave'], [['enter', false]]]);
  assert.equal(comms.onGesture('swipe:left'), true);
  assert.equal(comms.screen, a); assert.deepEqual(b.log, [['enter', false], 'swipe:left', ['leave']]);
});

const stamp = (item) => new Date(item.t).toTimeString().slice(0, 5);
const thread = (texts) => texts.filter((x) => !['CHANNEL', 'SCAN'].includes(x)).slice(0, -1);   // what the screen wrote, less the tab row and the hint

test('channel: the feed as a message thread, the wearer on the right and Jet on the left; front talks, or opens the selected bubble and replays it; rear steps back in order', async (t) => {
  const { s, feed, voice, operator, comms, channel, frame, g } = await make(t);
  assert.ok((await frame()).includes('press front = talk'), 'an empty feed says what to do');
  const heard = feed.post({ kind: 'heard', body: 'what is this meter reading', audio: true });
  const said = feed.post({ kind: 'said', body: 'Two point two one kilohms.', audio: true });
  const photo = feed.post({ kind: 'photo', image: { width: 4, height: 3, data: new Uint8Array(48).fill(128) } });
  const card = feed.post({ kind: 'card', title: 'Fluke 117', body: 'Ohms to 40M\nContinuity under 20 ohms', image: { width: 4, height: 3, data: new Uint8Array(48).fill(128) } });
  const fills = [], fill = s.surface.fillRect.bind(s.surface);
  s.surface.fillRect = (x, y, w, h, colour) => { if (h > 1) fills.push({ x, w, h, colour }); return fill(x, y, w, h, colour); };
  let f = await frame();
  assert.deepEqual(thread(f), ['what is this meter reading', stamp(heard), 'Two point two one kilohms.', stamp(said), stamp(photo), 'Fluke 117', 'Ohms to 40M', 'Continuity under 20 ohms', stamp(card)], 'oldest first, newest at the bottom; a card has its title line, a photo needs no words');
  const bubbles = fills.filter((x) => [C.you, C.jet].includes(x.colour));
  assert.deepEqual(bubbles.map((x) => x.colour), [C.you, C.jet, C.you, C.jet], 'heard and photo are the wearer\'s, said and card are Jet\'s');
  assert.deepEqual(bubbles.map((x) => (x.colour === C.you ? x.x + x.w : x.x)), [422, 2, 422, 2], 'the wearer against the right edge, Jet against the left');
  assert.equal(hintOf(f), 'front: talk   swipe: select');

  await g('frontPress');
  assert.deepEqual(operator.calls, ['talk'], 'front = talk while following the newest');
  assert.equal(channel.opened, null, 'nothing selected: front opens nothing');
  await g('up');
  assert.equal(channel.selected.id, 'f4', 'the first swipe selects the newest');
  fills.length = 0;
  assert.equal(hintOf(await frame()), 'front: open   rear: newest');
  assert.deepEqual(fills.filter((x) => x.colour === C.ok && x.h === 66).map((x) => x.x), [2], 'the selected bubble is the green bar, where Jet\'s card was');
  await g('up'); await g('up'); await g('down');
  assert.equal(channel.selected.id, 'f3', 'swipes walk the thread');
  await g('frontPress');
  assert.equal(channel.opened.id, 'f3', 'front on a selected bubble opens it');
  assert.deepEqual(operator.calls, ['talk', 'replay:f3'], 'and replays its audio, once');
  f = await frame();
  assert.deepEqual(f.slice(2), [stamp(photo), 'photo', '', 'swipe: scroll   rear: close'], 'the open photo has the panel; no clip, no replay hint');
  await frame();
  assert.deepEqual(operator.calls, ['talk', 'replay:f3'], 'a repaint replays nothing');
  await g('right'); await g('down');
  assert.equal(comms.screen, channel, 'an open item consumes the tab swipe');
  assert.equal(channel.opened.id, 'f3');
  await g('frontPress'); await g('tap');
  assert.deepEqual(operator.calls.slice(2), ['replay:f3', 'replay:f3'], 'front inside the open item replays it again (the pad tap is the same button)');

  // a running turn owns both buttons: front is the talk button, rear cancels and nothing else
  voice.set('thinking', { transcript: 'and the range' });
  assert.equal(hintOf(await frame()), 'front: interrupt   rear: cancel');
  await g('frontPress'); await g('rearPress');
  assert.deepEqual(operator.calls.slice(4), ['talk', 'cancel']); assert.equal(channel.opened.id, 'f3', 'the open item stays');
  voice.set('idle', { transcript: '' });
  // rear: the open item, then the selection, then the root
  await g('rearPress');
  assert.equal(channel.opened, null); assert.equal(channel.selected.id, 'f3', 'rear closed the item; the selection stays');
  voice.set('speaking'); await g('frontPress');
  assert.equal(channel.opened, null); assert.equal(operator.calls.at(-1), 'talk', 'with a turn running front talks even on a selected bubble');
  voice.set('idle');
  await g('rearPress');
  assert.equal(channel.selected, null, 'rear let go of the selection: following the newest again');
  assert.equal(s.modes.switcher, null);
  await g('rearPress');
  assert.notEqual(s.modes.switcher, null, 'rear at the root ascends to the switcher');
  assert.deepEqual(operator.calls.filter((x) => x === 'cancel').length, 1, 'an idle rear cancels nothing');
});

test('channel: an opened message is shown whole, with its picture enlarged; an item the ring dropped falls back to the thread', async (t) => {
  const { s, feed, operator, channel, frame, g } = await make(t);
  const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ');
  feed.post({ kind: 'card', title: 'Fluke 117', body: 'Ohms to 40M', image: { width: 160, height: 120, data: new Uint8Array(160 * 120 * 4).fill(255) } });
  const said = feed.post({ kind: 'said', body: long, audio: true });
  let f = await frame();
  const rows = thread(f).slice(3, -1);
  assert.equal(rows.length, 4, 'four rows in the thread'); assert.ok(rows[3].endsWith('~') && long.startsWith(rows.slice(0, 3).join(' ')), 'cut, and marked');
  await g('up'); await g('tap');
  assert.equal(channel.opened.id, 'f2'); assert.deepEqual(operator.calls, ['replay:f2']);
  f = await frame();
  assert.deepEqual(f.slice(2, 4), [stamp(said), 'Jet'], 'headed by who said it and when');
  assert.equal(f.slice(4, -1).join(' '), long, 'every word of it');
  assert.equal(hintOf(f), 'front: replay   swipe: scroll   rear: close');

  await g('rearPress'); await g('up'); await g('frontPress');
  assert.equal(channel.opened.id, 'f1'); assert.equal(operator.calls.at(-1), 'replay:f1', 'the operator is asked whatever the item holds: no clip is its answer to give');
  f = await frame();
  assert.ok(f.includes('Fluke 117') && f.includes('Ohms to 40M'));
  const px = (x, y) => s.surface.raster.px[y * s.surface.raster.pitch + x], body = 28 + 20 + 6;
  assert.deepEqual([px(8, body), px(8 + 218, body + 163), px(8 + 219, body + 80), px(8 + 100, body + 164)], [0xffff, 0xffff, 0, 0], 'the picture fills the height under the heading: 219x164 from 160x120');
  feed.drop('f1');
  assert.equal(channel.opened, null);
  assert.ok(thread(await frame()).includes(stamp(said)), 'the thread again');
});

test('channel: the running turn is pending bubbles under the thread until the feed holds it', async (t) => {
  const { s, feed, voice, channel, frame, g } = await make(t);
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
  assert.equal(channel.selected.id, earlier.id, 'a pending bubble is not for selecting: the newest item is');
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
  assert.deepEqual(f.slice(-6, -1), ['Two to three seconds.', stamp(said), 'Solder', '2-3 s per joint', stamp(feed.get('f5'))]);
  assert.equal(hintOf(f), 'front: talk   swipe: select');
  voice.configured = false;
  assert.equal(hintOf(await frame()), 'voice: not configured');
});

test('channel: follows the feed (post, change) and the voice state only while showing; a change repaints', async (t) => {
  const { s, feed, voice, comms, frame, g } = await make(t);
  const subs = () => [feed.listenerCount('post'), feed.listenerCount('change'), voice.listenerCount('state')];
  let asked = 0; const request = s.ui.requestRender.bind(s.ui);
  s.ui.requestRender = () => { asked++; request(); };
  const quiet = async (act) => { await settle(); asked = 0; act(); return asked; };
  assert.deepEqual(subs(), [1, 1, 1]);
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
  await g('up'); await g('up'); await g('frontPress');
  feed.amend(said.id, { audio: false });
  assert.equal(hintOf(await frame()), 'swipe: scroll   rear: close');
  assert.equal(await quiet(() => feed.amend(said.id, { audio: true })), 1, 'an open item repaints on its change too');
  assert.equal(hintOf(await frame()), 'front: replay   swipe: scroll   rear: close');

  await g('rearPress'); await g('rearPress'); await g('right');
  assert.equal(comms.screen.id, 'scan'); assert.deepEqual(subs(), [0, 0, 0], 'another tab: the Channel let go of everything');
  assert.equal(await quiet(() => { feed.amend(said.id, { audio: false }); feed.post({ kind: 'said', body: 'unseen' }); voice.set('thinking'); voice.set('idle'); }), 0, 'and asks for nothing');
  await g('left');
  assert.deepEqual(subs(), [1, 1, 1]);
  assert.ok((await frame()).includes('unseen'), 'entering draws the feed as it stands');
  s.modes.switchTo('other'); await settle();
  assert.deepEqual(subs(), [0, 0, 0], 'leaving the mode unsubscribes');
});

test('scan: front toggles the scanner; the camera runs in the corner while scanning, pauses under the switcher, stops on leave', async (t) => {
  const list = [entity('e7', 'multimeter', 'tool', T0 - 5000, ['display off', 'reads 2.210 kOhm']), entity('e6', 'solder spool', 'material', T0 - 65_000, ['0.8 mm leaded'])];
  const { s, world, scanner, comms, scan, clock, frame, g } = await make(t, { entities: list });
  const vf = { x: 428 - 120 - 6, y: 16, w: 120, h: 90 }, sent = (line) => s.link.sent.filter((l) => l === line).length;
  await g('right');
  let f = await frame();
  assert.deepEqual(f.slice(2, -1), ['now', 'multimeter', 'tool - reads 2.210 kOhm', '1m', 'solder spool', 'material - 0.8 mm leaded'], 'the entities, most recent first: age, name, kind and newest claim');
  assert.equal(hintOf(f), 'front: scan   swipe: select');
  assert.equal(s.surface.viewfinderRect, null); assert.equal(s.ui.strip, null);

  await g('frontPress');
  assert.equal(scanner.active, true, 'front = scanner.toggle()');
  assert.deepEqual(s.surface.viewfinderRect, vf); assert.equal(sent('Z 302 16 120 90 10'), 1);
  assert.equal(s.ui.strip.text, 'scanning');
  f = await frame();
  assert.ok(f.includes('watching') && f.includes('2 in the log')); assert.equal(hintOf(f), 'front: stop   swipe: select');
  scanner.set('looking'); await settle();
  assert.equal(s.ui.strip.text, 'looking'); assert.ok((await frame()).includes('looking...'));
  assert.equal(sent('Z 302 16 120 90 10'), 1, 'a scan starting does not restart the camera');
  list[1].lastSeen = clock.t = T0 + 1000; list[1].claims.push({ t: clock.t, text: 'half left', source: 'scan' });
  world.emit('change'); scanner.set('idle');
  assert.deepEqual((await frame()).filter((x) => / - |^(multimeter|solder spool)$/.test(x)), ['solder spool', 'material - half left', 'multimeter', 'tool - reads 2.210 kOhm'], 'a sighting re-sorts the tiles');

  await g('frontHold');
  assert.notEqual(s.modes.switcher, null);
  assert.equal(s.surface.viewfinderRect, null, 'the camera is paused under the mode menu'); assert.equal(scanner.active, true);
  await g('frontHold');
  assert.deepEqual(s.surface.viewfinderRect, vf, 'and resumes when the menu closes back to us');

  await g('left');
  assert.equal(comms.screen.id, 'channel');
  assert.equal(scanner.active, false, 'leaving the screen stops the scanning'); assert.equal(s.surface.viewfinderRect, null); assert.equal(s.ui.strip, null);
  await g('right'); await g('frontPress');
  assert.deepEqual(s.surface.viewfinderRect, vf);
  s.modes.switchTo('other'); await settle();
  assert.equal(scanner.active, false, 'leaving the mode does too'); assert.equal(s.surface.viewfinderRect, null); assert.equal(s.ui.strip, null);
  const stops = scanner.stops;
  scanner.set('looking'); await settle();   // a `look` scans without us
  assert.equal(s.ui.strip, null, 'nothing of ours reacts once we are gone'); assert.equal(scanner.stops, stops);
  assert.equal(scan.opened, null);

  // left by picking another mode in the menu (the camera was paused under it): the pause does not outlive us
  s.modes.switchTo('comms'); await settle(); await g('frontPress');
  assert.deepEqual(s.surface.viewfinderRect, vf);
  await g('frontHold'); await g('down'); await g('frontPress');
  assert.equal(s.modes.current.id, 'other'); assert.equal(s.surface.viewfinderRect, null); assert.equal(scanner.active, false);
  assert.equal(s.surface.viewfinderPaused, false);
  s.modes.switchTo('comms'); await settle(); await g('frontPress');
  assert.deepEqual(s.surface.viewfinderRect, vf, 'the next scan gets its camera');
});

test('scan: front stops the scan, opens the selected entity, pins it there; rear steps back', async (t) => {
  const list = [entity('e7', 'multimeter', 'tool', T0 - 5000, ['display off', 'reads 2.210 kOhm'], { where: { lat: 37.774929, lon: -122.419416 } }), entity('e6', 'solder spool', 'material', T0 - 65_000)];
  const { s, world, scanner, comms, scan, frame, g } = await make(t, { entities: list });
  await g('right'); await g('frontPress');
  assert.ok(s.surface.viewfinderRect);
  await g('down'); await g('frontPress');
  assert.equal(scanner.active, false, 'while scanning front stops, whatever is selected'); assert.equal(scan.opened, null);
  assert.equal(s.surface.viewfinderRect, null, 'review: no camera');
  assert.equal(hintOf(await frame()), 'front: open   swipe: select   rear: unselect');
  await g('frontPress');
  assert.equal(scan.opened.id, 'e7', 'in review front opens the selected entity');
  let f = await frame();
  const clock = (ts) => new Date(ts).toTimeString().slice(0, 5);
  assert.deepEqual(f.slice(2), ['tool', 'multimeter', 'first seen 10m ago', 'last seen just now, 3 times', 'at 37.77493, -122.41942', '', `${clock(T0 - 60_000)} reads 2.210 kOhm`, `${clock(T0 - 120_000)} display off`, 'front: pin   swipe: scroll   rear: back'], 'kind, name, when, where, then the claims newest first');
  await g('frontPress');
  assert.deepEqual(world.pins, [['e7', true]], 'front in the detail = world.pin(id, !pinned)');
  f = await frame();
  assert.equal(f[4], 'pinned'); assert.equal(hintOf(f), 'front: unpin   swipe: scroll   rear: back');
  await g('frontPress');
  assert.deepEqual(world.pins.at(-1), ['e7', false]);
  await g('left'); await g('up');
  assert.equal(comms.screen, scan, 'an open entity consumes the tab swipe'); assert.equal(scan.opened.id, 'e7');
  await g('rearPress');
  assert.equal(scan.opened, null);
  await g('rearPress');
  assert.equal(hintOf(await frame()), 'front: scan   swipe: select', 'rear let go of the selection');
  assert.equal(s.modes.switcher, null);
  await g('rearPress');
  assert.notEqual(s.modes.switcher, null, 'rear at the root ascends');
  await g('rearPress');

  await g('down'); await g('tap');
  assert.equal(scan.opened.id, 'e7');
  list.shift(); world.emit('change');   // it expired under us
  assert.equal(scan.opened, null);
  assert.ok((await frame()).includes('solder spool'), 'an entity that is gone falls back to the list');
});

test('scan: the tick repaints only when an age on the glass reads differently', async (t) => {
  const list = [entity('e7', 'multimeter', 'tool', T0 - 2000), entity('e6', 'solder spool', 'material', T0 - 125_000)];
  const { s, world, scan, clock, frame, g } = await make(t, { entities: list });
  await g('right');
  assert.deepEqual((await frame()).filter((x) => ['now', '2m'].includes(x)), ['now', '2m']);
  let asked = 0; const request = s.ui.requestRender.bind(s.ui);
  s.ui.requestRender = () => { asked++; request(); };
  clock.t = T0 + 5000; scan.tick();
  assert.equal(asked, 0, 'seven seconds old still reads "now", 2m10s still "2m": nothing to repaint');
  clock.t = T0 + 9000; scan.tick();
  assert.equal(asked, 1, '11 s: the newest now reads "10s"');
  assert.ok((await frame()).includes('10s'));
  asked = 0; scan.tick();
  assert.equal(asked, 0);
  clock.t = T0 + 55_000; scan.tick();
  assert.equal(asked, 1, 'the older one turned "3m"');
  assert.deepEqual((await frame()).filter((x) => ['50s', '3m'].includes(x)), ['50s', '3m']);
  const before = world.thumbs;
  await frame();
  assert.equal(world.thumbs - before, 2, 'a thumbnail is asked for only for a tile that is drawn');

  await g('down'); await g('tap');   // the detail's ages are first and last seen
  asked = 0; clock.t += 1000; scan.tick();
  assert.equal(asked, 0);
  clock.t += 60_000; scan.tick();
  assert.equal(asked, 1);

  assert.deepEqual([0, 9999, 10_000, 59_000, 60_000, 3_599_000, 3_600_000, 86_400_000 * 2, -5].map(age), ['now', 'now', '10s', '50s', '1m', '59m', '1h', '2d', 'now']);
});

test('comms: screens are DI modules providing CommsScreen, built and configured by the container', async () => {
  const s = Schema.create;
  // class instances, not plain objects: injection deep-merges plain objects but assigns instances
  const inst = (shape) => Object.assign(new (class Fake {})(), shape);
  const fakes = () => ({
    ui: inst({ requestRender() {}, setStrip() {} }), modes: Object.assign(new EventEmitter(), { registered: [], register(m) { this.registered.push(m.id); } }),
    feed: Object.assign(new Feed(), { dir: '', maxItems: 10 }), operator: inst(fakeOperator()), voice: fakeVoice(), world: fakeWorld(), scanner: fakeScanner(),
    surface: Object.assign(new EventEmitter(), { width: 428, height: 240 }),
  });
  class Harness { static moduleInfo = { name: 'harness', isMain: true, schema: s().property('comms', s('CommsMode').required()) }; comms; }
  const build = async (f, defaults, extra = () => {}) => {
    const mm = new ModuleManager();
    for (const [name, instance] of Object.entries(f)) mm.registerInstance(instance, { name, lifecycle: false });
    mm.registerInstance(fakeLink(), { name: 'device-link', lifecycle: false });
    mm.register(Harness).register(CommsMode);
    extra(mm);
    await mm.initModules(await mm.configure({ argv: [], env: {}, defaults }));
    return mm.getModuleInstance('harness').comms;
  };
  const f = fakes(), comms = await build(f, {});
  assert.ok(comms instanceof CommsMode);
  assert.deepEqual(comms.screens.map((x) => x.id), ['channel', 'scan'], 'the CommsScreen array defaults to the two, in tab order');
  const [channel, scan] = comms.screens;
  assert.ok(channel instanceof ChannelScreen); assert.ok(scan instanceof ScanScreen);
  assert.deepEqual([channel.feed, channel.operator, channel.voice, channel.ui], [f.feed, f.operator, f.voice, f.ui], 'a screen gets its own dependencies injected');
  assert.deepEqual([scan.world, scan.scanner, scan.surface, scan.modes, scan.ui], [f.world, f.scanner, f.surface, f.modes, f.ui]);
  await comms.start();
  assert.deepEqual(f.modes.registered, ['comms'], 'the mode registers itself; its screens do not');

  // the screens array is itself configuration: a subset (or a personal/ provider) reshapes the tabs
  class PartyScreen { static moduleInfo = { name: 'party-screen', provides: 'CommsScreen' }; id = 'party'; label = 'Party'; render() {} }
  const comms2 = await build(fakes(), { commsMode: { screens: ['scan-screen', 'party-screen'] } }, (mm) => mm.registerInstance(new PartyScreen()));
  assert.deepEqual(comms2.screens.map((x) => x.id), ['scan', 'party'], 'tab order follows the configured array');
});

test('scan: what is selected or open is the world\'s focus, and nothing is once the screen is left', async (t) => {
  const list = [entity('e7', 'multimeter', 'tool', T0 - 5000, ['reads 2.210 kOhm']), entity('e6', 'solder spool', 'material', T0 - 65_000)];
  const { world, g } = await make(t, { entities: list });
  const focused = []; const set = world.focus.bind(world); world.focus = (id) => { if (id !== undefined) focused.push(id); return set(id); };
  await g('right'); await g('down');
  assert.equal(focused.at(-1), 'e7', 'the selection');
  await g('down'); assert.equal(focused.at(-1), 'e6');
  await g('frontPress'); assert.equal(focused.at(-1), 'e6', 'the open entity');
  await g('rearPress'); await g('rearPress'); assert.equal(focused.at(-1), null, 'unselected');
  await g('down'); assert.equal(focused.at(-1), 'e7');
  await g('left'); assert.equal(focused.at(-1), null, 'left the screen');
});
