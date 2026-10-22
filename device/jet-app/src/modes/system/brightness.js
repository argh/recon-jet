// Brightness: the kopin-a230 backlight, 16..1023 in steps of 48, applied live through sysfs as
// the selection moves (swipe up/right brighter, down/left dimmer); front saves the level to
// `mainline/backlight` (applied by jetd at boot), rear reverts to the saved level.
import { C, TOP, heading, hint } from '../../modules/ui/style.js';
import { backlightStep } from './calibration.js';

export class BrightnessScreen {
  /** @param {import('./index.js').SystemMode} sys */
  constructor(sys) { this.sys = sys; }
  level = 0; saved = 0;

  enter() { this.saved = this.level = this.sys.backlight.level; }

  onGesture(g) {
    switch (g) {
      case 'swipe:up': case 'swipe:right': this.#set(backlightStep(this.level, +1)); return true;
      case 'swipe:down': case 'swipe:left': this.#set(backlightStep(this.level, -1)); return true;
      case 'press:front': case 'press:tap':
        this.sys.backlight.save(this.level).then(() => { this.saved = this.level; this.sys.stepDone(); }, (error) => this.sys.ui.setStrip(`backlight: ${error.message}`, { colour: C.bad, ms: 3000 }));
        return true;
      case 'press:rear': this.#set(this.saved); return false;   // revert, then let the mode go back to the menu
      default: return false;
    }
  }
  #set(level) { this.level = level; this.sys.backlight.apply(level); this.sys.ui.requestRender(); }

  render(s) {
    const { main, small } = s.fonts, cx = s.width / 2;
    heading(s, this.sys.stepTitle('brightness'));
    s.text(cx, TOP + 40, `backlight ${this.level} / 1023`, { font: main, colour: C.white, align: 'center' });
    const w = s.width - 40;
    s.strokeRect(20, TOP + 70, w, main.height, C.dim);
    s.fillRect(21, TOP + 71, Math.round((w - 2) * this.level / 1023), main.height - 2, C.ok);
    s.text(cx, TOP + 100, `saved: ${this.saved}`, { font: small, colour: C.dim, align: 'center' });
    hint(s, this.sys.wizard ? 'swipe: adjust   front: save and next' : 'swipe: adjust   front: save   rear: revert');
  }
}
