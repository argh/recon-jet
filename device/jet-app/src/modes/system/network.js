// Network readings for the Status screen: the interfaces in /sys/class/net with their IPv4
// addresses (`ip -4 -j addr`) and the WiFi association (`iw dev wlan0 link`). The parsers are
// pure; the commands run through child_process without a shell. (The dedicated Network screen
// is gone: Status shows the useful parts of this.)
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

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

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 3000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
