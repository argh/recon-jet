// Glance calibration, the stock flow: look at the display, look forward, at again, away again;
// a front press takes each reading (an average of 8 reads of the tmd2771's proximity channel),
// then the thresholds (calibration.js) are written to `mainline/glance` and jetd re-reads them
// (`U`). A flat run (too little contrast between at and away) is reported, not saved.
import { C, TOP, heading, hint } from '../../modules/ui/style.js';
import { GLANCE_STEPS, GLANCE_READS, glanceThresholds } from './calibration.js';

export class GlanceCalScreen {
  /** @param {import('./index.js').SystemMode} sys */
  constructor(sys) { this.sys = sys; }
  reads = [];
  /** @type {ReturnType<typeof glanceThresholds>|null} */ result = null;
  now = null;       // the live reading (tick)
  busy = false;     // a reading is being averaged
  error = null;

  enter() { this.reads = []; this.result = null; this.error = null; this.busy = false; this.tick(); }
  get done() { return this.result !== null || this.error !== null; }

  tick() { this.sys.readGlance(1).then((v) => { this.now = v; }, () => { this.now = null; }); }

  onGesture(g) {
    if (g !== 'press:front' && g !== 'press:tap') return false;
    if (this.done) { if (this.result?.ok || this.error) this.sys.stepDone(); else this.enter(); return true; }   // a flat run: try again
    if (this.busy) return true;
    this.busy = true;
    this.sys.readGlance(GLANCE_READS).then((v) => { this.reads.push(v); if (this.reads.length === GLANCE_STEPS.length) return this.#finish(); })
      .catch((error) => { this.error = error.message; })
      .finally(() => { this.busy = false; this.sys.ui.requestRender(); });
    return true;
  }

  async #finish() {
    this.result = glanceThresholds(this.reads);
    if (!this.result.ok) return;
    await this.sys.saveGlance(this.result);
    this.sys.logger?.info(this.result, 'glance calibrated');
  }

  render(s) {
    const { main, small } = s.fonts, cx = s.width / 2;
    heading(s, this.sys.stepTitle('glance calibration'));
    if (this.error) {
      s.text(cx, TOP + 40, 'no glance sensor', { font: main, colour: C.bad, align: 'center' });
      s.text(cx, TOP + 70, this.error, { font: small, colour: C.dim, align: 'center', maxWidth: s.width - 12 });
      hint(s, this.sys.wizard ? 'front: skip' : 'front: menu');
    } else if (this.result) {
      const r = this.result;
      s.text(cx, TOP + 40, r.ok ? 'glance calibrated' : 'too little contrast', { font: main, colour: r.ok ? C.ok : C.bad, align: 'center' });
      s.text(cx, TOP + 66, `at ${this.reads[0]}/${this.reads[2]}  away ${this.reads[1]}/${this.reads[3]}`, { font: small, colour: C.white, align: 'center' });
      if (r.ok) s.text(cx, TOP + 82, r.on >= r.off ? `worn >= ${r.on}   off <= ${r.off}` : `worn <= ${r.on}   off >= ${r.off}`, { font: small, colour: C.white, align: 'center' });
      else s.text(cx, TOP + 82, `span ${r.span} (need 40): sensor clear?`, { font: small, colour: C.dim, align: 'center' });
      hint(s, r.ok ? (this.sys.wizard ? 'front: next' : 'front: menu') : 'front: try again   rear: cancel');
    } else {
      const i = this.reads.length;
      s.text(cx, TOP + 40, `${i + 1} of ${GLANCE_STEPS.length}: ${GLANCE_STEPS[i]}`, { font: main, colour: C.title, align: 'center', maxWidth: s.width - 12 });
      s.text(cx, TOP + 66, this.busy ? 'reading...' : 'then press front', { font: small, colour: C.dim, align: 'center' });
      s.text(cx, TOP + 82, `sensor now: ${this.now ?? '?'}`, { font: small, colour: C.dim, align: 'center' });
      this.reads.forEach((v, k) => s.text(cx, TOP + 100 + k * small.height, `step ${k + 1}: ${v}`, { font: small, colour: C.white, align: 'center' }));
      hint(s, 'rear: cancel');
    }
  }
}
