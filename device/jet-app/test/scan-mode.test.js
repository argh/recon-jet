// The Scan mode through the real input/surface/ui/modes stack, over fakes for its models
// (world, scanner): front is the scanner's switch and never opens anything, the camera corner
// while scanning (paused under the switcher, stopped on leave, stopped while a detail has the
// panel), swipe right/left opening and closing the detail, front pinning there, the order rear
// steps back in, the selection published as the world's focus, that it follows its models only
// while showing, the 1 s tick repainting only on a changed age, the scanner's column (the
// viewfinder border as readiness to capture, the frame under analysis in its slot, the
// animation timer only while something moves), the border geometry, and the DI shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ModuleManager, Schema } from '@versionzero/module-manager';
import { ScanMode, age } from '../src/modes/scan/index.js';
import { ring } from '../src/modules/ui/ring.js';
import { C } from '../src/modules/ui/style.js';
import { stack, fakeMode, fakeLink, settle } from './helpers.js';

const TAP = 330;   // a pad tap of its own: the default tap code (28) is also Enter, which input reads as a front press
const T0 = 1_000_000;

const fakeScanner = () => Object.assign(new EventEmitter(), {
  active: false, state: 'off', stops: 0, frame: null, due: null,
  set(state) { this.state = state; this.emit('state', state); },
  start() { if (!this.active) { this.active = true; this.set('idle'); } },
  stop() { this.stops++; if (this.active) { this.active = false; this.due = null; this.set('off'); } },
  arm(from, at) { this.due = { from, at }; this.emit('due', this.due); },
  /** a capture: the wait is over, the frame is being analysed */
  take(frame) { this.due = null; this.frame = frame; this.emit('frame', frame); this.set('looking'); },
  /** its analysis ended */
  done() { this.frame = null; this.emit('frame', null); this.set('idle'); },
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

/** The mode over the real stack, with another mode after it. `frame()` is what the panel says after the pending render. */
async function make(t, { entities = [] } = {}) {
  const s = await stack(); t.after(s.stop);
  s.input.tapCode = TAP;
  const world = fakeWorld(entities), scanner = fakeScanner();
  const scan = Object.assign(new ScanMode(), { modes: s.modes, ui: s.ui, world, scanner, surface: s.surface, logger: null });
  const clock = { t: T0 }; scan.now = () => clock.t;
  const other = fakeMode('other');
  const subs0 = [s.surface.listenerCount('ready'), s.modes.listenerCount('switcher')];
  await scan.start(); s.modes.register(other);
  await s.modes.begin(); await settle();
  const texts = [], draw = s.surface.text.bind(s.surface);
  s.surface.text = (x, y, str, options) => { texts.push(str); return draw(x, y, str, options); };
  // the ui draws its status strip last: it is not the mode's, so it is left out
  const frame = async () => { texts.length = 0; s.ui.requestRender(); await settle(); return s.ui.strip ? texts.slice(0, -1) : [...texts]; };
  let now = 10_000;
  const g = async (name) => { if (name === 'tap') s.key(TAP, 1, now); else s.k[name](now); now += 2000; await settle(); };
  const subs = () => [world.listenerCount('change'), scanner.listenerCount('state'), s.surface.listenerCount('ready') - subs0[0], s.modes.listenerCount('switcher') - subs0[1]];
  return { s, world, scanner, scan, other, clock, frame, g, subs };
}
const hintOf = (texts) => texts.at(-1);

test('scan: front toggles the scanner; the camera runs in the corner while scanning, pauses under the switcher, stops on leave; the mode follows its models only while showing', async (t) => {
  const list = [entity('e7', 'multimeter', 'tool', T0 - 5000, ['display off', 'reads 2.210 kOhm']), entity('e6', 'solder spool', 'material', T0 - 65_000, ['0.8 mm leaded'])];
  const { s, world, scanner, scan, clock, frame, g, subs } = await make(t, { entities: list });
  const vf = { x: 428 - 120 - 6, y: 16, w: 120, h: 90 }, sent = (line) => s.link.sent.filter((l) => l === line).length;
  assert.equal(s.modes.current, scan);
  assert.deepEqual([scan.id, scan.label, scan.spoken], ['scan', 'Scan', ['scan', 'scanner']]);
  assert.equal(s.modes.spoken('scanner'), scan);
  assert.deepEqual(subs(), [1, 1, 1, 1], 'showing: it follows the world, the scanner, the surface and the switcher');
  const tiles = [], fill = s.surface.fillRect.bind(s.surface);
  s.surface.fillRect = (x, y, w, h, colour) => { if (w > 20 && h > 20) tiles.push({ x, y, w, h }); return fill(x, y, w, h, colour); };
  let f = await frame();
  assert.deepEqual(f.slice(0, -1), ['now', 'multimeter', 'tool - reads 2.210 kOhm', '1m', 'solder spool', 'material - 0.8 mm leaded'], 'the entities, most recent first: age, name, kind and newest claim');
  assert.deepEqual(tiles[0], { x: 2, y: 14, w: 420, h: 48 }, 'the review list has the panel from the strip down, full width');
  assert.equal(hintOf(f), 'front: scan   swipe: select');
  assert.equal(s.surface.viewfinderRect, null); assert.equal(s.ui.strip, null);

  await g('frontPress');
  assert.equal(scanner.active, true, 'front = scanner.toggle()');
  assert.deepEqual(s.surface.viewfinderRect, vf); assert.equal(sent('Z 302 16 120 90 10'), 1);
  assert.equal(s.ui.strip.text, 'scanning');
  tiles.length = 0;
  f = await frame();
  assert.ok(f.includes('2 logged')); assert.equal(hintOf(f), 'front: stop   swipe: select');
  assert.deepEqual(tiles[0], { x: 2, y: 14, w: 290, h: 48 }, 'while scanning the tiles stop short of the camera corner');
  scanner.set('looking'); await settle();
  assert.equal(s.ui.strip.text, 'analyzing');
  assert.equal(sent('Z 302 16 120 90 10'), 1, 'a scan starting does not restart the camera');
  list[1].lastSeen = clock.t = T0 + 1000; list[1].claims.push({ t: clock.t, text: 'half left', source: 'scan' });
  world.emit('change'); scanner.set('idle');
  assert.deepEqual((await frame()).filter((x) => / - |^(multimeter|solder spool)$/.test(x)), ['solder spool', 'material - half left', 'multimeter', 'tool - reads 2.210 kOhm'], 'a sighting re-sorts the tiles');

  await g('frontHold');
  assert.notEqual(s.modes.switcher, null);
  assert.equal(s.surface.viewfinderRect, null, 'the camera is paused under the mode menu'); assert.equal(scanner.active, true);
  await g('frontHold');
  assert.deepEqual(s.surface.viewfinderRect, vf, 'and resumes when the menu closes back to us');

  s.modes.switchTo('other'); await settle();
  assert.equal(scanner.active, false, 'leaving the mode stops the scanning'); assert.equal(s.surface.viewfinderRect, null); assert.equal(s.ui.strip, null);
  assert.deepEqual(subs(), [0, 0, 0, 0], 'and lets go of every model');
  const stops = scanner.stops;
  scanner.set('looking'); await settle();   // a `look` scans without us
  assert.equal(s.ui.strip, null, 'nothing of ours reacts once we are gone'); assert.equal(scanner.stops, stops);
  assert.equal(scan.opened, null);

  // left by picking another mode in the menu (the camera was paused under it): the pause does not outlive us
  s.modes.switchTo('scan'); await settle(); await g('frontPress');
  assert.deepEqual(subs(), [1, 1, 1, 1]);
  assert.deepEqual(s.surface.viewfinderRect, vf);
  await g('frontHold'); await g('down'); await g('frontPress');
  assert.equal(s.modes.current.id, 'other'); assert.equal(s.surface.viewfinderRect, null); assert.equal(scanner.active, false);
  assert.equal(s.surface.viewfinderPaused, false);
  s.modes.switchTo('scan'); await settle(); await g('frontPress');
  assert.deepEqual(s.surface.viewfinderRect, vf, 'the next scan gets its camera');
});

test('scan: front never opens; swipe right opens the selected entity, front pins it there, swipe left or rear closes; rear steps back', async (t) => {
  const list = [entity('e7', 'multimeter', 'tool', T0 - 5000, ['display off', 'reads 2.210 kOhm'], { where: { lat: 37.774929, lon: -122.419416 } }), entity('e6', 'solder spool', 'material', T0 - 65_000)];
  const { s, world, scanner, scan, frame, g } = await make(t, { entities: list });
  await g('right');
  assert.equal(scan.opened, null, 'nothing selected: a swipe right opens nothing');
  await g('frontPress');
  assert.ok(s.surface.viewfinderRect);
  await g('down');
  assert.equal(hintOf(await frame()), 'front: stop   right: open   rear: unselect');
  await g('frontPress');
  assert.equal(scanner.active, false, 'front stops the scan, whatever is selected'); assert.equal(scan.opened, null);
  assert.equal(s.surface.viewfinderRect, null, 'review: no camera');
  assert.equal(hintOf(await frame()), 'front: scan   right: open   rear: unselect');
  await g('frontPress'); await g('tap'); await g('frontPress');
  assert.equal(scan.opened, null, 'in review too, front (or the pad tap) only switches the scanner: it never opens the selection');
  assert.equal(scanner.active, true); assert.deepEqual(world.pins, []);
  assert.ok(s.surface.viewfinderRect);
  await g('right');
  assert.equal(scan.opened.id, 'e7', 'swipe right opens the selected entity');
  assert.equal(scanner.active, true, 'the scan goes on behind the detail'); assert.equal(s.surface.viewfinderRect, null, 'its camera corner does not: the detail has the panel');
  let f = await frame();
  const clock = (ts) => new Date(ts).toTimeString().slice(0, 5);
  assert.deepEqual(f, ['tool', 'multimeter', 'first seen 10m ago', 'last seen just now, 3 times', 'at 37.77493, -122.41942', '', `${clock(T0 - 60_000)} reads 2.210 kOhm`, `${clock(T0 - 120_000)} display off`, 'front: pin   up/down: scroll   left: back'], 'kind, name, when, where, then the claims newest first');
  await g('frontPress');
  assert.deepEqual(world.pins, [['e7', true]], 'front in the detail = world.pin(id, !pinned)');
  assert.equal(scanner.active, true, 'and not the scanner\'s switch');
  f = await frame();
  assert.equal(f[2], 'pinned'); assert.equal(hintOf(f), 'front: unpin   up/down: scroll   left: back');
  await g('tap');
  assert.deepEqual(world.pins.at(-1), ['e7', false]);
  await g('right'); await g('up'); await g('down');
  assert.equal(scan.opened.id, 'e7', 'up/down scroll the detail');
  await g('left');
  assert.equal(scan.opened, null, 'swipe left closes it');
  assert.ok(s.surface.viewfinderRect, 'back at the list the camera corner returns');
  assert.equal(hintOf(await frame()), 'front: stop   right: open   rear: unselect', 'the selection stayed');
  await g('left');
  assert.equal(s.modes.current, scan, 'a swipe left at the list does nothing');
  await g('right'); await g('rearPress');
  assert.equal(scan.opened, null, 'rear closes the detail too');
  await g('frontPress');
  assert.equal(scanner.active, false);
  await g('rearPress');
  assert.equal(hintOf(await frame()), 'front: scan   swipe: select', 'rear let go of the selection');
  assert.equal(s.modes.switcher, null);
  await g('rearPress');
  assert.notEqual(s.modes.switcher, null, 'rear at the root ascends');
  await g('rearPress');

  await g('down'); await g('right');
  assert.equal(scan.opened.id, 'e7');
  list.shift(); world.emit('change');   // it expired under us
  assert.equal(scan.opened, null);
  assert.ok((await frame()).includes('solder spool'), 'an entity that is gone falls back to the list');
});

test('scan: what is selected or open is the world\'s focus, and nothing is once the mode is left', async (t) => {
  const list = [entity('e7', 'multimeter', 'tool', T0 - 5000, ['reads 2.210 kOhm']), entity('e6', 'solder spool', 'material', T0 - 65_000)];
  const { s, world, g } = await make(t, { entities: list });
  const focused = []; const set = world.focus.bind(world); world.focus = (id) => { if (id !== undefined) focused.push(id); return set(id); };
  await g('down');
  assert.equal(focused.at(-1), 'e7', 'the selection');
  await g('down'); assert.equal(focused.at(-1), 'e6');
  await g('right'); assert.equal(focused.at(-1), 'e6', 'the open entity');
  await g('left'); assert.equal(focused.at(-1), 'e6', 'closed: still selected');
  await g('rearPress'); assert.equal(focused.at(-1), null, 'unselected');
  await g('down'); assert.equal(focused.at(-1), 'e7');
  await g('frontPress'); assert.equal(focused.at(-1), 'e7', 'the scanner\'s switch leaves the focus alone');
  s.modes.switchTo('other'); await settle();
  assert.equal(focused.at(-1), null, 'left the mode');
});

test('scan: the tick repaints only when an age on the glass reads differently', async (t) => {
  const list = [entity('e7', 'multimeter', 'tool', T0 - 2000), entity('e6', 'solder spool', 'material', T0 - 125_000)];
  const { s, world, scan, clock, frame, g } = await make(t, { entities: list });
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

  await g('down'); await g('right');   // the detail's ages are first and last seen
  asked = 0; clock.t += 1000; scan.tick();
  assert.equal(asked, 0);
  clock.t += 60_000; scan.tick();
  assert.equal(asked, 1);

  assert.deepEqual([0, 9999, 10_000, 59_000, 60_000, 3_599_000, 3_600_000, 86_400_000 * 2, -5].map(age), ['now', 'now', '10s', '50s', '1m', '59m', '1h', '2d', 'now']);
});

test('ring: a span of a border, clockwise from the top left, as rectangles', () => {
  const r = { x: 10, y: 20, w: 40, h: 20 }, area = (rects) => rects.reduce((n, b) => n + b.w * b.h, 0);   // a lap is 120 px
  assert.deepEqual(ring(r, 2, 0, 0), [], 'nothing');
  assert.deepEqual(ring(r, 2, 0, 0.25), [{ x: 10, y: 20, w: 30, h: 2 }], 'a quarter: 30 px along the top');
  assert.deepEqual(ring(r, 2, 0, 0.5), [{ x: 10, y: 20, w: 40, h: 2 }, { x: 48, y: 20, w: 2, h: 20 }], 'half: the top, then down the right');
  assert.deepEqual(ring(r, 2, 0.5, 0.75), [{ x: 20, y: 38, w: 30, h: 2 }], 'the bottom runs right to left');
  assert.deepEqual(ring(r, 2, 0, 1), [{ x: 10, y: 20, w: 40, h: 2 }, { x: 48, y: 20, w: 2, h: 20 }, { x: 10, y: 38, w: 40, h: 2 }, { x: 10, y: 20, w: 2, h: 20 }], 'the whole border');
  assert.deepEqual(ring(r, 2, 0.875, 1.125), [{ x: 10, y: 20, w: 2, h: 15 }, { x: 10, y: 20, w: 15, h: 2 }], 'a span past the corner wraps: up the left, on along the top');
  assert.deepEqual(ring(r, 2, 2.875, 3.125), ring(r, 2, 0.875, 1.125), 'the start is taken modulo a lap');
  assert.equal(area(ring(r, 2, 0.3, 5)), area(ring(r, 2, 0, 1)), 'never more than one lap');
  assert.deepEqual(ring(r, 2, 0.5, 0.2), [], 'a negative span is nothing');
});

test('scan: the viewfinder border is the readiness to capture, the frame under analysis sits in the slot under it, and the animation runs only while something moves', async (t) => {
  const list = [entity('e7', 'multimeter', 'tool', T0 - 5000)];
  const { s, scanner, scan, clock, frame, g } = await make(t, { entities: list });
  scan.frameMs = 100_000;   // the timer is observed, not waited for
  const cam = { x: 302, y: 16, w: 120, h: 90 }, slot = { x: 302, y: 128, w: 120, h: 90 };
  const px = (x, y) => s.surface.raster.px[y * s.surface.raster.pitch + x];
  const c16 = (c) => ((c >> 8) & 0xf800) | ((c >> 5) & 0x07e0) | ((c >> 3) & 0x1f), [OK, FAINT, TITLE, DIM] = [C.ok, C.faint, C.title, C.dim].map(c16);
  /** the colour of the viewfinder border `d` px along its walk (the lap is 2 * (124 + 94) = 436 px) */
  const border = (d) => (d < 124 ? px(300 + d, 14) : d < 218 ? px(423, 14 + d - 124) : d < 342 ? px(423 - (d - 218), 107) : px(300, 107 - (d - 342)));
  const inside = (r) => { let n = 0; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (px(x, y)) n++; return n; };
  assert.deepEqual(scan.slotRect, slot, 'the slot: the camera\'s footprint, under it and a caption row, above the hint line');
  assert.equal(scan.readiness, null); assert.equal(scan.animating, false, 'review: nothing to animate');
  await frame();
  assert.equal(border(200), 0, 'and no column');

  await g('frontPress');
  assert.deepEqual(s.surface.viewfinderRect, cam);
  assert.equal(scan.readiness, null); assert.equal(scan.animating, false, 'scanning but no capture armed: nothing moves, no timer');
  await frame();
  assert.deepEqual([border(1), border(200), border(400)], [DIM, DIM, DIM], 'nothing armed: the plain grey border');
  scanner.arm(T0, T0 + 10_000);
  assert.equal(scan.animating, true, 'a capture is due: the border fills, the timer runs');
  clock.t = T0 + 3000;
  assert.equal(scan.readiness, 0.3);
  let f = await frame();
  assert.deepEqual([border(1), border(129), border(132), border(300)], [OK, OK, FAINT, FAINT], '30%: green from the top left corner clockwise for 131 px of the 436, the rest the track');
  assert.ok(f.includes('1 logged') && !f.includes('analyzing'));
  assert.equal(inside(slot), 0, 'the slot is empty');
  clock.t = T0 + 9000; await frame();
  assert.deepEqual([border(1), border(391), border(394), border(430)], [OK, OK, FAINT, FAINT], '90%');
  assert.equal(inside(cam), 0, 'nothing is ever drawn in the viewfinder: those pixels are jetd\'s');

  await g('frontHold');
  assert.equal(scan.animating, false, 'under the mode menu nothing animates');
  await g('frontHold');
  assert.equal(scan.animating, true);
  await g('down'); await g('right');
  assert.equal(scan.animating, false, 'nor behind an open detail');
  await g('left'); await g('rearPress');
  assert.equal(scan.animating, true);

  // the capture: no further one can happen while this frame is analysed
  const image = { width: 120, height: 90, data: new Uint8Array(120 * 90 * 4).fill(255) };
  clock.t = T0 + 10_000; scanner.take(image);
  assert.equal(scan.readiness, null); assert.equal(scan.animating, true, 'the analysed frame is animated');
  assert.equal(s.ui.strip.text, 'analyzing');
  f = await frame();
  assert.deepEqual([border(1), border(200), border(400)], [DIM, DIM, DIM], 'analysing: the viewfinder border is grey, brighter than the empty track');
  assert.ok(f.includes('analyzing') && !f.includes('1 logged'));
  assert.equal(inside(cam), 0, 'the slide starts behind the viewfinder: nothing of it is drawn there');
  clock.t += 150; await frame();
  assert.deepEqual([px(310, 107), px(310, 108), px(310, 161), px(310, 162)], [DIM, 0xffff, 0xffff, 0], 'halfway down: the part of the frame that has come out from under the viewfinder');
  assert.equal(inside(cam), 0);
  clock.t += 150; await frame();
  assert.deepEqual([px(302, 128), px(421, 217), px(302, 220)], [0xffff, 0xffff, 0], 'arrived: the frame fills the slot, 1:1');
  const circle = (d) => (d < 124 ? px(300 + d, 126) : d < 218 ? px(423, 126 + d - 124) : d < 342 ? px(423 - (d - 218), 219) : px(300, 219 - (d - 342)));
  assert.deepEqual([circle(1), circle(108), circle(111), circle(300)], [TITLE, TITLE, FAINT, FAINT], 'a bright quarter of its border, starting at the top left');
  clock.t += 600; await frame();
  assert.deepEqual([circle(1), circle(219), circle(326), circle(329)], [FAINT, TITLE, TITLE, FAINT], 'half a lap later it is on the far side');
  assert.equal(inside(cam), 0);

  scanner.done();
  assert.equal(scan.animating, false, 'analysed, and no capture armed yet: still');
  f = await frame();
  assert.equal(inside({ x: 300, y: 126, w: 124, h: 94 }), 0, 'the slot is cleared, border and all');
  assert.ok(f.includes('1 logged'));
  scanner.arm(clock.t, clock.t + 5000);
  assert.equal(scan.animating, true);
  clock.t += 5000;
  assert.equal(scan.readiness, 1, 'due: full');
  scanner.arm(clock.t - 5000, clock.t - 1);   // re-armed already past (a head turn brought it forward): nothing left to fill
  assert.equal(scan.animating, false, 'a full border does not keep the timer');
  await frame();
  assert.deepEqual([border(1), border(430)], [OK, OK]);

  scanner.arm(clock.t, clock.t + 5000);
  await g('frontPress');
  assert.equal(scanner.active, false); assert.equal(scan.animating, false, 'scanning stopped: the timer is gone');
  await frame();
  assert.equal(border(200), 0, 'and the column with it: the review list is full width');
  await g('frontPress'); scanner.arm(clock.t, clock.t + 5000);
  assert.equal(scan.animating, true);
  s.modes.switchTo('other'); await settle();
  assert.equal(scan.animating, false, 'left the mode: the timer is gone');
  assert.deepEqual([scanner.listenerCount('frame'), scanner.listenerCount('due'), scanner.listenerCount('state')], [0, 0, 0]);
  scanner.take(image);   // a `look` scans without us
  assert.equal(scan.animating, false);
});

test('scan: the animation timer asks for a repaint each period and stops itself once the border is full', async (t) => {
  const { s, scanner, scan, clock, g } = await make(t);
  scan.frameMs = 5;
  await g('frontPress');
  let asked = 0; const request = s.ui.requestRender.bind(s.ui);
  s.ui.requestRender = () => { asked++; request(); };
  scanner.arm(T0, T0 + 1000); await settle(); asked = 0;
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(asked >= 2, 'repaints while the border fills');
  clock.t = T0 + 1000;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(scan.animating, false, 'full: the timer stopped itself');
  asked = 0;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked, 0, 'and nothing repaints');
});

test('scan: a DI module, built and wired by the container', async () => {
  const s = Schema.create;
  // class instances, not plain objects: injection deep-merges plain objects but assigns instances
  const inst = (shape) => Object.assign(new (class Fake {})(), shape);
  const f = {
    ui: inst({ requestRender() {}, setStrip() {} }), modes: Object.assign(new EventEmitter(), { registered: [], register(m) { this.registered.push(m.id); } }),
    world: fakeWorld(), scanner: fakeScanner(), surface: Object.assign(new EventEmitter(), { width: 428, height: 240 }),
  };
  class Harness { static moduleInfo = { name: 'harness', isMain: true, schema: s().property('scanMode', s('ScanMode').required()) }; scanMode; }
  const mm = new ModuleManager();
  for (const [name, instance] of Object.entries(f)) mm.registerInstance(instance, { name, lifecycle: false });
  mm.registerInstance(fakeLink(), { name: 'device-link', lifecycle: false });
  mm.register(Harness).register(ScanMode);
  await mm.initModules(await mm.configure({ argv: [], env: {}, defaults: {} }));
  const mode = mm.getModuleInstance('harness').scanMode;
  assert.ok(mode instanceof ScanMode);
  assert.deepEqual([mode.modes, mode.ui, mode.world, mode.scanner, mode.surface], [f.modes, f.ui, f.world, f.scanner, f.surface], 'its models, the surface and the registry are injected');
  await mode.start();
  assert.deepEqual(f.modes.registered, ['scan'], 'the mode registers itself');
  assert.deepEqual([f.world.listenerCount('change'), f.scanner.listenerCount('state')], [0, 0], 'not showing: no view subscription');
});
