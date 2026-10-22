// Status screen: clock, link state, battery bar, power readout, glance state, last new-view event.
import { Screen, C, MARGIN } from './screen.js';

const BATTERY = { empty: 3400, full: 4150 };   // mV, for the bar

export class StatusScreen extends Screen {
  #timer = null;
  glance = null;   // { worn, raw, t }
  view = null;     // { degrees, t }

  onShow() { this.#timer = setInterval(() => this.invalidate(), this.ui.clockMs); }
  onHide() { clearInterval(this.#timer); }

  render(s) {
    const { main, small } = s.fonts, { width, height } = s;
    const { power, deviceLink } = this.ui, p = power.last, right = width - MARGIN;
    const row = (y, label, value, colour = C.white) => {
      s.text(MARGIN, y, label, { font: small, colour: C.dim });
      s.text(right, y, value, { font: small, colour, align: 'right', maxWidth: width - 2 * MARGIN - 80 });
    };
    s.text(MARGIN, 4, 'jet-app', { font: main, colour: C.title });
    s.text(right, 4, new Date().toTimeString().slice(0, 8), { font: main, colour: C.white, align: 'right' });
    s.line(0, 26, width, 26, C.faint);
    const g = s.geometry;
    row(32, 'link', deviceLink.connected ? `${deviceLink.mode ?? '?'}  ${g.w}x${g.h} ${g.bpp} bpp` : 'down', deviceLink.connected ? C.ok : C.warn);
    if (p) {
      const charging = p.vbus > 4300 && p.ma > 0, level = Math.max(0, Math.min(1, (p.vbat - BATTERY.empty) / (BATTERY.full - BATTERY.empty)));
      const colour = p.vbat < 3500 ? C.bad : p.vbat < 3700 ? C.warn : C.ok;
      s.text(MARGIN, 48, 'battery', { font: small, colour: C.dim });
      s.icon(78, 50, s.icons.battery, C.dim);
      s.strokeRect(98, 48, 102, 12, C.dim);
      s.fillRect(100, 50, Math.round(98 * level), 8, colour);
      if (charging) s.icon(204, 50, s.icons.bolt, C.title);
      s.text(right, 48, `${p.vbat} mV  ${p.ma >= 0 ? '+' : ''}${p.ma} mA`, { font: small, colour, align: 'right' });
      row(66, 'vsys / vbus', `${p.vsys} / ${p.vbus} mV`);
      row(80, 'charger', `stat ${hex(p.stat1)}  ctrl ${hex(p.ctrl1)}  lin ${hex(p.linsts)}`);
      row(94, 'limits', `cin ${hex(p.cinlimit)}  vichrg ${hex(p.vichrg)}`);
      row(108, 'usb', `${p.udc}  ${p.maxpower} mA`);
      if (p.vbus > 4300) s.icon(MARGIN + 30, 107, s.icons.usb, C.dim);
    } else row(48, 'power', 'no reading yet', C.dim);
    row(130, 'glance', this.glance ? `${this.glance.worn ? 'worn' : 'off'}  raw ${this.glance.raw}  ${ago(this.glance.t)}` : '-');
    row(144, 'new view', this.view ? `${this.view.degrees} deg  ${ago(this.view.t)}` : '-');
    s.text(width / 2, height - small.height - 2, 'hold front (or rear) = menu', { font: small, colour: C.dim, align: 'center' });
  }
}

const hex = (n) => '0x' + (n ?? 0).toString(16).padStart(2, '0');
const ago = (t) => 'at ' + new Date(t).toTimeString().slice(0, 8);
