// One-shot jetd client: dial, request/reply by reply letter, typed events. No reconnect on
// purpose — the CLI connects, does one thing and exits. Framing (raw bytes after an `f` or `a`
// header line) and the `q` power decode lifted from the retired jet-hub; protocol in docs/jetd.md.
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

export class JetClient extends EventEmitter {
  #sock = null;
  #buf = Buffer.alloc(0);
  #pending = null;     // { kind, header, len } while a binary payload is being collected
  #waiters = new Map(); // reply letter -> [{ resolve, reject, timer }]
  hello = null;         // { w, h, cols, rows }
  mode = null;          // last `m`; 'remote' assumed after a hello

  constructor({ host, port, timeoutMs = 8000 }) {
    super();
    this.host = host; this.port = port; this.timeoutMs = timeoutMs;
  }

  /** Dial jetd and resolve with the hello geometry. Connecting is side-effect-free: jetd greets
   *  every client and keeps running its own show (up to 4 clients, jet-app among them). */
  connect() {
    return new Promise((resolve, reject) => {
      const sock = (this.#sock = net.connect({ host: this.host, port: this.port }));
      sock.setNoDelay(true);
      sock.setTimeout(this.timeoutMs, () => sock.destroy(new Error('connect timeout')));
      sock.on('data', (chunk) => this.#feed(chunk));
      sock.on('error', () => {});   // 'close' carries the verdict
      sock.once('close', () => {
        const error = new Error(`${this.host}:${this.port}: ${sock.errored?.message ?? 'disconnected'}`);
        this.#sock = null;
        this.#rejectAll(error);
        if (!this.hello) reject(error);
        this.emit('close');
      });
      this.once('hello', (hello) => { sock.setTimeout(0); resolve(hello); });
    });
  }

  /** Write raw protocol lines (no trailing newline needed). False when not connected. */
  send(...lines) {
    if (!this.#sock) return false;
    this.#sock.write(lines.join('\n') + '\n');
    return true;
  }

  /** Send `line` and resolve with the parsed reply for `letter` (or reject on timeout/close). */
  request(letter, line, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.send(line)) return reject(new Error('not connected'));
      const list = this.#waiters.get(letter) ?? this.#waiters.set(letter, []).get(letter);
      const entry = { resolve, reject, timer: setTimeout(() => { list.splice(list.indexOf(entry), 1); reject(new Error(`timeout waiting for '${letter}'`)); }, timeoutMs) };
      list.push(entry);
    });
  }

  /** Flush what is queued (FIN), then make sure the handle is gone so the process can exit. */
  async close() {
    const sock = this.#sock;
    if (!sock) return;
    this.#sock = null;
    sock.end();
    await Promise.race([once(sock, 'close'), delay(500)]);
    sock.destroy();
  }

  #feed(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    for (;;) {
      if (this.#pending) {
        if (this.#buf.length < this.#pending.len) return;
        const data = Buffer.from(this.#buf.subarray(0, this.#pending.len));
        this.#buf = this.#buf.subarray(this.#pending.len);
        const p = this.#pending; this.#pending = null;
        if (p.kind === 'f') this.#resolve('f', { ...p.header, data }, 'frame');
        else if (p.kind === 'b') this.emit('blit', { ...p.header, data });      // mirror rect (N 1)
        else if (p.kind === 'u') this.emit('speaker', data);                    // speaker tee, 48 kHz stereo S16
        else if (p.kind === 'a') this.emit('mic', data);                        // capture chunk, 16 kHz mono S16
        continue;
      }
      const nl = this.#buf.indexOf(10);
      if (nl < 0) return;
      const line = this.#buf.subarray(0, nl).toString('latin1').replace(/\r$/, '');
      this.#buf = this.#buf.subarray(nl + 1);
      this.#dispatch(line);
    }
  }

  #dispatch(line) {
    this.emit('line', line);
    const [t, ...a] = line.split(' ');
    switch (t) {
      case 'f': this.#pending = { kind: 'f', header: { w: +a[0], h: +a[1], fmt: a[2] }, len: +a[3] }; return;
      case 'a': this.#pending = { kind: 'a', len: +a[0] }; return;
      case 'b': this.#pending = { kind: 'b', header: { x: +a[0], y: +a[1], w: +a[2], h: +a[3] }, len: +a[4] }; return;
      case 'u': this.#pending = { kind: 'u', len: +a[0] }; return;
      case 'N': return this.#resolve('N', { w: +a[0], h: +a[1], bpp: +a[2], lineLength: +a[3] }, 'mirror');
      case 'h': this.hello = { w: +a[0], h: +a[1], cols: +a[2], rows: +a[3] }; this.mode ??= 'remote'; return this.emit('hello', this.hello);
      case 'k': return this.emit('key', { code: +a[0], value: +a[1] });
      case 'r': return this.emit('touch', { dx: +a[0], dy: +a[1] });
      case 'm': this.mode = a[0]; return this.emit('mode', a[0]);
      case 'n': return this.emit('view', { degrees: +a[0] });
      case 'j': return this.emit('log', line.slice(2));
      case 'J': return this.#resolve('J', +a[0]);
      case 'g': return this.#resolve('g', { at: +a[0], raw: +a[1] }, 'glance');
      case 'o': return this.#resolve('o', { worn: +a[0], raw: +a[1] }, 'wear');
      case 'p': return this.#resolve('p', true);
      case 'q': return this.#resolve('q', parsePower(a));
      case 'e': return this.#reject('f', new Error(a.join(' ')));
      default: return;   // audio/wake/surface replies: not this CLI's business
    }
  }

  #take(letter) { const e = this.#waiters.get(letter)?.shift(); if (e) clearTimeout(e.timer); return e; }
  #resolve(letter, value, eventName) { if (eventName) this.emit(eventName, value); this.#take(letter)?.resolve(value); }
  #reject(letter, error) { this.#take(letter)?.reject(error); }
  #rejectAll(error) { for (const letter of this.#waiters.keys()) while (this.#waiters.get(letter).length) this.#reject(letter, error); }
}

/** `q vbat vsys vbus mA ctrl1 stat1 linsts cinlimit vichrg udc maxpower` -> object (hex registers). */
export function parsePower(fields) {
  const [vbat, vsys, vbus, ma, ctrl1, stat1, linsts, cinlimit, vichrg, udc, maxpower] = fields;
  const hex = (v) => parseInt(v, 16);
  return { vbat: +vbat, vsys: +vsys, vbus: +vbus, ma: +ma, ctrl1: hex(ctrl1), stat1: hex(stat1),
           linsts: hex(linsts), cinlimit: hex(cinlimit), vichrg: hex(vichrg), udc, maxpower: +maxpower };
}
