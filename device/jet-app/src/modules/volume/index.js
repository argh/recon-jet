// volume: how loud Jet speaks, as a model. There is no hardware control to turn - the amplifier
// driver is a plain I2S pass-through with no mixer - so the level is applied to the samples on
// their way to the speaker. That is more useful than it sounds: the TTS voice peaks around -15 dB
// of full scale (measured on stored clips), so there are five steps of clean boost before
// anything clips, and a soft limiter rounds off what the last steps push over.
//
// Levels are 0..10: 0 is silent, 5 is the signal as it comes, each step is 3 dB (10 = +15 dB).
// `set(level)` applies at once and persists into the per-device config layer; "set volume 7"
// is the spoken command. Only speech goes through it (the voice module): the cue tones have
// their own gain and are already loud.
import { Schema } from '@versionzero/module-manager';
import { patchLayer } from '../../lib/config.js';

const s = Schema.create;
const STEP_DB = 3, UNITY = 5, KNEE = 0.8 * 32767;

const WORDS = { zero: 0, off: 0, mute: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, max: 10, maximum: 10, full: 10 };
/** "7", "seven", "max" -> 0..10, or null. (The ASR writes small numbers either way, and "two"/"four" as their homophones.) */
export function parseLevel(word) {
  const w = String(word ?? '').toLowerCase().trim();
  const n = /^\d+$/.test(w) ? Number(w) : WORDS[w];
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : null;
}

/** The amplitude factor of a level: 0 at 0, 1 at 5, 3 dB a step. */
export const gainOf = (level) => (level <= 0 ? 0 : 10 ** ((level - UNITY) * STEP_DB / 20));

/**
 * Scale S16 PCM by `gain` into a new buffer. Above the knee (80 % of full scale) the excess is
 * squeezed through tanh instead of clipped, so a boosted peak is rounded, not squared off.
 */
export function scale(pcm, gain) {
  if (gain === 1) return pcm;
  const n = pcm.length >> 1, out = Buffer.allocUnsafe(n << 1), room = 32767 - KNEE;
  for (let i = 0; i < n; i++) {
    let v = pcm.readInt16LE(i << 1) * gain;
    const a = Math.abs(v);
    if (a > KNEE) v = Math.sign(v) * (KNEE + room * Math.tanh((a - KNEE) / room));
    out.writeInt16LE(Math.round(v), i << 1);
  }
  return out;
}

export class Volume {
  static moduleInfo = {
    name: 'volume',
    schema: s()
      .property('level', s('number').default(8).meta('description', 'speech volume 0..10: 0 silent, 5 the signal as it comes, 3 dB a step (the TTS leaves ~15 dB of headroom)'))
      .property('deviceConfig', s('string').default('/android-data/mainline/jet-app.json').meta('description', 'where a changed level persists'))
      .property('actions', s('Actions').lax().meta('internal', true))
      .property('ui', s('Ui').lax().meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  level; deviceConfig; actions; ui; logger;

  async start() {
    this.level = Math.max(0, Math.min(10, Math.round(this.level)));
    // "heya jet, set volume 7" (also "set the volume to seven", "set volume max")
    this.actions?.register('volume', /^set (?:the )?(?:volume|sound|speaker)(?: level)? (?:to |at )?(\w+)$/, async (m) => {
      const level = parseLevel(m[1]);
      if (level === null) throw new Error(`volume is 0 to 10, not "${m[1]}"`);
      await this.set(level);
      this.ui?.setStrip?.(`volume ${level}`, { ms: 2000 });
    });
  }

  /** The amplitude factor now. */
  get gain() { return gainOf(this.level); }

  /** Speech PCM (S16, any rate or channel count) at the current level. */
  apply(pcm) { return scale(pcm, this.gain); }

  /** Change the level (0..10): at once, and persisted for the next start. */
  async set(level) {
    this.level = Math.max(0, Math.min(10, Math.round(level)));
    this.logger?.info({ volume: this.level, gainDb: this.level ? (this.level - UNITY) * STEP_DB : null }, 'volume');
    await patchLayer(this.deviceConfig, { volume: { level: this.level } }).catch((error) => this.logger?.warn({ error: error.message }, 'volume not persisted'));
    return this.level;
  }
}
