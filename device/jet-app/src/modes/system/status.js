// Status: clock, link state, a small battery strip plus the smoothed power readout, charger
// registers, USB state, the last glance and new-view events. A power poll repaints only when
// the displayed (rounded) values change; the clock comes from the mode tick.
import { stateOfCharge } from '../../modules/power/soc.js';
import { C, MARGIN, TOP, heading, row, hint } from '../../modules/ui/style.js';
import { readNetwork } from './network.js';

const STRIP = { x: 60, y: TOP + 42, w: 60, h: 8 };
const NET_TICKS = 5;   // address refresh while showing

export class StatusScreen {
  /** @param {import('./index.js').SystemMode} sys */
  constructor(sys) { this.sys = sys; }
  #shownPower = null;
  #ticks = 0;
  /** @type {Record<string, string[]>} interface -> IPv4 addresses */ addrs = {};

  enter() { this.#ticks = 0; this.refreshNet(); }
  tick() { if (++this.#ticks % NET_TICKS === 0) this.refreshNet(); }
  async refreshNet() {
    try { this.addrs = (await readNetwork(this.sys.netDir)).addrs; this.sys.ui.requestRender(); }
    catch { /* no ip(8) here: the rows say no address */ }
  }

  /** A power poll landed: redraw only if the figures we show moved. */
  onPower() {
    const key = JSON.stringify(this.powerRows());
    if (key === this.#shownPower) return false;
    this.#shownPower = key;
    return true;
  }

  /** What the power rows show, from the smoothed reading (null until one arrives). */
  powerRows() {
    const { power } = this.sys, p = power.last, m = power.smoothed;
    if (!p || !m) return null;
    const soc = power.soc ?? stateOfCharge(m);
    return {
      charging: soc.charging,
      percent: soc.percent, full: soc.full,
      vbat: m.vbat, vbus: m.vbus,
      battery: `${soc.percent}%  ${m.vbat} mV  ${m.ma >= 0 ? '+' : ''}${m.ma} mA`,
      rails: `${m.vsys} / ${m.vbus} mV`,
      charger: `stat ${hex(p.stat1)}  ctrl ${hex(p.ctrl1)}  lin ${hex(p.linsts)}`,
      limits: `cin ${hex(p.cinlimit)}  vichrg ${hex(p.vichrg)}`,
      usb: `${p.udc}  ${p.maxpower} mA`,
    };
  }

  onGesture() { return false; }

  render(s) {
    const { small } = s.fonts, { deviceLink, sensors } = this.sys, g = s.geometry;
    heading(s, 'status', new Date().toTimeString().slice(0, 8));
    let y = TOP + 26;
    y = row(s, y, 'link', deviceLink.connected ? `${deviceLink.mode ?? '?'}  ${g.w}x${g.h} ${g.bpp} bpp` : 'down', deviceLink.connected ? C.ok : C.warn);
    const p = this.powerRows();
    if (p) {
      const level = Math.max(0, Math.min(1, p.percent / 100));
      const colour = p.percent < 15 ? C.bad : p.percent < 35 ? C.warn : C.ok;
      s.text(MARGIN, y, 'battery', { font: small, colour: C.dim });
      s.strokeRect(STRIP.x, y + 2, STRIP.w, STRIP.h, C.dim);
      s.fillRect(STRIP.x + 1, y + 3, Math.round((STRIP.w - 2) * level), STRIP.h - 2, colour);
      if (p.charging) s.icon(STRIP.x + STRIP.w + 4, y + 2, s.icons.bolt, C.title);
      s.text(s.width - MARGIN, y, p.battery, { font: small, colour, align: 'right' });
      y += small.height + 1;
      y = row(s, y, 'vsys / vbus', p.rails);
      y = row(s, y, 'charger', p.charger);
      y = row(s, y, 'limits', p.limits);
      if (p.vbus > 4300) s.icon(MARGIN + 48, y, s.icons.usb, C.dim);
      y = row(s, y, 'gadget', p.usb);
    } else y = row(s, y, 'power', 'no reading yet', C.dim);
    const addr = (ifname) => { const a = this.addrs[ifname] ?? []; return a.length ? a.map((x) => x.split('/')[0]).join('  ') : 'no address'; };
    y = row(s, y, 'wifi', addr('wlan0'), this.addrs.wlan0?.length ? C.ok : C.dim);
    y = row(s, y, 'usb', addr('usb0'), this.addrs.usb0?.length ? C.ok : C.dim);
    y = row(s, y, 'glance', sensors.glance ? `${sensors.glance.worn ? 'worn' : 'off'}  raw ${sensors.glance.raw}  ${ago(sensors.glance.t)}` : '-');
    row(s, y, 'new view', sensors.view ? `${sensors.view.degrees} deg  ${ago(sensors.view.t)}` : '-');
    hint(s, 'rear: menu');
  }
}

const hex = (n) => '0x' + (n ?? 0).toString(16).padStart(2, '0');
const ago = (t) => 'at ' + new Date(t).toTimeString().slice(0, 8);
