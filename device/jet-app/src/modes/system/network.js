// Network: the interfaces in /sys/class/net with their IPv4 addresses (`ip -4 -j addr`) and the
// WiFi association (`iw dev wlan0 link`), refreshed every few seconds while showing. The
// parsers are pure; the commands run through child_process without a shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { C, TOP, heading, row, hint } from '../../modules/ui/style.js';

const REFRESH_TICKS = 5;

/** `ip -4 -j addr` JSON -> { ifname: ['10.42.0.1/24', ...] } */
export function parseIpAddr(json) {
  const out = {};
  for (const i of JSON.parse(json || '[]')) out[i.ifname] = (i.addr_info ?? []).filter((a) => a.family === 'inet').map((a) => `${a.local}/${a.prefixlen}`);
  return out;
}

/** `iw dev wlan0 link` text -> { ssid, freq, signal } or null when not connected */
export function parseIwLink(text) {
  if (!/^Connected to/m.test(text)) return null;
  const get = (re) => text.match(re)?.[1]?.trim() ?? null;
  return { ssid: get(/^\s*SSID:\s*(.+)$/m), freq: get(/^\s*freq:\s*(\S+)/m), signal: get(/^\s*signal:\s*(.+)$/m) };
}

/** The interfaces (no lo/sit), their IPv4 addresses and the WiFi link, for any screen that shows them. */
export async function readNetwork(netDir) {
  const interfaces = (await fs.readdir(netDir).catch(() => [])).filter((n) => n !== 'lo' && !n.startsWith('sit')).sort();
  const addrs = parseIpAddr(await run('ip', ['-4', '-j', 'addr']).catch(() => '[]'));
  const wifi = interfaces.includes('wlan0') ? parseIwLink(await run('iw', ['dev', 'wlan0', 'link']).catch(() => '')) : null;
  return { interfaces, addrs, wifi };
}

export class NetworkScreen {
  /** @param {import('./index.js').SystemMode} sys */
  constructor(sys) { this.sys = sys; }
  interfaces = []; addrs = {}; wifi = null; error = null;
  #ticks = 0;

  enter() { this.#ticks = 0; this.refresh(); }
  tick() { if (++this.#ticks % REFRESH_TICKS === 0) this.refresh(); }
  onGesture() { return false; }

  async refresh() {
    try { Object.assign(this, await readNetwork(this.sys.netDir)); this.error = null; }
    catch (error) { this.error = error.message; }
    this.sys.ui.requestRender();
  }

  render(s) {
    heading(s, 'network');
    let y = TOP + 26;
    if (this.error) y = row(s, y, 'error', this.error, C.bad);
    for (const i of this.interfaces) {
      const a = this.addrs[i] ?? [];
      y = row(s, y, i, a.length ? a.join('  ') : 'no address', a.length ? C.ok : C.dim);
    }
    if (!this.interfaces.length) y = row(s, y, 'interfaces', 'none', C.dim);
    y += 4;
    if (this.wifi) { y = row(s, y, 'wifi', this.wifi.ssid ?? '?', C.ok); y = row(s, y, 'freq / signal', `${this.wifi.freq ?? '?'} MHz  ${this.wifi.signal ?? '?'}`); }
    else row(s, y, 'wifi', this.interfaces.includes('wlan0') ? 'not associated' : 'no wlan0', C.dim);
    hint(s, 'rear: menu');
  }
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 3000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
