// Demo mode: the small, readable example other modes are built from. A clock, a few readouts
// (glance, last new view, battery), the camera live in a rectangle (the surface viewfinder),
// and "front press = describe what I see": one snapshot through jetd (`S`, a UYVY frame),
// shrunk and JPEG-encoded on the device, sent to the host voice session as a `look` request,
// the model's answer wrapped on the glass as it streams. Rear press clears the answer.
import jpeg from 'jpeg-js';
import { Schema } from '@versionzero/module-manager';
import { C, MARGIN, TOP, hint, row, paragraph } from '../../modules/ui/style.js';
import { uyvyToRgba } from '../../lib/uyvy.js';

const s = Schema.create;
const CAMERA = { w: 160, h: 120 };

export class DemoMode {
  static moduleInfo = {
    name: 'demo-mode',
    schema: s()
      .property('question', s('string').default('Describe what is in front of me in one or two short sentences.').meta('description', 'what the front press asks about the snapshot'))
      .property('jpegQuality', s('number').default(60).meta('description', 'snapshot JPEG quality (320x240)'))
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('surface', s('Surface').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('power', s('Power').meta('internal', true))
      .property('sensors', s('Sensors').meta('internal', true))
      .property('voice', s('Voice').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  question; jpegQuality; modes; ui; surface; deviceLink; power; sensors; voice; logger;

  id = 'demo'; label = 'Describe';
  /** @type {'idle'|'looking'|'answering'} */ state = 'idle';
  answer = ''; error = null;
  #look = 0;   // the current look's id; a late answer from an older one is ignored

  async start() { this.modes.register(this); }

  enter() {
    this.state = 'idle'; this.answer = ''; this.error = null;
    this.#camera();
  }
  leave() { this.surface.stopViewfinder(); this.#look++; this.state = 'idle'; this.answer = ''; this.error = null; }

  /** The camera rectangle: right side, under the strip. */
  get cameraRect() { return { x: this.surface.width - CAMERA.w - MARGIN, y: TOP, ...CAMERA }; }

  #camera() {
    const r = this.cameraRect;
    this.surface.viewfinder(r.x, r.y, r.w, r.h).catch((error) => this.logger?.warn({ error: error.message }, 'demo: no camera'));
  }

  onGesture(g) {
    if (g === 'press:front' || g === 'press:tap') { this.describe(); return true; }
    if (g === 'press:rear' && (this.answer || this.error)) { this.answer = ''; this.error = null; this.ui.requestRender(); return true; }
    return false;
  }

  /** Snapshot -> JPEG -> host `look`; the answer streams into `answer`. */
  async describe() {
    if (this.state !== 'idle') return;
    const id = ++this.#look, t0 = Date.now();
    this.state = 'looking'; this.answer = ''; this.error = null;
    this.ui.setStrip('looking', { colour: C.title });
    try {
      const frame = await this.deviceLink.snapshot({ w: 640, h: 480 });
      const image = uyvyToRgba(frame.data, frame.w, frame.h, { scale: 2 });
      const { data: jpg } = jpeg.encode(image, this.jpegQuality);
      this.logger?.info({ src: `${frame.w}x${frame.h}`, jpegBytes: jpg.length, ms: Date.now() - t0 }, 'demo: snapshot');
      if (id !== this.#look) return;
      this.state = 'answering';
      const answer = await this.voice.look(jpg, this.question, { onToken: (t) => { if (id === this.#look) { this.answer += t; this.ui.requestRender(); } } });
      if (id !== this.#look) return;
      this.answer = answer || this.answer || '(no answer)';
      this.logger?.info({ ms: Date.now() - t0, answer: this.answer }, 'demo: look');
    } catch (error) {
      if (id !== this.#look) return;
      this.error = error.message;
      this.logger?.warn({ error: error.message }, 'demo: look failed');
    } finally {
      if (id === this.#look) { this.state = 'idle'; this.ui.setStrip(null); this.ui.requestRender(); }
    }
  }

  render(s) {
    const { main, small } = s.fonts, m = this.power.smoothed, { glance, view } = this.sensors, cam = this.cameraRect;
    const left = cam.x - MARGIN * 2;   // the readouts stay left of the camera
    s.text(MARGIN, TOP, new Date().toTimeString().slice(0, 8), { font: main, colour: C.white });
    let y = TOP + main.height + 6;
    const r = (label, value, colour) => { s.text(MARGIN, y, label, { font: small, colour: C.dim }); s.text(left, y, value, { font: small, colour: colour ?? C.white, align: 'right', maxWidth: left - MARGIN - 70 }); y += small.height + 1; };
    r('glance', glance ? (glance.worn ? 'worn' : 'off') + `  raw ${glance.raw}` : '-', glance?.worn ? C.ok : C.white);
    r('new view', view ? `${view.degrees} deg  ${ago(view.t)}` : '-');
    r('battery', m ? `${m.vbat} mV  ${m.ma >= 0 ? '+' : ''}${m.ma} mA` : '-', m && m.vbat < 3600 ? C.warn : C.white);
    r('camera', s.viewfinderRect ? 'live' : 'off', s.viewfinderRect ? C.ok : C.dim);
    s.strokeRect(cam.x - 2, cam.y - 2, cam.w + 4, cam.h + 4, s.viewfinderRect ? C.ok : C.faint);
    if (!s.viewfinderRect) s.icon(cam.x + cam.w / 2 - 8, cam.y + cam.h / 2 - 10, s.icons.camera, C.faint);
    const top = cam.y + cam.h + 8, bottom = s.height - small.height - 4;
    if (this.error) paragraph(s, MARGIN, top, s.width - 2 * MARGIN, bottom - top, this.error, { colour: C.bad });
    else if (this.answer) paragraph(s, MARGIN, top, s.width - 2 * MARGIN, bottom - top, this.answer);
    else if (this.state !== 'idle') s.text(MARGIN, top, this.state === 'looking' ? 'looking...' : 'thinking...', { font: main, colour: C.title });
    hint(s, this.state === 'idle' ? (this.answer || this.error ? 'front: look again   rear: clear' : 'front: describe what I see') : 'working...');
  }
}

const ago = (t) => 'at ' + new Date(t).toTimeString().slice(0, 8);
