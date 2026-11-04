// The System mode against temp files standing in for userdata and sysfs: the first-use wizard
// (pad -> glance -> brightness with "n of 3"), what each step writes and sends, the menu, the
// Status screen's repaint rule and address rows, and the DI shape: screens are modules providing
// `Screen`, injected into SystemMode's `screens` array, each subscribing to its own models only
// while it is showing.
import { stateOfCharge } from '../src/modules/power/soc.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ModuleManager, Schema } from '@versionzero/module-manager';
import { SystemMode } from '../src/modes/system/index.js';
import { StatusScreen } from '../src/modes/system/status.js';
import { PadCalScreen } from '../src/modes/system/pad-cal.js';
import { Gps } from '../src/modules/gps/index.js';
import { Radio } from '../src/modules/radio/index.js';
import { Wear } from '../src/modules/wear/index.js';
import { fakeLink, fakeSounds, fakeGps, buildSystem, tmpdir, settle } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond()` is true (6 s limit: the full suite runs files in parallel and loads the box). */
async function until(cond, what = 'condition') { for (let i = 0; i < 1200; i++) { if (cond()) return; await sleep(5); } throw new Error(`timeout: ${what}`); }

async function make({ calibrated = false, glanceRaw = 150, extra = {} } = {}) {
  const dir = tmpdir('jet-system-');
  const iio = path.join(dir, 'iio', 'iio:device5'); fs.mkdirSync(iio, { recursive: true });
  fs.writeFileSync(path.join(iio, 'name'), 'tmd2771\n');
  const proximity = path.join(iio, 'in_proximity0_raw');
  const setRaw = (v) => fs.writeFileSync(proximity, `${v}\n`);
  setRaw(glanceRaw);
  fs.mkdirSync(path.join(dir, 'net', 'wlan0'), { recursive: true }); fs.mkdirSync(path.join(dir, 'net', 'usb0'));
  fs.writeFileSync(path.join(dir, 'gps.sh'), '#!/bin/sh\necho "$1" >> "$(dirname "$0")/gps-calls"\n');
  for (const name of ['bluetoothctl', 'hciconfig', 'wpa_cli']) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\necho ' + name + ' "$@" >> "$(dirname "$0")/ran"\n');
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  fs.chmodSync(path.join(dir, 'gps.sh'), 0o755);
  const link = fakeLink();
  const ui = Object.assign(new EventEmitter(), { renders: 0, strips: [], requestRender() { this.renders++; }, setStrip(t) { this.strips.push(t); }, surface: { width: 428, height: 240 } });
  const input = new EventEmitter(), power = Object.assign(new EventEmitter(), { last: null, smoothed: null });
  const modes = { registered: [], list: [], current: null, switched: [], register(m) { this.registered.push(m.id); }, switchTo(id) { this.switched.push(id); return true; } };
  fs.writeFileSync(path.join(dir, 'brightness'), '208\n'); fs.writeFileSync(path.join(dir, 'thr_x'), '20\n'); fs.writeFileSync(path.join(dir, 'thr_y'), '20\n');
  const deviceConfig = path.join(dir, 'mainline', 'jet-app.json');
  const wear = Object.assign(new Wear(), { enabled: false, offDelayMs: 2000, led: '', deviceConfig, logger: null, calls: [] });
  const liveSet = wear.setEnabled.bind(wear); wear.setEnabled = (on) => { wear.calls.push(on); liveSet(on); };
  const paths = {
    ofmArgsFile: path.join(dir, 'mainline', 'ofm-args'), ofmSysfs: dir, glanceFile: path.join(dir, 'mainline', 'glance'), iioDir: path.join(dir, 'iio'),
    backlightFile: path.join(dir, 'mainline', 'backlight'), backlightSysfs: path.join(dir, 'brightness'), netDir: path.join(dir, 'net'), btMarker: path.join(dir, 'mainline', 'bt'),
  };
  const sys = buildSystem({ paths, ui, input, power, sensors: { glance: null, view: null, worn: null }, wear, deviceLink: link, modes, ...extra });
  if (calibrated) { fs.mkdirSync(path.join(dir, 'mainline')); fs.writeFileSync(paths.ofmArgsFile, 'thr_x=41 thr_y=38\n'); fs.writeFileSync(paths.glanceFile, '180 197\n'); }
  await sys.backlightModule.start();
  await sys.scr('status').start();
  await sys.start();
  return { sys, dir, paths, link, ui, input, power, modes, wear, deviceConfig, setRaw, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
}
const swipe = (input, dx, dy) => input.emit('motion', { dx, dy, t: 0 });

test('system: first use when a calibration file is missing; the wizard walks pad, glance, brightness', async () => {
  const { sys, link, input, ui, modes, paths, read, setRaw } = await make();
  assert.deepEqual(modes.registered, ['system']);
  assert.equal(await sys.firstUse(), true);
  sys.enter({ wizard: true });
  const pad = sys.scr('pad'), glance = sys.scr('glance'), brightness = sys.scr('brightness');
  assert.equal(sys.screen, pad); assert.deepEqual(pad.ctx.wizard, { n: 1, of: 3 });
  // pad: swipes arrive as motion sums plus the driver's swipe keys; keys are swallowed here
  assert.equal(sys.onGesture('swipe:right'), true);
  swipe(input, 3, 2);   // too small
  assert.equal(pad.samples[0].length, 0);
  for (const dx of [80, 90, 100]) swipe(input, dx, 5);
  assert.equal(pad.step, 1);
  for (const dx of [-70, -60, -200]) swipe(input, dx, 0);
  for (const dy of [-50, -40, -45]) swipe(input, 0, dy);
  for (const dy of [60, 55, 58]) swipe(input, 0, dy);
  assert.deepEqual(pad.result, { thrX: 35, thrY: 22 });
  await until(() => fs.existsSync(paths.ofmArgsFile), 'ofm-args written');
  assert.equal(read('mainline/ofm-args'), 'thr_x=35 thr_y=22\n');
  assert.equal(read('thr_x'), '35\n'); assert.equal(read('thr_y'), '22\n');
  swipe(input, 100, 0);
  assert.deepEqual(pad.result, { thrX: 35, thrY: 22 }, 'done: further motion ignored');
  assert.equal(sys.onGesture('press:front'), true);
  // glance: four front presses, 8 reads each, then the file and U
  assert.equal(sys.screen, glance); assert.deepEqual(glance.ctx.wizard, { n: 2, of: 3 });
  for (const [i, raw] of [150, 230, 130, 230].entries()) {
    setRaw(raw);
    assert.equal(sys.onGesture('press:front'), true);
    assert.equal(sys.onGesture('press:front'), true, 'a press while reading is swallowed');
    await until(() => glance.reads.length === i + 1, `step ${i + 1}`);
  }
  await until(() => glance.result && link.sent.includes('U'), 'glance saved');
  const g = glance.result;
  assert.equal(g.ok, true); assert.deepEqual([g.on, g.off], [176, 194]);
  assert.equal(read('mainline/glance'), '176 194\n');
  assert.equal(link.sent.at(-1), 'U', 'jetd re-reads the thresholds');
  assert.equal(sys.onGesture('press:front'), true);
  // brightness: live sysfs, saved on front
  assert.equal(sys.screen, brightness); assert.deepEqual(brightness.ctx.wizard, { n: 3, of: 3 });
  assert.equal(brightness.level, 208);
  sys.onGesture('swipe:up'); sys.onGesture('swipe:right'); sys.onGesture('swipe:down');
  assert.equal(brightness.level, 256);
  await sleep(10);
  assert.equal(read('brightness'), '256\n', 'applied live');
  assert.equal(sys.onGesture('press:front'), true);
  await until(() => sys.screen === null, 'backlight saved');
  assert.equal(read('mainline/backlight'), '256\n');
  assert.equal(sys.wizard, null, 'wizard done: the menu');
  assert.equal(ui.strips.at(-1), 'setup complete');
  assert.equal(await sys.firstUse(), false);
  sys.leave();
});

test('system: a flat glance run is reported and not saved; no sensor is an error, not a hang', async () => {
  const { sys, read, dir } = await make({ calibrated: true, glanceRaw: 700 });
  sys.enter();
  const glance = sys.scr('glance');
  assert.equal(sys.screen, null, 'the menu');
  sys.onGesture('swipe:down'); sys.onGesture('swipe:down'); assert.equal(sys.menu.item.id, 'glance');
  sys.onGesture('press:front');
  for (let i = 0; i < 4; i++) { sys.onGesture('press:front'); await until(() => glance.reads.length === i + 1); }
  await until(() => glance.result);
  assert.equal(glance.result.ok, false);
  assert.equal(read('mainline/glance'), '180 197\n', 'untouched');
  sys.onGesture('press:front');
  assert.equal(glance.result, null, 'try again');
  assert.equal(sys.onGesture('press:rear'), true); assert.equal(sys.screen, null, 'rear: menu');
  fs.rmSync(path.join(dir, 'iio'), { recursive: true });
  sys.open('glance'); sys.onGesture('press:front'); await until(() => glance.error);
  assert.match(glance.error, /ENOENT|no tmd2771/);
});

test('system: the menu opens every screen; brightness rear reverts; Status repaints on changed power and shows addresses', async () => {
  const { sys, power, ui, read } = await make({ calibrated: true });
  sys.enter();
  const ids = sys.menu.items.map((i) => i.id);
  assert.deepEqual(ids, ['status', 'pad', 'glance', 'brightness', 'wear', 'bluetooth', 'location']);
  for (const id of ids) { sys.open(id); assert.equal(sys.screen, sys.scr(id)); assert.equal(sys.onGesture('press:rear'), true); assert.equal(sys.screen, null); }
  sys.onGesture('swipe:up'); assert.equal(sys.menu.item.id, 'location', 'wraps');
  sys.open('brightness');
  sys.onGesture('swipe:up'); assert.equal(sys.scr('brightness').level, 256);
  assert.equal(sys.onGesture('press:rear'), true);
  await until(() => read('brightness') === '208\n', 'reverted');
  assert.equal(sys.screen, null);
  sys.open('status'); await settle();
  const status = sys.scr('status');
  const reading = (vbat, ma) => ({ vbat, vsys: 4012, vbus: 4893, ma, ctrl1: 0x8c, stat1: 0x4c, linsts: 0, cinlimit: 2, vichrg: 3, udc: 'configured', maxpower: 500 });
  const update = (vbat, ma) => { const n = ui.renders; power.last = reading(vbat, ma); power.smoothed = { vbat, ma, vsys: 4010, vbus: 4890 }; power.emit('update'); return ui.renders - n; };
  assert.equal(update(3990, -120), 1, 'first reading paints');
  assert.equal(update(3990, -120), 0, 'same rounded readout: nothing');
  assert.equal(update(3980, -120), 1);
  assert.equal(status.powerRows().battery, `${stateOfCharge({ vbat: 3980, ma: -120, vsys: 4010, vbus: 4890 }).percent}%  3980 mV  -120 mA`);
  sys.onGesture('press:rear');
  assert.equal(update(3970, -120), 0, 'not showing: nothing');
  // addresses: the Status rows read what the network reader reads
  status.addrs = { wlan0: ['192.168.1.9/24'], usb0: [] };
  const drawn = [];
  const s = { width: 428, height: 240, geometry: { w: 428, h: 240, bpp: 16 }, fonts: { main: { width: 10, height: 20 }, small: { width: 6, height: 12 } }, icons: {},
    text(x, y, str) { drawn.push(str); }, line() {}, fillRect() {}, strokeRect() {}, icon() {} };
  status.render(s);
  assert.ok(drawn.includes('192.168.1.9') && drawn.includes('no address'), drawn.join('|'));
});

test('system: screens subscribe to their models only while showing', async () => {
  const { sys, power, input } = await make({ calibrated: true });
  const gps = sys.gps;
  sys.enter();
  assert.equal(power.listenerCount('update'), 0, 'at the menu nobody listens');
  assert.equal(input.listenerCount('motion'), 0);
  sys.open('status');
  assert.equal(power.listenerCount('update'), 1, 'the showing screen listens itself');
  assert.equal(gps.listenerCount('update'), 1);
  sys.open('pad');
  assert.equal(power.listenerCount('update'), 0, 'leaving unsubscribes');
  assert.equal(gps.listenerCount('update'), 0);
  assert.equal(input.listenerCount('motion'), 1, 'pad calibration follows the pad only while showing');
  sys.open('location');
  assert.equal(input.listenerCount('motion'), 0);
  assert.equal(gps.listenerCount('update'), 1);
  sys.leave();
  assert.equal(gps.listenerCount('update'), 0, 'leaving the mode unsubscribes the open screen');
});

test('system: screens are DI modules providing Screen, built and configured by the container', async () => {
  const dir = tmpdir('jet-di-');
  const mm = new ModuleManager();
  const s = Schema.create;
  // class instances, not plain objects: injection deep-merges plain objects but assigns instances
  const inst = (shape) => Object.assign(new (class Fake {})(), shape);
  const fakes = {
    ui: inst({ requestRender() {}, setStrip() {} }), power: new EventEmitter(), sensors: inst({}), wear: inst({ enabled: false }),
    modes: inst({ register() {} }), input: new EventEmitter(), sounds: inst(fakeSounds()), actions: inst({ register() { return this; } }), voice: null, logger: null,
    gps: fakeGps(),
  };
  for (const [name, instance] of Object.entries(fakes)) if (instance) mm.registerInstance(instance, { name, lifecycle: false });
  mm.registerInstance(fakeLink(), { name: 'device-link', lifecycle: false });
  mm.register(Radio);   // referenced by the status/bluetooth screens (in the app, the gps module registers it)
  class Harness { static moduleInfo = { name: 'harness', isMain: true, schema: s().property('sys', s('SystemMode').required()) }; sys; }
  mm.register(Harness).register(SystemMode);
  const config = await mm.configure({ argv: [], env: {}, defaults: { systemMode: { statusScreen: { netDir: path.join(dir, 'net') } } } });
  await mm.initModules(config);
  const sys = mm.getModuleInstance('harness').sys;
  assert.ok(sys instanceof SystemMode);
  assert.deepEqual(sys.screens.map((x) => x.id), ['status', 'pad', 'glance', 'brightness', 'wear', 'bluetooth', 'location'], 'the Screen array defaults to the seven, in menu order');
  const status = sys.screens[0];
  assert.ok(status instanceof StatusScreen);
  assert.equal(status.ui, fakes.ui, 'a screen gets its own dependencies injected');
  assert.equal(status.power, fakes.power);
  assert.equal(status.gps, fakes.gps);
  assert.equal(sys.screens[1].input, fakes.input);
  assert.equal(status.netDir, path.join(dir, 'net'), 'a screen config value rides the systemMode.<screen> layer');

  // the screens array is itself configuration: a subset (or a personal/ provider) reshapes the menu
  const mm2 = new ModuleManager();
  for (const [name, instance] of Object.entries(fakes)) if (instance) mm2.registerInstance(instance, { name, lifecycle: false });
  mm2.registerInstance(fakeLink(), { name: 'device-link', lifecycle: false });
  class PartyScreen { static moduleInfo = { name: 'party-screen', provides: 'Screen' }; id = 'party'; label = 'Party'; render() {} }
  mm2.register(Radio).register(Harness).register(SystemMode);
  mm2.registerInstance(new PartyScreen());
  const config2 = await mm2.configure({ argv: [], env: {}, defaults: { systemMode: { screens: ['status-screen', 'party-screen'] } } });
  await mm2.initModules(config2);
  const sys2 = mm2.getModuleInstance('harness').sys;
  await sys2.start();
  assert.deepEqual(sys2.menu.items.map((i) => i.id), ['status', 'party'], 'menu order follows the configured array');
});

test('system: Location toggles GPS through the gps module (script, session, radio recovery); "enable gps" goes to the same switch', async () => {
  const dir = tmpdir('jet-gps-sys-');
  fs.writeFileSync(path.join(dir, 'gps.sh'), '#!/bin/sh\necho "$1" >> "$(dirname "$0")/gps-calls"\n');
  for (const name of ['bluetoothctl', 'hciconfig', 'wpa_cli']) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\necho ' + name + ' "$@" >> "$(dirname "$0")/ran"\n');
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  fs.chmodSync(path.join(dir, 'gps.sh'), 0o755);
  const gps = Object.assign(new Gps(), { fifo: path.join(dir, 'none'), socket: path.join(dir, 'none.sock'), logFile: '', retryMs: 50, script: path.join(dir, 'gps.sh'), logger: null });
  let sessionStopped = 0;
  gps.stopSession = async () => { sessionStopped++; };
  gps.probe = async function () { return (this.running ??= false); };   // no navd on a dev box: the module's own state is the answer
  const ui = { strips: [], renders: 0, setStrip(t) { this.strips.push(t); }, requestRender() { this.renders++; } };
  const radio = Object.assign(new Radio(), { btMarker: path.join(dir, 'bt'), gps, logger: null });
  gps.radio = radio;
  const sys = buildSystem({ paths: {}, ui, input: new EventEmitter(), power: new EventEmitter(), sensors: {}, gps, radio, modes: { register() {}, switchTo: () => true, current: null } });
  await sys.start();
  const old = process.env.PATH; process.env.PATH = `${dir}:${old}`;
  try {
    sys.enter(); sys.open('location');
    const location = sys.scr('location');
    await until(() => gps.running === false, 'probed');
    assert.equal(sys.onGesture('press:front'), true);
    await until(() => ui.strips.includes('gps on'), 'started');
    assert.equal(gps.running, true);
    assert.equal(gps.listening, true, 'the NMEA stream is followed while on');
    sys.onGesture('press:tap');
    await until(() => ui.strips.includes('gps off'), 'stopped');
    assert.equal(fs.readFileSync(path.join(dir, 'gps-calls'), 'utf8'), 'start\nstop\n');
    assert.equal(sessionStopped, 1, 'the fix session was ended before the daemon');
    const ran = fs.readFileSync(path.join(dir, 'ran'), 'utf8');
    assert.match(ran, /wpa_cli -i wlan0 reassociate/, 'wifi rate recovered on gps off');
    assert.match(ran, /hciconfig hci0 down/);
    location.render({ fillRect() {}, text() {}, line() {}, strokeRect() {}, width: 428, height: 240, fonts: { main: { height: 20 }, small: { height: 12 } } });
    // the spoken switch: same screen, and a dead script surfaces as a thrown error for the error phrase
    gps.script = path.join(dir, 'missing.sh');
    await assert.rejects(location.set(true), /missing\.sh/);
    assert.equal(ui.strips.at(-1), 'gps off', 'no strip for the failure');
  } finally { process.env.PATH = old; gps.stopListening(); }
});

test('system: "check my location" = start the pursuit + announcement observers: satellites as they lock, the fix brings the screen up', async () => {
  // voice: announcements recorded (the supersede/queue policy itself is voice.test.js territory)
  const voice = { said: [], warmed: 0, warm() { this.warmed++; }, announce() { const said = this.said; return { say(t) { said.push(t); }, cancel() {} }; } };
  const gps = Object.assign(new Gps(), { logger: null, fixTimeoutS: 0.2 });
  let sats = 0, fix = null, enabled = 0;
  gps.probe = async function () { return (this.running ??= false); };
  gps.enable = async function () { enabled++; this.running = true; };
  gps.goodFix = () => fix;
  Object.defineProperty(gps, 'state', { get: () => ({ satsUsed: sats }) });
  const actions = { list: [], register(name, pattern, run) { this.list.push({ name, pattern, run }); return this; } };
  const { sys } = await make({ calibrated: true, extra: { gps, voice, actions } });
  const check = actions.list.find((a) => a.name === 'check location');
  assert.ok(check.pattern.test('check my location')); assert.ok(check.pattern.test('check gps'));
  assert.ok(!check.pattern.test('check my calendar'));
  sys.enter();
  // no fix in time: the hunt narrates and gives up onto the screen (the receiver stays on)
  check.run();
  await until(() => voice.said.length >= 2, 'gave up');
  assert.equal(voice.said[0], 'Getting a fix on you.');
  assert.match(voice.said.at(-1), /No fix yet/);
  assert.equal(sys.screen, sys.scr('location'), 'the hunt is on the glass');
  assert.equal(voice.warmed, 1);
  assert.equal(enabled, 1, 'gps was turned on');
  assert.equal(gps.running, true, 'and stays on after the timeout');
  // satellites lock, then the gated fix: progressive news, then the map and the word
  voice.said.length = 0;
  sys.open(null);
  gps.fixTimeoutS = 180;
  check.run();
  await until(() => voice.said.length === 1, 'hunting again');
  sats = 3; gps.emit('update', {});
  assert.ok(voice.said.includes('3 satellites locked.'), 'sats spoken');
  sats = 5; fix = { good: true }; gps.emit('update', {});
  await until(() => voice.said.at(-1) === 'Got a fix. On your display.', 'fix spoken');
  assert.ok(sys.modes.switched.includes('map'), 'the fix opens the map');
  assert.ok(!voice.said.includes('5 satellites locked.'), 'the fix beat the count');
  // a second call while one runs is swallowed; with a fresh good fix the answer is immediate
  voice.said.length = 0;
  check.run(); check.run();
  await until(() => voice.said.at(-1) === 'Got a fix. On your display.', 'immediate');
  assert.equal(voice.said.length, 1);
  // the receiver refusing to come up is one spoken line, not a crash
  voice.said.length = 0;
  gps.running = false; fix = null;
  gps.enable = async () => { throw new Error('no receiver'); };
  check.run();
  await until(() => voice.said.length === 1, 'error spoken');
  assert.equal(voice.said[0], 'The receiver did not come up.');
  assert.equal(gps.pursuit.state, 'idle');
});

test('system: Wear toggles the off-head behaviour live through the wear module, which persists it into the per-device config layer', async () => {
  const { sys, ui, wear, deviceConfig, read } = await make({ calibrated: true });
  fs.mkdirSync(path.dirname(deviceConfig), { recursive: true });
  fs.writeFileSync(deviceConfig, '{ "llm": { "base": "http://x" }, "wear": { "offDelayMs": 5000 } }\n');
  sys.enter(); sys.open('wear');
  const screen = sys.scr('wear');
  assert.equal(sys.onGesture('press:front'), true);
  await until(() => screen.busy === false && ui.strips.includes('off-head dark on'), 'saved');
  assert.deepEqual(wear.calls, [true], 'live first');
  assert.deepEqual(JSON.parse(read('mainline/jet-app.json')), { llm: { base: 'http://x' }, wear: { offDelayMs: 5000, enabled: true } }, 'merged, nothing else touched');
  sys.onGesture('press:tap');
  await until(() => ui.strips.includes('off-head dark off'), 'saved again');
  assert.equal(JSON.parse(read('mainline/jet-app.json')).wear.enabled, false);
  screen.render({ fillRect() {}, text() { return { w: 0, h: 0 }; }, measureText() { return { w: 0, h: 0, chars: 0 }; }, line() {}, strokeRect() {}, width: 428, height: 240, fonts: { main: {}, small: {} } });
  fs.rmSync(path.dirname(deviceConfig), { recursive: true });
  sys.onGesture('press:front');
  await until(() => screen.error, 'a failed save is shown');
  assert.equal(wear.enabled, true, 'the live change still happened');
});
