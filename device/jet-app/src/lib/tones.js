// Tones rendered as 48 kHz stereo S16 PCM (what jetd's `W` plays), with a 5 ms fade at each end
// so they do not click. Pure functions, no device knowledge; the vocabulary lives in the sounds
// module.

export const RATE = 48000;

/**
 * A sequence of tones played back to back.
 * @param {Array<{hz: number, ms: number}>} notes
 * @param {{gain?: number, rate?: number}} [options] gain 0..1 (0.3 is comfortable on the Jet's speaker)
 * @returns {Buffer} interleaved stereo S16
 */
export function tones(notes, { gain = 0.3, rate = RATE } = {}) {
  const frames = notes.map((n) => Math.round(rate * n.ms / 1000));
  const buf = Buffer.alloc(frames.reduce((a, b) => a + b, 0) * 4);
  const fade = Math.round(rate * 0.005);
  let f = 0;
  notes.forEach((n, i) => {
    const len = frames[i];
    for (let k = 0; k < len; k++, f++) {
      const env = Math.min(1, (k + 1) / fade, (len - k) / fade);
      const v = Math.round(Math.sin(2 * Math.PI * n.hz * k / rate) * env * gain * 32767);
      buf.writeInt16LE(v, f * 4); buf.writeInt16LE(v, f * 4 + 2);
    }
  });
  return buf;
}
