// backlight: the kopin-a230 level as a model. One owner of "what the panel is set to": the
// Brightness screen adjusts and saves through here, jetd applies the saved file at boot. Writes
// are serialised so a swipe burst ends on the last level; `save` persists the level to the file
// jetd's init reads. 16..1023 in steps of 48 (the range jetd's setup mode used).
import fs from 'node:fs/promises';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { writeIfPresent } from '../../lib/sysfs.js';

const s = Schema.create;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** The panel's range: 16..1023 by 48 (the kopin-a230 range jetd used). */
export const BACKLIGHT = { min: 16, max: 1023, step: 48, fallback: 208 };
export const backlightStep = (level, d) => clamp(level + d * BACKLIGHT.step, BACKLIGHT.min, BACKLIGHT.max);

export class Backlight {
  static moduleInfo = {
    name: 'backlight',
    schema: s()
      .property('file', s('string').default('/android-data/mainline/backlight').meta('description', 'saved backlight level (applied by jetd at boot)'))
      .property('sysfs', s('string').default('/sys/class/backlight/kopin-a230/brightness').meta('description', 'backlight control'))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  file; sysfs; logger;

  /** The level as this module last set it (the saved file, else the live sysfs, at start). */
  level = BACKLIGHT.fallback;
  #write = Promise.resolve();

  async start() { this.level = await this.#read(); }

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
    this.logger?.info({ level }, 'backlight saved');
  }

  async #read() {
    const saved = parseInt(await fs.readFile(this.file, 'utf8').catch(() => ''), 10);
    if (saved >= BACKLIGHT.min && saved <= BACKLIGHT.max) return saved;
    const live = parseInt(await fs.readFile(this.sysfs, 'utf8').catch(() => ''), 10);
    return live >= BACKLIGHT.min && live <= BACKLIGHT.max ? live : BACKLIGHT.fallback;
  }
}
