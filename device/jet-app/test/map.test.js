// The map stack: PNG decode (every colour type the tiles use), the Mercator tile math, and the
// map mode's centring / zoom / bounded pan plus a real tile blit from the disk cache (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { encodePng, decodePng } from '../src/lib/png.js';
import { project, unproject, coverViewport, TILE } from '../src/lib/slippy.js';
import { MapMode } from '../src/modes/map/index.js';
import { tmpdir } from './helpers.js';

/** Build a minimal PNG of a given colour type by hand, to prove the decoder's branches. */
function makePng(width, height, colour, pixels, palette, trns) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const o = Buffer.alloc(12 + data.length); o.writeUInt32BE(data.length, 0); o.write(type, 4, 'latin1'); data.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + data.length)), 8 + data.length); return o; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colour;
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  const raw = Buffer.alloc((width * ch + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * ch + 1)] = 0; pixels.subarray(y * width * ch, (y + 1) * width * ch).copy(raw, y * (width * ch + 1) + 1); }
  const parts = [sig, chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', palette));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

test('png decode: rgb, rgba, grayscale, palette with transparency', () => {
  let img = decodePng(makePng(2, 1, 2, Buffer.from([10, 20, 30, 40, 50, 60])));
  assert.deepEqual([...img.data], [10, 20, 30, 255, 40, 50, 60, 255]);
  img = decodePng(makePng(1, 1, 6, Buffer.from([1, 2, 3, 128])));
  assert.deepEqual([...img.data], [1, 2, 3, 128]);
  img = decodePng(makePng(2, 1, 0, Buffer.from([77, 200])));
  assert.deepEqual([...img.data], [77, 77, 77, 255, 200, 200, 200, 255]);
  img = decodePng(makePng(2, 1, 3, Buffer.from([0, 1]), Buffer.from([9, 8, 7, 6, 5, 4]), Buffer.from([100])));
  assert.deepEqual([...img.data], [9, 8, 7, 100, 6, 5, 4, 255], 'index 0 gets tRNS alpha, index 1 opaque');
  assert.throws(() => decodePng(Buffer.from('not a png')), /signature/);
});

test('png decode: the Up and Sub filters reconstruct', () => {
  // two rows, RGB, row1 filtered Sub, row2 filtered Up; build raw and deflate
  const w = 2, h = 2, ch = 3;
  const raw = Buffer.from([
    1, 10, 20, 30, 5, 6, 7,       // row0 filter=1 (Sub): px0=(10,20,30), px1=(15,26,37)
    2, 1, 1, 1, 2, 2, 2,          // row1 filter=2 (Up): add row0 reconstructed
  ]);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length, 0); o.write(t, 4); d.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + d.length)), 8 + d.length); return o; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const img = decodePng(png);
  assert.deepEqual([...img.data.subarray(0, 8)], [10, 20, 30, 255, 15, 26, 37, 255], 'Sub');
  assert.deepEqual([...img.data.subarray(8, 16)], [11, 21, 31, 255, 17, 28, 39, 255], 'Up adds row0');
});

test('slippy: project round-trips and covers the viewport', () => {
  const z = 16, lat = 37.6000, lon = -122.3000;
  const p = project(lat, lon, z), b = unproject(p.x, p.y, z);
  assert.ok(Math.abs(b.lat - lat) < 1e-9 && Math.abs(b.lon - lon) < 1e-9);
  const cov = coverViewport(p.x - 214, p.y - 120, 428, 240, z);
  assert.ok(cov.tiles.length >= 4 && cov.tiles.length <= 9);
  for (const t of cov.tiles) { assert.ok(t.x >= 0 && t.y >= 0); assert.equal(typeof t.sx, 'number'); }
  // longitude wraps, latitude does not
  const near180 = coverViewport(project(0, 179.99, 2).x - 10, project(0, 0, 2).y, 20, 256, 2);
  assert.ok(near180.tiles.every((t) => t.x < 4));
});

test('map mode: centres on the fix, zoom clamps, pan is bounded, a cached tile blits', async () => {
  const dir = tmpdir('jet-map-');
  const gps = { listening: true, snap: { good: true, lat: 37.6000, lon: -122.3000, satsUsed: 6, satsInView: 8 },
    get state() { return this.snap; }, goodFix() { return this.snap.good ? this.snap : null; }, listen() {}, on() {} };
  const ui = { renders: 0, requestRender() { this.renders++; } };
  const map = Object.assign(new MapMode(), { tileUrl: 'https://0.0.0.0/{z}/{x}/{y}.png', cacheDir: dir, zoom: 16, minZoom: 10, maxZoom: 18, maxTiles: 50,
    modes: { current: null, register() {} }, ui, surface: { width: 428, height: 240 }, gps, sounds: { play() {} }, logger: null });
  map.modes.current = map;
  await map.start();
  map.enter();
  assert.deepEqual(map.center, { lat: 37.6000, lon: -122.3000 }, 'centred on the fix');
  // zoom clamps
  for (let i = 0; i < 10; i++) map.onGesture('press:front');
  assert.equal(map.zoom, 18);
  for (let i = 0; i < 20; i++) map.onGesture('press:rear');
  assert.equal(map.zoom, 10);
  map.zoom = 16;
  // pan leaves follow and stays within PAN_TILES of the anchor
  map.onGesture('swipe:right'); map.onGesture('swipe:right'); map.onGesture('swipe:right'); map.onGesture('swipe:right');
  assert.equal(map.follow, false);
  const a = project(map.anchor.lat, map.anchor.lon, 16), c = project(map.center.lat, map.center.lon, 16);
  assert.ok(Math.abs(c.x - a.x) <= 2 * TILE + 1, 'pan bounded to the anchor box');
  // tap recentres and follows
  map.onGesture('press:tap');
  assert.equal(map.follow, true);
  assert.deepEqual(map.center, { lat: 37.6000, lon: -122.3000 });
  // seed the disk cache for the tiles this viewport needs, then render: they blit (no network)
  const p = project(map.center.lat, map.center.lon, 16), cov = coverViewport(p.x - 214, p.y - 120, 428, 240, 16);
  const tilePng = encodePng(new Uint8Array(TILE * TILE * 4).fill(200), TILE, TILE);
  for (const t of cov.tiles) { const fp = path.join(dir, '16', `${t.x}`, `${t.y}.png`); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, tilePng); }
  const blits = [];
  const sfc = { width: 428, height: 240, fonts: { main: { width: 10, height: 20 }, small: { width: 6, height: 12 } },
    blitImage(img, x, y) { blits.push({ w: img.width, x, y }); }, fillRect() {}, text() {}, line() {} };
  map.render(sfc);
  await new Promise((r) => setTimeout(r, 50));   // disk reads are async; let them land
  map.render(sfc);
  assert.ok(blits.length >= cov.tiles.length, `tiles blitted (${blits.length})`);
  assert.ok(blits.every((b) => b.w === TILE));
});
