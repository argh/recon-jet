// The screenshot path: RGB565 framebuffer bytes -> RGBA -> a PNG that decodes back to the same pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { encodePng, rgb565ToRgba } from '../src/lib/png.js';
import { screenshot } from '../src/lib/screenshot.js';
import { tmpdir } from './helpers.js';

/** A minimal PNG reader for the test: IHDR size and the unfiltered RGBA rows. */
function decode(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let i = 8; const chunks = [];
  while (i < png.length) { const len = png.readUInt32BE(i), type = png.toString('latin1', i + 4, i + 8); chunks.push({ type, data: png.subarray(i + 8, i + 8 + len) }); i += 12 + len; }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const w = chunks[0].data.readUInt32BE(0), h = chunks[0].data.readUInt32BE(4);
  assert.equal(chunks[0].data[8], 8); assert.equal(chunks[0].data[9], 6);
  const raw = zlib.inflateSync(chunks[1].data), rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) { assert.equal(raw[y * (w * 4 + 1)], 0, 'filter none'); raw.copy(rgba, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)); }
  return { w, h, rgba };
}

test('rgb565 -> rgba -> png round trip, with a pitch wider than the image and a scale', () => {
  // 3x2 image in a 4-pixel pitch: red, green, blue / white, black, mid grey
  const px = [0xf800, 0x07e0, 0x001f, 0, 0xffff, 0x0000, 0x8410, 0];
  const fb = Buffer.alloc(px.length * 2); px.forEach((p, i) => fb.writeUInt16LE(p, i * 2));
  const rgba = rgb565ToRgba(fb, 3, 2, 4);
  assert.deepEqual([...rgba.subarray(0, 12)], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  assert.deepEqual([...rgba.subarray(12, 20)], [255, 255, 255, 255, 0, 0, 0, 255], 'white is white, black is black');
  assert.deepEqual([...rgba.subarray(20, 23)], [132, 130, 132]);
  const one = decode(encodePng(rgba, 3, 2));
  assert.equal(one.w, 3); assert.equal(one.h, 2); assert.deepEqual(one.rgba, rgba);
  const big = decode(encodePng(rgba, 3, 2, { scale: 3 }));
  assert.equal(big.w, 9); assert.equal(big.h, 6);
  assert.deepEqual([...big.rgba.subarray(0, 4)], [255, 0, 0, 255]); assert.deepEqual([...big.rgba.subarray(8, 12)], [255, 0, 0, 255], 'repeated across');
  assert.deepEqual([...big.rgba.subarray(2 * 9 * 4, 2 * 9 * 4 + 4)], [255, 0, 0, 255], 'repeated down');
  assert.deepEqual([...big.rgba.subarray(3 * 9 * 4, 3 * 9 * 4 + 4)], [255, 255, 255, 255], 'second source row starts at y=3');
  assert.throws(() => encodePng(rgba, 4, 2), /png: /);
});

test('screenshot(): geometry from sysfs, pixels from the device', async () => {
  const dir = tmpdir(), sysfs = path.join(dir, 'fb0'); fs.mkdirSync(sysfs);
  fs.writeFileSync(path.join(sysfs, 'virtual_size'), '4,2\n'); fs.writeFileSync(path.join(sysfs, 'bits_per_pixel'), '16\n'); fs.writeFileSync(path.join(sysfs, 'stride'), '16\n');
  const fb = Buffer.alloc(16 * 2); fb.writeUInt16LE(0xffff, 0); fb.writeUInt16LE(0xf800, 16);
  fs.writeFileSync(path.join(dir, 'fb'), fb);
  const shot = await screenshot({ device: path.join(dir, 'fb'), sysfs, scale: 2 });
  assert.equal(shot.width, 4); assert.equal(shot.height, 2); assert.equal(shot.bpp, 16);
  const img = decode(shot.png);
  assert.equal(img.w, 8); assert.equal(img.h, 4);
  assert.deepEqual([...img.rgba.subarray(0, 4)], [255, 255, 255, 255]); assert.deepEqual([...img.rgba.subarray(2 * 8 * 4, 2 * 8 * 4 + 4)], [255, 0, 0, 255]);
  await assert.rejects(screenshot({ device: path.join(dir, 'fb'), sysfs: path.join(dir, 'none') }), /no framebuffer geometry/);
  fs.writeFileSync(path.join(dir, 'short'), Buffer.alloc(4));
  await assert.rejects(screenshot({ device: path.join(dir, 'short'), sysfs }), /expected 32/);
});
