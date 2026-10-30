// Bluetooth: the radio (hci0) on or off, live and for the next boot. The stack (dbus + bluetoothd)
// runs from init with AutoEnable off, so the radio only comes up when asked: an up hci0 pins the
// wl1283's WiFi rx at 1 Mbit/s (coex untuned). On for a keyboard while on the USB link, off to use
// WiFi unplugged. Front toggles (and "heya jet, enable bluetooth" sets) and persists the choice as
// the marker file init reads; the screen lists connected and paired devices. Pairing itself is
// still bluetoothctl over ssh.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { C, TOP, heading, row, hint } from '../../modules/ui/style.js';

const REFRESH_TICKS = 5;

/** `bluetoothctl show` text -> { address, powered }, or null without a controller (bluetoothd down) */
export function parseShow(text) {
  const m = text.match(/^Controller (\S+)/m);
  return m ? { address: m[1], powered: /^\s*Powered:\s*yes/m.test(text) } : null;
}

/** `bluetoothctl devices [Connected|Paired]` lines -> [{ address, name }] */
export function parseDevices(text) {
  return [...text.matchAll(/^Device (\S+) (.*)$/gm)].map((m) => ({ address: m[1], name: m[2].trim() }));
}

export class BluetoothScreen {
  /** @param {import('./index.js').SystemMode} sys */
  constructor(sys) { this.sys = sys; }
  /** @type {{address: string, powered: boolean}|null|undefined} undefined until the first refresh */ controller;
  connected = []; paired = []; atBoot = false; error = null; busy = false;
  #ticks = 0;

  enter() { this.#ticks = 0; this.refresh(); }
  tick() { if (++this.#ticks % REFRESH_TICKS === 0) this.refresh(); }
  onGesture(g) {
    if (g === 'press:front' || g === 'press:tap') { this.toggle(); return true; }
    return false;
  }

  async refresh() {
    try {
      this.controller = parseShow(await run('bluetoothctl', ['show']).catch(() => ''));
      this.connected = this.controller?.powered ? parseDevices(await run('bluetoothctl', ['devices', 'Connected']).catch(() => '')) : [];
      this.paired = this.controller ? parseDevices(await run('bluetoothctl', ['devices', 'Paired']).catch(() => '')) : [];
      this.atBoot = await fs.access(this.sys.btMarker).then(() => true, () => false);
      this.error = null;
    } catch (error) { this.error = error.message; }
    this.sys.ui.requestRender();
  }

  /** Flip the radio and make that the boot default (marker present = radio on at boot). */
  toggle() { if (this.controller) this.set(!this.controller.powered).catch(() => {}); }

  /** Radio on or off, live and at boot. Rejects, after showing why, when it cannot: a spoken command reports that. */
  async set(on) {
    if (this.busy) return;
    if (this.controller === undefined) await this.refresh();
    if (!this.controller) { this.error = 'no bluetooth controller'; this.sys.ui.requestRender(); throw new Error(this.error); }
    this.busy = true; this.sys.ui.requestRender();
    let failed = null;
    try {
      // GPS rides this radio: powering it off takes the GPS daemon down first (Location shows it off)
      if (!on && this.sys.screens.location?.running) await run('sh', [this.sys.gpsScript, 'stop']).then(() => { this.sys.screens.location.running = false; this.sys.logger?.info('gps stopped for radio off'); }, () => {});
      await run('bluetoothctl', ['power', on ? 'on' : 'off']);
      if (on) await fs.writeFile(this.sys.btMarker, 'bluetooth radio on at boot (System > Bluetooth)\n');
      else await fs.rm(this.sys.btMarker, { force: true });
      this.sys.logger?.info({ on }, 'bluetooth radio');
      this.sys.ui.setStrip(`bluetooth ${on ? 'on' : 'off'}`, { colour: on ? C.warn : C.ok, ms: 2000 });
    } catch (error) { failed = error; this.error = error.message; this.sys.logger?.warn({ error: error.message }, 'bluetooth toggle failed'); }
    this.busy = false;
    await this.refresh();
    if (failed) throw failed;
  }

  render(s) {
    heading(s, 'bluetooth');
    let y = TOP + 26;
    if (this.error) y = row(s, y, 'error', this.error, C.bad);
    if (this.controller === null) { row(s, y, 'radio', 'no controller (bluetoothd down?)', C.dim); hint(s, 'rear: menu'); return; }
    const on = this.controller?.powered ?? false;
    y = row(s, y, 'radio', this.busy ? 'switching...' : on ? 'ON  (WiFi rx degraded)' : 'off', this.busy ? C.dim : on ? C.warn : C.ok);
    y = row(s, y, 'at boot', this.atBoot ? 'on' : 'off');
    y += 4;
    if (this.connected.length) for (const d of this.connected) y = row(s, y, 'connected', d.name, C.ok);
    else y = row(s, y, 'connected', on ? 'nothing' : '-', C.dim);
    row(s, y, 'paired', this.paired.length ? this.paired.map((d) => d.name).join(', ') : 'none (pair over ssh)', C.dim);
    hint(s, `front: radio ${on ? 'off' : 'on'}   rear: menu`);
  }
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
