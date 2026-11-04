// wear: the display follows the glasses. jetd classifies the proximity reading as worn or off the
// head (`o`, after its own 1 s of agreement; the finer `g` glance event says where the eye looks
// while worn); `offDelayMs` after "not worn" the display goes dark and the "removed" cue plays,
// "worn" brings it back with the "worn" cue. Any button or swipe while dark relights without a
// cue, and the panel then stays lit until the sensor reports a fresh worn -> removed: a
// miscalibrated sensor must never lock the user out. Off by default (the saving is modest and the
// sensor is not every head's): System > Wear turns it on, live and in the per-device config.
// Dark means: backlight 0, the camera stream held off (the surface keeps the mode's request and
// restarts it on relight; measured ~85 mA, the backlight itself is not measurable) and the white
// power LED pulsing (kernel `timer` trigger, no userspace timer) so the glasses on the desk are
// visibly alive. The ui keeps rendering and doom keeps running, there is just no light.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { readInt, writeIfPresent } from '../../lib/sysfs.js';
import { patchLayer } from '../../lib/config.js';

const s = Schema.create;
const FALLBACK_LEVEL = 208;
const LED_ON_MS = 150, LED_PERIOD_MS = 3000;

export class Wear extends EventEmitter {
  static moduleInfo = {
    name: 'wear',
    schema: s()
      .property('enabled', s('boolean').default(false).meta('description', 'dark display while the glasses are not worn (System > Wear toggles it)'))
      .property('offDelayMs', s('number').default(2000).meta('description', 'ms not worn before the display goes dark'))
      .property('backlightSysfs', s('string').default('/sys/class/backlight/kopin-a230/brightness').meta('description', 'backlight control'))
      .property('backlightFile', s('string').default('/android-data/mainline/backlight').meta('description', 'the saved level, used when the live one cannot be read'))
      .property('led', s('string').default('/sys/class/leds/jet:white:power').meta('description', 'LED class directory pulsed while dark ("" for none)'))
      .property('deviceConfig', s('string').default('/android-data/mainline/jet-app.json').meta('description', 'per-device config layer, where `enabled` persists'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('surface', s('Surface').meta('internal', true))
      .property('input', s('Input').meta('internal', true))
      .property('sounds', s('Sounds').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  enabled; offDelayMs; backlightSysfs; backlightFile; led; deviceConfig; deviceLink; surface; input; sounds; logger;

  /** @type {boolean|null} the sensor's last word (null until it has one) */ worn = null;
  /** the display is on (as far as this module is concerned) */ lit = true;
  #timer = null;
  #level = null;             // the backlight to come back to, read as the light went out
  #ledLevel = null;          // the LED's steady brightness, read as the pulsing began
  #chain = Promise.resolve();   // sysfs writes, in order

  async start() {
    this.deviceLink.on('worn', (o) => this.#worn(o.worn));
    const ask = () => this.deviceLink.worn().then((o) => this.#worn(o.worn), () => {});
    this.deviceLink.on('connected', ask);
    if (this.deviceLink.connected) ask();
    this.input.on('gesture', () => { if (!this.lit) this.#light('gesture'); });
  }

  async stop() {
    clearTimeout(this.#timer); this.#timer = null;
    if (!this.lit) await this.#light('stop');
  }

  /** The behaviour on or off, live and persisted into the per-device config layer. The live
   * change always happens; a failed save throws after it (the screen shows why). */
  async set(on) {
    this.setEnabled(on);
    await patchLayer(this.deviceConfig, { wear: { enabled: on } });
    this.logger?.info({ on }, 'wear behaviour');
  }

  /** Turn the behaviour on or off live; off relights at once. */
  setEnabled(on) {
    this.enabled = on;
    clearTimeout(this.#timer); this.#timer = null;
    if (!on && !this.lit) this.#light('disabled');
    else if (on && this.worn === false) this.#worn(0);
  }

  #worn(worn) {
    if (worn !== 0 && worn !== 1) return;   // -1: the sensor has not decided yet
    this.worn = worn === 1;
    if (!this.enabled) return;              // the sensor is still followed, only nothing is done
    clearTimeout(this.#timer); this.#timer = null;
    if (this.worn) { if (!this.lit) { this.#light('worn'); this.sounds.play('worn'); } return; }
    if (this.lit) { this.#timer = setTimeout(() => this.#dark(), this.offDelayMs); this.#timer.unref?.(); }
  }

  async #dark() {
    this.#timer = null;
    if (!this.lit || this.worn) return;
    const level = await readInt(this.backlightSysfs);
    const ledLevel = this.led ? await readInt(path.join(this.led, 'brightness')) : null;
    if (!this.lit || this.worn) return;      // worn again while we read
    if (level > 0) this.#level = level;
    if (ledLevel > 0) this.#ledLevel = ledLevel;
    this.lit = false;
    this.logger?.info({ backlight: this.#level, led: this.#ledLevel }, 'display dark: not worn');
    this.#write(this.backlightSysfs, 0);
    this.surface.pauseViewfinder();
    if (this.led) { this.#write(path.join(this.led, 'trigger'), 'timer'); this.#write(path.join(this.led, 'delay_on'), LED_ON_MS); this.#write(path.join(this.led, 'delay_off'), LED_PERIOD_MS - LED_ON_MS); }
    this.sounds.play('removed');
    this.emit('change', false);
  }

  async #light(why) {
    this.lit = true;
    const level = this.#level ?? await readInt(this.backlightFile) ?? FALLBACK_LEVEL;
    this.logger?.info({ backlight: level, why }, 'display lit');
    this.#write(this.backlightSysfs, level > 0 ? level : FALLBACK_LEVEL);
    if (this.led) { this.#write(path.join(this.led, 'trigger'), 'none'); if (this.#ledLevel != null) this.#write(path.join(this.led, 'brightness'), this.#ledLevel); }
    this.surface.resumeViewfinder();
    this.emit('change', true);
    return this.#chain;
  }

  #write(file, value) {
    this.#chain = this.#chain.then(() => writeIfPresent(file, `${value}\n`)).catch((error) => this.logger?.warn({ error: error.message, file }, 'sysfs'));
    return this.#chain;
  }
}
