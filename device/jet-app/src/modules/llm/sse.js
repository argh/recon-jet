// Server-sent events as OpenAI-compatible servers stream them: `data: {json}` lines, comments
// (`: keep-alive`), `data: [DONE]` at the end. Stateful across chunks, so a JSON object split
// over two TCP reads is reassembled; bytes are decoded as a UTF-8 stream, so a multi-byte
// character split over two reads survives too.

export class SseParser {
  #buf = ''; #decoder = new TextDecoder();
  done = false;

  /**
   * @param {Buffer|Uint8Array|string} chunk
   * @returns {object[]} the parsed payloads of the complete `data:` lines in order
   */
  feed(chunk) {
    this.#buf += typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    const out = [];
    let nl;
    while (!this.done && (nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl).replace(/\r$/, ''); this.#buf = this.#buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { this.done = true; break; }
      try { out.push(JSON.parse(data)); } catch { /* keep-alive or garbage: skip */ }
    }
    return out;
  }
}
