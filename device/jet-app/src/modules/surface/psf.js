// PSF bitmap fonts (the Linux console format, versions 1 and 2). Glyphs are 1 bpp, one row per
// (width + 7) / 8 bytes, MSB first. The optional unicode table maps code points to glyph indexes;
// without one (or for code points it lacks) the glyph index is the code point itself.

const PSF2_MAGIC = 0x864ab572;

export class PsfFont {
  /** @param {{width:number, height:number, count:number, glyphSize:number, glyphs:Uint8Array, map:Map<number,number>|null}} parsed */
  constructor({ width, height, count, glyphSize, glyphs, map }) {
    this.width = width; this.height = height; this.count = count;
    this.glyphSize = glyphSize; this.rowBytes = (width + 7) >> 3;
    this.glyphs = glyphs; this.map = map;
    this.fallback = this.indexOf('?'.codePointAt(0), -1);
  }

  /** Glyph index for a code point; `fallback` (default the font's '?') when the font lacks it. */
  indexOf(codePoint, fallback = this.fallback) {
    const i = this.map ? this.map.get(codePoint) : codePoint;
    return i !== undefined && i < this.count ? i : fallback;
  }

  /** @returns {Uint8Array} the glyph's rows (rowBytes per row, height rows) */
  glyph(index) { return this.glyphs.subarray(index * this.glyphSize, (index + 1) * this.glyphSize); }
}

/** @param {Buffer|Uint8Array} buf a .psf file @returns {PsfFont} */
export function parsePsf(buf) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b[0] === 0x36 && b[1] === 0x04) {
    const mode = b[2], count = mode & 1 ? 512 : 256, height = b[3];
    const glyphs = b.subarray(4, 4 + count * height);
    const map = mode & 6 ? readTable1(b.subarray(4 + count * height)) : null;
    return new PsfFont({ width: 8, height, count, glyphSize: height, glyphs, map });
  }
  if (b.length >= 32 && b.readUInt32LE(0) === PSF2_MAGIC) {
    const start = b.readUInt32LE(8), flags = b.readUInt32LE(12), count = b.readUInt32LE(16);
    const glyphSize = b.readUInt32LE(20), height = b.readUInt32LE(24), width = b.readUInt32LE(28);
    const glyphs = b.subarray(start, start + count * glyphSize);
    const map = flags & 1 ? readTable2(b.subarray(start + count * glyphSize)) : null;
    return new PsfFont({ width, height, count, glyphSize, glyphs, map });
  }
  throw new Error('not a PSF font');
}

// PSF1 table: UCS-2 LE per glyph, 0xFFFE opens a sequence (ignored), 0xFFFF ends the glyph.
function readTable1(t) {
  const map = new Map();
  let glyph = 0, inSeq = false;
  for (let i = 0; i + 1 < t.length; i += 2) {
    const v = t[i] | (t[i + 1] << 8);
    if (v === 0xffff) { glyph++; inSeq = false; }
    else if (v === 0xfffe) inSeq = true;
    else if (!inSeq && !map.has(v)) map.set(v, glyph);
  }
  return map;
}

// PSF2 table: UTF-8 per glyph, 0xFE opens a sequence (ignored), 0xFF ends the glyph.
function readTable2(t) {
  const map = new Map();
  let glyph = 0, inSeq = false;
  for (let i = 0; i < t.length;) {
    const c = t[i];
    if (c === 0xff) { glyph++; inSeq = false; i++; continue; }
    if (c === 0xfe) { inSeq = true; i++; continue; }
    let cp, n;
    if (c < 0x80) { cp = c; n = 1; }
    else if ((c & 0xe0) === 0xc0) { cp = c & 0x1f; n = 2; }
    else if ((c & 0xf0) === 0xe0) { cp = c & 0x0f; n = 3; }
    else { cp = c & 0x07; n = 4; }
    for (let k = 1; k < n; k++) cp = (cp << 6) | (t[i + k] & 0x3f);
    i += n;
    if (!inSeq && !map.has(cp)) map.set(cp, glyph);
  }
  return map;
}
