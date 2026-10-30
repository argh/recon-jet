// Status: everything worth glancing at, on one display-only screen (the old Power, Network and
// About screens folded in; their debug rows - charger registers, gadget state, mode lists - are
// gone, that is what ssh is for). Clock, battery strip with the smoothed readout, the rails,
// WiFi with its association and address, the USB link, the radio toggles' states (Bluetooth,
// GPS), the wear sensors, and what is running. A power poll repaints only when the displayed
// (rounded) values change; addresses and radio states refresh every few seconds while showing.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { stateOfCharge } from '../../modules/power/soc.js';
import { C, MARGIN, TOP, heading, row, hint } from '../../modules/ui/style.js';
import { readNetwork } from './network.js';
import { parseShow, parseDevices } from './bluetooth.js';

const STRIP = { x: 60, w: 60, h: 8 };
const NET_TICKS = 5;   // address / radio refresh while showing

export class StatusScreen {
  /** @param {import('./index.js').SystemMode} sys @param {string} version jet-app's package version */
  constructor(sys, version) { this.sys = sys; this.version = version; }
  #shownPower = null;
  #ticks = 0;
  /** @type {Record<string, string[]>} interface -> IPv4 addresses */ addrs = {};
  /** @type {{ssid: string|null, freq: string|null, signal: string|null}|null} */ wifi = null;
  /** @type {{powered: boolean, device: string|null}|null} null = no controller */ bt = null;

  enter() { this.#ticks = 0; this.refresh(); }
  tick() { if (++this.#ticks % NET_TICKS === 0) this.refresh(); }
  async refresh() {
    try {
      const net = await readNetwork(this.sys.netDir);
      this.addrs = net.addrs; this.wifi = net.wifi;
      const show = parseShow(await run('bluetoothctl', ['show']).catch(() => ''));
      const device = show?.powered ? parseDevices(await run('bluetoothctl', ['devices', 'Connected']).catch(() => ''))[0]?.name ?? null : null;
      this.bt = show && { powered: show.powered, device };
      await this.sys.screens.location?.probe();
      this.sys.ui.requestRender();
    } catch { /* a dev box has none of the tools: the rows say so */ }
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
    const { power } = this.sys, m = power.smoothed;
    if (!m) return null;
    const soc = power.soc ?? stateOfCharge(m);
    return {
      charging: soc.charging, percent: soc.percent,
      battery: `${soc.percent}%  ${m.vbat} mV  ${m.ma >= 0 ? '+' : ''}${m.ma} mA`,
      rails: `vsys ${m.vsys}  vbus ${m.vbus} mV`,
      powered: m.vbus > 4300,
    };
  }

  onGesture() { return false; }

  render(s) {
    const { small } = s.fonts, { sensors } = this.sys;
    heading(s, 'status', new Date().toTimeString().slice(0, 8));
    let y = TOP + 26;
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
      y = row(s, y, 'power', p.rails, p.powered ? C.ok : C.dim);
    } else y = row(s, y, 'battery', 'no reading yet', C.dim);
    const ip = (ifname) => this.addrs[ifname]?.[0]?.split('/')[0];
    y = row(s, y, 'wifi', this.wifi ? `${this.wifi.ssid ?? '?'}  ${this.wifi.signal ?? ''}  ${ip('wlan0') ?? 'no address'}` : ip('wlan0') ?? 'not associated', this.wifi || ip('wlan0') ? C.ok : C.dim);
    y = row(s, y, 'usb', ip('usb0') ?? 'no address', ip('usb0') ? C.ok : C.dim);
    y = row(s, y, 'bluetooth', this.bt ? (this.bt.powered ? `on${this.bt.device ? '  ' + this.bt.device : ''}` : 'off') : 'no controller', this.bt?.powered ? C.warn : C.dim);
    const gps = this.sys.screens.location?.running, gstate = this.sys.gps?.state;
    const gval = gps == null ? '-' : !gps ? 'off' : gstate && gstate.at ? (gstate.fix !== 'none' ? `on  ${gstate.fix} fix  ${gstate.satsUsed} sats` : `on  ${gstate.satsUsed}/${gstate.satsInView} sats`) : 'on';
    y = row(s, y, 'gps', gval, gps ? C.warn : C.dim);
    y = row(s, y, 'glance', sensors.glance ? `${sensors.glance.worn ? 'worn' : 'off'}  raw ${sensors.glance.raw}  ${ago(sensors.glance.t)}` : '-');
    y = row(s, y, 'new view', sensors.view ? `${sensors.view.degrees} deg  ${ago(sensors.view.t)}` : '-');
    y = row(s, y, 'jet-app', `${this.version}  up ${fmtUp(process.uptime())}`);
    row(s, y, 'system', `node ${process.version}  linux ${os.release()}`);
    hint(s, 'rear: menu');
  }
}

const ago = (t) => 'at ' + new Date(t).toTimeString().slice(0, 8);
const fmtUp = (s) => (s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 3000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
