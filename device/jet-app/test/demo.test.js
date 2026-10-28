// The Demo mode's picture path: UYVY -> RGBA (pure), the describe flow (snapshot, JPEG, look).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { uyvyToRgba } from '../src/lib/uyvy.js';
import { DemoMode } from '../src/modes/demo/index.js';
import { fakeLink, fakeSounds, settle } from './helpers.js';

test('uyvy -> rgba: grey, pure colours, subsampling', () => {
  const px = (Y, U, V) => Buffer.from([U, Y, V, Y]);   // two pixels
  let img = uyvyToRgba(px(128, 128, 128), 2, 1);
  assert.deepEqual([...img.data.subarray(0, 4)], [130, 130, 130, 255]);
  img = uyvyToRgba(px(235, 128, 128), 2, 1);
  assert.deepEqual([...img.data.subarray(0, 3)], [255, 255, 255], 'white clamps');
  img = uyvyToRgba(px(81, 90, 240), 2, 1);
  const [r, g, b] = img.data;
  assert.ok(r > 200 && g < 60 && b < 60, `red: ${r} ${g} ${b}`);
  const frame = Buffer.alloc(640 * 480 * 2, 0x80);
  const t0 = performance.now();
  img = uyvyToRgba(frame, 640, 480, { scale: 2 });
  assert.equal(img.width, 320); assert.equal(img.height, 240); assert.equal(img.data.length, 320 * 240 * 4);
  const { data: jpg } = jpeg.encode(img, 60);
  assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8);
  assert.ok(performance.now() - t0 < 2000);
});

test('demo: front press takes a snapshot, encodes it and streams the answer; rear clears; stale looks are dropped', async () => {
  const link = fakeLink();
  const ui = { renders: 0, strips: [], requestRender() { this.renders++; }, setStrip(t) { this.strips.push(t); } };
  const surface = { width: 428, height: 240, viewfinderRect: null, viewfinder(x, y, w, h) { this.viewfinderRect = { x, y, w, h }; return Promise.resolve({ w: 640, h: 480 }); }, stopViewfinder() { this.viewfinderRect = null; } };
  let resolveLook; const looks = [];
  const voice = { look(jpg, q, { onToken }) { looks.push({ jpg, q }); onToken('It '); onToken('is a wall.'); return new Promise((r) => { resolveLook = r; }); } };
  const demo = Object.assign(new DemoMode(), { question: 'what?', jpegQuality: 50, modes: { register() {} }, ui, surface, deviceLink: link, power: { smoothed: null }, sensors: { glance: null, view: null }, voice, sounds: fakeSounds() });
  await demo.start();
  demo.enter(); await settle();
  assert.deepEqual(surface.viewfinderRect, { x: 428 - 160 - 6, y: 14, w: 160, h: 120 });
  assert.equal(demo.onGesture('press:rear'), false, 'nothing to clear: root');
  assert.equal(demo.onGesture('press:front'), true);
  assert.equal(demo.state, 'looking'); assert.equal(ui.strips.at(-1), 'looking');
  assert.equal(demo.onGesture('press:front'), true, 'a second press while working is swallowed');
  await settle(); await new Promise((r) => setTimeout(r, 100));
  assert.equal(looks.length, 1); assert.equal(link.sent.at(-1), 'S 640 480');
  assert.equal(looks[0].q, 'what?'); assert.equal(looks[0].jpg[0], 0xff);
  const decoded = jpeg.decode(looks[0].jpg);
  assert.equal(decoded.width, 320); assert.equal(decoded.height, 240);
  assert.equal(demo.state, 'answering'); assert.equal(demo.answer, 'It is a wall.');
  resolveLook('It is a wall.'); await settle();
  assert.equal(demo.state, 'idle'); assert.equal(ui.strips.at(-1), null);
  assert.equal(demo.onGesture('press:rear'), true); assert.equal(demo.answer, '');
  // leaving mid-look: the late answer is ignored
  demo.onGesture('press:front'); await new Promise((r) => setTimeout(r, 100));
  demo.leave();
  assert.equal(surface.viewfinderRect, null);
  resolveLook('late'); await settle();
  assert.equal(demo.answer, ''); assert.equal(demo.state, 'idle');
  // a failing snapshot shows the error
  demo.enter(); link.snapshot = async () => { throw new Error('no camera'); };
  demo.onGesture('press:front'); await new Promise((r) => setTimeout(r, 20));
  assert.equal(demo.error, 'no camera'); assert.equal(demo.state, 'idle');
  assert.deepEqual(demo.sounds.played.filter((n) => n === 'error'), ['error'], 'the failure is heard'); assert.equal(demo.sounds.played[0], 'ack', 'sending is acknowledged');
});
