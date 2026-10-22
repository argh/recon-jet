// UYVY (what jetd's camera snapshot `S` returns) -> RGBA, optionally subsampled by an integer
// factor on the way (every `scale`-th pixel and row, no filtering: good enough for a model).
// Pure; the output is what jpeg-js encodes and the surface blits.

/**
 * @param {Buffer|Uint8Array} uyvy packed U0 Y0 V0 Y1 per two pixels
 * @param {number} w @param {number} h source size
 * @param {{scale?: number}} [options]
 * @returns {{width: number, height: number, data: Uint8Array}} RGBA
 */
export function uyvyToRgba(uyvy, w, h, { scale = 1 } = {}) {
  const ow = Math.floor(w / scale), oh = Math.floor(h / scale), out = new Uint8Array(ow * oh * 4);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0);
  for (let y = 0; y < oh; y++) {
    const row = y * scale * w * 2;
    for (let x = 0; x < ow; x++) {
      const sx = x * scale, i = row + (sx >> 1) * 4;          // the U Y V Y quad holding pixel sx
      const Y = uyvy[i + (sx & 1 ? 3 : 1)] - 16, U = uyvy[i] - 128, V = uyvy[i + 2] - 128;
      const o = (y * ow + x) * 4, yy = 1.164 * Y;
      out[o] = clamp(yy + 1.596 * V); out[o + 1] = clamp(yy - 0.392 * U - 0.813 * V); out[o + 2] = clamp(yy + 2.017 * U); out[o + 3] = 255;
    }
  }
  return { width: ow, height: oh, data: out };
}
