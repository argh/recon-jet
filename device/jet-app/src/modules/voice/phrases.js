// The spoken-reply bank: short conversational phrases ("Copy that.", "Stand by.", "Uh, that
// glitched.") rendered once through the TTS in the current voice and kept as 48 kHz stereo S16
// PCM on userdata, so a spoken command can be answered at once with no round trip to the server.
// Sets are named (ack, wait, error); `pick(set)` returns a random cached clip, not the one before.
// A clip's file name carries a hash of the text and the voice tag (TTS model + voice), so changing
// either in the config leaves the old files behind and renders new ones; `render()` makes what is
// missing, one at a time, and never throws (a phrase that fails is logged and tried next time).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PHRASES = {
  ack: ['Copy that.', 'On it.', 'Roger.', 'Got it.', 'Copy.'],
  wait: ['Stand by.', 'Still working on it.', 'Hang on, this one is slow.', 'One sec.', 'Hmm, let me think.'],
  error: ['Uh, that glitched. Send it again.', 'Lost that one. Say again?', 'That did not go through. One more time.'],
  report: ['Sent you the details.', 'Report is in.', 'On your display.', 'Details are up.'],   // the answer is on the glass; the spoken remark follows
};

export class PhraseBank {
  #dir; #sets; #tag; #say; #logger;
  /** @type {Map<string, Buffer>} file key -> PCM */ #pcm = new Map();
  /** @type {Map<string, string>} set -> the key played last */ #last = new Map();
  #rendering = null;

  /**
   * @param {{dir: string, sets: Record<string, string[]>, tag?: string, say: (text: string) => Promise<Buffer>, logger?: object}} options
   *   tag: what the voice is (model/voice), part of every clip's name
   */
  constructor({ dir, sets, tag = '', say, logger }) {
    this.#dir = dir; this.#sets = sets ?? {}; this.#tag = tag; this.#say = say; this.#logger = logger;
  }

  /** The file key of a phrase: its set and a hash of the voice tag and text. */
  key(set, text) { return `${set}-${crypto.createHash('sha1').update(`${this.#tag}\n${text}`).digest('hex').slice(0, 10)}`; }

  /** Every phrase as [set, text, key]. */
  *entries() { for (const [set, texts] of Object.entries(this.#sets)) for (const text of texts ?? []) yield [set, text, this.key(set, text)]; }

  /** Read the clips already on disk. Resolves with `status()`. */
  async load() {
    for (const [, , key] of this.entries()) {
      if (this.#pcm.has(key)) continue;
      await fs.readFile(path.join(this.#dir, `${key}.pcm`)).then((pcm) => { if (pcm.length) this.#pcm.set(key, pcm); }, () => {});
    }
    return this.status();
  }

  /** Cached clips per set, e.g. {ack: 5, wait: 2, error: 0}. */
  status() {
    const out = {};
    for (const [set, , key] of this.entries()) out[set] = (out[set] ?? 0) + (this.#pcm.has(key) ? 1 : 0);
    return out;
  }

  /** The phrases not on disk yet, as [set, text, key]. */
  missing() { return [...this.entries()].filter(([, , key]) => !this.#pcm.has(key)); }

  /**
   * A random cached clip of the set, not the one played last when there is a choice. With `used`
   * (a Set the caller keeps for one command) a clip is never picked twice: the pick is recorded
   * there, and null comes back once every clip has been used. Null also when none is cached
   * (`status()[set]` tells the two apart).
   */
  pick(set, used = null) {
    let keys = [...this.entries()].filter(([s, , key]) => s === set && this.#pcm.has(key)).map(([, , key]) => key);
    if (used) keys = keys.filter((k) => !used.has(k));
    if (!keys.length) return null;
    const choice = keys.length > 1 ? keys.filter((k) => k !== this.#last.get(set)) : keys;
    const key = choice[Math.floor(Math.random() * choice.length)];
    this.#last.set(set, key); used?.add(key);
    return this.#pcm.get(key);
  }

  /** Render what is missing, one phrase at a time; resolves with `status()`. Shared while running. */
  render() {
    if (this.#rendering) return this.#rendering;
    this.#rendering = (async () => {
      const missing = this.missing();
      if (missing.length) await fs.mkdir(this.#dir, { recursive: true }).catch(() => {});
      for (const [set, text, key] of missing) {
        try {
          const pcm = await this.#say(text);
          await fs.writeFile(path.join(this.#dir, `${key}.pcm`), pcm);
          this.#pcm.set(key, pcm);
          this.#logger?.info({ set, text, bytes: pcm.length }, 'phrase rendered');
        } catch (error) { this.#logger?.warn({ set, text, error: error.message }, 'phrase not rendered'); }
      }
      return this.status();
    })().finally(() => { this.#rendering = null; });
    return this.#rendering;
  }
}
