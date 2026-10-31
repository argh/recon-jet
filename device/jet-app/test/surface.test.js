import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { parsePsf } from '../src/modules/surface/psf.js';
import { Raster, to565, union, intersect, clip, diffRect, layoutText } from '../src/modules/surface/raster.js';
import { parseIcon, ICONS } from '../src/modules/surface/icons.js';
import { Surface } from '../src/modules/surface/index.js';

const fontDir = new URL('../assets/fonts/', import.meta.url).pathname;
const main = parsePsf(fs.readFileSync(path.join(fontDir, 'ter-u20b.psf')));
const small = parsePsf(fs.readFileSync(path.join(fontDir, 'Lat2-Terminus12x6.psf')));

test('PSF2 fonts parse with their unicode tables', () => {
  assert.deepEqual([main.width, main.height, main.count], [10, 20, 256]);
  assert.deepEqual([small.width, small.height, small.count], [6, 12, 256]);
  assert.equal(main.indexOf(0x41), 0x41);                       // ASCII maps onto itself
  assert.ok(main.glyph(main.indexOf(0x41)).some((b) => b));     // 'A' has ink
  assert.equal(main.indexOf(0x1f600), main.indexOf(0x3f));      // missing -> '?'
  assert.ok(main.map.size > 256);                               // the table maps more than the glyph count
});

test('PSF1 parses (8 wide, glyph index = code point without a table, UCS-2 table when present)', () => {
  const glyphs = Buffer.alloc(256 * 8); glyphs[0x41 * 8 + 3] = 0x18;
  const bare = parsePsf(Buffer.concat([Buffer.from([0x36, 0x04, 0x00, 0x08]), glyphs]));
  assert.deepEqual([bare.width, bare.height, bare.count, bare.map], [8, 8, 256, null]);
  assert.equal(bare.glyph(0x41)[3], 0x18);
  // table: glyph 0 <- U+00E9, glyph 1 <- 'A' plus the sequence <'A', U+0301> (ignored), glyph 2 <- nothing
  const table = Buffer.from([0xe9, 0x00, 0xff, 0xff, 0x41, 0x00, 0xfe, 0xff, 0x41, 0x00, 0x01, 0x03, 0xff, 0xff, 0xff, 0xff]);
  const withTable = parsePsf(Buffer.concat([Buffer.from([0x36, 0x04, 0x02, 0x08]), glyphs, table]));
  assert.equal(withTable.indexOf(0xe9), 0);
  assert.equal(withTable.indexOf(0x41), 1);
  assert.equal(withTable.indexOf(0x301, -1), -1);
});

test('RGB565 packing and rectangle algebra', () => {
  assert.equal(to565(0xffffff), 0xffff);
  assert.equal(to565(0xff0000), 0xf800);
  assert.equal(to565([0, 255, 0]), 0x07e0);
  assert.equal(to565(0x0000ff), 0x001f);
  assert.equal(to565(0x080408), 0x0821);
  assert.deepEqual(union({ x: 1, y: 1, w: 2, h: 2 }, { x: 5, y: 0, w: 1, h: 1 }), { x: 1, y: 0, w: 5, h: 3 });
  assert.deepEqual(union(null, { x: 1, y: 1, w: 2, h: 2 }), { x: 1, y: 1, w: 2, h: 2 });
  assert.deepEqual(intersect({ x: 0, y: 0, w: 4, h: 4 }, { x: 2, y: 2, w: 4, h: 4 }), { x: 2, y: 2, w: 2, h: 2 });
  assert.equal(intersect({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 }), null);
  assert.deepEqual(clip(-3, 2, 10, 10, 5, 5), { x: 0, y: 2, w: 5, h: 3 });
  assert.equal(clip(6, 0, 2, 2, 5, 5), null);
});

test('text layout truncates to maxWidth with a marker', () => {
  assert.deepEqual(layoutText('hello', small), { chars: [...'hello'], w: 30, h: 12 });
  assert.deepEqual(layoutText('hello world', small, { maxWidth: 36 }).chars, [...'hello~']);
  assert.deepEqual(layoutText('hi', small, { maxWidth: 6 }).chars, ['h']);
});

test('diffRect finds the tight changed rectangle', () => {
  const a = Buffer.alloc(8 * 2 * 4), b = Buffer.alloc(8 * 2 * 4);
  const rect = { x: 0, y: 0, w: 8, h: 4 };
  assert.equal(diffRect(a, b, rect, 8), null);
  b.writeUInt16LE(1, (1 * 8 + 3) * 2); b.writeUInt16LE(1, (2 * 8 + 5) * 2);
  assert.deepEqual(diffRect(a, b, rect, 8), { x: 3, y: 1, w: 3, h: 2 });
  assert.deepEqual(diffRect(a, b, { x: 0, y: 2, w: 8, h: 2 }, 8), { x: 5, y: 2, w: 1, h: 1 });
});

test('raster primitives clip, track dirty bounds and honour pitch', () => {
  const r = new Raster(20, 10, { pitch: 24 });
  assert.equal(r.bytes.length, 24 * 2 * 10);
  r.fillRect(-2, -2, 4, 4, 0xff0000);
  assert.deepEqual(r.takeDirty(), { x: 0, y: 0, w: 2, h: 2 });
  assert.equal(r.px[1 * 24 + 1], 0xf800); assert.equal(r.px[2 * 24 + 2], 0);
  r.line(0, 9, 19, 0, 0x00ff00);
  assert.deepEqual(r.takeDirty(), { x: 0, y: 0, w: 20, h: 10 });
  assert.equal(r.px[9 * 24], 0x07e0); assert.equal(r.px[19], 0x07e0);
  r.strokeRect(0, 0, 5, 4, 0xffffff);
  assert.equal(r.px[1], 0xffff); assert.equal(r.px[2 * 24 + 3], 0); assert.equal(r.px[3 * 24 + 4], 0xffff);
  r.icon(0, 0, parseIcon(['#.', '.#']), 0x0000ff);
  assert.equal(r.px[0], 0x001f); assert.equal(r.px[1], 0xffff); assert.equal(r.px[24 + 1], 0x001f);
  r.clear(0);
  r.fillCircle(5, 5, 3, 0xffffff);
  assert.equal(r.px[5 * 24 + 5], 0xffff, 'centre filled');
  assert.equal(r.px[5 * 24 + 8], 0xffff, 'horizontal extent reaches the radius');
  assert.equal(r.px[2 * 24 + 2], 0, 'the corner of the bounding box is left clear');
  r.clear(0x101010);
  assert.deepEqual(r.takeDirty(), { x: 0, y: 0, w: 20, h: 10 });
  assert.equal(r.px[24 * 9 + 19], to565(0x101010));
});

test('surface forwards every drawing call the modes use to the raster (fillCircle was once missing)', () => {
  const calls = new Set();
  const s = Object.assign(new Surface(), { fonts: { main: {}, small: {} } });
  s.raster = new Proxy({}, { get: (_t, m) => () => { calls.add(m); } });
  for (const m of ['clear', 'fillRect', 'strokeRect', 'fillCircle', 'line', 'blitImage', 'icon', 'text']) {
    assert.equal(typeof s[m], 'function', `Surface.${m} is defined`);
    s[m](0, 0, 0, 0);   // a mode that calls a method the Surface does not forward would throw here on-device
  }
  for (const m of ['clear', 'fillRect', 'strokeRect', 'fillCircle', 'line', 'blitImage', 'icon']) assert.ok(calls.has(m), `Surface.${m} reaches the raster`);
});

test('text draws glyph ink inside its box, aligns and truncates', () => {
  const r = new Raster(100, 30);
  const box = r.text(50, 2, 'ab', { font: small, colour: 0xffffff, align: 'center' });
  assert.deepEqual(box, { x: 44, y: 2, w: 12, h: 12 });
  const ink = (rect) => { let n = 0; for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) n += r.px[y * r.pitch + x] ? 1 : 0; return n; };
  assert.ok(ink(box) > 10);
  assert.equal(ink({ x: 0, y: 0, w: 100, h: 30 }), ink(box));
  assert.deepEqual(r.takeDirty(), box);
  assert.deepEqual(r.text(100, 16, 'xyz', { font: small, align: 'right' }), { x: 82, y: 16, w: 18, h: 12 });
  assert.deepEqual(r.text(0, 16, 'abcdefghij', { font: main, maxWidth: 55 }), { x: 0, y: 16, w: 50, h: 20 });
  r.text(-500, 200, 'off screen', { font: main });   // nothing to draw, nothing thrown
  r.text(2, 2, 'ab', { font: small, colour: 0, background: 0xff0000 });
  assert.equal(r.px[2 * r.pitch + 2], 0xf800);
});

test('blitRGB565 and blitImage (jpeg-js round trip, scaled)', () => {
  const r = new Raster(16, 8);
  const src = new Uint16Array([1, 2, 3, 4, 5, 6]);
  r.blitRGB565(src, 14, 7, 3, 2);   // clipped to 2 x 1
  assert.deepEqual([r.px[7 * 16 + 14], r.px[7 * 16 + 15]], [1, 2]);
  assert.deepEqual(r.takeDirty(), { x: 14, y: 7, w: 2, h: 1 });
  const rgba = Buffer.alloc(8 * 8 * 4); for (let i = 0; i < 64; i++) { rgba[i * 4] = 255; rgba[i * 4 + 3] = 255; }
  const image = jpeg.decode(jpeg.encode({ width: 8, height: 8, data: rgba }, 100).data, { useTArray: true, formatAsRGBA: true });
  r.blitImage(image, 0, 0, { w: 4, h: 4 });
  const px = r.px[3 * 16 + 3];
  assert.ok((px >> 11) >= 29 && (px & 0x7ff) < 0x80, `red-ish: ${px.toString(16)}`);
  assert.equal(r.px[4 * 16 + 4], 0);
  assert.deepEqual(r.takeDirty(), { x: 0, y: 0, w: 4, h: 4 });
  assert.equal(ICONS.battery.w, 16);
});

test('surface: acquires geometry, writes changed rows only, leaves the viewfinder to jetd', async () => {
  const device = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jet-fb-')), 'fb0');
  const sent = [];
  const link = { connected: true, on() {}, send: (l) => sent.push(l), surface: async () => ({ w: 8, h: 4, bpp: 16, stride: 16 }),
    flushRect: (...a) => sent.push(`F ${a.join(' ')}`), viewfinder: async () => ({ w: 640, h: 480 }), viewfinderStop: () => sent.push('z') };
  const s = Object.assign(new Surface(), { device, minFlushMs: 0, fontDir, mainFont: 'ter-u20b.psf', smallFont: 'Lat2-Terminus12x6.psf', viewfinderFps: 10, deviceLink: link });
  const ready = once(s, 'ready');
  await s.start(); await ready;
  assert.deepEqual(s.geometry, { w: 8, h: 4, bpp: 16, stride: 16 });
  assert.equal(s.width, 8);
  const fb = () => { const b = fs.readFileSync(device); return Array.from({ length: b.length / 2 }, (_, i) => b.readUInt16LE(i * 2)); };
  s.active = false; s.fillRect(0, 0, 8, 4, 0xff0000);
  assert.equal(s.flush(), null);
  s.active = true;
  assert.deepEqual(s.flush(), { x: 0, y: 0, w: 8, h: 4 });
  assert.deepEqual(sent, ['F 0 0 8 4']);
  assert.ok(fb().every((p) => p === 0xf800));
  sent.length = 0;
  s.fillRect(0, 0, 8, 4, 0xff0000); s.fillRect(2, 1, 2, 1, 0x0000ff);   // the red is unchanged, only the blue differs
  assert.deepEqual(s.flush(), { x: 2, y: 1, w: 2, h: 1 });
  assert.deepEqual(sent, ['F 2 1 2 1']);
  assert.deepEqual(fb().slice(8, 16), [0xf800, 0xf800, 0x001f, 0x001f, 0xf800, 0xf800, 0xf800, 0xf800]);
  sent.length = 0;
  assert.equal(s.flush(), null);
  assert.deepEqual(sent, []);
  await s.viewfinder(4, 0, 4, 4);
  s.clear(0x00ff00);
  assert.deepEqual(s.flush(), { x: 0, y: 0, w: 8, h: 4 });
  const after = fb();
  assert.ok(after.slice(0, 4).every((p) => p === 0x07e0));
  assert.deepEqual(after.slice(4, 8), [0xf800, 0xf800, 0xf800, 0xf800]);     // jetd's rectangle untouched
  assert.deepEqual(after.slice(8, 16), [0x07e0, 0x07e0, 0x07e0, 0x07e0, 0xf800, 0xf800, 0xf800, 0xf800]);
  sent.length = 0;
  s.stopViewfinder();
  assert.deepEqual(s.flush(), { x: 4, y: 0, w: 4, h: 4 });
  assert.deepEqual(sent, ['z', 'F 4 0 4 4']);
  assert.ok(fb().every((p) => p === 0x07e0));
  s.invalidate();
  assert.deepEqual(s.flush(), { x: 0, y: 0, w: 8, h: 4 });
  await s.stop();
});

test('surface: a paused viewfinder is stopped at jetd but remembered; resume restarts it, a stop while paused forgets it', async () => {
  const device = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jet-fb-')), 'fb0');
  const sent = [];
  const link = { connected: true, on() {}, send: (l) => sent.push(l), surface: async () => ({ w: 8, h: 4, bpp: 16, stride: 16 }),
    flushRect: (...a) => sent.push(`F ${a.join(' ')}`), viewfinder: async (...a) => { sent.push(`Z ${a.join(' ')}`); return { w: 640, h: 480 }; }, viewfinderStop: () => sent.push('z') };
  const s = Object.assign(new Surface(), { device, minFlushMs: 0, fontDir, mainFont: 'ter-u20b.psf', smallFont: 'Lat2-Terminus12x6.psf', viewfinderFps: 10, deviceLink: link });
  const ready = once(s, 'ready');
  await s.start(); await ready; s.active = true; s.flush();
  await s.viewfinder(4, 0, 4, 4);
  sent.length = 0;
  s.pauseViewfinder(); s.pauseViewfinder();
  assert.equal(s.viewfinderRect, null, 'jetd is not streaming, so the rectangle is ours again');
  assert.deepEqual(s.flush(), { x: 4, y: 0, w: 4, h: 4 }); assert.deepEqual(sent, ['z', 'F 4 0 4 4']);
  sent.length = 0;
  assert.equal(await s.viewfinder(0, 0, 4, 4), null, 'a mode asking while paused is parked');
  assert.deepEqual(sent, []);
  s.resumeViewfinder(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['Z 0 0 4 4 10']); assert.deepEqual(s.viewfinderRect, { x: 0, y: 0, w: 4, h: 4 }, 'the latest request, not the first');
  sent.length = 0;
  s.pauseViewfinder(); s.stopViewfinder(); s.resumeViewfinder(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['z'], 'stopped while paused: nothing to resume');
  assert.equal(s.viewfinderRect, null);
  await s.stop();
});
