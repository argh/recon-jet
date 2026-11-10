// PCM conversion for the speaker: whatever the TTS returns (24 kHz mono S16 from kokoro) to the
// 48 kHz stereo S16 jetd plays (`docs/audio.md`: mono streams silence the amp). Linear
// interpolation between neighbouring input frames; a mono input is duplicated to both channels,
// a stereo input keeps its channels. Pure JS: a 3 s clip is a few ms on the Jet.

export const OUT_RATE = 48000;

/**
 * @param {Buffer} pcm interleaved S16LE
 * @param {{rate: number, channels?: number}} format of `pcm`
 * @param {{rate?: number}} [out]
 * @returns {Buffer} interleaved stereo S16LE at `out.rate` (48 kHz)
 */
export function toStereo48k(pcm, { rate, channels = 1 }, { rate: outRate = OUT_RATE } = {}) {
  if (channels !== 1 && channels !== 2) throw new Error(`${channels}-channel input`);
  if (!(rate > 0)) throw new Error(`bad rate ${rate}`);
  const inFrames = Math.floor(pcm.length / (2 * channels));
  if (inFrames === 0) return Buffer.alloc(0);
  const aligned = pcm.byteOffset % 2 ? Buffer.from(pcm) : pcm;   // an Int16Array view needs 2-byte alignment
  const src = new Int16Array(aligned.buffer, aligned.byteOffset, inFrames * channels);
  const outFrames = Math.round(inFrames * outRate / rate);
  const dst = new Int16Array(outFrames * 2);
  const step = rate / outRate, last = inFrames - 1;
  for (let o = 0; o < outFrames; o++) {
    const pos = o * step, i = Math.min(Math.floor(pos), last), j = Math.min(i + 1, last), f = pos - i;
    if (channels === 1) {
      const v = src[i] + (src[j] - src[i]) * f;
      dst[o * 2] = dst[o * 2 + 1] = v;
    } else {
      dst[o * 2] = src[i * 2] + (src[j * 2] - src[i * 2]) * f;
      dst[o * 2 + 1] = src[i * 2 + 1] + (src[j * 2 + 1] - src[i * 2 + 1]) * f;
    }
  }
  return Buffer.from(dst.buffer, dst.byteOffset, dst.byteLength);
}

/**
 * Stateful streaming resampler for a chunked source (the TTS SSE deltas): feed each chunk
 * (interleaved S16LE at `rate`, `channels`), get 48 kHz stereo S16LE out, with the linear
 * interpolation carried across chunk boundaries so seams do not click and the total length does
 * not drift. Upsampling only (24 kHz TTS -> 48 kHz). Returns a function to call per chunk.
 * @param {{rate: number, channels?: number}} format
 * @returns {(pcm: Buffer) => Buffer}
 */
export function createStereo48kStream({ rate, channels = 1 }, { rate: outRate = OUT_RATE } = {}) {
  if (channels !== 1 && channels !== 2) throw new Error(`${channels}-channel input`);
  if (!(rate > 0) || rate > outRate) throw new Error(`stream resampler is upsample-only (${rate} -> ${outRate})`);
  const step = rate / outRate;   // input frames advanced per output frame (< 1)
  let prevL = 0, prevR = 0, t = 0, first = true;   // t: next output's input position; index -1 is the carried prev frame
  return (pcm) => {
    const inFrames = Math.floor(pcm.length / (2 * channels));
    if (inFrames === 0) return Buffer.alloc(0);
    const aligned = pcm.byteOffset % 2 ? Buffer.from(pcm) : pcm;
    const src = new Int16Array(aligned.buffer, aligned.byteOffset, inFrames * channels);
    const L = (i) => (i < 0 ? prevL : src[i * channels]);
    const R = (i) => (channels === 2 ? (i < 0 ? prevR : src[i * channels + 1]) : L(i));
    if (first) { t = 0; first = false; }
    const dst = new Int16Array((Math.ceil(inFrames / step) + 2) * 2); let o = 0;
    for (; ; t += step) {
      const i = Math.floor(t + 1e-9);
      if (i + 1 > inFrames - 1) break;   // src[i+1] is in the next chunk: carry and stop
      const f = t - i;
      dst[o++] = L(i) + (L(i + 1) - L(i)) * f;
      dst[o++] = R(i) + (R(i + 1) - R(i)) * f;
    }
    prevL = src[(inFrames - 1) * channels]; prevR = channels === 2 ? src[(inFrames - 1) * channels + 1] : prevL;
    t -= inFrames;   // this chunk's last frame becomes index -1 for the next
    return Buffer.from(dst.buffer, dst.byteOffset, o * 2);
  };
}
