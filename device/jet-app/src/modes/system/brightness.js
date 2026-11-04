// Brightness: a view over the backlight module. Applied live as the selection moves (swipe
// up/right brighter, down/left dimmer); front saves the level (applied by jetd at boot), rear
// reverts to the saved level.
import { Schema } from '@versionzero/module-manager';
import { C, TOP, heading, hint, stepTitle } from '../../modules/ui/style.js';
import { Backlight, backlightStep } from '../../modules/backlight/index.js';

const s = Schema.create;

export class BrightnessScreen {
  static moduleInfo = {
    name: 'brightness-screen',
    provides: 'Screen',
    schema: s()
      .property('backlight', s('Backlight').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true)),
    register: [Backlight],
  };
  backlight; ui;

  id = 'brightness'; label = 'Brightness';
  level = 0; saved = 0;
  ctx = {};

  enter(ctx = {}) { this.ctx = ctx; this.saved = this.level = this.backlight.level; }

  onGesture(g) {
    switch (g) {
      case 'swipe:up': case 'swipe:right': this.#set(backlightStep(this.level, +1)); return true;
      case 'swipe:down': case 'swipe:left': this.#set(backlightStep(this.level, -1)); return true;
      case 'press:front': case 'press:tap':
        this.backlight.save(this.level).then(() => { this.saved = this.level; this.ctx.done?.(); }, (error) => this.ui.setStrip(`backlight: ${error.message}`, { colour: C.bad, ms: 3000 }));
        return true;
      case 'press:rear': this.#set(this.saved); return false;   // revert, then let the mode go back to the menu
      default: return false;
    }
  }
  #set(level) { this.level = level; this.backlight.apply(level); this.ui.requestRender(); }

  render(s) {
    const { main, small } = s.fonts, cx = s.width / 2;
    heading(s, stepTitle('brightness', this.ctx.wizard));
    s.text(cx, TOP + 40, `backlight ${this.level} / 1023`, { font: main, colour: C.white, align: 'center' });
    const w = s.width - 40;
    s.strokeRect(20, TOP + 70, w, main.height, C.dim);
    s.fillRect(21, TOP + 71, Math.round((w - 2) * this.level / 1023), main.height - 2, C.ok);
    s.text(cx, TOP + 100, `saved: ${this.saved}`, { font: small, colour: C.dim, align: 'center' });
    hint(s, this.ctx.wizard ? 'swipe: adjust   front: save and next' : 'swipe: adjust   front: save   rear: revert');
  }
}
