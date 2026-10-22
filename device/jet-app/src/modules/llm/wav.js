// RIFF/WAVE in memory: a 44-byte PCM header for the ASR upload, and a parser for the TTS reply
// that walks the chunks (a `LIST` or `fact` chunk before `data` is common) instead of assuming
// the data starts at byte 44. Pure functions, no I/O.

/** @returns {Buffer} the 44-byte PCM header for `dataLen` bytes of audio */
export function wavHeader(dataLen, rate, channels, bits) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * bits / 8, 28); h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

/** PCM samples with a header, as the ASR endpoint wants them. */
export function pcmToWav(pcm, rate, channels = 1, bits = 16) { return Buffer.concat([wavHeader(pcm.length, rate, channels, bits), pcm]); }

/**
 * Parse a PCM wav. A `data` chunk whose declared size overruns the buffer (streamed writers put
 * 0 or 0xffffffff there) is taken to the end of the buffer.
 * @param {Buffer} buf
 * @returns {{rate: number, channels: number, bits: number, data: Buffer}}
 */
export function parseWav(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a wav file');
  let fmt = null, data = null, p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4), size = buf.readUInt32LE(p + 4), start = p + 8;
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(start);
      if (format !== 1 && format !== 0xfffe) throw new Error(`wav format ${format} is not PCM`);
      fmt = { channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      data = buf.subarray(start, start + size > buf.length ? buf.length : start + size);
      break;
    }
    p = start + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('wav without fmt or data chunk');
  if (fmt.bits !== 16) throw new Error(`wav with ${fmt.bits}-bit samples (16 expected)`);
  return { ...fmt, data };
}
