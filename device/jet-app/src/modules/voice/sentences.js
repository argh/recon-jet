// Sentence splitter for streamed tokens: emits a sentence at ". ", "! ", "? " (closing quotes
// allowed) or a newline. A boundary inside the first `minChars` characters is skipped ("No. 5
// is fine."), and "3.5" never splits because the dot is not followed by whitespace. `flush()`
// returns whatever is left. Each sentence goes to the TTS on its own, so the first audio does
// not wait for the whole answer.

export class SentenceSplitter {
  #buf = ''; #minChars;
  constructor({ minChars = 12 } = {}) { this.#minChars = minChars; }

  /** @param {string} text @returns {string[]} complete sentences */
  push(text) {
    this.#buf += text;
    const out = [];
    const re = /[.!?…]+["')\]]*(?=\s)|\n+/g;
    let start = 0, m;
    while ((m = re.exec(this.#buf))) {
      const end = m.index + m[0].length;
      const s = this.#buf.slice(start, end).trim();
      if (s.length < this.#minChars && !m[0].includes('\n')) continue;
      if (s) out.push(s);
      start = end;
    }
    this.#buf = this.#buf.slice(start);
    return out;
  }

  /** @returns {string|null} whatever is left */
  flush() { const s = this.#buf.trim(); this.#buf = ''; return s || null; }
}
