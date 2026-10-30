// Location: the GPS receiver on or off. GPS lives in the same combo chip as Bluetooth and rides
// its UART, so turning it on powers that radio too (scripts/gps.sh does the bring-up: chroot
// mounts, hci0 up, TI's navd from the stock partition - docs/gps.md); while it runs, WiFi rx is
// slow (coex untuned). Front toggles ("heya jet, enable gps" too); off stops the daemon and
// powers the radio back down unless Bluetooth is set to be on. No boot persistence yet: GPS
// starts off. Fix details will come from the NMEA stream once something consumes it.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { C, TOP, heading, row, hint } from '../../modules/ui/style.js';

export class LocationScreen {
  /** @param {import('./index.js').SystemMode} sys */
  constructor(sys) { this.sys = sys; }
  /** @type {boolean|null} navd seen running (null until the first probe) */ running = null;
  error = null; busy = false;
  #ticks = 0;

  enter() { this.#ticks = 0; this.probe().then(() => this.sys.ui.requestRender()); }
  tick() { if (++this.#ticks % 5 === 0) this.probe().then(() => this.sys.ui.requestRender()); }
  onGesture(g) {
    if (g === 'press:front' || g === 'press:tap') { this.toggle().catch(() => {}); return true; }
    return false;
  }

  /** Is the GPS daemon up? (pgrep: exit 1 just means no.) */
  async probe() {
    this.running = await run('pgrep', ['navd']).then(() => true, () => false);
    return this.running;
  }

  toggle() { return this.set(!this.running); }

  /** GPS on or off, live. Rejects, after showing why, when it cannot: a spoken command reports that. */
  async set(on) {
    if (this.busy) return;
    this.busy = true; this.error = null; this.sys.ui.requestRender();
    let failed = null;
    try {
      if (on) await run('sh', [this.sys.gpsScript, 'start'], 30000);
      else {
        await run('sh', [this.sys.gpsScript, 'stop'], 10000);
        // the radio came up for GPS; put it back down unless Bluetooth is wanted at boot
        const btWanted = await fs.access(this.sys.btMarker).then(() => true, () => false);
        if (!btWanted) await run('bluetoothctl', ['power', 'off']).catch(() => {});
      }
      this.running = on;
      this.sys.logger?.info({ on }, 'gps');
      this.sys.ui.setStrip(`gps ${on ? 'on' : 'off'}`, { colour: on ? C.warn : C.ok, ms: 2000 });
    } catch (error) {
      failed = error; this.error = error.message;
      this.sys.logger?.warn({ error: error.message }, 'gps toggle failed');
      await this.probe().catch(() => {});
    }
    this.busy = false;
    this.sys.ui.requestRender();
    if (failed) throw failed;
  }

  render(s) {
    heading(s, 'location');
    let y = TOP + 26;
    if (this.error) y = row(s, y, 'error', this.error, C.bad);
    const on = this.running === true;
    y = row(s, y, 'gps', this.busy ? 'switching...' : this.running == null ? '-' : on ? 'ON  (WiFi rx degraded)' : 'off', this.busy ? C.dim : on ? C.warn : C.ok);
    y = row(s, y, 'receiver', 'in the radio chip; GPS on powers Bluetooth\'s radio too', C.dim);
    y = row(s, y, 'fix', on ? 'see the NMEA stream (docs/gps.md)' : '-', C.dim);
    y += 4;
    row(s, y, 'first fix', 'cold start can take minutes under open sky', C.dim);
    hint(s, `front: gps ${on ? 'off' : 'on'}   rear: menu`);
  }
}

const run = (cmd, args, timeout = 5000) => new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
