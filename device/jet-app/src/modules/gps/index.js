// GPS: the receiver and the position, as one model. GPS lives in the same combo chip as
// Bluetooth and rides its UART, so `enable()` (scripts/gps.sh: chroot mounts, hci0 up, TI's navd
// from the stock partition - docs/gps.md) powers that radio too, and `disable()` powers it back
// down unless the radio module says Bluetooth belongs on; while the daemon runs, WiFi rx is slow
// (coex untuned). The NMEA stream the daemon routes to its FIFO is kept as one position snapshot
// for whoever wants it (the Location and Status screens, "check my location"). `listen()` opens
// the FIFO and follows it, reopening while the daemon restarts; every sentence is also appended
// raw to `logFile` (on eMMC, so an outdoor test survives WiFi dropping), and fix transitions
// plus a 30 s satellite summary go to the app log. `stopListening()` keeps the last snapshot,
// so a screen can still say where the fix was. No boot persistence yet: GPS starts off.
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { FifoRecords, Responses, basebandStart, fixStart, fixStop, basebandStop, parseComplete, EVENT } from '../../lib/navl.js';
import { NmeaState } from './nmea.js';
import { Radio } from '../radio/index.js';
import { patchLayer } from '../../lib/config.js';

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
      .property('localTime', s('boolean').default(false).meta('description', 'derive the timezone from the fix; off = clocks show GMT (Location screen toggles this)'))
      .property('tz', s('string').default('').meta('description', 'last derived IANA zone, persisted so local time survives a reboot without a fix'))
      .property('deviceConfig', s('string').default('/android-data/mainline/jet-app.json').meta('description', 'where localTime/tz persist'))
      .property('localtimeFile', s('string').default('/etc/localtime').meta('advanced').meta('description', 'symlink kept pointing at the zone for the shell and friends'))
      .property('script', s('string').default('/opt/jet-app/scripts/gps.sh').meta('description', 'the GPS bring-up script (start|stop)'))
      .property('fixTimeoutS', s('number').default(180).meta('description', 'how long a fix pursuit hunts before giving up'))
      .property('radio', s('Radio').lax().meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
    register: [Radio],
  };
  fifo; socket; logFile; retryMs; maxHdop; minSats; localTime; tz; deviceConfig; localtimeFile; script; fixTimeoutS; radio; logger;

  /** @type {NmeaState} the rolling picture; `state` is its snapshot */ nmea = new NmeaState();
  /** @type {boolean|null} the daemon seen running (null until the first probe) */ running = null;
  listening = false;
  #fd = null; #retry = null; #log = null; #records = null; #sock = null; #sockRetry = null;
  #emitAt = 0; #summaryAt = 0; #lastFix = 'none'; #tzAt = 0;

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
    this.#applyTz();
    await this.probe();
  }

  // ---- the receiver -----------------------------------------------------------------------------
  /** Is the GPS daemon up? (pgrep: exit 1 just means no.) The listener follows the answer. */
  async probe() {
    this.running = await run('pgrep', ['navd']).then(() => true, () => false);
    if (this.running && !this.listening) this.listen();
    if (this.running === false && this.listening) this.stopListening();
    return this.running;
  }

  /** Bring the daemon (and the shared radio) up and follow the stream. */
  async enable() {
    await run('sh', [this.script, 'start'], 30000);
    this.running = true;
    this.listen();
  }

  /**
   * Stop the receiver: end the fix session at the chip first (killing the daemon leaves it
   * streaming, which keeps the shared radio busy and strangles WiFi), then the daemon, then the
   * radio goes down unless Bluetooth is set to be on. `keepRadio` leaves the radio to the caller
   * (the radio module stops GPS this way before powering itself off).
   */
  async disable({ keepRadio = false } = {}) {
    await this.stopSession();
    this.stopListening();
    await run('sh', [this.script, 'stop'], 10000);
    this.running = false;
    if (!keepRadio && !(await this.radio?.wantedAtBoot?.())) await this.radio?.powerDown?.();
  }

  /** GPS on or off, live ("heya jet, enable gps" and the Location screen land here). */
  async set(on) {
    try {
      if (on) await this.enable(); else await this.disable();
      this.logger?.info({ on }, 'gps');
    } catch (error) {
      this.logger?.warn({ error: error.message }, 'gps toggle failed');
      await this.probe().catch(() => {});
      throw error;
    }
  }

  // ---- the fix pursuit ------------------------------------------------------------------------
  // "check my location" as data: idle -> acquiring (satsUsed as progress) -> fixed | timeout,
  // emitted as 'pursuit' events. The pursuit owns its own timeout and knows nothing of voice or
  // UI; the screens watch it to draw, the voice layer watches it to speak (modes/system).

  /** @type {{state: 'idle'|'acquiring'|'fixed'|'timeout', satsUsed?: number, fix?: object}} */
  pursuit = { state: 'idle' };
  #pursuitTimer = null;
  #pursuitWatch = null;

  /**
   * Hunt for a gated fix: receiver up if it is off, then `acquiring` until `goodFix()` lands
   * (`fixed`) or `fixTimeoutS` passes (`timeout`, the receiver stays on). A fresh good fix
   * resolves to `fixed` at once. One hunt at a time: resolves false while one is running.
   * Rejects (back to `idle`) when the receiver will not come up.
   */
  startPursuit() {
    if (this.pursuit.state === 'acquiring') return Promise.resolve(false);
    const fix = this.goodFix();
    if (fix) { this.#pursuit({ state: 'fixed', fix }); return Promise.resolve(true); }
    this.#pursuit({ state: 'acquiring', satsUsed: 0 });
    this.#pursuitWatch = () => {
      const got = this.goodFix();
      if (got) return this.#endPursuit({ state: 'fixed', fix: got });
      const satsUsed = this.state.satsUsed ?? 0;
      if (satsUsed !== this.pursuit.satsUsed) this.#pursuit({ state: 'acquiring', satsUsed });
    };
    this.on('update', this.#pursuitWatch);
    this.#pursuitTimer = setTimeout(() => this.#endPursuit({ state: 'timeout' }), this.fixTimeoutS * 1000);
    this.#pursuitTimer.unref?.();
    return (async () => {
      if (!(await this.probe())) await this.enable();
      return true;
    })().catch((error) => { this.#endPursuit({ state: 'idle' }); throw error; });
  }

  /** Call off a running hunt (the receiver is left as it is). */
  cancelPursuit() { if (this.pursuit.state === 'acquiring') this.#endPursuit({ state: 'idle' }); }

  #endPursuit(next) {
    clearTimeout(this.#pursuitTimer); this.#pursuitTimer = null;
    if (this.#pursuitWatch) { this.off('update', this.#pursuitWatch); this.#pursuitWatch = null; }
    this.#pursuit(next);
  }
  #pursuit(next) { this.pursuit = next; this.emit('pursuit', next); }

  // ---- local time: the system clock stays UTC; only TZ (and /etc/localtime) localise ---------
  /** The Location screen's toggle. On with a fresh fix derives the zone now; otherwise the next
   *  good fix does. Off returns every clock to GMT (the persisted zone is kept for next time). */
  async setLocalTime(on) {
    this.localTime = on;
    this.#applyTz();
    await patchLayer(this.deviceConfig, { gps: { localTime: on } }).catch((error) => this.logger?.warn({ error: error.message }, 'localTime not persisted'));
    const fix = this.goodFix();
    if (on && fix) await this.#zoneFromFix(fix);
    this.emit('update', this.state);
  }

  async #zoneFromFix(fix) {
    let zone;
    try { zone = (await import('@photostructure/tz-lookup')).default(fix.lat, fix.lon); }
    catch (error) { this.logger?.warn({ error: error.message }, 'tz lookup failed'); return; }
    if (zone === this.tz) return;
    this.tz = zone;
    this.#applyTz();
    this.logger?.info({ zone, lat: fix.lat, lon: fix.lon }, 'timezone from fix');
    await patchLayer(this.deviceConfig, { gps: { tz: zone } }).catch((error) => this.logger?.warn({ error: error.message }, 'tz not persisted'));
    this.emit('update', this.state);
  }

  #applyTz() {
    const zone = this.localTime && this.tz ? this.tz : 'UTC';
    process.env.TZ = zone;                       // Node re-reads TZ: every toTimeString localises
    try {                                        // the shell and anything else reading /etc/localtime
      const target = `/usr/share/zoneinfo/${zone}`;
      if (fs.existsSync(target) && fs.existsSync(path.dirname(this.localtimeFile))) {
        try { fs.unlinkSync(this.localtimeFile); } catch {}
        fs.symlinkSync(target, this.localtimeFile);
      }
    } catch (error) { this.logger?.warn({ error: error.message }, 'localtime symlink'); }
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

  /**
   * Tell the chip to end the fix session, over the open command socket, and wait for it to go
   * quiet. The chip streams reports on its own once a fix starts; killing the daemon does not
   * stop it, and a chip left fixing keeps the shared radio busy and strangles WiFi. Call this
   * before the daemon is stopped. Safe to call with no socket (resolves at once).
   */
  async stopSession() {
    if (!this.#sock || this.#sock.destroyed) return;
    try {
      this.#sock.write(fixStop());
      this.#sock.write(basebandStop());
      await new Promise((r) => setTimeout(r, 600));
    } catch { /* the socket went away: the daemon is already gone */ }
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
    if (this.localTime && snap.good && now - (this.#tzAt ?? 0) > 60000) {   // once a minute while moving
      this.#tzAt = now;
      this.#zoneFromFix(snap).catch(() => {});
    }
  }
}

const run = (cmd, args, timeout = 5000) => new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
