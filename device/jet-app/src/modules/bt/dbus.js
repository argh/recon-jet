// A minimal D-Bus client, just enough to drive BlueZ: connect to the system bus, call methods,
// receive signals, and export one object (the pairing agent). Little-endian only (what we write;
// we read either endianness). Signature-driven marshalling, so the deep BlueZ types
// (a{oa{sa{sv}}} from GetManagedObjects, a{sv} property dicts, variants) all work from one pair of
// recursive routines. No dependency: the wire format is simple enough to hand-roll, and the point
// of D-Bus over parsing bluetoothctl output is typed, structured calls — a library would undercut
// the "no deps" line for a protocol this contained.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import os from 'node:os';

// ---- marshalling -------------------------------------------------------------------------------
// A tiny growable writer that tracks alignment relative to the message start.
class Writer {
  constructor() { this.buf = Buffer.alloc(256); this.len = 0; }
  #ensure(n) { if (this.len + n > this.buf.length) { const b = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n)); this.buf.copy(b); this.buf = b; } }
  align(n) { const pad = (n - (this.len % n)) % n; this.#ensure(pad); this.buf.fill(0, this.len, this.len + pad); this.len += pad; }
  byte(v) { this.#ensure(1); this.buf.writeUInt8(v & 0xff, this.len); this.len += 1; }
  u16(v) { this.align(2); this.#ensure(2); this.buf.writeUInt16LE(v, this.len); this.len += 2; }
  u32(v) { this.align(4); this.#ensure(4); this.buf.writeUInt32LE(v >>> 0, this.len); this.len += 4; }
  i32(v) { this.align(4); this.#ensure(4); this.buf.writeInt32LE(v, this.len); this.len += 4; }
  u64(v) { this.align(8); this.#ensure(8); this.buf.writeBigUInt64LE(BigInt(v), this.len); this.len += 8; }
  dbl(v) { this.align(8); this.#ensure(8); this.buf.writeDoubleLE(v, this.len); this.len += 8; }
  str(v, lenBytes) { const b = Buffer.from(String(v), 'utf8'); if (lenBytes === 1) this.byte(b.length); else this.u32(b.length); this.#ensure(b.length + 1); b.copy(this.buf, this.len); this.len += b.length; this.buf[this.len++] = 0; }
  raw(b) { this.#ensure(b.length); b.copy(this.buf, this.len); this.len += b.length; }
  take() { return this.buf.subarray(0, this.len); }
}

class Reader {
  constructor(buf, le = true) { this.buf = buf; this.pos = 0; this.le = le; }
  align(n) { this.pos = Math.ceil(this.pos / n) * n; }
  byte() { return this.buf.readUInt8(this.pos++); }
  u16() { this.align(2); const v = this.le ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  u32() { this.align(4); const v = this.le ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  i32() { this.align(4); const v = this.le ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  u64() { this.align(8); const v = this.le ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos); this.pos += 8; return v; }
  dbl() { this.align(8); const v = this.le ? this.buf.readDoubleLE(this.pos) : this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  str(lenBytes) { const n = lenBytes === 1 ? this.byte() : this.u32(); const s = this.buf.toString('utf8', this.pos, this.pos + n); this.pos += n + 1; return s; }
}

/** Split a signature into its top-level complete types, e.g. "a{sv}s" -> ["a{sv}", "s"]. */
function splitSig(sig) {
  const out = []; let i = 0;
  const one = () => {
    const c = sig[i++];
    if (c === 'a') { if (sig[i] === '{') { let d = 0; const st = i; do { if (sig[i] === '{') d++; else if (sig[i] === '}') d--; i++; } while (d); return 'a' + sig.slice(st, i); } return 'a' + one(); }
    if (c === '(') { let d = 1; const st = i; while (d) { if (sig[i] === '(') d++; else if (sig[i] === ')') d--; i++; } return '(' + sig.slice(st, i); }
    return c;
  };
  while (i < sig.length) out.push(one());
  return out;
}

const BASIC_ALIGN = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, h: 4 };
function alignOf(t) { if (t in BASIC_ALIGN) return BASIC_ALIGN[t]; if (t[0] === 'a') return 4; if (t[0] === '(' || t[0] === '{') return 8; if (t === 'v') return 1; return 1; }

/** Marshal one value of type `t` (a signature) into the writer. `v` shape follows the type:
 *  a struct/variant is {type, value}; a dict array is a Map or array of [k,v]; other arrays an array. */
function marshal(w, t, v) {
  switch (t[0]) {
    case 'y': return w.byte(v);
    case 'b': return w.u32(v ? 1 : 0);
    case 'n': case 'q': return w.u16(v);
    case 'i': return w.i32(v);
    case 'u': case 'h': return w.u32(v);
    case 'x': case 't': return w.u64(v);
    case 'd': return w.dbl(v);
    case 's': case 'o': return w.str(v, 4);
    case 'g': return w.str(v, 1);
    case 'v': { const vt = v.type; w.str(vt, 1); marshal(w, vt, v.value); return; }
    case 'a': {
      const el = t.slice(1);
      w.align(4); const lenPos = w.len; w.u32(0);             // length placeholder
      w.align(alignOf(el[0] === '{' ? '{' : el));             // the first element's alignment is counted after the length
      const start = w.len;
      const entries = el[0] === '{' ? (v instanceof Map ? [...v] : (Array.isArray(v) ? v : Object.entries(v))) : v;
      for (const e of entries) {
        if (el[0] === '{') { w.align(8); const [kt, vt] = splitSig(el.slice(1, -1)); marshal(w, kt, e[0]); marshal(w, vt, e[1]); }
        else marshal(w, el, e);
      }
      w.buf.writeUInt32LE(w.len - start, lenPos);
      return;
    }
    case '(': { w.align(8); for (const [i2, st] of splitSig(t.slice(1, -1)).entries()) marshal(w, st, v[i2]); return; }
    default: throw new Error(`marshal: unhandled ${t}`);
  }
}

function unmarshal(r, t) {
  switch (t[0]) {
    case 'y': return r.byte();
    case 'b': return r.u32() !== 0;
    case 'n': { r.align(2); const v = r.le ? r.buf.readInt16LE(r.pos) : r.buf.readInt16BE(r.pos); r.pos += 2; return v; }
    case 'q': return r.u16();
    case 'i': return r.i32();
    case 'u': case 'h': return r.u32();
    case 'x': { r.align(8); const v = r.le ? r.buf.readBigInt64LE(r.pos) : r.buf.readBigInt64BE(r.pos); r.pos += 8; return v; }
    case 't': return r.u64();
    case 'd': return r.dbl();
    case 's': case 'o': return r.str(4);
    case 'g': return r.str(1);
    case 'v': { const vt = r.str(1); return unmarshal(r, vt); }
    case 'a': {
      const el = t.slice(1), n = r.u32(), out = el[0] === '{' ? {} : [];
      r.align(alignOf(el[0] === '{' ? '{' : el));
      const end = r.pos + n;
      while (r.pos < end) {
        if (el[0] === '{') { r.align(8); const [kt, vt] = splitSig(el.slice(1, -1)); out[unmarshal(r, kt)] = unmarshal(r, vt); }
        else out.push(unmarshal(r, el));
      }
      return out;
    }
    case '(': { r.align(8); return splitSig(t.slice(1, -1)).map((st) => unmarshal(r, st)); }
    default: throw new Error(`unmarshal: unhandled ${t}`);
  }
}

// ---- connection --------------------------------------------------------------------------------
const HDR = { PATH: 1, INTERFACE: 2, MEMBER: 3, ERROR_NAME: 4, REPLY_SERIAL: 5, DESTINATION: 6, SENDER: 7, SIGNATURE: 8 };
const MSG = { METHOD_CALL: 1, METHOD_RETURN: 2, ERROR: 3, SIGNAL: 4 };

export class DBus extends EventEmitter {
  #sock = null; #serial = 1; #rx = Buffer.alloc(0);
  #pending = new Map();   // serial -> {resolve, reject}
  #handlers = new Map();  // "path\0interface\0member" -> (msg) => reply args or throws
  name = null;

  /** Connect to the system bus and say Hello; resolves with our unique name. */
  async connect(address = process.env.DBUS_SYSTEM_BUS_ADDRESS || 'unix:path=/run/dbus/system_bus_socket') {
    const path = /unix:path=([^,]+)/.exec(address)?.[1] || '/run/dbus/system_bus_socket';
    await new Promise((res, rej) => { this.#sock = net.createConnection(path, res); this.#sock.once('error', rej); });
    this.#sock.on('error', (e) => this.emit('error', e));
    // SASL EXTERNAL auth first (its own line-based data handler); only then attach the binary
    // message parser, or it would eat the auth text as a malformed message
    await this.#auth();
    this.#sock.on('data', (d) => this.#onData(d));
    this.name = await this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', iface: 'org.freedesktop.DBus', member: 'Hello' });
    return this.name;
  }

  #auth() {
    return new Promise((resolve, reject) => {
      const uid = Buffer.from(String(os.userInfo().uid), 'utf8').toString('hex');
      let buf = '';
      const onLine = (d) => {
        buf += d.toString('latin1');
        if (!buf.includes('\r\n')) return;
        const line = buf.trim();
        if (line.startsWith('OK')) { this.#sock.write('BEGIN\r\n'); this.#sock.off('data', onLine); resolve(); }
        else { this.#sock.off('data', onLine); reject(new Error(`dbus auth: ${line}`)); }
      };
      this.#sock.on('data', onLine);
      this.#sock.write('\0');
      this.#sock.write(`AUTH EXTERNAL ${uid}\r\n`);
    });
  }

  /** A method call; resolves with the single return value (or an array for multi-return), rejects on error. */
  call({ destination, path, iface, member, signature = '', args = [], noReply = false }) {
    const serial = this.#serial++;
    const w = new Writer();
    w.byte(0x6c); w.byte(MSG.METHOD_CALL); w.byte(noReply ? 1 : 0); w.byte(1);   // le, type, flags, version
    const bodyW = new Writer(); for (const [i, st] of splitSig(signature).entries()) marshal(bodyW, st, args[i]);
    const body = bodyW.take();
    w.u32(body.length); w.u32(serial);
    const fields = [[HDR.PATH, { type: 'o', value: path }], [HDR.DESTINATION, { type: 's', value: destination }], [HDR.INTERFACE, { type: 's', value: iface }], [HDR.MEMBER, { type: 's', value: member }]];
    if (signature) fields.push([HDR.SIGNATURE, { type: 'g', value: signature }]);
    marshal(w, 'a(yv)', fields);
    w.align(8); w.raw(body);
    this.#sock.write(w.take());
    if (noReply) return Promise.resolve();
    return new Promise((resolve, reject) => this.#pending.set(serial, { resolve, reject }));
  }

  /** Export a method handler for one object/interface/member. `fn(args) -> {signature, values}` or throws {name,message}. */
  export(path, iface, member, fn) { this.#handlers.set(`${path}\0${iface}\0${member}`, fn); }

  /** Subscribe to signals matching a rule (e.g. "type='signal',interface='org.freedesktop.DBus.ObjectManager'"). */
  addMatch(rule) { return this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', iface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', args: [rule] }); }

  close() { this.#sock?.end(); }

  #onData(chunk) {
    this.#rx = this.#rx.length ? Buffer.concat([this.#rx, chunk]) : chunk;
    for (;;) {
      if (this.#rx.length < 16) return;
      const le = this.#rx[0] === 0x6c;
      const r = new Reader(this.#rx, le); r.pos = 4;
      const bodyLen = r.u32(); r.u32();                  // body length, serial
      const fieldsLen = (le ? this.#rx.readUInt32LE(12) : this.#rx.readUInt32BE(12));
      const headerLen = Math.ceil((16 + fieldsLen) / 8) * 8;
      const total = headerLen + bodyLen;
      if (this.#rx.length < total) return;
      this.#dispatch(this.#rx.subarray(0, total), le);
      this.#rx = this.#rx.subarray(total);
    }
  }

  #dispatch(msg, le) {
    const r = new Reader(msg, le);
    r.pos = 1; const type = r.byte(); r.pos = 4;
    const bodyLen = r.u32(); const serial = r.u32();
    const fields = unmarshal(r, 'a(yv)');
    const h = {}; for (const [code, val] of fields) h[code] = val;
    r.align(8);
    const sig = h[HDR.SIGNATURE] ?? '';
    const body = sig ? splitSig(sig).map((st) => unmarshal(r, st)) : [];
    if (type === MSG.METHOD_RETURN || type === MSG.ERROR) {
      const p = this.#pending.get(h[HDR.REPLY_SERIAL]); if (!p) return; this.#pending.delete(h[HDR.REPLY_SERIAL]);
      if (type === MSG.ERROR) p.reject(Object.assign(new Error(body[0] ?? h[HDR.ERROR_NAME] ?? 'dbus error'), { dbusName: h[HDR.ERROR_NAME] }));
      else p.resolve(body.length <= 1 ? body[0] : body);
    } else if (type === MSG.SIGNAL) {
      this.emit('signal', { path: h[HDR.PATH], iface: h[HDR.INTERFACE], member: h[HDR.MEMBER], body });
    } else if (type === MSG.METHOD_CALL) {
      this.#serveCall(h, body, serial);
    }
  }

  async #serveCall(h, body, serial) {
    const key = `${h[HDR.PATH]}\0${h[HDR.INTERFACE]}\0${h[HDR.MEMBER]}`;
    const fn = this.#handlers.get(key);
    const reply = (type, { destination, signature = '', values = [], errorName } = {}) => {
      const w = new Writer();
      w.byte(0x6c); w.byte(type); w.byte(1); w.byte(1);
      const bodyW = new Writer(); for (const [i, st] of splitSig(signature).entries()) marshal(bodyW, st, values[i]);
      const b = bodyW.take();
      w.u32(b.length); w.u32(this.#serial++);
      const fields = [[HDR.REPLY_SERIAL, { type: 'u', value: serial }], [HDR.DESTINATION, { type: 's', value: destination }]];
      if (errorName) fields.push([HDR.ERROR_NAME, { type: 's', value: errorName }]);
      if (signature) fields.push([HDR.SIGNATURE, { type: 'g', value: signature }]);
      marshal(w, 'a(yv)', fields); w.align(8); w.raw(b);
      this.#sock.write(w.take());
    };
    if (!fn) return reply(MSG.ERROR, { destination: h[HDR.SENDER], signature: 's', values: ['unknown method'], errorName: 'org.freedesktop.DBus.Error.UnknownMethod' });
    try { const res = (await fn(body)) ?? {}; reply(MSG.METHOD_RETURN, { destination: h[HDR.SENDER], signature: res.signature ?? '', values: res.values ?? [] }); }
    catch (e) { reply(MSG.ERROR, { destination: h[HDR.SENDER], signature: 's', values: [e.message ?? 'rejected'], errorName: e.dbusName ?? 'org.bluez.Error.Rejected' }); }
  }
}
