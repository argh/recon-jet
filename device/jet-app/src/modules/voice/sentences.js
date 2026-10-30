// Sentence splitter for streamed tokens: emits a sentence at ". ", "! ", "? " (closing quotes
// allowed) or a newline, once the next word is seen to start with something other than a lowercase
// letter ('"Sure!" she said' is one sentence). A boundary inside the first `minChars` characters
// is skipped ("No. 5 is fine."), and "3.5" never splits because the dot is not followed by whitespace. `flush()`
// returns whatever is left. Each sentence goes to the TTS on its own, so the first audio does
// not wait for the whole answer, and the session puts a gap after each: a one-word sentence
// ("Roger.", "Copy.") is a sentence, so minChars only guards the abbreviation-sized cases.

export class SentenceSplitter {
  #buf = ''; #minChars;
  constructor({ minChars = 4 } = {}) { this.#minChars = minChars; }

  /** @param {string} text @returns {string[]} complete sentences */
  push(text) {
    this.#buf += text;
    const out = [];
    const re = /[.!?…]+["')\]]*(?=\s+[^\sa-z])|\n+/g;
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
