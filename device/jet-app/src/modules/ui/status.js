// Status screen: clock, link state, a small battery strip plus the smoothed power readout,
// charger registers, USB state, glance state, last new-view event. The clock timer runs only
// while the screen is showing (the menu covering it pauses it); power updates re-render only
// when the displayed (rounded) values change.
import { Screen, C, MARGIN } from './screen.js';

const BATTERY = { empty: 3400, full: 4150 };   // mV, for the strip
const STRIP = { x: 60, y: 46, w: 60, h: 8 };

export class StatusScreen extends Screen {
  #timer = null;
  #shownPower = null;
  glance = null;   // { worn, raw, t }
  view = null;     // { degrees, t }

  onShow() { clearInterval(this.#timer); this.#timer = setInterval(() => this.invalidate(), this.ui.clockMs); }
  onHide() { clearInterval(this.#timer); this.#timer = null; }
  /** True while the clock timer is stopped (hidden or covered by the menu). */
  get paused() { return this.#timer === null; }

  /** A power poll landed: redraw only if the figures we show moved. */
  onPower() {
    const key = JSON.stringify(this.powerRows());
    if (key === this.#shownPower) return;
    this.#shownPower = key;
    this.invalidate();
  }

  /** What the power rows show, from the smoothed reading (null until one arrives). */
  powerRows() {
    const { power } = this.ui, p = power.last, m = power.smoothed;
    if (!p || !m) return null;
    return {
      charging: m.vbus > 4300 && m.ma > 0,
      vbat: m.vbat, vbus: m.vbus,
      battery: `${m.vbat} mV  ${m.ma >= 0 ? '+' : ''}${m.ma} mA`,
      rails: `${m.vsys} / ${m.vbus} mV`,
      charger: `stat ${hex(p.stat1)}  ctrl ${hex(p.ctrl1)}  lin ${hex(p.linsts)}`,
      limits: `cin ${hex(p.cinlimit)}  vichrg ${hex(p.vichrg)}`,
      usb: `${p.udc}  ${p.maxpower} mA`,
    };
  }

  render(s) {
    const { main, small } = s.fonts, { width, height } = s;
    const { deviceLink } = this.ui, right = width - MARGIN;
    const row = (y, label, value, colour = C.white) => {
      s.text(MARGIN, y, label, { font: small, colour: C.dim });
      s.text(right, y, value, { font: small, colour, align: 'right', maxWidth: width - 2 * MARGIN - 80 });
    };
    s.text(MARGIN, 4, 'jet-app', { font: main, colour: C.title });
    s.text(right, 4, new Date().toTimeString().slice(0, 8), { font: main, colour: C.white, align: 'right' });
    s.line(0, 26, width, 26, C.faint);
    const g = s.geometry;
    row(30, 'link', deviceLink.connected ? `${deviceLink.mode ?? '?'}  ${g.w}x${g.h} ${g.bpp} bpp` : 'down', deviceLink.connected ? C.ok : C.warn);
    const p = this.powerRows();
    if (p) {
      const level = Math.max(0, Math.min(1, (p.vbat - BATTERY.empty) / (BATTERY.full - BATTERY.empty)));
      const colour = p.vbat < 3500 ? C.bad : p.vbat < 3700 ? C.warn : C.ok;
      s.text(MARGIN, 44, 'battery', { font: small, colour: C.dim });
      s.strokeRect(STRIP.x, STRIP.y, STRIP.w, STRIP.h, C.dim);
      s.fillRect(STRIP.x + 1, STRIP.y + 1, Math.round((STRIP.w - 2) * level), STRIP.h - 2, colour);
      if (p.charging) s.icon(STRIP.x + STRIP.w + 4, STRIP.y, s.icons.bolt, C.title);
      s.text(right, 44, p.battery, { font: small, colour, align: 'right' });
      row(57, 'vsys / vbus', p.rails);
      row(70, 'charger', p.charger);
      row(83, 'limits', p.limits);
      row(96, 'usb', p.usb);
      if (p.vbus > 4300) s.icon(MARGIN + 30, 96, s.icons.usb, C.dim);
    } else row(44, 'power', 'no reading yet', C.dim);
    row(114, 'glance', this.glance ? `${this.glance.worn ? 'worn' : 'off'}  raw ${this.glance.raw}  ${ago(this.glance.t)}` : '-');
    row(127, 'new view', this.view ? `${this.view.degrees} deg  ${ago(this.view.t)}` : '-');
    s.text(width / 2, height - small.height - 2, 'hold front = menu', { font: small, colour: C.dim, align: 'center' });
  }
}

const hex = (n) => '0x' + (n ?? 0).toString(16).padStart(2, '0');
const ago = (t) => 'at ' + new Date(t).toTimeString().slice(0, 8);
