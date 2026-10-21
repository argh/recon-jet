// Status screen: clock, power readout, glance state, last new-view event, link state.
import { Screen } from './screen.js';
import { spread } from '../display/layout.js';

const DIM = [160, 160, 160], OK = [0, 255, 128], WARN = [255, 160, 0];

export class StatusScreen extends Screen {
  #timer = null;
  glance = null;   // { worn, raw, t }
  view = null;     // { degrees, t }

  onShow() { this.#timer = setInterval(() => this.invalidate(), this.ui.clockMs); }
  onHide() { clearInterval(this.#timer); }

  render(grid) {
    const { power, deviceLink } = this.ui;
    const p = power.last;
    const cols = grid.cols;
    const clock = new Date().toTimeString().slice(0, 8);
    grid.set(0, spread('jet-app', clock, cols), { colour: DIM });
    grid.set(1, spread('link', deviceLink.connected ? `${deviceLink.mode ?? '?'} ${grid.cols}x${grid.rowCount}` : 'down', cols), { colour: deviceLink.connected ? OK : WARN });
    if (p) {
      grid.set(3, spread('battery', `${p.vbat} mV ${p.ma >= 0 ? '+' : ''}${p.ma} mA`, cols), { colour: p.vbat < 3500 ? WARN : undefined });
      grid.set(4, spread('vsys / vbus', `${p.vsys} / ${p.vbus} mV`, cols));
      grid.set(5, spread('charger', `stat ${hex(p.stat1)} ctrl ${hex(p.ctrl1)} lin ${hex(p.linsts)}`, cols));
      grid.set(6, spread('limits', `cin ${hex(p.cinlimit)} vichrg ${hex(p.vichrg)}`, cols));
      grid.set(7, spread('usb', `${p.udc} ${p.maxpower} mA`, cols));
    } else grid.set(3, 'power: no reading yet', { colour: DIM });
    grid.set(9, spread('glance', this.glance ? `${this.glance.worn ? 'worn' : 'off'} raw ${this.glance.raw} ${ago(this.glance.t)}` : '-', cols));
    grid.set(10, spread('new view', this.view ? `${this.view.degrees} deg ${ago(this.view.t)}` : '-', cols));
    grid.set(11, 'hold front (or rear) = menu', { colour: DIM, centre: true });
  }
}

const hex = (n) => '0x' + (n ?? 0).toString(16).padStart(2, '0');
const ago = (t) => 'at ' + new Date(t).toTimeString().slice(0, 8);
