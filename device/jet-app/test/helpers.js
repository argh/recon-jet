// Shared test scaffolding: a stub jetd link, and the real Input/Surface/Ui/Modes stack driven
// by synthetic `k` events with timestamps (the button vocabulary as jetd's raw keys deliver it).
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Input } from '../src/modules/input/index.js';
import { Surface } from '../src/modules/surface/index.js';
import { Power } from '../src/modules/power/index.js';
import { Sensors } from '../src/modules/sensors/index.js';
import { Ui } from '../src/modules/ui/index.js';
import { Modes } from '../src/modules/modes/index.js';

export const fontDir = new URL('../assets/fonts/', import.meta.url).pathname;
export const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
export const tmpdir = (prefix = 'jet-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A stub for the device link: records every line, answers the requests the modules make. */
export function fakeLink({ klog = [] } = {}) {
  return Object.assign(new EventEmitter(), {
    connected: true, mode: 'remote', sent: [], hello: { w: 428, h: 240, cols: 42, rows: 12 }, klog,
    reading: { vbat: 3987, vsys: 4012, vbus: 4890, ma: -120, ctrl1: 0x8c, stat1: 0x4c, linsts: 0, cinlimit: 2, vichrg: 3, udc: 'configured', maxpower: 500 },
    send(...lines) { this.sent.push(...lines); return true; },
    setMode(m) { return this.send(`M ${m}`); },
    surface: async () => ({ w: 428, h: 240, bpp: 16, stride: 856 }),
    flushRect(x, y, w, h) { return this.send(`F ${x} ${y} ${w} ${h}`); },
    viewfinder(x, y, w, h, fps) { this.send(`Z ${x} ${y} ${w} ${h} ${fps}`); return Promise.resolve({ w: 640, h: 480 }); },
    viewfinderStop() { return this.send('z'); },
    async logBacklog(n) { this.send(n ? `J ${n}` : 'J'); n = Math.min(this.klog.length, n || this.klog.length); for (const l of this.klog.slice(-n)) this.emit('log', l); return n; },
    async reloadCalibration() { this.send('U'); return { on: 180, off: 197, deg: 20, still: 1000 }; },
    async power() { this.send('Q'); return { ...this.reading }; },
    async snapshot({ w = 640, h = 480 } = {}) { this.send(`S ${w} ${h}`); return { w, h, fmt: 'UYVY', data: Buffer.alloc(w * h * 2, 0x80) }; },
    captureStart(max) { return this.send(`V ${max}`); }, captureStop() { return this.send('v'); },
    play(pcm) { return this.send(`W ${pcm.length}`); }, playEnd() { this.send('w'); return Promise.resolve('done'); },
  });
}

/** The real input -> ui -> modes stack over a stub link; `k` has the gesture vocabulary. */
export async function stack({ link = fakeLink(), stateFile, defaultMode = '', bootMode = 'log' } = {}) {
  const dir = tmpdir('jet-stack-');
  stateFile ??= path.join(dir, 'state.json');
  const surface = Object.assign(new Surface(), { device: path.join(dir, 'fb0'), minFlushMs: 0, fontDir, mainFont: 'ter-u20b.psf', smallFont: 'Lat2-Terminus12x6.psf', viewfinderFps: 10, deviceLink: link });
  const input = Object.assign(new Input(), { holdMs: 1000, swipeDebounceMs: 250, tapCode: 28, rawKeys: true, deviceLink: link });
  input.now = () => 0;
  const power = Object.assign(new Power(), { pollMs: 0, samples: 8, roundStep: 10, deviceLink: link });
  const sensors = Object.assign(new Sensors(), { deviceLink: link });
  const ui = Object.assign(new Ui(), { defaultMode, surface, deviceLink: link });
  const modes = Object.assign(new Modes(), { stateFile, tickMs: 100000, bootMode, ui, input, deviceLink: link });
  const ready = once(surface, 'ready');
  await surface.start(); await input.start(); await power.start(); await sensors.start(); await ui.start(); await modes.start();
  await ready; await settle();
  const key = (code, value, t) => link.emit('key', { code, value, t });
  const k = {
    frontHold: (t) => { key(86, 1, t); key(86, 0, t + 1500); },
    frontPress: (t) => { key(86, 1, t); key(86, 0, t + 200); },
    rearPress: (t) => { key(107, 1, t); key(107, 0, t + 200); },
    tap: (t) => { key(28, 1, t); key(28, 0, t + 50); },
    up: (t) => { link.emit('rel', { dx: 0, dy: 30, t }); key(103, 1, t + 20); key(103, 0, t + 30); },
    down: (t) => { link.emit('rel', { dx: 0, dy: -30, t }); key(108, 1, t + 20); key(108, 0, t + 30); },
    left: (t) => { link.emit('rel', { dx: -30, dy: 0, t }); key(105, 1, t + 20); key(105, 0, t + 30); },
    right: (t) => { link.emit('rel', { dx: 30, dy: 0, t }); key(106, 1, t + 20); key(106, 0, t + 30); },
  };
  const stop = async () => { await modes.stop(); await ui.stop(); await sensors.stop?.(); await power.stop(); await input.stop(); await surface.stop(); };
  return { dir, stateFile, link, surface, input, power, sensors, ui, modes, key, k, stop };
}

/** Stands in for the sounds module: records the cue names. */
export function fakeSounds() { return { played: [], play(name) { this.played.push(name); return Promise.resolve('done'); } }; }

/** A minimal mode that records what happens to it. */
export function fakeMode(id, extra = {}) {
  const m = { id, label: id[0].toUpperCase() + id.slice(1), events: [], gestures: [], ticks: 0, rendered: 0,
    enter(ctx) { this.events.push(['enter', ctx.wizard]); }, leave() { this.events.push(['leave']); },
    onGesture(g) { this.gestures.push(g); return g === 'press:rear' ? this.consumeRear : true; }, consumeRear: false,
    render(s) { this.rendered++; s.text(6, 40, `mode ${id}`); }, tick() { this.ticks++; }, ...extra };
  return m;
}

// ---- the System mode, wired by hand -----------------------------------------------------------
// The screens are DI modules in production (SystemMode's `screens` array of `Screen` providers);
// here the same instances are assembled directly so behaviour tests control every dependency.
import { SystemMode } from '../src/modes/system/index.js';
import { StatusScreen } from '../src/modes/system/status.js';
import { PadCalScreen } from '../src/modes/system/pad-cal.js';
import { GlanceCalScreen } from '../src/modes/system/glance-cal.js';
import { InterfaceScreen } from '../src/modes/system/interface.js';
import { WearScreen } from '../src/modes/system/wear.js';
import { BluetoothScreen } from '../src/modes/system/bluetooth.js';
import { LocationScreen } from '../src/modes/system/location.js';
import { Backlight } from '../src/modules/backlight/index.js';
import { Radio } from '../src/modules/radio/index.js';

/** Stands in for the gps module: the receiver switch and the snapshot, no daemon. */
export function fakeGps() {
  return Object.assign(new EventEmitter(), {
    running: null, listening: false, state: {}, localTime: false, tz: '', calls: [],
    async probe() { return this.running === true; },
    goodFix() { return null; },
    async set(on) { this.calls.push(on); this.running = on; },
    async setLocalTime(on) { this.localTime = on; },
    listen() { this.listening = true; }, stopListening() { this.listening = false; },
  });
}

/**
 * The real SystemMode over real screens, every dependency injectable (`paths` for the files).
 * Returns the mode with `scr(id)` for reaching a screen.
 */
export function buildSystem({ paths = {}, ui, input, power, sensors, gps = fakeGps(), radio, bluez, backlight, wear, volume = null, deviceLink = fakeLink(), modes, sounds = fakeSounds(), voice = null, actions = null, logger = null } = {}) {
  radio ??= Object.assign(new Radio(), { btMarker: paths.btMarker, gps, logger });
  bluez ??= Object.assign(new EventEmitter(), { ready: true, pairing: null, list: () => [], scan: async () => {}, pair: async () => {}, remove: async () => {}, ensure: async () => {} });
  backlight ??= Object.assign(new Backlight(), { file: paths.backlightFile, sysfs: paths.backlightSysfs, logger });
  const screens = [
    Object.assign(new StatusScreen(), { netDir: paths.netDir, ui, power, sensors, gps, radio }),
    Object.assign(new PadCalScreen(), { ofmArgsFile: paths.ofmArgsFile, ofmSysfs: paths.ofmSysfs, ui, input, logger }),
    Object.assign(new GlanceCalScreen(), { glanceFile: paths.glanceFile, iioDir: paths.iioDir, ui, deviceLink, logger }),
    Object.assign(new InterfaceScreen(), { backlight, ui, volume, voice }),
    Object.assign(new WearScreen(), { wear, sensors, ui, logger }),
    Object.assign(new BluetoothScreen(), { radio, bluez, ui }),
    Object.assign(new LocationScreen(), { gps, ui }),
  ];
  const sys = Object.assign(new SystemMode(), { screens, modes, ui, gps, voice, sounds, actions, logger });
  sys.scr = (id) => sys.getScreen(id);
  sys.backlightModule = backlight; sys.radioModule = radio;
  return sys;
}
