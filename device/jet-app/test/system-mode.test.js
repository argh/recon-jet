// The System mode against temp files standing in for userdata and sysfs: the first-use wizard
// (pad -> glance -> brightness with "n of 3"), what each step writes and sends, the menu, and
// the Status screen's repaint rule and address rows.
import { stateOfCharge } from '../src/modules/power/soc.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SystemMode } from '../src/modes/system/index.js';
import { fakeLink, tmpdir, settle } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond()` is true (2 s limit). */
async function until(cond, what = 'condition') { for (let i = 0; i < 400; i++) { if (cond()) return; await sleep(5); } throw new Error(`timeout: ${what}`); }

async function make({ calibrated = false, glanceRaw = 150 } = {}) {
  const dir = tmpdir('jet-system-');
  const iio = path.join(dir, 'iio', 'iio:device5'); fs.mkdirSync(iio, { recursive: true });
  fs.writeFileSync(path.join(iio, 'name'), 'tmd2771\n');
  const proximity = path.join(iio, 'in_proximity0_raw');
  const setRaw = (v) => fs.writeFileSync(proximity, `${v}\n`);
  setRaw(glanceRaw);
  fs.mkdirSync(path.join(dir, 'net', 'wlan0'), { recursive: true }); fs.mkdirSync(path.join(dir, 'net', 'usb0'));
  fs.writeFileSync(path.join(dir, 'brightness'), '208\n'); fs.writeFileSync(path.join(dir, 'thr_x'), '20\n'); fs.writeFileSync(path.join(dir, 'thr_y'), '20\n');
  const link = fakeLink();
  const ui = Object.assign(new EventEmitter(), { renders: 0, strips: [], requestRender() { this.renders++; }, setStrip(t) { this.strips.push(t); }, surface: { width: 428, height: 240 } });
  const input = new EventEmitter(), power = Object.assign(new EventEmitter(), { last: null, smoothed: null });
  const modes = { registered: [], list: [], register(m) { this.registered.push(m.id); } };
  const sys = Object.assign(new SystemMode(), {
    ofmArgsFile: path.join(dir, 'mainline', 'ofm-args'), ofmSysfs: dir, glanceFile: path.join(dir, 'mainline', 'glance'), iioDir: path.join(dir, 'iio'),
    backlightFile: path.join(dir, 'mainline', 'backlight'), backlightSysfs: path.join(dir, 'brightness'), netDir: path.join(dir, 'net'),
    modes, ui, input, power, sensors: { glance: null, view: null }, deviceLink: link });
  if (calibrated) { fs.mkdirSync(path.join(dir, 'mainline')); fs.writeFileSync(sys.ofmArgsFile, 'thr_x=41 thr_y=38\n'); fs.writeFileSync(sys.glanceFile, '180 197\n'); }
  await sys.start();
  return { sys, dir, link, ui, input, power, modes, setRaw, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
}
const swipe = (input, dx, dy) => input.emit('motion', { dx, dy, t: 0 });

test('system: first use when a calibration file is missing; the wizard walks pad, glance, brightness', async () => {
  const { sys, link, input, ui, modes, read, setRaw } = await make();
  assert.deepEqual(modes.registered, ['system']);
  assert.equal(await sys.firstUse(), true);
  sys.enter({ wizard: true });
  assert.equal(sys.screen, sys.screens.pad); assert.equal(sys.stepTitle('pad calibration'), 'pad calibration  1 of 3');
  // pad: swipes arrive as motion sums plus the driver's swipe keys; keys are swallowed here
  assert.equal(sys.onGesture('swipe:right'), true);
  swipe(input, 3, 2);   // too small
  assert.equal(sys.screens.pad.samples[0].length, 0);
  for (const dx of [80, 90, 100]) swipe(input, dx, 5);
  assert.equal(sys.screens.pad.step, 1);
  for (const dx of [-70, -60, -200]) swipe(input, dx, 0);
  for (const dy of [-50, -40, -45]) swipe(input, 0, dy);
  for (const dy of [60, 55, 58]) swipe(input, 0, dy);
  assert.deepEqual(sys.screens.pad.result, { thrX: 35, thrY: 22 });
  await until(() => fs.existsSync(sys.ofmArgsFile), 'ofm-args written');
  assert.equal(read('mainline/ofm-args'), 'thr_x=35 thr_y=22\n');
  assert.equal(read('thr_x'), '35\n'); assert.equal(read('thr_y'), '22\n');
  swipe(input, 100, 0);
  assert.deepEqual(sys.screens.pad.result, { thrX: 35, thrY: 22 }, 'done: further motion ignored');
  assert.equal(sys.onGesture('press:front'), true);
  // glance: four front presses, 8 reads each, then the file and U
  assert.equal(sys.screen, sys.screens.glance); assert.equal(sys.stepTitle('glance calibration'), 'glance calibration  2 of 3');
  for (const [i, raw] of [150, 230, 130, 230].entries()) {
    setRaw(raw);
    assert.equal(sys.onGesture('press:front'), true);
    assert.equal(sys.onGesture('press:front'), true, 'a press while reading is swallowed');
    await until(() => sys.screens.glance.reads.length === i + 1, `step ${i + 1}`);
  }
  await until(() => sys.screens.glance.result && link.sent.includes('U'), 'glance saved');
  const g = sys.screens.glance.result;
  assert.equal(g.ok, true); assert.deepEqual([g.on, g.off], [176, 194]);
  assert.equal(read('mainline/glance'), '176 194\n');
  assert.equal(link.sent.at(-1), 'U', 'jetd re-reads the thresholds');
  assert.equal(sys.onGesture('press:front'), true);
  // brightness: live sysfs, saved on front
  assert.equal(sys.screen, sys.screens.brightness); assert.equal(sys.stepTitle('brightness'), 'brightness  3 of 3');
  assert.equal(sys.screens.brightness.level, 208);
  sys.onGesture('swipe:up'); sys.onGesture('swipe:right'); sys.onGesture('swipe:down');
  assert.equal(sys.screens.brightness.level, 256);
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
  assert.equal(sys.screen, null, 'the menu');
  sys.onGesture('swipe:down'); sys.onGesture('swipe:down'); assert.equal(sys.menu.item.id, 'glance');
  sys.onGesture('press:front');
  for (let i = 0; i < 4; i++) { sys.onGesture('press:front'); await until(() => sys.screens.glance.reads.length === i + 1); }
  await until(() => sys.screens.glance.result);
  assert.equal(sys.screens.glance.result.ok, false);
  assert.equal(read('mainline/glance'), '180 197\n', 'untouched');
  sys.onGesture('press:front');
  assert.equal(sys.screens.glance.result, null, 'try again');
  assert.equal(sys.onGesture('press:rear'), true); assert.equal(sys.screen, null, 'rear: menu');
  fs.rmSync(path.join(dir, 'iio'), { recursive: true });
  sys.open('glance'); sys.onGesture('press:front'); await until(() => sys.screens.glance.error);
  assert.match(sys.screens.glance.error, /ENOENT|no tmd2771/);
});

test('system: the menu opens every screen; brightness rear reverts; Status repaints on changed power and shows addresses', async () => {
  const { sys, power, ui, read } = await make({ calibrated: true });
  sys.enter();
  const ids = sys.menu.items.map((i) => i.id);
  assert.deepEqual(ids, ['status', 'pad', 'glance', 'brightness', 'power', 'network', 'about']);
  for (const id of ids) { sys.open(id); assert.equal(sys.screen, sys.screens[id]); assert.equal(sys.onGesture('press:rear'), true); assert.equal(sys.screen, null); }
  sys.onGesture('swipe:up'); assert.equal(sys.menu.item.id, 'about', 'wraps');
  sys.open('brightness');
  sys.onGesture('swipe:up'); assert.equal(sys.screens.brightness.level, 256);
  assert.equal(sys.onGesture('press:rear'), true);
  await until(() => read('brightness') === '208\n', 'reverted');
  assert.equal(sys.screen, null);
  sys.open('status'); await settle();
  const status = sys.screens.status;
  const reading = (vbat, ma) => ({ vbat, vsys: 4012, vbus: 4893, ma, ctrl1: 0x8c, stat1: 0x4c, linsts: 0, cinlimit: 2, vichrg: 3, udc: 'configured', maxpower: 500 });
  const update = (vbat, ma) => { const n = ui.renders; power.last = reading(vbat, ma); power.smoothed = { vbat, ma, vsys: 4010, vbus: 4890 }; power.emit('update'); return ui.renders - n; };
  assert.equal(update(3990, -120), 1, 'first reading paints');
  assert.equal(update(3990, -120), 0, 'same rounded readout: nothing');
  assert.equal(update(3980, -120), 1);
  assert.equal(status.powerRows().battery, `${stateOfCharge({ vbat: 3980, ma: -120, vsys: 4010, vbus: 4890 }).percent}%  3980 mV  -120 mA`);
  sys.onGesture('press:rear');
  assert.equal(update(3970, -120), 0, 'not showing: nothing');
  // addresses: the Status rows read what the Network screen reads
  status.addrs = { wlan0: ['192.168.1.9/24'], usb0: [] };
  const drawn = [];
  const s = { width: 428, height: 240, geometry: { w: 428, h: 240, bpp: 16 }, fonts: { main: { width: 10, height: 20 }, small: { width: 6, height: 12 } }, icons: {},
    text(x, y, str) { drawn.push(str); }, line() {}, fillRect() {}, strokeRect() {}, icon() {} };
  status.render(s);
  assert.ok(drawn.includes('192.168.1.9') && drawn.includes('no address'), drawn.join('|'));
});
