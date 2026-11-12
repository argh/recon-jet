// device-link: TCP client (or acceptor) for jetd's line protocol. Emits jet->host events and
// exposes host->jet commands. Reconnects forever; writes are dropped while disconnected.
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { Schema } from '@versionzero/module-manager';
import { ProtocolParser, parsePower } from './parser.js';

const s = Schema.create;

export class DeviceLink extends EventEmitter {
  static moduleInfo = {
    name: 'device-link',
    schema: s()
      .property('host', s('string').default('127.0.0.1').meta('description', 'jetd address to dial'))
      .property('port', s('number').default(7777).meta('description', 'jetd port (dial target, or our listen port)'))
      .property('listen', s('boolean').default(false).meta('description', 'accept jetd dialling us instead of dialling it'))
      .property('bind', s('string').default('0.0.0.0').meta('description', 'listen address when listen=true'))
      .property('reconnectMs', s('number').default(2000).meta('description', 'redial interval'))
      .property('dialTimeoutMs', s('number').default(5000).meta('description', 'give up a dial attempt after this long'))
      .property('replyTimeoutMs', s('number').default(5000).meta('description', 'timeout for request/reply commands'))
      .property('silentMs', s('number').default(15000).meta('description', 'ping after this long without a received byte; no reply tears the link down'))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  host; port; listen; bind; reconnectMs; dialTimeoutMs; replyTimeoutMs; silentMs; logger;

  /** @type {net.Socket|null} */ #sock = null;
  #server = null;
  #timer = null;
  #stopped = false;
  #waiters = new Map();   // reply letter -> [{resolve, reject, timer}]
  hello = null;           // { w, h, cols, rows }
  mode = null;            // last `m`, or 'remote' assumed after a hello
  get connected() { return this.#sock !== null; }

  async start() {
    this.#stopped = false;
    if (this.listen) {
      this.#server = net.createServer((sock) => this.#attach(sock)).listen(this.port, this.bind);
      this.logger?.info({ port: this.port, bind: this.bind }, 'listening for jetd');
    } else this.#dial();
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#server?.close();
    this.#sock?.end();   // let queued commands (E 0, z) reach jetd; 'close' follows the FIN
  }

  #dial() {
    if (this.#stopped || this.#sock) return;
    const sock = net.connect({ host: this.host, port: this.port });
    sock.setTimeout(this.dialTimeoutMs, () => sock.destroy(new Error('dial timeout')));   // a down loopback swallows SYNs silently
    sock.once('connect', () => { sock.setTimeout(0); this.#attach(sock); });
    sock.once('error', (error) => { this.logger?.debug({ error: error.message }, 'dial failed'); });
    sock.once('close', () => { if (!this.#sock) this.#timer = setTimeout(() => this.#dial(), this.reconnectMs); });
  }

  #attach(sock) {
    if (this.#sock) this.#sock.destroy();
    this.#sock = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10000);
    const parser = new ProtocolParser();
    // Proof-of-life watchdog: a dead link does not always close (a half-open USB peer, or jetd
    // dropping this hub while a forked helper's inherited fd kept the socket established — the
    // app once ran for minutes "connected" with every button dead). Any received byte is proof;
    // after silentMs without one a ping must bring bytes, or the socket is torn down to redial.
    let lastRecv = Date.now(), probed = false;
    const watchdog = setInterval(() => {
      const idleMs = Date.now() - lastRecv;
      if (idleMs < this.silentMs) { probed = false; return; }
      if (!probed) { probed = true; this.ping().catch(() => {}); return; }
      if (idleMs >= this.silentMs + this.replyTimeoutMs) { this.logger?.warn({ idleMs }, 'link silent, tearing it down'); sock.destroy(); }
    }, 5000);
    watchdog.unref?.();
    sock.on('data', (chunk) => { lastRecv = Date.now(); for (const m of parser.feed(chunk)) this.#dispatch(m); });
    sock.on('error', (error) => this.logger?.warn({ error: error.message }, 'link error'));
    sock.on('close', () => {
      clearInterval(watchdog);
      if (this.#sock !== sock) return;
      this.#sock = null; this.hello = null; this.mode = null;
      this.#rejectAll(new Error('disconnected'));
      this.logger?.info('jetd disconnected');
      this.emit('disconnected');
      if (!this.listen && !this.#stopped) this.#timer = setTimeout(() => this.#dial(), this.reconnectMs);
    });
    this.logger?.info({ peer: `${sock.remoteAddress}:${sock.remotePort}` }, 'jetd connected');
    this.emit('connected');
  }

  #dispatch(m) {
    if (m.type === 'frame') return this.#resolve('f', m, 'frame');
    if (m.type === 'audio') return this.emit('captureChunk', m.data);
    const [t, ...a] = m.line.split(' ');
    switch (t) {
      case 'h': this.hello = { w: +a[0], h: +a[1], cols: +a[2], rows: +a[3] }; this.mode ??= 'remote'; return this.emit('hello', this.hello);
      case 'k': return this.emit('key', { code: +a[0], value: +a[1] });
      case 'r': return this.emit('rel', { dx: +a[0], dy: +a[1] });
      case 'm': this.mode = a[0]; return this.emit('mode', a[0]);
      case 'j': return this.emit('log', m.line.slice(2));
      case 'J': return this.#resolve('J', +a[0], 'logBacklog');
      case 'U': return this.#resolve('U', { on: +a[0], off: +a[1], deg: +a[2], still: +a[3] }, 'calibration');
      case 'g': return this.#resolve('g', { worn: +a[0], raw: +a[1] }, 'glance');
      case 'o': return this.#resolve('o', { worn: +a[0], raw: +a[1] }, 'worn');
      case 'd': return this.emit('wake', { avg: +a[0], max: +a[1] });
      case 'x': return this.#resolve('x', a.join(' '), 'listen');
      case 'n': return this.emit('view', { degrees: +a[0] });
      case 'A': return this.emit('captureEnd', a[0]);
      case 'w': return this.#resolve('w', a[0], 'playDone');
      case 'p': return this.#resolve('p', true, 'pong');
      case 'q': return this.#resolve('q', parsePower(a), 'power');
      case 'E': return this.#resolve('E', { w: +a[0], h: +a[1], bpp: +a[2], stride: +a[3] }, 'surface');
      case 'Z': return this.#resolve('Z', { w: +a[0], h: +a[1] });
      case 'e': { const msg = a.join(' '); this.emit('jetError', msg); return this.#reject(msg.startsWith('viewfinder') ? 'Z' : 'f', new Error(msg)); }
      default: return this.emit('unknown', m.line);
    }
  }

  // ---- host -> jet ------------------------------------------------------------------
  /** Write raw lines (no trailing newline). Returns false when not connected. */
  send(...lines) {
    if (!this.#sock) return false;
    this.#sock.write(lines.join('\n') + '\n');
    return true;
  }
  clear() { return this.send('C'); }
  flush() { return this.send('F'); }
  colour(r, g, b) { return this.send(`R ${r} ${g} ${b}`); }
  text(row, text, { centre = false } = {}) { return this.send(`${centre ? 'A' : 'T'} ${row} ${text}`); }
  rect(x, y, w, h, [r, g, b]) { return this.send(`B ${x} ${y} ${w} ${h} ${r} ${g} ${b}`); }
  backlight(level) { return this.send(`L ${level}`); }
  /** Switch jetd's mode. `mode` flips optimistically: the ui's render gate reads it, and a frame
   *  flushed during the ACK round-trip would land on jetd's screen (the shell-entry race: one
   *  placeholder flush overwrote the console). jetd's `m` reply confirms or corrects it. */
  setMode(name) { const ok = this.send(`M ${name}`); if (ok) this.mode = name; return ok; }
  captureStart(maxSeconds) { return this.send(maxSeconds ? `V ${maxSeconds}` : 'V'); }
  captureStop() { return this.send('v'); }
  /** Wake word listening on (with the model's cutoff and window) or off; resolves with jetd's `x` state ("on", "off", "error ..."). */
  wakeListen(on, cutoff = 0.97, window = 5) { return this.#request('x', on ? `D 1 ${cutoff} ${window}` : 'D 0'); }
  /** Queue 48 kHz stereo S16 PCM; `playEnd()` closes the clip and resolves when played. */
  play(pcm) { return this.#sock ? this.#sock.write(Buffer.concat([Buffer.from(`W ${pcm.length}\n`), pcm])) : false; }
  playEnd() { return this.#request('w', 'w', 15000); }
  ping() { return this.#request('p', 'P'); }
  power() { return this.#request('q', 'Q'); }
  glance() { return this.#request('g', 'G'); }
  worn() { return this.#request('o', 'O'); }
  /** Ask for the last `n` kernel-log lines again (the whole ring by default) as `j` lines; resolves with the count. */
  logBacklog(n) { return this.#request('J', n ? `J ${n}` : 'J'); }
  /** Make jetd re-read the calibration files; resolves with `{on, off, deg, still}`. */
  reloadCalibration() { return this.#request('U', 'U'); }
  snapshot({ w = 640, h = 480, skip = 6 } = {}) { return this.#request('f', `S ${w} ${h} ${skip}`, 15000); }
  /** Take (or return) the panel pixels; resolves with `{w, h, bpp, stride}` (see docs/jetd.md). */
  surface(on) { return this.#request('E', `E ${on ? 1 : 0}`); }
  /** External surface: push one framebuffer rectangle to the panel. */
  flushRect(x, y, w, h) { return this.send(`F ${x} ${y} ${w} ${h}`); }
  /** Live camera into a panel rectangle; resolves with the source size `{w, h}`. */
  viewfinder(x, y, w, h, fps = 10) { return this.#request('Z', `Z ${x} ${y} ${w} ${h} ${fps}`).then((r) => { this.streaming = true; return r; }); }
  viewfinderStop() { this.streaming = false; return this.send('z'); }
  /** The camera is streaming (a viewfinder is up): a snapshot taps that stream instead of starting the sensor. Cleared on `z`; a link that drops and returns is re-armed by whoever owns the viewfinder. */
  streaming = false;
  /** Resolves once connected (immediately if already). */
  async ready(signal) { if (!this.#sock) await once(this, 'connected', { signal }); }

  // ---- request/reply plumbing --------------------------------------------------------
  #request(replyLetter, line, timeoutMs = this.replyTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.send(line)) return reject(new Error('not connected'));
      const list = this.#waiters.get(replyLetter) ?? this.#waiters.set(replyLetter, []).get(replyLetter);
      const entry = { resolve, reject, timer: setTimeout(() => { list.splice(list.indexOf(entry), 1); reject(new Error(`timeout waiting for '${replyLetter}'`)); }, timeoutMs) };
      list.push(entry);
    });
  }
  #take(letter) { const e = this.#waiters.get(letter)?.shift(); if (e) clearTimeout(e.timer); return e; }
  #resolve(letter, value, eventName) {
    if (eventName) this.emit(eventName, value);
    this.#take(letter)?.resolve(value);
  }
  #reject(letter, error) { this.#take(letter)?.reject(error); }
  #rejectAll(error) { for (const letter of this.#waiters.keys()) while (this.#waiters.get(letter).length) this.#reject(letter, error); }
}
