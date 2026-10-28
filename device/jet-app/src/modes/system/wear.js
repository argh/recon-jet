// Wear: what happens when the glasses leave the head, on or off. The wear module follows jetd's
// classification either way (shown here live); the behaviour (backlight 0, camera held off, LED
// pulsing) is optional because the saving is modest (~85 mA, the camera; the backlight itself
// measures nothing) and the proximity sensor is not every head's. Front toggles it live and
// persists the choice in the per-device config layer (`wear.enabled`).
import { C, TOP, heading, row, hint } from '../../modules/ui/style.js';

export class WearScreen {
  /** @param {import('./index.js').SystemMode} sys */
  constructor(sys) { this.sys = sys; }
  error = null; busy = false;

  tick() { this.sys.ui.requestRender(); }   // the sensor row follows the glasses
  onGesture(g) {
    if (g === 'press:front' || g === 'press:tap') { this.toggle(); return true; }
    return false;
  }

  async toggle() {
    if (this.busy) return;
    const on = !this.sys.wear.enabled;
    this.busy = true;
    this.sys.wear.setEnabled(on);
    try {
      await this.sys.saveSetting({ wear: { enabled: on } });
      this.error = null;
      this.sys.logger?.info({ on }, 'wear behaviour');
      this.sys.ui.setStrip(`off-head dark ${on ? 'on' : 'off'}`, { colour: C.ok, ms: 2000 });
    } catch (error) { this.error = error.message; this.sys.logger?.warn({ error: error.message }, 'wear setting not saved'); }
    this.busy = false;
    this.sys.ui.requestRender();
  }

  render(s) {
    heading(s, 'wear');
    let y = TOP + 26;
    if (this.error) y = row(s, y, 'error', this.error, C.bad);
    const w = this.sys.sensors.worn;
    y = row(s, y, 'sensor', !w || w.worn < 0 ? 'no reading yet' : w.worn ? `on a head  (${w.raw})` : `off the head  (${w.raw})`, !w || w.worn < 0 ? C.dim : C.white);
    const on = this.sys.wear.enabled;
    y = row(s, y, 'off the head', on ? 'display dark, camera off, LED pulsing' : 'nothing happens', on ? C.ok : C.dim);
    y = row(s, y, 'display now', this.sys.wear.lit ? 'lit' : 'dark', C.dim);
    y += 4;
    row(s, y, 'saves', 'about 85 mA, mostly the camera', C.dim);
    hint(s, `front: turn ${on ? 'off' : 'on'}   rear: menu`);
  }
}
