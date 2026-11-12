// camera: the one place a still frame comes from. `capture()` is a jetd snapshot (`S`, a UYVY
// frame) converted to RGBA at full resolution; captures asked for while one is in flight share
// its frame (a snapshot costs jetd ~6 skipped frames, and two callers a moment apart want the
// same picture anyway). `jpeg()` is the encoder everything downstream uses (the model, the
// world's thumbnails via `crop`). No state beyond the in-flight request: the frame belongs to
// whoever asked. An image is `{width, height, data /* RGBA */}` throughout, and is shared -
// treat `data` as read-only.
import jpegJs from 'jpeg-js';
import { Schema } from '@versionzero/module-manager';
import { uyvyToRgba } from '../../lib/uyvy.js';

const s = Schema.create;

/**
 * Cut a pixel rectangle out of an RGBA image, shrunk (never enlarged) to fit `maxW` x `maxH`
 * with the aspect kept. The rectangle is clamped to the image, so a box hanging over an edge
 * gives what is there. Shrinking is a box average (every source pixel counted once): a 96x72
 * thumbnail of a whole frame is one pass over the frame, with no intermediate copy.
 * @param {{width: number, height: number, data: Uint8Array}} image
 * @param {{x: number, y: number, w: number, h: number}} rect  source pixels
 * @param {{maxW?: number, maxH?: number}} [fit]
 * @returns {{width: number, height: number, data: Uint8Array}|null} null when nothing of the rectangle is inside the image
 */
export function crop(image, rect, { maxW = Infinity, maxH = Infinity } = {}) {
  const { width: W, height: H, data: src } = image;
  const lim = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  const x0 = lim(Math.floor(rect.x), W), y0 = lim(Math.floor(rect.y), H);
  const sw = lim(Math.ceil(rect.x + rect.w), W) - x0, sh = lim(Math.ceil(rect.y + rect.h), H) - y0;
  if (!(sw > 0 && sh > 0)) return null;
  const f = Math.min(1, maxW / sw, maxH / sh);
  const ow = Math.max(1, Math.round(sw * f)), oh = Math.max(1, Math.round(sh * f));
  const out = new Uint8Array(ow * oh * 4);
  if (ow === sw && oh === sh) {   // no scaling: row copies
    for (let y = 0; y < sh; y++) { const i = ((y0 + y) * W + x0) * 4; out.set(src.subarray(i, i + sw * 4), y * sw * 4); }
    return { width: ow, height: oh, data: out };
  }
  const xs = new Int32Array(ow + 1);   // the source column where each output column's box starts
  for (let x = 0; x <= ow; x++) xs[x] = x0 + Math.floor(x * sw / ow);
  for (let y = 0, o = 0; y < oh; y++) {
    const ya = y0 + Math.floor(y * sh / oh), yb = Math.max(ya + 1, y0 + Math.floor((y + 1) * sh / oh));
    for (let x = 0; x < ow; x++, o += 4) {
      const xa = xs[x], xb = Math.max(xa + 1, xs[x + 1]);
      let r = 0, g = 0, b = 0;
      for (let sy = ya; sy < yb; sy++) {
        for (let i = (sy * W + xa) * 4, end = (sy * W + xb) * 4; i < end; i += 4) { r += src[i]; g += src[i + 1]; b += src[i + 2]; }
      }
      const n = (xb - xa) * (yb - ya);
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: ow, height: oh, data: out };
}

/**
 * Two pictures as one: both scaled to `height` (nearest neighbour, up or down), LEFT and RIGHT
 * of a white bar. For asking a vision model to compare two things: it relates two halves of one
 * picture far more reliably than two separate pictures (which it mixes up).
 * @param {{width: number, height: number, data: Uint8Array}} a @param {{width: number, height: number, data: Uint8Array}} b
 * @param {{height?: number, gap?: number}} [options]
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function sideBySide(a, b, { height = 200, gap = 24 } = {}) {
  const wa = Math.max(1, Math.round(a.width * height / a.height)), wb = Math.max(1, Math.round(b.width * height / b.height));
  const W = wa + gap + wb, data = new Uint8Array(W * height * 4).fill(255);
  const paint = (img, w, x0) => {
    const src = new Uint32Array(img.data.buffer, img.data.byteOffset, img.width * img.height), dst = new Uint32Array(data.buffer);
    for (let y = 0; y < height; y++) {
      const row = Math.min(img.height - 1, Math.floor(y * img.height / height)) * img.width, o = y * W + x0;
      for (let x = 0; x < w; x++) dst[o + x] = src[row + Math.min(img.width - 1, Math.floor(x * img.width / w))];
    }
  };
  paint(a, wa, 0); paint(b, wb, wa + gap);
  return { width: W, height, data };
}

export class Camera {
  static moduleInfo = {
    name: 'camera',
    schema: s()
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  deviceLink; logger;

  /** the clock, a field so tests own time */ now = () => Date.now();
  /** @type {{key: string, promise: Promise<object>}|null} the snapshot in flight */ #pending = null;
  /** @type {{t: number, promise: Promise<object>}|null} a frame taken ahead of need (`hold`) */ #held = null;

  /** The camera is already streaming (a viewfinder is up): a capture is a tap on that stream, not a sensor start. */
  get streaming() { return Boolean(this.deviceLink.streaming); }

  /**
   * Take a frame now and keep it for whoever asks next (`held`): what the wearer was looking at
   * when they asked, not what the camera sees seconds later when the model gets round to looking.
   * Never throws (a camera that fails here fails again, loudly, at the real capture).
   */
  hold(size) {
    const promise = this.capture(size);
    promise.catch(() => { if (this.#held?.promise === promise) this.#held = null; });
    this.#held = { t: this.now(), promise };
  }

  /**
   * The held frame, once: null when there is none or it is older than `maxAgeMs`.
   * @returns {Promise<{width: number, height: number, data: Uint8Array, t: number}>|null}
   */
  held(maxAgeMs = 30000) {
    const h = this.#held;
    this.#held = null;
    return h && this.now() - h.t <= maxAgeMs ? h.promise : null;
  }

  /**
   * One frame through jetd, as RGBA at the size asked for. A capture requested while another
   * of the same size is in flight resolves with that one's frame (the same object).
   * @param {{w?: number, h?: number}} [size]
   * @returns {Promise<{width: number, height: number, data: Uint8Array, t: number}>}
   */
  capture({ w = 640, h = 480 } = {}) {
    const key = `${w}x${h}`;
    if (this.#pending?.key === key) return this.#pending.promise;
    const promise = (async () => {
      const t0 = this.now();
      const frame = await this.deviceLink.snapshot({ w, h });
      const image = uyvyToRgba(frame.data, frame.w, frame.h);
      this.logger?.debug?.({ size: `${image.width}x${image.height}`, ms: this.now() - t0 }, 'camera: capture');
      return { ...image, t: this.now() };
    })().finally(() => { if (this.#pending?.promise === promise) this.#pending = null; });
    this.#pending = { key, promise };
    return promise;
  }

  /**
   * JPEG-encode an image. `scale` shrinks first by that factor (2 = half each way, box
   * filtered), the same meaning it has in `uyvyToRgba`.
   * @param {{width: number, height: number, data: Uint8Array}} image
   * @param {{quality?: number, scale?: number}} [options]
   * @returns {Buffer}
   */
  jpeg(image, { quality = 70, scale = 1 } = {}) {
    if (scale > 1) image = crop(image, { x: 0, y: 0, w: image.width, h: image.height }, { maxW: Math.max(1, Math.floor(image.width / scale)), maxH: Math.max(1, Math.floor(image.height / scale)) });
    return jpegJs.encode({ width: image.width, height: image.height, data: image.data }, quality).data;
  }
}
