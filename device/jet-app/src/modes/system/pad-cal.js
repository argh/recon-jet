// Pad calibration: three swipes in each of RIGHT, LEFT, DOWN, UP, measured from the touchpad's
// summed motion (`r dx dy`, the `motion` event), then the thresholds (calibration.js) go to
// jet-ofm's sysfs parameters at once and to `mainline/ofm-args` for the next boot. A System
// screen module: it follows the pad itself (subscribed to `input` motion only while showing);
// swipe keys arriving during the measurement are swallowed so the pad does not navigate anything.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { C, TOP, heading, hint, stepTitle } from '../../modules/ui/style.js';
import { writeIfPresent } from '../../lib/sysfs.js';
import { PAD_STEPS, PAD_SWIPES, PAD_MIN_MOTION, padThresholds, ofmArgs } from './calibration.js';

const s = Schema.create;

export class PadCalScreen {
  static moduleInfo = {
    name: 'pad-cal-screen',
    provides: 'Screen',
    schema: s()
      .property('ofmArgsFile', s('string').default('/android-data/mainline/ofm-args').meta('description', 'pad thresholds for the next boot'))
      .property('ofmSysfs', s('string').default('/sys/module/jet_ofm/parameters').meta('description', 'jet-ofm parameters (thr_x, thr_y), applied live'))
      .property('ui', s('Ui').meta('internal', true))
      .property('input', s('Input').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  ofmArgsFile; ofmSysfs; ui; input; logger;

  id = 'pad'; label = 'Pad calibration';
  /** @type {number[][]} */ samples = [];
  step = 0;
  /** @type {{thrX: number, thrY: number}|null} set when finished */ result = null;
  error = null;
  ctx = {};
  #onMotion = (m) => this.onMotion(m);

  /** First use: no thresholds on userdata yet, the wizard starts here. */
  needsSetup() { return fs.access(this.ofmArgsFile).then(() => false, () => true); }

  enter(ctx = {}) {
    this.ctx = ctx;
    this.samples = PAD_STEPS.map(() => []); this.step = 0; this.result = null; this.error = null;
    this.input.on('motion', this.#onMotion);   // the measurement is ours only while showing
  }
  leave() { this.input.off('motion', this.#onMotion); }
  get done() { return this.result !== null; }

  /** One summed motion from the pad. */
  onMotion({ dx, dy }) {
    if (this.done || Math.abs(dx) + Math.abs(dy) < PAD_MIN_MOTION) return;
    const cur = this.samples[this.step];
    cur.push(PAD_STEPS[this.step].axis === 'x' ? dx : dy);
    if (cur.length === PAD_SWIPES && ++this.step === PAD_STEPS.length) this.#finish();
    this.ui.requestRender();
  }

  /** Pad thresholds: live to jet-ofm, and to the args file for the next boot. */
  async save({ thrX, thrY }) {
    await Promise.all([writeIfPresent(path.join(this.ofmSysfs, 'thr_x'), `${thrX}\n`), writeIfPresent(path.join(this.ofmSysfs, 'thr_y'), `${thrY}\n`)]);
    await fs.mkdir(path.dirname(this.ofmArgsFile), { recursive: true });
    await fs.writeFile(this.ofmArgsFile, ofmArgs({ thrX, thrY }));
  }

  #finish() {
    this.result = padThresholds(this.samples);
    this.save(this.result).then(
      () => { this.logger?.info(this.result, 'pad calibrated'); this.ui.requestRender(); },
      (error) => { this.error = error.message; this.ui.requestRender(); });
  }

  onGesture(g) {
    if (g.startsWith('swipe:')) return true;   // measuring: the keys the driver makes from the same swipes are noise here
    if (this.done && (g === 'press:front' || g === 'press:tap')) { this.ctx.done?.(); return true; }
    return false;
  }

  render(s) {
    const { main, small } = s.fonts, cx = s.width / 2;
    heading(s, stepTitle('pad calibration', this.ctx.wizard));
    if (this.done) {
      s.text(cx, TOP + 40, this.error ? 'not saved' : 'calibrated', { font: main, colour: this.error ? C.bad : C.ok, align: 'center' });
      s.text(cx, TOP + 70, `thresholds: x ${this.result.thrX}  y ${this.result.thrY}`, { font: main, colour: C.white, align: 'center' });
      if (this.error) s.text(cx, TOP + 95, this.error, { font: small, colour: C.bad, align: 'center', maxWidth: s.width - 12 });
      hint(s, this.ctx.wizard ? 'front: next' : 'front: menu');
      return;
    }
    const cur = this.samples[this.step];
    s.text(cx, TOP + 40, `swipe ${PAD_STEPS[this.step].dir}`, { font: main, colour: C.title, align: 'center' });
    s.text(cx, TOP + 64, `${cur.length + 1} of ${PAD_SWIPES}`, { font: main, colour: C.white, align: 'center' });
    cur.forEach((v, i) => s.text(cx, TOP + 92 + i * small.height, `got ${v}`, { font: small, colour: C.dim, align: 'center' }));
    hint(s, `direction ${this.step + 1} of ${PAD_STEPS.length}   rear: cancel`);
  }
}
