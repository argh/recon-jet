// voice: one push-to-talk turn at a time, streamed through host/voice-session.js. No gesture
// is read here: a mode (Assistant) calls `startTurn()` / `cancel()`; `look(jpeg, question)` is
// the vision request the Demo mode makes over the same host.
//
//   idle --startTurn--> listening --A--> thinking --audio--> speaking --done+played--> idle
//
// listening: an earcon plays at once, jetd captures (`V maxSeconds`, energy VAD) and every `a`
//   chunk goes to the host as a binary frame; `A` ends it (`{type:"end"}`); a second press ends
//   the capture early (`v`).
// thinking: partial transcripts are shown as they arrive; `fillerMs` after the final transcript
//   with no audio yet, a cached filler phrase plays ("hmm", rendered once by the host and kept
//   at `fillerPath`), or a soft beep while that cache is being made.
// speaking: audio frames are queued to jetd (`W`) as they arrive, `w` at `done`, idle once jetd
//   reports the clip played. The answer and transcript stay for the mode to show.
// `startTurn()` during thinking/speaking is a barge-in: `Y` flushes jetd's playback, the host gets
// `{type:"cancel"}`, and a new turn starts. Nothing here blocks: the host link is a WebSocket,
// audio goes to jetd as it arrives, the filler file is read and written asynchronously.
//
// Outgoing frames for a turn are queued until the session socket is open, so the capture starts
// at the press even when the host has to be (re)dialled; a dial failure ends the turn.
//
// Debug: `voice.debugPort` (JET_VOICE_DEBUG_PORT) serves POST /talk (start a turn, as the
// Assistant mode's front press would), POST /say {text} (host TTS round trip to the speaker), POST /filler (re-render
// the filler), GET /state.
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { C } from '../ui/style.js';
import { VoiceSession } from './session.js';
import { LISTEN_EARCON, SOFT_BEEP, ERROR_EARCON } from './tones.js';

const s = Schema.create;
const STATES = ['idle', 'listening', 'thinking', 'speaking'];

export class Voice extends EventEmitter {
  static moduleInfo = {
    name: 'voice',
    schema: s()
      .property('enabled', s('boolean').default(true).meta('description', 'voice turns allowed'))
      .property('hostUrl', s('string').default('').meta('description', 'voice session server, ws://host:7779 (device or personal config layer; empty = off)'))
      .property('fillerMs', s('number').default(700).meta('description', 'play the filler when no answer audio has arrived this long after the transcript'))
      .property('fillerText', s('string').default('Hmm, let me think.').meta('description', 'the filler phrase (rendered by the host once, cached on the device)'))
      .property('fillerPath', s('string').default('/android-data/mainline/voice/filler.pcm').meta('description', 'filler cache (48 kHz stereo S16 raw)'))
      .property('maxSeconds', s('number').default(8).meta('description', 'longest capture (jetd V argument)'))
      .property('captureDelayMs', s('number').default(250).meta('description', 'ms between the earcon and opening the mic'))
      .property('debugPort', s('number').default(0).meta('description', 'debug HTTP port (POST /talk, /say, /filler; GET /state); 0 = off'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  enabled; hostUrl; fillerMs; fillerText; fillerPath; maxSeconds; captureDelayMs; debugPort; deviceLink; ui; logger;

  /** @type {'idle'|'listening'|'thinking'|'speaking'} */ state = 'idle';
  turn = 0;           // the current (or last) turn id; events from older turns are ignored
  transcript = '';
  answer = '';
  audioFrames = 0;    // answer audio frames received this turn
  /** The session factory (tests inject a fake). @type {(url: string) => VoiceSession} */
  createSession = (url) => new VoiceSession(url, { logger: this.logger });
  now = () => Date.now();
  /** @type {VoiceSession|null} */ #session = null;
  #outbox = [];          // frames for the current turn waiting for the socket to open
  #fillerTimer = null;
  #fillerPcm = null;
  #makingFiller = null;
  #debug = null;
  #stateT = 0;

  get fillerCached() { return this.#fillerPcm !== null; }
  /** A host session exists and turns are allowed. */
  get configured() { return this.enabled && this.#session !== null; }

  async start() {
    this.#stateT = this.now();
    this.deviceLink.on('captureChunk', (pcm) => this.#onChunk(pcm));
    this.deviceLink.on('captureEnd', (reason) => this.#onCaptureEnd(reason));
    this.deviceLink.on('disconnected', () => { if (this.state !== 'idle') this.#fail('link down'); });
    if (this.hostUrl) { this.#session = this.#wire(this.createSession(this.hostUrl)); this.#session.connect().catch(() => {}); }
    else this.logger?.warn('voice.hostUrl is not set: voice is off');
    fs.readFile(this.fillerPath).then((pcm) => { this.#fillerPcm = pcm; this.logger?.info({ path: this.fillerPath, bytes: pcm.length }, 'filler cached'); }, () => {});
    if (this.debugPort) this.#serveDebug();
  }

  async stop() {
    clearTimeout(this.#fillerTimer);
    if (this.state !== 'idle') { this.#session?.send({ type: 'cancel', turn: this.turn }); if (this.state === 'listening') this.deviceLink.captureStop(); }
    this.#session?.close();
    this.#debug?.close();
  }

  // ---- the mode's calls ----------------------------------------------------------------------
  /**
   * Start a turn (the Assistant mode's front press): ends the capture early while listening, a
   * barge-in while thinking/speaking. Returns false when voice is off.
   */
  startTurn() {
    if (!this.configured) { this.ui.setStrip('voice: not configured', { colour: C.warn, ms: 3000 }); return false; }
    if (this.state === 'listening') { this.logger?.info({ turn: this.turn }, 'press: capture ends early'); this.deviceLink.captureStop(); return true; }
    if (this.state !== 'idle') this.#bargeIn();
    this.#begin();
    return true;
  }

  /** Abort the running turn (nothing is said, nothing more plays); idle stays idle. */
  cancel() {
    if (this.state === 'idle') return false;
    this.logger?.info({ turn: this.turn, state: this.state }, 'cancel');
    clearTimeout(this.#fillerTimer);
    if (this.state === 'listening') this.deviceLink.captureStop();
    else this.deviceLink.send('Y');
    this.#session?.send({ type: 'cancel', turn: this.turn });
    this.#outbox = [];
    this.#setState('idle');
    this.ui.setStrip(null);
    return true;
  }

  /** Forget the last transcript and answer. */
  clear() { this.transcript = ''; this.answer = ''; }

  #begin() {
    const turn = ++this.turn;
    this.transcript = ''; this.answer = ''; this.audioFrames = 0; this.#outbox = [];
    this.#setState('listening');
    this.ui.setStrip('listening', { colour: C.ok });
    this.#play(LISTEN_EARCON());
    // open the mic only after the earcon has played, so jetd's noise-floor window (its first
    // 300 ms of capture) does not measure the beep
    const open = () => {
      if (this.turn !== turn || this.state !== 'listening') return;
      if (!this.deviceLink.captureStart(this.maxSeconds)) this.#fail('link down');
    };
    if (this.captureDelayMs > 0) setTimeout(open, this.captureDelayMs); else open();
    this.#out({ type: 'start', turn });
    this.#session.connect().then(
      () => { if (this.turn === turn) this.#flushOutbox(); },
      (error) => { if (this.turn === turn && this.state !== 'idle') this.#fail(`no host (${error.message})`); });
  }

  #bargeIn() {
    this.logger?.info({ turn: this.turn, state: this.state }, 'barge-in');
    clearTimeout(this.#fillerTimer);
    this.deviceLink.send('Y');
    this.#session.send({ type: 'cancel', turn: this.turn });
    this.#setState('idle');
  }

  // ---- capture -> host ----------------------------------------------------------------------
  #onChunk(pcm) { if (this.state === 'listening') this.#out(pcm); }

  #onCaptureEnd(reason) {
    if (this.state !== 'listening') return;
    this.logger?.info({ turn: this.turn, reason }, 'capture ended');
    if (reason === 'error') return this.#fail('capture error');
    this.#out({ type: 'end' });
    this.#setState('thinking');
    this.ui.setStrip('thinking', { colour: C.title });
  }

  /** Queue a frame for the host; sent at once when the socket is open. */
  #out(frame) {
    if (this.#outbox.length || !this.#session.open) { this.#outbox.push(frame); return; }
    this.#send(frame);
  }
  #send(frame) { return Buffer.isBuffer(frame) ? this.#session.sendAudio(frame) : this.#session.send(frame); }
  #flushOutbox() {
    const frames = this.#outbox; this.#outbox = [];
    if (frames.length) this.logger?.debug({ frames: frames.length }, 'outbox flushed');
    for (const f of frames) this.#send(f);
  }

  // ---- host -> device --------------------------------------------------------------------------
  #wire(session) {
    const current = (m) => m.turn === this.turn && this.state !== 'idle';
    session.on('partial', (m) => { if (current(m) && this.state !== 'speaking') { this.transcript = m.text; this.ui.requestRender(); } });
    session.on('final', (m) => {
      if (!current(m)) return;
      this.transcript = m.text; this.ui.requestRender();
      this.logger?.info({ turn: this.turn, text: m.text }, 'transcript');
      if (this.state === 'thinking' && !this.audioFrames) this.#armFiller();
    });
    session.on('token', (m) => { if (current(m)) { this.answer += m.text; this.ui.requestRender(); } });
    session.on('audio', (m) => {
      if (!current(m) || this.state === 'listening') return;
      clearTimeout(this.#fillerTimer);
      if (this.state === 'thinking') { this.#setState('speaking'); this.ui.setStrip('speaking', { colour: C.ok }); }
      this.audioFrames++;
      this.logger?.debug({ turn: this.turn, bytes: m.bytes, sentence: m.sentence }, 'audio frame');
      this.deviceLink.play(m.pcm);
    });
    session.on('done', (m) => {
      if (!current(m)) return;
      const turn = this.turn;
      this.answer = m.answer ?? this.answer;
      this.logger?.info({ turn, answer: this.answer, audioFrames: this.audioFrames }, 'answer');
      if (this.state !== 'speaking') return this.#finish(this.transcript ? 'no audio' : 'nothing heard');
      this.deviceLink.playEnd().then((r) => { if (this.turn === turn && this.state === 'speaking') this.#finish(`played ${r}`); }, (error) => { if (this.turn === turn && this.state === 'speaking') this.#finish(`play ${error.message}`); });
    });
    session.on('error', (m) => { if (current(m) || m.turn === undefined && this.state !== 'idle') this.#fail(m.message); });
    session.on('close', () => { if (this.state !== 'idle') this.#fail('session closed'); });
    return session;
  }

  #finish(why) {
    clearTimeout(this.#fillerTimer);
    this.logger?.info({ turn: this.turn, why }, 'turn finished');
    this.#setState('idle');
    this.ui.setStrip(why === 'nothing heard' ? 'nothing heard' : null, { colour: C.dim, ms: 2000 });
  }

  #fail(why) {
    clearTimeout(this.#fillerTimer);
    this.logger?.warn({ turn: this.turn, state: this.state, why }, 'turn failed');
    if (this.state === 'listening') this.deviceLink.captureStop();
    this.#outbox = [];
    this.#setState('idle');
    this.ui.setStrip(`voice: ${why}`, { colour: C.bad, ms: 3000 });
    this.#play(ERROR_EARCON());
  }

  #setState(next) {
    if (!STATES.includes(next)) throw new Error(`bad state ${next}`);
    const t = this.now(), from = this.state;
    this.logger?.info({ from, to: next, turn: this.turn, afterMs: t - this.#stateT, at: new Date(t).toISOString() }, 'voice state');
    this.state = next; this.#stateT = t;
    this.emit('state', { from, to: next, turn: this.turn });
    this.ui.requestRender();
  }

  // ---- speaker --------------------------------------------------------------------------------
  /** One clip (earcon, filler): queue it and close it; jetd's `w` reply is logged, not waited for. */
  #play(pcm) {
    if (!this.deviceLink.play(pcm)) return;
    const t0 = this.now();
    this.deviceLink.playEnd().then((r) => this.logger?.info({ bytes: pcm.length, result: r, ms: this.now() - t0 }, 'clip played'), () => {});
  }

  #armFiller() {
    clearTimeout(this.#fillerTimer);
    this.#fillerTimer = setTimeout(() => { if (this.state === 'thinking' && !this.audioFrames) this.#filler(); }, this.fillerMs);
    this.#fillerTimer.unref?.();
  }

  #filler() {
    if (this.#fillerPcm) { this.logger?.info({ turn: this.turn }, 'filler'); return this.#play(this.#fillerPcm); }
    this.logger?.info({ turn: this.turn }, 'filler not cached: beep');
    this.#play(SOFT_BEEP());
    this.makeFiller().catch(() => {});
  }

  /** Render `fillerText` through a separate host session and cache it at `fillerPath`. */
  makeFiller() {
    if (this.#makingFiller) return this.#makingFiller;
    const t0 = this.now();
    this.#makingFiller = (async () => {
      const pcm = await this.#sayRemote(this.fillerText);
      await fs.mkdir(path.dirname(this.fillerPath), { recursive: true });
      await fs.writeFile(this.fillerPath, pcm);
      this.#fillerPcm = pcm;
      this.logger?.info({ path: this.fillerPath, bytes: pcm.length, ms: this.now() - t0 }, 'filler rendered');
      return pcm;
    })().catch((error) => { this.logger?.warn({ error: error.message }, 'filler failed'); throw error; })
      .finally(() => { this.#makingFiller = null; });
    return this.#makingFiller;
  }

  /** TTS on the host over its own connection (a turn may be running on the main one). */
  async #sayRemote(text) {
    const session = this.createSession(this.hostUrl);
    try { await session.connect(); return await session.say(text); }
    finally { session.close(); }
  }

  /**
   * Ask the host's vision model about a JPEG, over its own connection; `onToken` streams the
   * answer, the promise resolves with the whole of it.
   * @param {Buffer} jpg @param {string} question @param {{onToken?: (text: string) => void}} [options]
   */
  async look(jpg, question, { onToken } = {}) {
    if (!this.hostUrl) throw new Error('voice.hostUrl is not set');
    const session = this.createSession(this.hostUrl);
    try { await session.connect(); return await session.look(jpg.toString('base64'), question, { onToken }); }
    finally { session.close(); }
  }

  /** Debug: speak `text` through the host and the Jet's speaker; resolves with the PCM size. */
  async say(text) {
    const t0 = this.now();
    const pcm = await this.#sayRemote(text);
    const synthMs = this.now() - t0;
    this.#play(pcm);
    return { bytes: pcm.length, seconds: +(pcm.length / 192000).toFixed(2), synthMs };
  }

  // ---- debug HTTP -------------------------------------------------------------------------------
  #serveDebug() {
    this.#debug = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj) + '\n'); };
        const run = (p) => p.then((r) => reply(200, r), (e) => reply(500, { error: e.message }));
        try {
          if (req.method === 'GET' && req.url === '/state') return reply(200, { state: this.state, turn: this.turn, transcript: this.transcript, answer: this.answer, fillerCached: this.fillerCached, session: this.#session?.open ?? false });
          if (req.method === 'POST' && req.url === '/talk') return reply(200, { started: this.startTurn(), turn: this.turn });
          if (req.method === 'POST' && req.url === '/cancel') return reply(200, { cancelled: this.cancel() });
          if (req.method === 'POST' && req.url === '/say') return run(this.say(String((body ? JSON.parse(body) : {}).text ?? 'hello')));
          if (req.method === 'POST' && req.url === '/filler') return run(this.makeFiller().then((pcm) => ({ bytes: pcm.length })));
          reply(404, { error: 'no such route' });
        } catch (e) { reply(400, { error: e.message }); }
      });
    }).listen(this.debugPort, '0.0.0.0', () => this.logger?.info({ port: this.debugPort }, 'voice debug http'));
  }
}
