// sounds: the Jet's cue vocabulary. Each cue is a short tone sequence rendered once (48 kHz
// stereo S16, what jetd's `W` plays) and sent as one clip. One tonal language: A5 (880 Hz) is
// the "1", its fifth the "5". Rising 1-5 is coming up, falling 5-1 going down, 1-5-1 "got it,
// working on it", the octave above "done", a slow fall to the minor third below "no"; the glasses
// say a short high "beep" when worn and a low "boop" when set down. Modules call
// `sounds.play(name)` where something happened; nothing here reads gestures or state.
import { Schema } from '@versionzero/module-manager';
import { tones } from '../../lib/tones.js';

const s = Schema.create;
const N1 = 880, N5 = 1320, N8 = 1760, N1_LOW = 440, N5_LOW = 660, MINOR_BELOW = 740;

/** @type {Record<string, {notes: Array<{hz: number, ms: number}>, gain?: number}>} */
export const SOUNDS = {
  powerOn: { notes: [{ hz: N1, ms: 70 }, { hz: N5, ms: 110 }] },
  powerOff: { notes: [{ hz: N5, ms: 70 }, { hz: N1, ms: 110 }] },
  ack: { notes: [{ hz: N1, ms: 50 }, { hz: N5, ms: 50 }, { hz: N1, ms: 60 }] },
  success: { notes: [{ hz: N8, ms: 80 }] },
  error: { notes: [{ hz: N1, ms: 160 }, { hz: MINOR_BELOW, ms: 260 }], gain: 0.25 },
  worn: { notes: [{ hz: N5, ms: 60 }] },
  removed: { notes: [{ hz: N1_LOW, ms: 90 }] },
  thinking: { notes: [{ hz: N5_LOW, ms: 120 }], gain: 0.12 },
};

export class Sounds {
  static moduleInfo = {
    name: 'sounds',
    schema: s()
      .property('enabled', s('boolean').default(true).meta('description', 'play the cue sounds'))
      .property('gain', s('number').default(1).meta('description', 'volume scale applied to every cue, 0..1'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  enabled; gain; deviceLink; logger;

  static #cache = new Map();
  /** The PCM of a cue, rendered once per gain. */
  static pcm(name, gain = 1) {
    const def = SOUNDS[name];
    if (!def) throw new Error(`no sound '${name}'`);
    const key = `${name}@${gain}`;
    if (!Sounds.#cache.has(key)) Sounds.#cache.set(key, tones(def.notes, { gain: (def.gain ?? 0.3) * gain }));
    return Sounds.#cache.get(key);
  }

  /**
   * Play a cue. Resolves with jetd's playback result (`done`, `flushed`, ...) or false when the
   * sounds are off or the link is down; never rejects.
   * @param {keyof typeof SOUNDS} name
   */
  play(name) {
    const pcm = Sounds.pcm(name, this.gain ?? 1);
    if (!this.enabled || !this.deviceLink.play(pcm)) return Promise.resolve(false);
    const t0 = Date.now();
    return this.deviceLink.playEnd().then(
      (r) => { this.logger?.debug({ sound: name, result: r, ms: Date.now() - t0 }, 'sound'); return r; },
      (error) => { this.logger?.warn({ sound: name, error: error.message }, 'sound'); return false; });
  }
}
