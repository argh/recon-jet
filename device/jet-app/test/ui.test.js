// The menu state machine, driven by synthetic `k` events with timestamps through the real
// Input, Surface (a temp file stands in for /dev/fb0), Power and Ui, against a stub link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Input } from '../src/modules/input/index.js';
import { Surface } from '../src/modules/surface/index.js';
import { Power } from '../src/modules/power/index.js';
import { Ui } from '../src/modules/ui/index.js';

const fontDir = new URL('../assets/fonts/', import.meta.url).pathname;
const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

async function stack() {
  const link = Object.assign(new EventEmitter(), {
    connected: true, mode: 'remote', sent: [],
    send(...lines) { this.sent.push(...lines); return true; },
    setMode(m) { return this.send(`M ${m}`); },
    surface: async () => ({ w: 428, h: 240, bpp: 16, stride: 856 }),
    flushRect(x, y, w, h) { return this.send(`F ${x} ${y} ${w} ${h}`); },
    viewfinder(x, y, w, h, fps) { this.send(`Z ${x} ${y} ${w} ${h} ${fps}`); return Promise.resolve({ w: 640, h: 480 }); },
    viewfinderStop() { return this.send('z'); },
  });
  const device = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jet-ui-')), 'fb0');
  const surface = Object.assign(new Surface(), { device, minFlushMs: 0, fontDir, mainFont: 'ter-u20b.psf', smallFont: 'Lat2-Terminus12x6.psf', viewfinderFps: 10, deviceLink: link });
  const input = Object.assign(new Input(), { holdMs: 1000, swipeThreshold: 20, swipeDedupeMs: 300, tapCode: 28, rawKeys: true, deviceLink: link });
  input.now = () => 0;
  const power = Object.assign(new Power(), { pollMs: 0, samples: 8, roundStep: 10, deviceLink: link });
  const ui = Object.assign(new Ui(), { menuGestures: ['hold:front'], clockMs: 1000, surface, input, power, deviceLink: link });
  const ready = once(surface, 'ready');
  await surface.start(); await input.start(); await power.start(); await ui.start();
  await ready; await settle();
  const key = (code, value, t) => link.emit('key', { code, value, t });
  // the button vocabulary as jetd's raw keys deliver it
  const k = {
    frontHold: (t) => { key(86, 1, t); key(86, 0, t + 1500); },
    frontPress: (t) => { key(86, 1, t); key(86, 0, t + 200); },
    rearPress: (t) => { key(107, 1, t); key(107, 0, t + 200); },
    up: (t) => { link.emit('rel', { dx: 0, dy: 30, t }); key(103, 1, t + 20); key(103, 0, t + 30); },
    down: (t) => { link.emit('rel', { dx: 0, dy: -30, t }); key(108, 1, t + 20); key(108, 0, t + 30); },
  };
  const stop = async () => { await ui.stop(); await input.stop(); await power.stop(); await surface.stop(); };
  return { link, surface, input, power, ui, key, k, stop };
}

test('ui: front hold opens/closes the menu, swipes move, rear closes, status clock pauses', async (t) => {
  const { link, ui, k, stop } = await stack(); t.after(stop);
  assert.deepEqual(link.sent.filter((l) => l[0] === 'K'), ['K 1']);
  assert.ok(ui.renders >= 1, 'first paint');
  assert.equal(ui.status.paused, false);
  let now = 1000;
  k.frontHold(now); now += 2000;
  assert.ok(ui.menu, 'menu open on hold');
  assert.equal(ui.status.paused, true, 'status clock paused under the menu');
  assert.deepEqual(ui.menu.items.map((i) => i.label), ['Status', 'Camera', 'Kernel log', 'Setup']);
  assert.equal(ui.menu.selected, 0);
  k.down(now); now += 500; assert.equal(ui.menu.selected, 1);
  k.down(now); now += 500; assert.equal(ui.menu.selected, 2);
  k.up(now); now += 500; assert.equal(ui.menu.selected, 1);
  k.up(now); now += 500; k.up(now); now += 500;
  assert.equal(ui.menu.selected, 3, 'wraps');
  const before = ui.renders; await settle();
  assert.ok(ui.renders > before, 'menu moves repaint');
  k.rearPress(now); now += 500;
  assert.equal(ui.menu, null, 'rear closes');
  assert.equal(ui.status.paused, false);
  k.frontHold(now); now += 2000; assert.ok(ui.menu);
  k.frontHold(now); now += 2000; assert.equal(ui.menu, null, 'a second hold closes');
  k.frontPress(now); now += 500; k.rearPress(now); now += 500;
  assert.equal(ui.menu, null, 'plain presses do not open the menu');
  await settle();
  assert.ok(!link.sent.some((l) => l[0] === 'M'), 'no mode change sent');
  await stop();
});

test('ui: Kernel log / Setup hand over to jetd; silent until m remote + hello', async (t) => {
  const { link, surface, ui, k, key, stop } = await stack(); t.after(stop);
  let now = 1000;
  k.frontHold(now); now += 2000;
  k.down(now); now += 500; k.down(now); now += 500;
  assert.equal(ui.menu.items[ui.menu.selected].label, 'Kernel log');
  link.sent.length = 0;
  k.frontPress(now); now += 500;
  assert.deepEqual(link.sent, ['M log']);
  assert.equal(ui.menu, null);
  assert.equal(surface.active, false, 'drawing stops before jetd confirms');
  link.mode = 'log'; link.emit('mode', 'log');
  const renders = ui.renders;
  ui.requestRender(); await settle();
  assert.equal(ui.renders, renders, 'no renders while jetd owns the panel');
  k.frontHold(now); now += 2000;                        // would be jetd's chooser; raw keys are off there anyway
  key(86, 0, now);                                     // the stray release of the pick that brought remote back
  assert.equal(ui.menu, null);
  assert.deepEqual(link.sent, ['M log'], 'nothing sent while not remote');
  link.mode = 'remote'; link.emit('mode', 'remote'); link.emit('hello', { w: 428, h: 240, cols: 42, rows: 12 });
  await settle();
  assert.equal(surface.active, true);
  assert.equal(ui.renders, renders + 1, 'hello repaints');
  assert.ok(link.sent.some((l) => l === 'F 0 0 428 240'), 'full repaint after jetd drew over us');
  k.frontHold(now); now += 2000; k.down(now); now += 500; k.down(now); now += 500; k.down(now); now += 500;
  link.sent.length = 0;
  k.frontPress(now); now += 500;
  assert.deepEqual(link.sent, ['M setup']);
  await stop();
});

test('ui: Camera toggles the viewfinder; closing the menu stops it; Status returns', async (t) => {
  const { link, surface, ui, k, stop } = await stack(); t.after(stop);
  let now = 1000;
  k.frontHold(now); now += 2000; k.down(now); now += 500;
  assert.equal(ui.menu.items[ui.menu.selected].label, 'Camera');
  k.frontPress(now); now += 500; await settle();
  assert.ok(surface.viewfinderRect, 'viewfinder on');
  assert.ok(link.sent.some((l) => l.startsWith('Z ')));
  k.frontPress(now); now += 500; await settle();
  assert.equal(surface.viewfinderRect, null, 'toggled off');
  k.frontPress(now); now += 500; await settle();
  assert.ok(surface.viewfinderRect);
  link.sent.length = 0;
  k.rearPress(now); now += 500;
  assert.equal(surface.viewfinderRect, null, 'closing the menu stops the camera');
  assert.equal(link.sent[0], 'z');
  k.frontHold(now); now += 2000; k.frontPress(now); now += 500;   // Status
  assert.equal(ui.menu, null); assert.equal(ui.screen, ui.status); assert.equal(ui.status.paused, false);
  await stop();
});

test('ui: power updates repaint only when the rounded readout changes', async (t) => {
  const { power, ui, stop } = await stack(); t.after(stop);
  const reading = (vbat, ma) => ({ vbat, vsys: 4012, vbus: 4893, ma, ctrl1: 0x8c, stat1: 0x4c, linsts: 0, cinlimit: 2, vichrg: 3, udc: 'configured', maxpower: 500 });
  const update = async (vbat, ma) => { const n = ui.renders; power.ingest(reading(vbat, ma)); power.emit('update', power.last); await settle(); return ui.renders - n; };
  assert.equal(await update(3987, -118), 1, 'first reading paints');
  assert.equal(await update(3989, -121), 0, 'noise within the rounding step: nothing');   // medians 3988 -> 3990, -119.5 -> -120
  assert.equal(await update(3700, -300), 0, 'one outlier is absorbed by the median');     // [3987 3989 3700] -> 3987
  assert.equal(await update(3700, -300), 1, 'the median moved: repaint');                 // middle pair -> 3843.5 -> 3840
  assert.equal(await update(3700, -300), 1);                                               // -> 3700
  await stop();
});
