// Wear: what happens when the glasses leave the head, on or off. The wear module owns the model
// (it follows jetd's classification either way, shown here live, and persists the choice); this
// screen is its view and switch. The behaviour (backlight 0, camera held off, LED pulsing) is
// optional because the saving is modest (~85 mA, the camera; the backlight itself measures
// nothing) and the proximity sensor is not every head's. Front toggles it ("heya jet, enable
// wear" comes here too).
import { Schema } from '@versionzero/module-manager';
import { C, TOP, heading, row, hint } from '../../modules/ui/style.js';

const s = Schema.create;

export class WearScreen {
  static moduleInfo = {
    name: 'wear-screen',
    provides: 'Screen',
    schema: s()
      .property('wear', s('Wear').meta('internal', true))
      .property('sensors', s('Sensors').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  wear; sensors; ui; logger;

  id = 'wear'; label = 'Wear';
  error = null; busy = false;

  tick() { this.ui.requestRender(); }   // the sensor row follows the glasses
  onGesture(g) {
    if (g === 'press:front' || g === 'press:tap') { this.toggle(); return true; }
    return false;
  }

  toggle() { return this.set(!this.wear.enabled); }

  /** Dark-when-off on or off, through the wear module ("heya jet, enable wear" comes here too). */
  async set(on) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.wear.set(on);
      this.error = null;
      this.ui.setStrip(`off-head dark ${on ? 'on' : 'off'}`, { colour: C.ok, ms: 2000 });
    } catch (error) { this.error = error.message; this.logger?.warn({ error: error.message }, 'wear setting not saved'); }
    this.busy = false;
    this.ui.requestRender();
  }

  render(s) {
    heading(s, 'wear');
    let y = TOP + 26;
    if (this.error) y = row(s, y, 'error', this.error, C.bad);
    const w = this.sensors.worn;
    y = row(s, y, 'sensor', !w || w.worn < 0 ? 'no reading yet' : w.worn ? `on a head  (${w.raw})` : `off the head  (${w.raw})`, !w || w.worn < 0 ? C.dim : C.white);
    const on = this.wear.enabled;
    y = row(s, y, 'off the head', on ? 'display dark, camera off, LED pulsing' : 'nothing happens', on ? C.ok : C.dim);
    y = row(s, y, 'display now', this.wear.lit ? 'lit' : 'dark', C.dim);
    y += 4;
    row(s, y, 'saves', 'about 85 mA, mostly the camera', C.dim);
    hint(s, `front: turn ${on ? 'off' : 'on'}   rear: menu`);
  }
}
