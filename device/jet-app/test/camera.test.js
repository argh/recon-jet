// The camera module: capture (snapshot -> RGBA, shared while in flight), the JPEG encoder, and
// the crop geometry the world's thumbnails are cut with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpegJs from 'jpeg-js';
import { Camera, crop } from '../src/modules/camera/index.js';
import { fakeLink } from './helpers.js';

/** An image whose pixels say where they are: r = x, g = y. */
function grid(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0, o = 0; y < height; y++) for (let x = 0; x < width; x++, o += 4) { data[o] = x; data[o + 1] = y; data[o + 3] = 255; }
  return { width, height, data };
}
const px = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

test('camera: capture is a full-resolution RGBA frame, stamped with the clock', async () => {
  const link = fakeLink();
  const camera = Object.assign(new Camera(), { deviceLink: link, logger: null, now: () => 1234 });
  const image = await camera.capture();
  assert.equal(link.sent.at(-1), 'S 640 480');
  assert.equal(image.width, 640); assert.equal(image.height, 480); assert.equal(image.data.length, 640 * 480 * 4);
  assert.equal(image.t, 1234);
  assert.deepEqual(px(image, 639, 479), [130, 130, 130, 255], 'the stub frame is mid grey');
  const small = await camera.capture({ w: 320, h: 240 });
  assert.equal(link.sent.at(-1), 'S 320 240'); assert.equal(small.width, 320);
});

test('camera: captures asked for while one is in flight share its frame', async () => {
  const pending = [];
  const link = { snapshot: ({ w, h }) => new Promise((resolve, reject) => pending.push({ w, h, resolve: () => resolve({ w, h, data: Buffer.alloc(w * h * 2, 0x80) }), reject })) };
  const camera = Object.assign(new Camera(), { deviceLink: link, logger: null });
  const a = camera.capture(), b = camera.capture(), other = camera.capture({ w: 160, h: 120 });
  assert.equal(pending.length, 2, 'one snapshot for the two alike, one for the other size');
  pending[0].resolve(); pending[1].resolve();
  assert.equal(await a, await b, 'the same frame object');
  assert.equal((await other).width, 160);
  const c = camera.capture();
  assert.equal(pending.length, 3, 'a capture after it landed is a new snapshot');
  pending[2].reject(new Error('not connected'));
  await assert.rejects(c, /not connected/);
  camera.capture(); assert.equal(pending.length, 4, 'a failure does not stick');
});

test('camera: jpeg encodes, and scale shrinks first', () => {
  const camera = new Camera(), image = grid(64, 48);
  const full = jpegJs.decode(camera.jpeg(image));
  assert.equal(full.width, 64); assert.equal(full.height, 48);
  const half = jpegJs.decode(camera.jpeg(image, { quality: 50, scale: 2 }));
  assert.equal(half.width, 32); assert.equal(half.height, 24);
  assert.ok(camera.jpeg(image, { quality: 20 }).length < camera.jpeg(image, { quality: 95 }).length);
});

test('crop: the rectangle as it is, clamped at the edges, null when outside', () => {
  const image = grid(200, 100);
  let out = crop(image, { x: 10, y: 20, w: 30, h: 10 });
  assert.equal(out.width, 30); assert.equal(out.height, 10);
  assert.deepEqual(px(out, 0, 0), [10, 20, 0, 255]); assert.deepEqual(px(out, 29, 9), [39, 29, 0, 255]);
  out = crop(image, { x: -10, y: -10, w: 30, h: 30 });
  assert.deepEqual([out.width, out.height], [20, 20], 'top left: only what is inside');
  assert.deepEqual(px(out, 0, 0), [0, 0, 0, 255]);
  out = crop(image, { x: 190, y: 95, w: 50, h: 50 });
  assert.deepEqual([out.width, out.height], [10, 5], 'bottom right');
  assert.deepEqual(px(out, 9, 4), [199, 99, 0, 255]);
  out = crop(image, { x: 10.6, y: 20.2, w: 2.2, h: 1 });
  assert.deepEqual([out.width, out.height], [3, 2], 'fractional edges take the pixels they touch');
  assert.equal(crop(image, { x: 200, y: 0, w: 10, h: 10 }), null);
  assert.equal(crop(image, { x: 0, y: -20, w: 10, h: 10 }), null);
  assert.equal(crop(image, { x: 5, y: 5, w: 0, h: 10 }), null);
});

test('crop: shrinks to fit with the aspect kept, never enlarges, averages what it covers', () => {
  const image = grid(200, 100);
  let out = crop(image, { x: 0, y: 0, w: 200, h: 100 }, { maxW: 96, maxH: 72 });
  assert.deepEqual([out.width, out.height], [96, 48], 'width-bound');
  out = crop(image, { x: 0, y: 0, w: 50, h: 100 }, { maxW: 96, maxH: 72 });
  assert.deepEqual([out.width, out.height], [36, 72], 'height-bound');
  out = crop(image, { x: 0, y: 0, w: 20, h: 10 }, { maxW: 96, maxH: 72 });
  assert.deepEqual([out.width, out.height], [20, 10], 'small stays small');
  out = crop(image, { x: 100, y: 40, w: 40, h: 20 }, { maxW: 10, maxH: 10 });
  assert.deepEqual([out.width, out.height], [10, 5]);
  assert.deepEqual(px(out, 0, 0), [101, 41, 0, 255], 'the mean of x 100..103, y 40..43');
  assert.deepEqual(px(out, 9, 4), [137, 57, 0, 255], 'the mean of x 136..139, y 56..59');
  out = crop(image, { x: 0, y: 0, w: 200, h: 100 }, { maxW: 1, maxH: 1 });
  assert.deepEqual([out.width, out.height], [1, 1], 'a sliver is still a pixel');
});

test('camera: hold takes a frame ahead of need; held hands it over once, and not when it is stale', async () => {
  const clock = { t: 1000 };
  const camera = Object.assign(new Camera(), { deviceLink: fakeLink(), logger: null, now: () => clock.t });
  assert.equal(camera.held(), null, 'nothing held');
  camera.hold();
  const frame = await camera.held(30000);
  assert.deepEqual([frame.width, frame.height], [640, 480]);
  assert.equal(camera.held(30000), null, 'once');
  camera.hold(); clock.t += 31000;
  assert.equal(camera.held(30000), null, 'too old to be what they were looking at');
  const dead = Object.assign(new Camera(), { deviceLink: { snapshot: async () => { throw new Error('no camera'); } }, logger: null });
  dead.hold(); await new Promise((r) => setImmediate(r));
  assert.equal(dead.held(), null, 'a failed hold is nothing held, and nothing thrown');
});
