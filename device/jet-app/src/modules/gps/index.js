// GPS: consume the NMEA stream the TI daemon routes to its FIFO (docs/gps.md) and keep one
// position snapshot for whoever wants it (the Location screen now, "check my location" later).
// `listen()` opens the FIFO and follows it, reopening while the daemon restarts; every sentence
// is also appended raw to `logFile` (on eMMC, so an outdoor test survives WiFi dropping), and
// fix transitions plus a 30 s satellite summary go to the app log. `stopListening()` keeps the
// last snapshot, so the screen can still say where the fix was.
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { FifoRecords, Responses, basebandStart, fixStart, parseComplete, EVENT } from '../../lib/navl.js';
import { NmeaState } from './nmea.js';

const s = Schema.create;

export class Gps extends EventEmitter {
  static moduleInfo = {
    name: 'gps',
    schema: s()
      .property('fifo', s('string').default('/android-data/gps/recongps').meta('description', 'the NMEA FIFO the GPS daemon writes'))
      .property('socket', s('string').default('/android-data/gps/gps4121').meta('description', 'the GPS daemon\'s command socket: the fix session is started there'))
      .property('logFile', s('string').default('/android-data/gps/nmea.log').meta('description', 'raw NMEA capture while listening, appended (reset past 5 MB); empty = off'))
      .property('retryMs', s('number').default(2000).meta('description', 'reopen interval while the FIFO has no writer'))
      .property('maxHdop', s('number').default(10).meta('description', 'a fix with worse dilution is not treated as a position'))
      .property('minSats', s('number').default(4).meta('description', 'a fix using fewer satellites is not treated as a position'))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  fifo; socket; logFile; retryMs; maxHdop; minSats; logger;

  /** @type {NmeaState} the rolling picture; `state` is its snapshot */ nmea = new NmeaState();
  listening = false;
  #fd = null; #retry = null; #log = null; #records = null; #sock = null; #sockRetry = null;
  #emitAt = 0; #summaryAt = 0; #lastFix = 'none';

  /** The snapshot, plus the quality gate: `good` = a position worth showing or speaking
   * (during signal loss the chip emits wild fixes with hdop ~100 and under 4 satellites). */
  get state() {
    const s = this.nmea.snapshot();
    s.good = s.fix !== 'none' && s.lat != null && s.satsUsed >= (this.minSats ?? 4) && (s.hdop == null || s.hdop <= (this.maxHdop ?? 10));
    return s;
  }

  /** The gated position when it is also fresh (sentences within 5 s), else null. */
  goodFix() { const s = this.state; return s.good && s.at && Date.now() - s.at < 5000 ? s : null; }

  /** The app may have (re)started while GPS was already on: follow the stream again. */
  async start() {
    const running = await new Promise((r) => execFile('pgrep', ['navd'], (e) => r(!e)));
    if (running) this.listen();
  }

  async stop() { this.stopListening(); }

  /** Follow the FIFO (idempotent). The snapshot starts fresh: an old fix is not this walk's. */
  listen() {
    if (this.listening) return;
    this.listening = true;
    this.nmea = new NmeaState();
    this.#records = new FifoRecords();
    if (this.logFile) {   // append, so a restart mid-walk keeps what was captured; reset when large
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        const size = fs.statSync(this.logFile, { throwIfNoEntry: false })?.size ?? 0;
        this.#log = fs.createWriteStream(this.logFile, { flags: size > 5e6 ? 'w' : 'a' });
        this.#log.write(`# listening ${new Date().toISOString()}\n`);
      } catch (error) { this.logger?.warn({ error: error.message }, 'gps: no capture log'); }
    }
    this.logger?.info({ fifo: this.fifo, log: this.logFile || undefined }, 'gps: listening');
    this.#open();
    this.#connect();
  }

  stopListening() {
    if (!this.listening) return;
    this.listening = false;
    clearTimeout(this.#retry); this.#retry = null;
    if (this.#fd != null) { try { fs.closeSync(this.#fd); } catch { /* gone */ } this.#fd = null; }
    this.#log?.end(); this.#log = null;
    clearTimeout(this.#sockRetry); this.#sockRetry = null;
    this.#sock?.destroy(); this.#sock = null;
    this.logger?.info('gps: stopped listening');
  }


  // The daemon only emits NMEA during a fix session, so the module is also the session's
  // client: connect, start the baseband, and on its completion start the one fix session
  // (1 Hz, the HAL's defaults). The daemon tears the session down when the connection dies.
  #connect() {
    if (!this.listening) return;
    const rx = new Responses();
    const sock = (this.#sock = net.connect(this.socket));
    sock.on('connect', () => { this.logger?.info('gps: session socket connected'); sock.write(basebandStart()); });
    sock.on('data', (chunk) => {
      for (const { code, payload } of rx.feed(chunk)) {
        if (code !== EVENT.COMPLETE) continue;
        const c = parseComplete(payload);
        this.logger?.info(c, 'gps: command complete');
        if (c.opcode === 1 && c.result === 0) sock.write(fixStart());
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.#sock === sock && this.listening) { this.#sock = null; this.#sockRetry = setTimeout(() => this.#connect(), this.retryMs); }
    });
  }

  // A FIFO is read with a non-blocking poll, not a stream: with no writer yet a stream sees
  // instant EOF or EAGAIN and stalls, while a poll just tries again (data is 1 Hz; 150 ms).
  #open() {
    if (!this.listening) return;
    try { this.#fd = fs.openSync(this.fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
    catch { this.#retry = setTimeout(() => this.#open(), this.retryMs); return; }
    this.#poll();
  }

  #poll() {
    if (!this.listening || this.#fd == null) return;
    fs.read(this.#fd, Buffer.alloc(4096), 0, 4096, null, (error, n, buf) => {
      if (!this.listening || this.#fd == null) return;
      if (error && error.code !== 'EAGAIN') return this.#reopen();
      if (n > 0) { this.#chunk(buf.subarray(0, n)); return this.#poll(); }   // drain the burst
      if (!error && n === 0) return this.#reopen();   // EOF: no writer (yet, or it restarted)
      this.#retry = setTimeout(() => this.#poll(), 150);
    });
  }

  #reopen() {
    if (this.#fd != null) { try { fs.closeSync(this.#fd); } catch { /* gone */ } this.#fd = null; }
    this.#retry = setTimeout(() => this.#open(), this.retryMs);
  }

  #chunk(chunk) {
    const now = Date.now();
    let changed = false;
    for (const r of this.#records.feed(chunk)) {
      const line = r.text.trim();
      if (!line) continue;
      this.#log?.write(`${new Date(now).toISOString()} ${line}\n`);
      changed = this.nmea.feed(line, now) || changed;
    }
    if (!changed) return;
    const snap = this.nmea.snapshot();
    if (snap.fix !== this.#lastFix) { this.#lastFix = snap.fix; this.logger?.info(snap, 'gps: fix'); }
    if (now - this.#summaryAt > 30000) { this.#summaryAt = now; this.logger?.info({ fix: snap.fix, satsUsed: snap.satsUsed, satsInView: snap.satsInView, hdop: snap.hdop }, 'gps: satellites'); }
    if (now - this.#emitAt > 900) { this.#emitAt = now; this.emit('update', snap); }
  }
}
