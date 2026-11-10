// BlueZ over the D-Bus client: a live device model and the pairing flow (the Model; the Bluetooth
// screen is the View/Controller and holds no BlueZ logic). Discovery runs on the adapter; a device
// list is built from GetManagedObjects and then kept current from InterfacesAdded /
// InterfacesRemoved / PropertiesChanged signals. pair() drives Device1.Pair + Trusted + Connect;
// the agent is registered NoInputNoOutput, so BlueZ does Just Works pairing automatically with no
// passkey or confirm — a keyboard that demands a typed passkey simply fails to pair (the only
// keyboards we support are code-free ones). The list is filtered to HID (keyboards and mice, incl.
// LE combos) so a user never tries to pair a speaker the glasses cannot use. One event: 'change'.
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';
import { DBus } from './dbus.js';

const s = Schema.create;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const BLUEZ = 'org.bluez';
const AGENT_PATH = '/net/v0/jet/agent';
const HID_UUIDS = ['00001124', '00001812'];   // classic HID profile, and HID-over-GATT (LE keyboards)
const OM = 'org.freedesktop.DBus.ObjectManager';
const PROPS = 'org.freedesktop.DBus.Properties';

/** HID = a keyboard/mouse the glasses can drive: a HID service UUID (classic 0x1124 or LE 0x1812),
 *  an input-* icon (BlueZ derives it from the class or the LE Appearance), or the peripheral major
 *  device class. LE HID devices report class 0 and may show the UUID only after connecting, so the
 *  icon is often what catches a fresh one. */
export function isHid({ uuids = [], icon = '', class: cls = 0 } = {}) {
  return uuids.some((u) => HID_UUIDS.some((h) => String(u).toLowerCase().startsWith(`0000${h}`)))
    || String(icon).startsWith('input-') || ((cls >> 8) & 0x1f) === 0x05;
}

const devFields = (p = {}) => ({
  address: p.Address, name: p.Name || p.Alias || p.Address, icon: p.Icon || '', class: p.Class || 0,
  uuids: p.UUIDs || [], rssi: typeof p.RSSI === 'bigint' ? Number(p.RSSI) : (p.RSSI ?? null),
  paired: !!p.Paired, connected: !!p.Connected, trusted: !!p.Trusted,
});

export class Bluez extends EventEmitter {
  static moduleInfo = {
    name: 'bluez',
    provides: 'Bluez',
    schema: s().property('logger', s('Logger').lax().meta('internal', true)),
  };
  logger;

  #bus = null; #adapter = null;
  /** @type {Map<string, object>} object path -> device record (+ `path`) */ devices = new Map();
  pairing = null;   // the address a pair() is in flight for
  ready = false;    // the D-Bus connection is up (bluetoothd reachable)

  /** Best-effort: a down bluetoothd must not fail app start. `ensure()` reconnects on demand. */
  async start() { await this.ensure().catch((e) => this.logger?.warn({ error: e.message }, 'bluez: not connected')); return this; }

  async ensure() {
    if (this.ready) return;
    const bus = new DBus();
    bus.on('error', () => { this.ready = false; this.emit('change'); });
    bus.on('signal', (sig) => this.#onSignal(sig));
    await bus.connect();
    this.#bus = bus; this.ready = true;
    await bus.addMatch(`type='signal',sender='${BLUEZ}',interface='${OM}'`);
    await bus.addMatch(`type='signal',sender='${BLUEZ}',interface='${PROPS}',member='PropertiesChanged'`);
    await this.#load();
    await this.#registerAgent();
  }
  async stop() { try { await this.scan(false); } catch {} this.#bus?.close(); this.ready = false; }

  get adapter() { return this.#adapter; }
  /** HID devices, one row per physical device, connected/paired first then by RSSI. A bonded BLE
   *  device also seen under its random advertising address collapses by name to the bonded one. */
  list() {
    const better = (a, b) => (a.connected - b.connected) || (a.paired - b.paired) || ((a.rssi ?? -999) - (b.rssi ?? -999));
    const best = new Map();
    for (const d of [...this.devices.values()].filter((x) => isHid(x))) {
      const key = (d.name || d.address).toLowerCase();
      if (!best.has(key) || better(d, best.get(key)) > 0) best.set(key, d);
    }
    return [...best.values()].sort((a, b) => better(b, a));
  }

  async #load() {
    this.devices.clear();
    const objs = await this.#bus.call({ destination: BLUEZ, path: '/', iface: OM, member: 'GetManagedObjects' });
    for (const [path, ifaces] of Object.entries(objs)) {
      if (ifaces['org.bluez.Adapter1'] && !this.#adapter) this.#adapter = path;
      if (ifaces['org.bluez.Device1']) this.devices.set(path, { path, ...devFields(ifaces['org.bluez.Device1']) });
    }
    this.emit('change');
  }

  async #prop(path, iface, name, value) {
    return this.#bus.call({ destination: BLUEZ, path, iface: PROPS, member: 'Set', signature: 'ssv', args: [iface, name, value] });
  }
  #get(path, iface, name) { return this.#bus.call({ destination: BLUEZ, path, iface: PROPS, member: 'Get', signature: 'ss', args: [iface, name] }); }
  #dev(path, member, signature, args) { return this.#bus.call({ destination: BLUEZ, path, iface: 'org.bluez.Device1', member, signature, args }); }

  /** Wait until GATT services resolve — for an LE HID that is when bluetoothd's input plugin reads
   *  the report map and creates the kernel input (uhid) node, so keys actually flow. */
  async #waitResolved(path, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await this.#get(path, 'org.bluez.Device1', 'ServicesResolved').catch(() => false)) return true;
      await delay(400);
    }
    return false;
  }

  /** Discovery on/off, filtered so only HID transports surface where BlueZ supports it. */
  async scan(on) {
    if (on) await this.ensure();
    if (!this.#adapter) return;
    const call = (member, sig, a) => this.#bus.call({ destination: BLUEZ, path: this.#adapter, iface: 'org.bluez.Adapter1', member, signature: sig, args: a });
    if (on) {
      // discover everything (don't filter by UUID — a fresh keyboard may advertise its type only as
      // an LE Appearance, not a service UUID); the list is HID-filtered for display instead
      await call('SetDiscoveryFilter', 'a{sv}', [[['Transport', { type: 's', value: 'auto' }]]]).catch(() => {});
      await call('StartDiscovery', '', []).catch((e) => { if (!/InProgress/.test(e.message)) throw e; });
    } else await call('StopDiscovery', '', []).catch(() => {});
  }

  /** Pair, trust (so it reconnects on its own), then bring the HID up with a clean reconnect.
   *  A Connect() straight after Pair returns before GATT services resolve, so bluetoothd's input
   *  plugin never reads the HID report map and no kernel input (uhid) node is created — the device
   *  reads "connected" but no keys flow. Disconnecting and reconnecting forces a fresh service
   *  resolution, which is when the input device appears; wait for ServicesResolved to confirm it. */
  async pair(address) {
    await this.ensure();
    const path = [...this.devices.values()].find((d) => d.address === address)?.path;
    if (!path) throw new Error('device gone');
    this.pairing = address;
    try {
      await this.scan(false).catch(() => {});
      await this.#dev(path, 'Pair', '', []);
      await this.#prop(path, 'org.bluez.Device1', 'Trusted', { type: 'b', value: true }).catch(() => {});
      await this.#dev(path, 'Disconnect', '', []).catch(() => {});
      await delay(1500);
      await this.#dev(path, 'Connect', '', []).catch(() => {});
      await this.#waitResolved(path, 8000);
    } finally { this.pairing = null; this.emit('change'); }
  }

  async remove(address) {
    const path = [...this.devices.values()].find((d) => d.address === address)?.path;
    if (!path || !this.#adapter) return;
    await this.#bus.call({ destination: BLUEZ, path: this.#adapter, iface: 'org.bluez.Adapter1', member: 'RemoveDevice', signature: 'o', args: [path] });
    this.devices.delete(path); this.emit('change');
  }

  // ---- signals -------------------------------------------------------------------------------
  #onSignal({ path, iface, member, body }) {
    if (iface === OM && member === 'InterfacesAdded') { const [p, ifaces] = body; if (ifaces['org.bluez.Device1']) { this.devices.set(p, { path: p, ...devFields(ifaces['org.bluez.Device1']) }); this.emit('change'); } }
    else if (iface === OM && member === 'InterfacesRemoved') { const [p, ifs] = body; if (ifs.includes('org.bluez.Device1')) { this.devices.delete(p); this.emit('change'); } }
    else if (iface === PROPS && member === 'PropertiesChanged') {
      const [which, changed] = body; if (which !== 'org.bluez.Device1') return;
      const d = this.devices.get(path); if (!d) return;
      // merge ONLY the changed properties — rebuilding from `changed` alone would drop Icon/UUIDs on
      // an RSSI tick and make the device flicker out of the HID-filtered list
      if ('Name' in changed || 'Alias' in changed) d.name = changed.Alias || changed.Name || d.name;
      if ('Icon' in changed) d.icon = changed.Icon;
      if ('Class' in changed) d.class = changed.Class;
      if ('UUIDs' in changed) d.uuids = changed.UUIDs;
      if ('RSSI' in changed) d.rssi = typeof changed.RSSI === 'bigint' ? Number(changed.RSSI) : changed.RSSI;
      if ('Paired' in changed) d.paired = !!changed.Paired;
      if ('Connected' in changed) d.connected = !!changed.Connected;
      if ('Trusted' in changed) d.trusted = !!changed.Trusted;
      this.emit('change');
    }
  }

  // ---- pairing agent -------------------------------------------------------------------------
  // NoInputNoOutput: Just Works pairing, fully automatic. There is nothing to display and nothing
  // to confirm; a device that demands a typed passkey finds no handler for it and pairing fails,
  // which is the intended filter (code-free keyboards only). The agent just auto-authorizes.
  async #registerAgent() {
    const ok = () => ({});
    for (const m of ['Release', 'Cancel', 'RequestAuthorization', 'AuthorizeService', 'RequestConfirmation']) this.#bus.export(AGENT_PATH, 'org.bluez.Agent1', m, ok);
    await this.#bus.call({ destination: BLUEZ, path: '/org/bluez', iface: 'org.bluez.AgentManager1', member: 'RegisterAgent', signature: 'os', args: [AGENT_PATH, 'NoInputNoOutput'] }).catch((e) => { if (!/AlreadyExists/.test(e.message)) throw e; });
    await this.#bus.call({ destination: BLUEZ, path: '/org/bluez', iface: 'org.bluez.AgentManager1', member: 'RequestDefaultAgent', signature: 'o', args: [AGENT_PATH] }).catch(() => {});
  }
}
