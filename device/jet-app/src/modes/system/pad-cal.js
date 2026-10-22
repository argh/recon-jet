// Pad calibration: three swipes in each of RIGHT, LEFT, DOWN, UP, measured from the touchpad's
// summed motion (`r dx dy`, the `motion` event), then the thresholds (calibration.js) go to
// jet-ofm's sysfs parameters at once and to `mainline/ofm-args` for the next boot. Swipe keys
// arriving during the measurement are swallowed so the pad does not navigate anything.
import { C, TOP, heading, hint } from '../../modules/ui/style.js';
import { PAD_STEPS, PAD_SWIPES, PAD_MIN_MOTION, padThresholds } from './calibration.js';

export class PadCalScreen {
  /** @param {import('./index.js').SystemMode} sys */
  constructor(sys) { this.sys = sys; }
  /** @type {number[][]} */ samples = [];
  step = 0;
  /** @type {{thrX: number, thrY: number}|null} set when finished */ result = null;
  error = null;

  enter() { this.samples = PAD_STEPS.map(() => []); this.step = 0; this.result = null; this.error = null; }
  get done() { return this.result !== null; }

  /** One summed motion from the pad. */
  onMotion({ dx, dy }) {
    if (this.done || Math.abs(dx) + Math.abs(dy) < PAD_MIN_MOTION) return;
    const cur = this.samples[this.step];
    cur.push(PAD_STEPS[this.step].axis === 'x' ? dx : dy);
    if (cur.length === PAD_SWIPES && ++this.step === PAD_STEPS.length) this.#finish();
    this.sys.ui.requestRender();
  }

  #finish() {
    this.result = padThresholds(this.samples);
    this.sys.savePad(this.result).then(
      () => { this.sys.logger?.info(this.result, 'pad calibrated'); this.sys.ui.requestRender(); },
      (error) => { this.error = error.message; this.sys.ui.requestRender(); });
  }

  onGesture(g) {
    if (g.startsWith('swipe:')) return true;   // measuring: the keys the driver makes from the same swipes are noise here
    if (this.done && (g === 'press:front' || g === 'press:tap')) { this.sys.stepDone(); return true; }
    return false;
  }

  render(s) {
    const { main, small } = s.fonts, cx = s.width / 2;
    heading(s, this.sys.stepTitle('pad calibration'));
    if (this.done) {
      s.text(cx, TOP + 40, this.error ? 'not saved' : 'calibrated', { font: main, colour: this.error ? C.bad : C.ok, align: 'center' });
      s.text(cx, TOP + 70, `thresholds: x ${this.result.thrX}  y ${this.result.thrY}`, { font: main, colour: C.white, align: 'center' });
      if (this.error) s.text(cx, TOP + 95, this.error, { font: small, colour: C.bad, align: 'center', maxWidth: s.width - 12 });
      hint(s, this.sys.wizard ? 'front: next' : 'front: menu');
      return;
    }
    const cur = this.samples[this.step];
    s.text(cx, TOP + 40, `swipe ${PAD_STEPS[this.step].dir}`, { font: main, colour: C.title, align: 'center' });
    s.text(cx, TOP + 64, `${cur.length + 1} of ${PAD_SWIPES}`, { font: main, colour: C.white, align: 'center' });
    cur.forEach((v, i) => s.text(cx, TOP + 92 + i * small.height, `got ${v}`, { font: small, colour: C.dim, align: 'center' }));
    hint(s, `direction ${this.step + 1} of ${PAD_STEPS.length}   rear: cancel`);
  }
}
