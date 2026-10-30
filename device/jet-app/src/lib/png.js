// A PNG encoder for screenshots: 8-bit RGBA, one IDAT, zlib from node. Nothing to install on
// the device for a format every browser and slide deck opens. `scale` repeats pixels (nearest
// neighbour) so a 428x240 panel reads at a sensible size in a document.
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * @param {Uint8Array} rgba  width*height*4 bytes
 * @param {number} width @param {number} height
 * @param {{scale?: number}} [options]  integer pixel repeat, 1..8
 * @returns {Buffer} the PNG file
 */
export function encodePng(rgba, width, height, { scale = 1 } = {}) {
  scale = Math.min(8, Math.max(1, Math.floor(scale)));
  if (rgba.length < width * height * 4) throw new Error(`png: ${rgba.length} bytes for ${width}x${height}`);
  const w = width * scale, h = height * scale, row = w * 4 + 1;
  const raw = Buffer.alloc(row * h);   // filter byte 0 per scanline
  for (let y = 0; y < h; y++) {
    const src = Math.floor(y / scale) * width * 4, dst = y * row + 1;
    if (scale === 1) raw.set(rgba.subarray(src, src + width * 4), dst);
    else for (let x = 0; x < width; x++) { const p = src + x * 4; for (let r = 0; r < scale; r++) raw.set(rgba.subarray(p, p + 4), dst + (x * scale + r) * 4); }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA, deflate, no filter, no interlace
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** RGB565 (little endian, `pitch` pixels per row) to RGBA, the low bits replicated so white is white. */
export function rgb565ToRgba(buf, width, height, pitch = width) {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = buf.readUInt16LE((y * pitch + x) * 2), o = (y * width + x) * 4;
    const r = (p >> 11) & 0x1f, g = (p >> 5) & 0x3f, b = p & 0x1f;
    out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 2) | (g >> 4); out[o + 2] = (b << 3) | (b >> 2); out[o + 3] = 255;
  }
  return out;
}
