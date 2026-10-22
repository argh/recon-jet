// Raster: an RGB565 back buffer with a minimal canvas-like API and a dirty bounding rectangle.
// Pure JS, no device knowledge: the surface module owns the framebuffer and jetd.
// Pixels are native-endian 16-bit (the Jet and every host we run on are little-endian, like the
// panel's framebuffer), `pitch` pixels per row so rows can be written to the device as-is.
// Colours are 0xRRGGBB or [r, g, b], converted once per call.

/** @typedef {{x:number, y:number, w:number, h:number}} Rect */

/** 0xRRGGBB or [r, g, b] -> RGB565 */
export function to565(colour) {
  const c = Array.isArray(colour) ? (colour[0] << 16) | (colour[1] << 8) | colour[2] : colour;
  return ((c >> 8) & 0xf800) | ((c >> 5) & 0x07e0) | ((c >> 3) & 0x001f);
}

/** Bounding rectangle of two rectangles (either may be null). @returns {Rect|null} */
export function union(a, b) {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Overlap of two rectangles. @returns {Rect|null} */
export function intersect(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Clip a rectangle to a width x height canvas (integers). @returns {Rect|null} */
export function clip(x, y, w, h, width, height) {
  return intersect({ x: Math.trunc(x), y: Math.trunc(y), w: Math.trunc(w), h: Math.trunc(h) }, { x: 0, y: 0, w: width, h: height });
}

/**
 * The tight rectangle inside `rect` where two pixel buffers (same pitch) differ, or null.
 * Rows are compared natively; columns are narrowed only on rows that changed.
 */
export function diffRect(a, b, rect, pitch) {
  const stride = pitch * 2;
  let top = -1, bottom = -1, left = rect.x + rect.w, right = rect.x;
  const a16 = new Uint16Array(a.buffer, a.byteOffset, a.byteLength >> 1), b16 = new Uint16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const s = y * stride + rect.x * 2, e = s + rect.w * 2;
    if (a.compare(b, s, e, s, e) === 0) continue;
    if (top < 0) top = y;
    bottom = y;
    const row = y * pitch;
    let l = rect.x, r = rect.x + rect.w - 1;
    while (l < left && a16[row + l] === b16[row + l]) l++;
    while (r >= right && a16[row + r] === b16[row + r]) r--;
    if (l < left) left = l;
    if (r >= right) right = r + 1;
  }
  return top < 0 ? null : { x: left, y: top, w: right - left, h: bottom - top + 1 };
}

/** Lay out one line of monospace text: truncate to `maxWidth` pixels with a '~' marker. */
export function layoutText(text, font, { maxWidth = Infinity } = {}) {
  let chars = Array.from(String(text));
  const fit = Math.floor(maxWidth / font.width);
  if (chars.length > fit) chars = fit > 1 ? [...chars.slice(0, fit - 1), '~'] : chars.slice(0, Math.max(fit, 0));
  return { chars, w: chars.length * font.width, h: font.height };
}

export class Raster {
  /** @param {number} width @param {number} height @param {{pitch?: number}} [options] pitch in pixels (>= width) */
  constructor(width, height, { pitch = width } = {}) {
    this.width = width; this.height = height; this.pitch = pitch;
    this.bytes = Buffer.alloc(pitch * 2 * height);
    this.px = new Uint16Array(this.bytes.buffer, this.bytes.byteOffset, pitch * height);
    /** @type {Rect|null} bounding box of everything drawn since the last `takeDirty()` */
    this.dirty = null;
  }

  get bounds() { return { x: 0, y: 0, w: this.width, h: this.height }; }
  touch(rect) { if (rect) this.dirty = union(this.dirty, rect); }
  takeDirty() { const d = this.dirty; this.dirty = null; return d; }

  clear(colour = 0) { this.px.fill(to565(colour)); this.touch(this.bounds); }

  fillRect(x, y, w, h, colour) {
    const r = clip(x, y, w, h, this.width, this.height);
    if (!r) return;
    const c = to565(colour);
    for (let row = r.y; row < r.y + r.h; row++) this.px.fill(c, row * this.pitch + r.x, row * this.pitch + r.x + r.w);
    this.touch(r);
  }

  strokeRect(x, y, w, h, colour, { width = 1 } = {}) {
    this.fillRect(x, y, w, width, colour); this.fillRect(x, y + h - width, w, width, colour);
    this.fillRect(x, y, width, h, colour); this.fillRect(x + w - width, y, width, h, colour);
  }

  /** Bresenham line, end points inclusive. */
  line(x0, y0, x1, y1, colour) {
    const c = to565(colour);
    x0 = Math.trunc(x0); y0 = Math.trunc(y0); x1 = Math.trunc(x1); y1 = Math.trunc(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    const box = clip(Math.min(x0, x1), Math.min(y0, y1), dx + 1, -dy + 1, this.width, this.height);
    let err = dx + dy;
    for (;;) {
      if (x0 >= 0 && x0 < this.width && y0 >= 0 && y0 < this.height) this.px[y0 * this.pitch + x0] = c;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    this.touch(box);
  }

  /** @returns {{w:number, h:number, chars:string[]}} */
  measureText(text, { font, maxWidth } = {}) { return layoutText(text, font, { maxWidth }); }

  /**
   * One line of text; `x` is the left edge, centre or right edge according to `align`.
   * @param {{font: import('./psf.js').PsfFont, colour?: number|number[], color?: number|number[], align?: 'left'|'center'|'centre'|'right', maxWidth?: number, background?: number|number[]}} options
   * @returns {Rect} the box the text occupies
   */
  text(x, y, text, { font, colour, color, align = 'left', maxWidth, background } = {}) {
    const { chars, w, h } = layoutText(text, font, { maxWidth });
    x = Math.trunc(align === 'right' ? x - w : align === 'center' || align === 'centre' ? x - w / 2 : x); y = Math.trunc(y);
    if (background !== undefined) this.fillRect(x, y, w, h, background);
    const c = to565(colour ?? color ?? 0xffffff), gw = font.width, gh = font.height, rb = font.rowBytes;
    for (let i = 0; i < chars.length; i++) {
      const gx = x + i * gw;
      if (gx + gw <= 0 || gx >= this.width || y >= this.height || y + gh <= 0) continue;
      const g = font.glyph(font.indexOf(chars[i].codePointAt(0)));
      const r0 = Math.max(0, -y), r1 = Math.min(gh, this.height - y), c0 = Math.max(0, -gx), c1 = Math.min(gw, this.width - gx);
      for (let r = r0; r < r1; r++) {
        const row = (y + r) * this.pitch + gx, gr = r * rb;
        for (let col = c0; col < c1; col++) if (g[gr + (col >> 3)] & (0x80 >> (col & 7))) this.px[row + col] = c;
      }
    }
    const box = { x, y, w, h };
    this.touch(clip(x, y, w, h, this.width, this.height));
    return box;
  }

  /** Copy w x h RGB565 pixels (`pitch` per source row) to (x, y). @param {Buffer|Uint16Array} src */
  blitRGB565(src, x, y, w, h, { pitch = w } = {}) {
    const s16 = src instanceof Uint16Array ? src : new Uint16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
    const r = clip(x, y, w, h, this.width, this.height);
    if (!r) return;
    for (let row = 0; row < r.h; row++) {
      const so = (r.y - y + row) * pitch + (r.x - x);
      this.px.set(s16.subarray(so, so + r.w), (r.y + row) * this.pitch + r.x);
    }
    this.touch(r);
  }

  /**
   * Draw a decoded image (RGBA or RGB bytes, e.g. jpeg-js output) at (x, y), nearest-neighbour
   * scaled to w x h when given.
   * @param {{width:number, height:number, data:Uint8Array}} image
   */
  blitImage(image, x, y, { w = image.width, h = image.height } = {}) {
    const ch = image.data.length / (image.width * image.height) === 3 ? 3 : 4, d = image.data;
    const r = clip(x, y, w, h, this.width, this.height);
    if (!r) return;
    for (let row = 0; row < r.h; row++) {
      const sy = Math.floor((r.y - y + row) * image.height / h), dst = (r.y + row) * this.pitch + r.x;
      for (let col = 0; col < r.w; col++) {
        const si = (sy * image.width + Math.floor((r.x - x + col) * image.width / w)) * ch;
        this.px[dst + col] = ((d[si] << 8) & 0xf800) | ((d[si + 1] << 3) & 0x07e0) | (d[si + 2] >> 3);
      }
    }
    this.touch(r);
  }

  /** A 1 bpp icon (see icons.js) in `colour`, each bit `scale` pixels square. */
  icon(x, y, icon, colour, { scale = 1 } = {}) {
    const c = to565(colour);
    x = Math.trunc(x); y = Math.trunc(y);
    for (let r = 0; r < icon.h; r++) {
      for (let col = 0; col < icon.w; col++) {
        if (!(icon.rows[r] & (1 << (icon.w - 1 - col)))) continue;
        if (scale === 1) { const px = x + col, py = y + r; if (px >= 0 && px < this.width && py >= 0 && py < this.height) this.px[py * this.pitch + px] = c; }
        else this.fillRect(x + col * scale, y + r * scale, scale, scale, colour);
      }
    }
    this.touch(clip(x, y, icon.w * scale, icon.h * scale, this.width, this.height));
  }
}
