// The Scan mode through the real input/surface/ui/modes stack, over fakes for its models
// (world, scanner): front is the scanner's switch and never opens anything, the camera corner
// while scanning (paused under the switcher, stopped on leave, stopped while a detail has the
// panel), swipe right/left opening and closing the detail, front pinning there, the order rear
// steps back in, the selection published as the world's focus, that it follows its models only
// while showing, the 1 s tick repainting only on a changed age, and the DI shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ModuleManager, Schema } from '@versionzero/module-manager';
import { ScanMode, age } from '../src/modes/scan/index.js';
import { stack, fakeMode, fakeLink, settle } from './helpers.js';

const TAP = 330;   // a pad tap of its own: the default tap code (28) is also Enter, which input reads as a front press
const T0 = 1_000_000;

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
  s.surface.fillRect = (x, y, w, h, colour) => { if (h > 20) tiles.push({ x, y, w, h }); return fill(x, y, w, h, colour); };
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
  assert.ok(f.includes('watching') && f.includes('2 in the log')); assert.equal(hintOf(f), 'front: stop   swipe: select');
  assert.deepEqual(tiles[0], { x: 2, y: 14, w: 290, h: 48 }, 'while scanning the tiles stop short of the camera corner');
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
