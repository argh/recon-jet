// backlight: the kopin-a230 level as a model. One owner of "what the panel is set to": the
// Brightness screen adjusts and saves through here, jetd applies the saved file at boot. Writes
// are serialised so a swipe burst ends on the last level; `save` persists the level to the file
// jetd's init reads. 16..1023 in steps of 48 (the range jetd's setup mode used).
import fs from 'node:fs/promises';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { writeIfPresent } from '../../lib/sysfs.js';
import { parseLevel } from '../volume/index.js';

const s = Schema.create;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** The panel's range: 16..1023 by 48 (the kopin-a230 range jetd used). */
export const BACKLIGHT = { min: 16, max: 1023, step: 48, fallback: 208 };
export const backlightStep = (level, d) => clamp(level + d * BACKLIGHT.step, BACKLIGHT.min, BACKLIGHT.max);
/** A spoken 1..10 as a panel level: the ends are the panel's ends, the rest lands on its steps. */
export const levelOf = (n) => clamp(BACKLIGHT.min + Math.round((clamp(n, 1, 10) - 1) / 9 * (BACKLIGHT.max - BACKLIGHT.min) / BACKLIGHT.step) * BACKLIGHT.step, BACKLIGHT.min, BACKLIGHT.max);

export class Backlight {
  static moduleInfo = {
    name: 'backlight',
    schema: s()
      .property('file', s('string').default('/android-data/mainline/backlight').meta('description', 'saved backlight level (applied by jetd at boot)'))
      .property('sysfs', s('string').default('/sys/class/backlight/kopin-a230/brightness').meta('description', 'backlight control'))
      .property('actions', s('Actions').lax().meta('internal', true))
      .property('ui', s('Ui').lax().meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  file; sysfs; actions; ui; logger;

  /** The level as this module last set it (the saved file, else the live sysfs, at start). */
  level = BACKLIGHT.fallback;
  #write = Promise.resolve();

  async start() {
    this.level = await this.#read();
    // "heya jet, set backlight 3" (also "set the brightness to seven"): 1..10 over the panel's
    // range, applied now and saved as the boot level
    this.actions?.register('backlight', /^set (?:the )?(?:backlight|back light|brightness|display)(?: level)? (?:to |at )?(\w+)$/, async (m) => {
      const n = parseLevel(m[1]);
      if (n === null || n < 1) throw new Error(`backlight is 1 to 10, not "${m[1]}"`);
      const level = levelOf(n);
      await this.apply(level); await this.save(level);
      this.ui?.setStrip?.(`backlight ${n}`, { ms: 2000 });
    });
  }

  /** Set the panel now (not persisted). Writes are serialised: a swipe burst must end on the last level. */
  apply(level) {
    this.level = level;
    this.#write = this.#write.then(() => writeIfPresent(this.sysfs, `${level}\n`)).catch((error) => this.logger?.warn({ error: error.message }, 'backlight'));
    return this.#write;
  }

  /** Make `level` the boot default. */
  async save(level) {
    this.level = level;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${level}\n`);
    this.logger?.info({ backlight: level }, 'backlight saved');   // not `level`: that key is the log line's severity
  }

  async #read() {
    const saved = parseInt(await fs.readFile(this.file, 'utf8').catch(() => ''), 10);
    if (saved >= BACKLIGHT.min && saved <= BACKLIGHT.max) return saved;
    const live = parseInt(await fs.readFile(this.sysfs, 'utf8').catch(() => ''), 10);
    return live >= BACKLIGHT.min && live <= BACKLIGHT.max ? live : BACKLIGHT.fallback;
  }
}
