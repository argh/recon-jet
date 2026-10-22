// Power: the live PMIC readout, jetd's `Q` at 1 Hz (from the mode tick): battery mV/mA, VSYS,
// VBUS, charger registers, input/charge limits, USB gadget state. Raw values, not smoothed:
// this is the page you watch while plugging things in.
import { C, TOP, heading, row, hint } from '../../modules/ui/style.js';

export class PowerScreen {
  /** @param {import('./index.js').SystemMode} sys */
  constructor(sys) { this.sys = sys; }
  reading = null; error = null;

  enter() { this.reading = null; this.tick(); }
  tick() { this.sys.deviceLink.power().then((p) => { this.reading = p; this.error = null; }, (error) => { this.error = error.message; }); }
  onGesture() { return false; }

  render(s) {
    heading(s, 'power', this.reading ? '1 Hz' : '');
    const p = this.reading;
    let y = TOP + 26;
    if (!p) { row(s, y, 'reading', this.error ?? 'waiting for jetd', C.dim); hint(s, 'rear: menu'); return; }
    const charging = p.vbus > 4300 && p.ma > 0;
    y = row(s, y, 'battery', `${p.vbat} mV  ${p.ma >= 0 ? '+' : ''}${p.ma} mA`, charging ? C.ok : C.white);
    y = row(s, y, 'vsys', `${p.vsys} mV`);
    y = row(s, y, 'vbus', `${p.vbus} mV`, p.vbus > 4300 ? C.ok : C.dim);
    y = row(s, y, 'charger ctrl1 / stat1', `${hex(p.ctrl1)}  ${hex(p.stat1)}`);
    y = row(s, y, 'linsts', hex(p.linsts));
    y = row(s, y, 'cinlimit / vichrg', `${hex(p.cinlimit)}  ${hex(p.vichrg)}`);
    y = row(s, y, 'udc', p.udc);
    row(s, y, 'gadget maxpower', `${p.maxpower} mA`);
    hint(s, 'rear: menu');
  }
}

const hex = (n) => '0x' + (n ?? 0).toString(16).padStart(2, '0');
