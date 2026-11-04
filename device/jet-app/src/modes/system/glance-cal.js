// Glance calibration, the stock flow: look at the display, look forward, at again, away again;
// a front press takes each reading (an average of 8 reads of the tmd2771's proximity channel),
// then the thresholds (calibration.js) are written to `mainline/glance` and jetd re-reads them
// (`U`). A flat run (too little contrast between at and away) is reported, not saved. A System
// screen module: it owns the sensor path and the file jetd reads.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { C, TOP, heading, hint, stepTitle } from '../../modules/ui/style.js';
import { GLANCE_STEPS, GLANCE_READS, glanceThresholds, glanceFile } from './calibration.js';

const s = Schema.create;

export class GlanceCalScreen {
  static moduleInfo = {
    name: 'glance-cal-screen',
    provides: 'Screen',
    schema: s()
      .property('glanceFile', s('string').default('/android-data/mainline/glance').meta('description', 'glance thresholds "on off"'))
      .property('iioDir', s('string').default('/sys/bus/iio/devices').meta('description', 'where the tmd2771 proximity channel is looked for'))
      .property('ui', s('Ui').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  glanceFile; iioDir; ui; deviceLink; logger;

  id = 'glance'; label = 'Glance calibration';
  reads = [];
  /** @type {ReturnType<typeof glanceThresholds>|null} */ result = null;
  now = null;       // the live reading (tick)
  busy = false;     // a reading is being averaged
  error = null;
  ctx = {};

  /** First use: no thresholds on userdata yet, the wizard comes through here. */
  needsSetup() { return fs.access(this.glanceFile).then(() => false, () => true); }

  enter(ctx) { if (ctx) this.ctx = ctx; this.reads = []; this.result = null; this.error = null; this.busy = false; this.tick(); }
  get done() { return this.result !== null || this.error !== null; }

  tick() { this.read(1).then((v) => { this.now = v; }, () => { this.now = null; }); }

  onGesture(g) {
    if (g !== 'press:front' && g !== 'press:tap') return false;
    if (this.done) { if (this.result?.ok || this.error) this.ctx.done?.(); else this.enter(); return true; }   // a flat run: try again
    if (this.busy) return true;
    this.busy = true;
    this.read(GLANCE_READS).then((v) => { this.reads.push(v); if (this.reads.length === GLANCE_STEPS.length) return this.#finish(); })
      .catch((error) => { this.error = error.message; })
      .finally(() => { this.busy = false; this.ui.requestRender(); });
    return true;
  }

  async #finish() {
    this.result = glanceThresholds(this.reads);
    if (!this.result.ok) return;
    await this.save(this.result);
    this.logger?.info(this.result, 'glance calibrated');
  }

  /** Glance thresholds: to the file jetd reads, then `U` so jetd uses them now. */
  async save(result) {
    await fs.mkdir(path.dirname(this.glanceFile), { recursive: true });
    await fs.writeFile(this.glanceFile, glanceFile(result));
    await this.deviceLink.reloadCalibration().then((r) => this.logger?.info(r, 'jetd calibration reloaded'), (error) => this.logger?.warn({ error: error.message }, 'jetd U failed'));
  }

  /** Average of `n` reads of the tmd2771 proximity channel, ~20 ms apart. */
  async read(n) {
    const file = await this.#glancePath();
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (i) await new Promise((r) => setTimeout(r, 20));
      sum += parseInt(await fs.readFile(file, 'utf8'), 10) || 0;
    }
    return Math.trunc(sum / n);
  }
  #glance = null;
  async #glancePath() {
    if (this.#glance) return this.#glance;
    for (const d of await fs.readdir(this.iioDir).catch(() => [])) {
      const name = await fs.readFile(path.join(this.iioDir, d, 'name'), 'utf8').catch(() => '');
      if (name.startsWith('tmd2771')) return (this.#glance = path.join(this.iioDir, d, 'in_proximity0_raw'));
    }
    throw new Error(`no tmd2771 under ${this.iioDir}`);
  }

  render(s) {
    const { main, small } = s.fonts, cx = s.width / 2;
    heading(s, stepTitle('glance calibration', this.ctx.wizard));
    if (this.error) {
      s.text(cx, TOP + 40, 'no glance sensor', { font: main, colour: C.bad, align: 'center' });
      s.text(cx, TOP + 70, this.error, { font: small, colour: C.dim, align: 'center', maxWidth: s.width - 12 });
      hint(s, this.ctx.wizard ? 'front: skip' : 'front: menu');
    } else if (this.result) {
      const r = this.result;
      s.text(cx, TOP + 40, r.ok ? 'glance calibrated' : 'too little contrast', { font: main, colour: r.ok ? C.ok : C.bad, align: 'center' });
      s.text(cx, TOP + 66, `at ${this.reads[0]}/${this.reads[2]}  away ${this.reads[1]}/${this.reads[3]}`, { font: small, colour: C.white, align: 'center' });
      if (r.ok) s.text(cx, TOP + 82, r.on >= r.off ? `worn >= ${r.on}   off <= ${r.off}` : `worn <= ${r.on}   off >= ${r.off}`, { font: small, colour: C.white, align: 'center' });
      else s.text(cx, TOP + 82, `span ${r.span} (need 40): sensor clear?`, { font: small, colour: C.dim, align: 'center' });
      hint(s, r.ok ? (this.ctx.wizard ? 'front: next' : 'front: menu') : 'front: try again   rear: cancel');
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
