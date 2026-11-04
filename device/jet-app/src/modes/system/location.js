// Location: a view over the gps module - the receiver on or off, and what it sees. The module
// owns the mechanics (daemon, radio interplay, NMEA snapshot, local time); this screen shows
// satellites, fix and position live while showing (subscribed to the module itself), and offers
// the two switches: front toggles the selected one ("heya jet, enable gps" lands on the first),
// swipe selects gps / local-time.
import { Schema } from '@versionzero/module-manager';
import { C, TOP, heading, row, hint } from '../../modules/ui/style.js';

const s = Schema.create;

export class LocationScreen {
  static moduleInfo = {
    name: 'location-screen',
    provides: 'Screen',
    schema: s()
      .property('gps', s('Gps').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true)),
  };
  gps; ui;

  id = 'location'; label = 'Location';
  error = null; busy = false;
  #ticks = 0;
  #sel = 0;   // 0 = the gps switch, 1 = the local-time switch (swipe selects, front toggles)
  #onUpdate = () => this.ui.requestRender();

  enter() {
    this.#ticks = 0;
    this.gps.on('update', this.#onUpdate);   // the readout follows the receiver while showing
    this.gps.probe().then(() => this.ui.requestRender());
  }
  leave() { this.gps.off('update', this.#onUpdate); }
  tick() { if (++this.#ticks % 5 === 0) this.gps.probe().then(() => this.ui.requestRender()); }

  onGesture(g) {
    if (g === 'swipe:up' || g === 'swipe:down') { this.#sel = this.#sel ? 0 : 1; this.ui.requestRender(); return true; }
    if (g === 'press:front' || g === 'press:tap') {
      if (this.#sel === 0) this.toggle().catch(() => {});
      else this.toggleLocalTime().catch(() => {});
      return true;
    }
    return false;
  }

  /** Local time from the fix, or GMT — the gps module owns the mechanics (TZ + /etc/localtime). */
  async toggleLocalTime() {
    const gps = this.gps;
    await gps.setLocalTime(!gps.localTime);
    this.ui.setStrip(gps.localTime ? (gps.tz ? `local time: ${gps.tz}` : 'local time: waiting for a fix') : 'clocks on GMT', { ms: 2500 });
    this.ui.requestRender();
  }

  toggle() { return this.set(!this.gps.running); }

  /** GPS on or off, through the module. Rejects, after showing why, when it cannot: a spoken command reports that. */
  async set(on) {
    if (this.busy) return;
    this.busy = true; this.error = null; this.ui.requestRender();
    let failed = null;
    try {
      await this.gps.set(on);
      this.ui.setStrip(`gps ${on ? 'on' : 'off'}`, { colour: on ? C.warn : C.ok, ms: 2000 });
    } catch (error) { failed = error; this.error = error.message; }
    this.busy = false;
    this.ui.requestRender();
    if (failed) throw failed;
  }

  render(s) {
    heading(s, 'location');
    let y = TOP + 26;
    if (this.error) y = row(s, y, 'error', this.error, C.bad);
    const gps = this.gps, g = gps.state, on = gps.running === true;
    y = row(s, y, `${this.#sel === 0 ? '> ' : '  '}gps`, this.busy ? 'switching...' : gps.running == null ? '-' : on ? 'ON  (WiFi rx degraded)' : 'off', this.busy ? C.dim : on ? C.warn : C.ok);
    const lt = gps.localTime;
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
    const what = this.#sel === 0 ? `gps ${on ? 'off' : 'on'}` : `local time ${gps.localTime ? 'off' : 'on'}`;
    hint(s, `front: ${what}   swipe: select   rear: menu`);
  }
}
