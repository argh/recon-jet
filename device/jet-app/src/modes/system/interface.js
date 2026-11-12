// Interface: the two things about the glasses themselves one adjusts by feel - how bright the
// panel is and how loud Jet speaks - as views over the `backlight` and `volume` models. Swipe
// up/down picks the row, left/right adjusts it. The backlight is applied live and front saves
// it as the boot level (rear puts the saved level back); the volume is a setting, changed and
// persisted as it moves, with a spoken phrase at the new level so it can be heard (rear puts
// back what it was on entry). In the first-use wizard this is the last step.
import { Schema } from '@versionzero/module-manager';
import { C, MARGIN, TOP, heading, hint, stepTitle } from '../../modules/ui/style.js';
import { Backlight, BACKLIGHT, backlightStep } from '../../modules/backlight/index.js';

const s = Schema.create;
const ROWS = ['backlight', 'volume'];

export class InterfaceScreen {
  static moduleInfo = {
    name: 'interface-screen',
    provides: 'Screen',
    schema: s()
      .property('backlight', s('Backlight').meta('internal', true))
      .property('volume', s('Volume').lax().meta('internal', true))
      .property('voice', s('Voice').lax().meta('internal', true))
      .property('ui', s('Ui').meta('internal', true)),
    register: [Backlight],
  };
  backlight; volume; voice; ui;

  id = 'interface'; label = 'Interface';
  /** the backlight as shown (live), and as saved */ level = 0; saved = 0;
  /** the volume on entry, for rear */ #volumeWas = 0;
  /** the selected row: an index into ROWS */ row = 0;
  ctx = {};

  /** The rows this device has (no volume model, no volume row). */
  get rows() { return this.volume ? ROWS : ROWS.slice(0, 1); }

  enter(ctx = {}) {
    this.ctx = ctx; this.row = 0;
    this.saved = this.level = this.backlight.level;
    this.#volumeWas = this.volume?.level ?? 0;
  }

  onGesture(g) {
    switch (g) {
      case 'swipe:up': case 'swipe:down': this.row = (this.row + (g === 'swipe:up' ? -1 : 1) + this.rows.length) % this.rows.length; this.ui.requestRender(); return true;
      case 'swipe:right': case 'swipe:left': this.#adjust(g === 'swipe:right' ? +1 : -1); return true;
      case 'press:front': case 'press:tap':
        this.backlight.save(this.level).then(() => { this.saved = this.level; this.ctx.done?.(); }, (error) => this.ui.setStrip(`backlight: ${error.message}`, { colour: C.bad, ms: 3000 }));
        return true;
      case 'press:rear':   // revert, then let the mode go back to the menu
        this.#backlight(this.saved);
        if (this.volume && this.volume.level !== this.#volumeWas) this.volume.set(this.#volumeWas);
        return false;
      default: return false;
    }
  }

  #adjust(d) {
    if (this.rows[this.row] === 'backlight') return this.#backlight(backlightStep(this.level, d));
    const next = Math.max(0, Math.min(10, this.volume.level + d));
    if (next === this.volume.level) return;
    this.volume.set(next).then(() => { if (this.voice?.state === 'idle') this.voice.phrase?.('ack'); });   // hear the new level
    this.ui.requestRender();
  }
  #backlight(level) { this.level = level; this.backlight.apply(level); this.ui.requestRender(); }

  render(s) {
    const { main, small } = s.fonts, w = s.width - 2 * 20;
    heading(s, stepTitle('interface', this.ctx.wizard));
    const bar = (i, y, label, value, max, note) => {
      const on = this.row === i;
      s.text(MARGIN, y, `${on ? '>' : ' '} ${label}`, { font: main, colour: on ? C.title : C.white });
      s.text(s.width - MARGIN, y, `${value} / ${max}`, { font: main, colour: C.white, align: 'right' });
      s.strokeRect(20, y + main.height + 4, w, 14, on ? C.title : C.dim);
      s.fillRect(21, y + main.height + 5, Math.round((w - 2) * value / max), 12, C.ok);
      if (note) s.text(s.width / 2, y + main.height + 22, note, { font: small, colour: C.dim, align: 'center' });
    };
    bar(0, TOP + 34, 'backlight', this.level, BACKLIGHT.max, `saved: ${this.saved}`);
    if (this.volume) bar(1, TOP + 110, 'volume', this.volume.level, 10, this.volume.level === 0 ? 'silent' : '');
    hint(s, this.ctx.wizard ? 'left/right: adjust   front: save and next' : `${this.rows.length > 1 ? 'up/down: select   ' : ''}left/right: adjust   front: save   rear: revert`);
  }
}
