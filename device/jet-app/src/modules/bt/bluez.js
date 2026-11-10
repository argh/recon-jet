// BlueZ over the D-Bus client: a live device model and the pairing flow. Discovery runs on the
// adapter; a device list is built from GetManagedObjects and then kept current from
// InterfacesAdded / InterfacesRemoved / PropertiesChanged signals. pair() drives Device1.Pair +
// Trusted + Connect; a registered Agent1 handles the passkey the user types on the keyboard. The
// list is filtered to HID (keyboards and mice, incl. LE combos) so a user never tries to pair a
// speaker the glasses cannot use. Events: 'change' (the list moved) and 'agent' (a pairing prompt
// the UI must show: {kind:'passkey', passkey} to type on the device, or {kind:'confirm', passkey,
// accept, reject}).
import { EventEmitter } from 'node:events';
import { DBus } from './dbus.js';

const BLUEZ = 'org.bluez';
const AGENT_PATH = '/net/v0/jet/agent';
const HID_UUID_PREFIX = '00001124';   // Human Interface Device service (classic + HID-over-GATT)
const OM = 'org.freedesktop.DBus.ObjectManager';
const PROPS = 'org.freedesktop.DBus.Properties';

/** HID = a keyboard/mouse the glasses can drive: HID service UUID, an input-* icon, or the
 *  peripheral major device class. LE HID devices report class 0, so the UUID/icon checks matter. */
export function isHid({ uuids = [], icon = '', class: cls = 0 } = {}) {
  return uuids.some((u) => String(u).toLowerCase().startsWith(`0000${HID_UUID_PREFIX}`))
    || String(icon).startsWith('input-') || ((cls >> 8) & 0x1f) === 0x05;
}

const devFields = (p = {}) => ({
  address: p.Address, name: p.Name || p.Alias || p.Address, icon: p.Icon || '', class: p.Class || 0,
  uuids: p.UUIDs || [], rssi: typeof p.RSSI === 'bigint' ? Number(p.RSSI) : (p.RSSI ?? null),
  paired: !!p.Paired, connected: !!p.Connected, trusted: !!p.Trusted,
});

export class Bluez extends EventEmitter {
  #bus = null; #adapter = null;
  /** @type {Map<string, object>} object path -> device record (+ `path`) */ devices = new Map();
  pairing = null;   // the address a pair() is in flight for

  async start() {
    this.#bus = new DBus();
    await this.#bus.connect();
    this.#bus.on('signal', (s) => this.#onSignal(s));
    await this.#bus.addMatch(`type='signal',sender='${BLUEZ}',interface='${OM}'`);
    await this.#bus.addMatch(`type='signal',sender='${BLUEZ}',interface='${PROPS}',member='PropertiesChanged'`);
    await this.#load();
    await this.#registerAgent();
    return this;
  }
  async stop() { try { await this.scan(false); } catch {} this.#bus?.close(); }

  get adapter() { return this.#adapter; }
  /** HID devices only, newest signal wins; connected and paired first, then by RSSI. */
  list() {
    return [...this.devices.values()].filter((d) => isHid(d))
      .sort((a, b) => (b.connected - a.connected) || (b.paired - a.paired) || ((b.rssi ?? -999) - (a.rssi ?? -999)));
  }

  async #load() {
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
  #dev(path, member, signature, args) { return this.#bus.call({ destination: BLUEZ, path, iface: 'org.bluez.Device1', member, signature, args }); }

  /** Discovery on/off, filtered so only HID transports surface where BlueZ supports it. */
  async scan(on) {
    if (!this.#adapter) return;
    const call = (member, sig, a) => this.#bus.call({ destination: BLUEZ, path: this.#adapter, iface: 'org.bluez.Adapter1', member, signature: sig, args: a });
    if (on) {
      await call('SetDiscoveryFilter', 'a{sv}', [[['Transport', { type: 's', value: 'auto' }], ['UUIDs', { type: 'as', value: [`0000${HID_UUID_PREFIX}-0000-1000-8000-00805f9b34fb`] }]]]).catch(() => {});
      await call('StartDiscovery', '', []).catch((e) => { if (!/InProgress/.test(e.message)) throw e; });
    } else await call('StopDiscovery', '', []).catch(() => {});
  }

  /** Pair, trust (so it reconnects by itself), and connect. Agent prompts arrive as 'agent' events. */
  async pair(address) {
    const path = [...this.devices.values()].find((d) => d.address === address)?.path;
    if (!path) throw new Error('device gone');
    this.pairing = address;
    try {
      await this.scan(false).catch(() => {});
      await this.#dev(path, 'Pair', '', []);
      await this.#prop(path, 'org.bluez.Device1', 'Trusted', { type: 'b', value: true }).catch(() => {});
      await this.#dev(path, 'Connect', '', []).catch(() => {});   // many HIDs connect from Pair already
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
      Object.assign(d, devFields({ ...d, ...changed, Address: d.address, Name: changed.Alias ?? changed.Name ?? d.name }));
      this.emit('change');
    }
  }

  // ---- pairing agent -------------------------------------------------------------------------
  async #registerAgent() {
    const name = (p) => this.devices.get(p)?.name ?? p;
    this.#bus.export(AGENT_PATH, 'org.bluez.Agent1', 'Release', () => ({}));
    this.#bus.export(AGENT_PATH, 'org.bluez.Agent1', 'Cancel', () => { this.emit('agent', null); return {}; });
    // the keyboard shows no screen: the glasses display the passkey, the user types it on the keyboard
    this.#bus.export(AGENT_PATH, 'org.bluez.Agent1', 'DisplayPasskey', ([dev, passkey]) => { this.emit('agent', { kind: 'passkey', device: name(dev), passkey: String(passkey).padStart(6, '0') }); return {}; });
    this.#bus.export(AGENT_PATH, 'org.bluez.Agent1', 'DisplayPinCode', ([dev, pin]) => { this.emit('agent', { kind: 'passkey', device: name(dev), passkey: pin }); return {}; });
    // just-works / numeric compare: surface the number and wait for a front-press
    this.#bus.export(AGENT_PATH, 'org.bluez.Agent1', 'RequestConfirmation', ([dev, passkey]) => new Promise((resolve, reject) => {
      this.emit('agent', { kind: 'confirm', device: name(dev), passkey: String(passkey).padStart(6, '0'),
        accept: () => resolve({}), reject: () => reject(Object.assign(new Error('rejected'), { dbusName: 'org.bluez.Error.Rejected' })) });
    }));
    this.#bus.export(AGENT_PATH, 'org.bluez.Agent1', 'RequestAuthorization', () => ({}));
    this.#bus.export(AGENT_PATH, 'org.bluez.Agent1', 'AuthorizeService', () => ({}));
    await this.#bus.call({ destination: BLUEZ, path: '/org/bluez', iface: 'org.bluez.AgentManager1', member: 'RegisterAgent', signature: 'os', args: [AGENT_PATH, 'KeyboardDisplay'] }).catch((e) => { if (!/AlreadyExists/.test(e.message)) throw e; });
    await this.#bus.call({ destination: BLUEZ, path: '/org/bluez', iface: 'org.bluez.AgentManager1', member: 'RequestDefaultAgent', signature: 'o', args: [AGENT_PATH] }).catch(() => {});
  }
}
