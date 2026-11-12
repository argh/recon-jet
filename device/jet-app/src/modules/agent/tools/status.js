// status: the device's own state in one call, for "how's the battery" / "do we have a fix" /
// "are you running hot" - the common questions, answered from the models that already hold the
// answers (`power`, `gps`) and a few files, with no shell and no model-written command. Both
// models are optional (`lax`): a setup without one just leaves its line out.
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { readNetwork } from '../../../modes/system/network.js';

const s = Schema.create;

function duration(seconds) {
  const m = Math.floor(seconds / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d} d ${h % 24} h` : h ? `${h} h ${m % 60} min` : `${m} min`;
}

export class StatusTool {
  static moduleInfo = {
    name: 'status-tool',
    provides: 'Tool',
    schema: s()
      .property('thermalDir', s('string').default('/sys/class/thermal').meta('description', 'where the thermal_zone*/temp files are'))
      .property('netDir', s('string').default('/sys/class/net').meta('description', 'the interfaces looked at for WiFi'))
      .property('power', s('Power').lax().meta('internal', true))
      .property('gps', s('Gps').lax().meta('internal', true)),
  };
  thermalDir; netDir; power; gps;

  name = 'status';
  description = 'The current state of your partner\'s glasses: battery level and charge current, GPS fix and position, WiFi, uptime, load and temperature. The only source for these: call it before answering a question about any of them.';
  parameters = { type: 'object', properties: {} };

  async run() {
    const [temps, wifi] = await Promise.all([this.#temperatures(), this.#wifi()]);
    return [this.#battery(), this.#position(), wifi, `Uptime ${duration(os.uptime())}, load ${os.loadavg().map((l) => l.toFixed(2)).join(' ')}.`, temps].filter(Boolean).join('\n');
  }

  #battery() {
    const m = this.power?.smoothed;
    if (!m) return this.power ? 'Battery: no reading yet.' : null;
    const soc = this.power.soc;
    const flow = m.ma > 0 ? `charging at ${m.ma} mA` : m.ma < 0 ? `drawing ${-m.ma} mA` : 'no current';
    return `Battery ${soc ? `${soc.percent}%, ` : ''}${(m.vbat / 1000).toFixed(2)} V, ${soc?.full ? 'full' : flow}.`;
  }

  #position() {
    const gps = this.gps;
    if (!gps) return null;
    if (!gps.running) return 'GPS is off.';
    const fix = gps.goodFix(), st = gps.state ?? {};
    if (!fix) return `GPS on, no fix (${st.satsUsed ?? 0} satellites used, ${st.satsInView ?? 0} in view).`;
    const extra = [fix.altM != null && `altitude ${Math.round(fix.altM)} m`, fix.speedKmh != null && `${fix.speedKmh} km/h`, `${fix.satsUsed} satellites`, fix.hdop != null && `hdop ${fix.hdop}`].filter(Boolean);
    return `GPS ${fix.fix} fix at ${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)} (${extra.join(', ')}).`;
  }

  async #wifi() {
    const { addrs, wifi } = await readNetwork(this.netDir).catch(() => ({ addrs: {}, wifi: null }));
    const ip = addrs.wlan0?.[0];
    if (!wifi) return ip ? `WiFi address ${ip}.` : 'WiFi not associated.';
    return `WiFi ${wifi.ssid ?? '?'}${wifi.signal ? `, ${wifi.signal}` : ''}${ip ? `, ${ip}` : ''}.`;
  }

  /** The zones as the kernel reports them (millidegrees), hottest first. */
  async #temperatures() {
    const zones = (await fs.readdir(this.thermalDir).catch(() => [])).filter((n) => n.startsWith('thermal_zone'));
    const temps = (await Promise.all(zones.map((z) => fs.readFile(path.join(this.thermalDir, z, 'temp'), 'utf8').then((t) => parseInt(t, 10) / 1000, () => NaN))))
      .filter(Number.isFinite).sort((a, b) => b - a);
    return temps.length ? `Temperature ${temps.map((t) => `${Math.round(t)}°C`).join(', ')}.` : null;
  }
}
