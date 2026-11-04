// Location: the GPS receiver on or off, and what it sees. GPS lives in the same combo chip as
// Bluetooth and rides its UART, so turning it on powers that radio too (scripts/gps.sh does the
// bring-up: chroot mounts, hci0 up, TI's navd from the stock partition - docs/gps.md); while it
// runs, WiFi rx is slow (coex untuned). The gps module follows the NMEA stream while on: this
// screen shows satellites, fix and position live (and keeps the capture at gps.logFile for
// later). Front toggles ("heya jet, enable gps" too); off stops the daemon and powers the radio
// back down unless Bluetooth is set to be on. No boot persistence yet: GPS starts off.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { C, TOP, heading, row, hint } from '../../modules/ui/style.js';

export class LocationScreen {
  /** @param {import('./index.js').SystemMode} sys */
  constructor(sys) { this.sys = sys; }
  /** @type {boolean|null} navd seen running (null until the first probe) */ running = null;
  error = null; busy = false;
  #ticks = 0;
  #sel = 0;   // 0 = the gps switch, 1 = the local-time switch (swipe selects, front toggles)

  enter() { this.#ticks = 0; this.probe().then(() => this.sys.ui.requestRender()); }
  tick() { if (++this.#ticks % 5 === 0) this.probe().then(() => this.sys.ui.requestRender()); }
  onGesture(g) {
    if (g === 'swipe:up' || g === 'swipe:down') { this.#sel = this.#sel ? 0 : 1; this.sys.ui.requestRender(); return true; }
    if (g === 'press:front' || g === 'press:tap') {
      if (this.#sel === 0) this.toggle().catch(() => {});
      else this.toggleLocalTime().catch(() => {});
      return true;
    }
    return false;
  }

  /** Local time from the fix, or GMT — the gps module owns the mechanics (TZ + /etc/localtime). */
  async toggleLocalTime() {
    const gps = this.sys.gps; if (!gps) return;
    await gps.setLocalTime(!gps.localTime);
    this.sys.ui.setStrip(gps.localTime ? (gps.tz ? `local time: ${gps.tz}` : 'local time: waiting for a fix') : 'clocks on GMT', { ms: 2500 });
    this.sys.ui.requestRender();
  }

  /** Is the GPS daemon up? (pgrep: exit 1 just means no.) The gps module follows the answer. */
  async probe() {
    this.running = await run('pgrep', ['navd']).then(() => true, () => false);
    if (this.running && !this.sys.gps?.listening) this.sys.gps?.listen();
    if (this.running === false && this.sys.gps?.listening) this.sys.gps?.stopListening();
    return this.running;
  }

  toggle() { return this.set(!this.running); }

  /** GPS on or off, live. Rejects, after showing why, when it cannot: a spoken command reports that. */
  async set(on) {
    if (this.busy) return;
    this.busy = true; this.error = null; this.sys.ui.requestRender();
    let failed = null;
    try {
      if (on) { await run('sh', [this.sys.gpsScript, 'start'], 30000); this.sys.gps?.listen(); }
      else {
        // end the fix session at the chip first (killing the daemon leaves it streaming, which
        // keeps the shared radio busy and strangles WiFi), then stop the daemon
        await this.sys.gps?.stopSession();
        this.sys.gps?.stopListening();
        await run('sh', [this.sys.gpsScript, 'stop'], 10000);
        const btWanted = await fs.access(this.sys.btMarker).then(() => true, () => false);
        if (!btWanted) {
          await run('bluetoothctl', ['power', 'off']).catch(() => {});   // radio down powers the chip off
          await run('hciconfig', ['hci0', 'down']).catch(() => {});      // belt and suspenders
          await run('wpa_cli', ['-i', 'wlan0', 'reassociate']).catch(() => {});   // the coex rate stays pinned at 1 Mbit/s until a reassociate
        }
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
    const on = this.running === true, g = this.sys.gps?.state, gps = this.sys.gps;
    y = row(s, y, `${this.#sel === 0 ? '> ' : '  '}gps`, this.busy ? 'switching...' : this.running == null ? '-' : on ? 'ON  (WiFi rx degraded)' : 'off', this.busy ? C.dim : on ? C.warn : C.ok);
    const lt = gps?.localTime;
    y = row(s, y, `${this.#sel === 1 ? '> ' : '  '}local time`, lt ? (gps.tz || 'waiting for a fix') : 'off (clocks on GMT)', lt ? (gps.tz ? C.ok : C.warn) : C.dim);
    if (on && g) {
      const stale = !g.at || Date.now() - g.at > 5000;
      y = row(s, y, 'satellites', stale ? 'no data from the receiver' : `${g.satsUsed} used  /  ${g.satsInView} in view`, stale ? C.dim : g.satsUsed ? C.ok : C.white);
      y = row(s, y, 'fix', g.fix === 'none' ? 'none yet' : `${g.fix.toUpperCase()}${g.hdop != null ? `  hdop ${g.hdop}` : ''}`, g.fix === 'none' ? C.dim : C.ok);
    }
    if (g && g.lat != null) {
      y = row(s, y, 'position', `${g.lat.toFixed(5)}  ${g.lon.toFixed(5)}${g.altM != null ? `  ${Math.round(g.altM)} m` : ''}${g.good ? '' : '  (rough)'}`, g.good ? C.ok : C.dim);
      if (g.speedKmh != null) y = row(s, y, 'motion', `${g.speedKmh} km/h${g.courseDeg != null ? `  ${Math.round(g.courseDeg)} deg` : ''}`);
      if (g.time) y = row(s, y, 'gps time', new Date(g.time).toISOString().slice(11, 19) + ' utc', C.dim);
    }
    y += 4;
    if (!on) y = row(s, y, 'receiver', 'in the radio chip; GPS on powers Bluetooth\'s radio too', C.dim);
    if (!g || g.fix === 'none') row(s, y, 'first fix', 'cold start can take minutes under open sky', C.dim);
    const what = this.#sel === 0 ? `gps ${on ? 'off' : 'on'}` : `local time ${gps?.localTime ? 'off' : 'on'}`;
    hint(s, `front: ${what}   swipe: select   rear: menu`);
  }
}

const run = (cmd, args, timeout = 5000) => new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
