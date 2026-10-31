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

/**
 * Decode a PNG to RGBA, enough of the format for raster map tiles: bit depths 1/2/4/8, colour
 * types grayscale (0), RGB (2), palette (3), grey+alpha (4) and RGBA (6), all five scanline
 * filters, no interlace. (CARTO's dark tiles are 4-bit palette; OSM's are 8-bit.) Sub-byte depths
 * apply to grayscale and palette only, per the spec. Returns the shape `blitImage` takes. Throws
 * on anything it does not handle.
 * @param {Buffer|Uint8Array} buf @returns {{width: number, height: number, data: Uint8Array}}
 */
export function decodePng(buf) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('png: bad signature');
  let i = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8), data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colour = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;   // length + type + data + crc
  }
  if (!width || !height) throw new Error('png: no IHDR');
  if (![1, 2, 4, 8].includes(depth)) throw new Error(`png: ${depth}-bit depth unsupported`);
  if (interlace) throw new Error('png: interlaced unsupported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  if (!channels) throw new Error(`png: colour type ${colour} unsupported`);
  if (depth < 8 && colour !== 0 && colour !== 3) throw new Error(`png: ${depth}-bit colour type ${colour} unsupported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels * depth;                 // bits per pixel
  const stride = Math.ceil(width * bpp / 8);     // bytes per scanline (padded to a whole byte)
  const fbpp = Math.max(1, bpp >> 3);            // the filter's byte stride between pixels (>=1)
  if (raw.length < (stride + 1) * height) throw new Error('png: short pixel data');
  // unfilter in place: each scanline is 1 filter byte then `stride` bytes
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= fbpp ? px[dst + x - fbpp] : 0, b = y > 0 ? px[up + x] : 0, c = x >= fbpp && y > 0 ? px[up + x - fbpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 0xff;
    }
  }
  // a sub-byte depth packs several pixels per byte (MSB first, each row byte-aligned); unpack to
  // one sample per byte so the expand below is the same as the 8-bit path. Palette keeps the raw
  // index; grayscale scales up to 0..255.
  let samples = px;
  if (depth < 8) {
    const max = (1 << depth) - 1;
    samples = Buffer.alloc(width * height);   // channels is 1 here (grayscale or palette)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = x * depth, s = (px[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
        samples[y * width + x] = colour === 0 ? Math.round(s * 255 / max) : s;
      }
    }
  }
  // expand to RGBA
  const out = new Uint8Array(width * height * 4);
  for (let p = 0, o = 0; p < width * height; p++, o += 4) {
    let r, g, b, alpha = 255;
    if (colour === 3) { const idx = samples[p]; r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2]; if (trns && idx < trns.length) alpha = trns[idx]; }
    else if (colour === 0) { r = g = b = samples[p]; }
    else if (colour === 4) { r = g = b = samples[p * 2]; alpha = samples[p * 2 + 1]; }
    else if (colour === 2) { r = samples[p * 3]; g = samples[p * 3 + 1]; b = samples[p * 3 + 2]; }
    else { r = samples[p * 4]; g = samples[p * 4 + 1]; b = samples[p * 4 + 2]; alpha = samples[p * 4 + 3]; }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = alpha;
  }
  return { width, height, data: out };
}
