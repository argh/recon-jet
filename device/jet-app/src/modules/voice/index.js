// voice: one push-to-talk turn at a time, run on the device against the `llm` module (the
// inference server over WiFi; see `session.js`). No gesture is read here: a mode (Assistant)
// calls `startTurn()` / `cancel()`; `look(jpeg, question)` is the vision request the Demo mode
// makes.
//
//   idle --startTurn--> listening --A--> thinking --audio--> speaking --done+played--> idle
//
// listening: an earcon plays at once, jetd captures (`V maxSeconds`, energy VAD) and every `a`
//   chunk goes to the session, which transcribes the whole buffer every `partialMs`; `A` ends it
//   (`session.end()`); a second press ends the capture early (`v`).
// thinking: partial transcripts are shown as they arrive; `fillerMs` after the final transcript
//   with no audio yet, a cached filler phrase plays ("hmm", rendered once by the TTS and kept
//   at `fillerPath`), or a soft beep while that cache is being made.
// speaking: audio frames are queued to jetd (`W`) as they arrive, `w` at `done`, idle once jetd
//   reports the clip played. The answer and transcript stay for the mode to show.
// `startTurn()` during thinking/speaking is a barge-in: `Y` flushes jetd's playback, the session
// aborts its requests, and a new turn starts. Nothing here blocks: audio goes to jetd as it
// arrives, the filler file is read and written asynchronously.
//
// Debug: `voice.debugPort` (JET_VOICE_DEBUG_PORT) serves POST /talk (start a turn, as the
// Assistant mode's front press would), POST /cancel, POST /say {text} (TTS round trip to the
// speaker), POST /filler (re-render the filler), POST /look {question?} (a camera snapshot
// through the vision model, as the Demo mode's front press), GET /state.
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { Schema } from '@versionzero/module-manager';
import { C } from '../ui/style.js';
import { uyvyToRgba } from '../../lib/uyvy.js';
import { VoiceSession, SYSTEM_PROMPT } from './session.js';
import { LISTEN_EARCON, SOFT_BEEP, ERROR_EARCON } from './tones.js';

const s = Schema.create;
const STATES = ['idle', 'listening', 'thinking', 'speaking'];

export class Voice extends EventEmitter {
  static moduleInfo = {
    name: 'voice',
    schema: s()
      .property('enabled', s('boolean').default(true).meta('description', 'voice turns allowed'))
      .property('systemPrompt', s('string').default(SYSTEM_PROMPT).meta('description', 'the chat model\'s system prompt for a turn'))
      .property('partialMs', s('number').default(1000).meta('description', 'partial transcript interval while listening'))
      .property('fillerMs', s('number').default(700).meta('description', 'play the filler when no answer audio has arrived this long after the transcript'))
      .property('fillerText', s('string').default('Hmm, let me think.').meta('description', 'the filler phrase (rendered by the TTS once, cached on the device)'))
      .property('fillerPath', s('string').default('/android-data/mainline/voice/filler.pcm').meta('description', 'filler cache (48 kHz stereo S16 raw)'))
      .property('maxSeconds', s('number').default(8).meta('description', 'longest capture (jetd V argument)'))
      .property('captureDelayMs', s('number').default(250).meta('description', 'ms between the earcon and opening the mic'))
      .property('debugPort', s('number').default(0).meta('description', 'debug HTTP port (POST /talk, /cancel, /say, /filler, /look; GET /state); 0 = off'))
      .property('llm', s('Llm').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  enabled; systemPrompt; partialMs; fillerMs; fillerText; fillerPath; maxSeconds; captureDelayMs; debugPort; llm; deviceLink; ui; logger;

  /** @type {'idle'|'listening'|'thinking'|'speaking'} */ state = 'idle';
  turn = 0;           // the current (or last) turn id; events from older turns are ignored
  transcript = '';
  answer = '';
  audioFrames = 0;    // answer audio frames received this turn
  /** The session factory (tests inject a fake). @type {(llm: object) => VoiceSession} */
  createSession = (llm) => new VoiceSession(llm, { partialMs: this.partialMs, systemPrompt: this.systemPrompt, logger: this.logger });
  now = () => Date.now();
  /** @type {VoiceSession|null} */ #session = null;
  #fillerTimer = null;
  #fillerPcm = null;
  #makingFiller = null;
  #debug = null;
  #stateT = 0;
  #clips = 0;         // clips queued with #play that jetd has not reported played yet

  get fillerCached() { return this.#fillerPcm !== null; }
  /** An inference server is configured and turns are allowed. */
  get configured() { return this.enabled && Boolean(this.llm?.configured); }

  async start() {
    this.#stateT = this.now();
    this.deviceLink.on('captureChunk', (pcm) => this.#onChunk(pcm));
    this.deviceLink.on('captureEnd', (reason) => this.#onCaptureEnd(reason));
    this.deviceLink.on('disconnected', () => { if (this.state !== 'idle') this.#fail('link down'); });
    this.#session = this.#wire(this.createSession(this.llm));
    if (!this.llm?.configured) this.logger?.warn('llm.base is not set: voice is off');
    fs.readFile(this.fillerPath).then((pcm) => { this.#fillerPcm = pcm; this.logger?.info({ path: this.fillerPath, bytes: pcm.length }, 'filler cached'); }, () => {});
    if (this.debugPort) this.#serveDebug();
  }

  async stop() {
    clearTimeout(this.#fillerTimer);
    if (this.state !== 'idle') { this.#session.cancel(); if (this.state === 'listening') this.deviceLink.captureStop(); }
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
    // a clip still playing (a debug `say`, the filler) is flushed first, as the barge-in does:
    // jetd's aplay must be gone before `V` spawns arecord, or the two block each other at the
    // clip's end
    else if (this.#clips > 0) { this.logger?.info({ clips: this.#clips }, 'flushing playback before capture'); this.deviceLink.send('Y'); }
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
    this.#session.cancel();
    this.#setState('idle');
    this.ui.setStrip(null);
    return true;
  }

  /** Forget the last transcript and answer. */
  clear() { this.transcript = ''; this.answer = ''; }

  #begin() {
    const turn = ++this.turn;
    this.transcript = ''; this.answer = ''; this.audioFrames = 0;
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
    this.#session.start(turn);
  }

  #bargeIn() {
    this.logger?.info({ turn: this.turn, state: this.state }, 'barge-in');
    clearTimeout(this.#fillerTimer);
    this.deviceLink.send('Y');
    this.#session.cancel();
    this.#setState('idle');
  }

  // ---- capture -> session ------------------------------------------------------------------
  #onChunk(pcm) { if (this.state === 'listening') this.#session.audio(pcm); }

  #onCaptureEnd(reason) {
    if (this.state !== 'listening') return;
    this.logger?.info({ turn: this.turn, reason }, 'capture ended');
    if (reason === 'error') return this.#fail('capture error');
    this.#setState('thinking');
    this.ui.setStrip('thinking', { colour: C.title });
    this.#session.end();
  }

  // ---- session -> device --------------------------------------------------------------------
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
    session.on('error', (m) => { if (current(m)) this.#fail(m.message); });
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
    this.#session.cancel();
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
    this.#clips++;
    this.deviceLink.playEnd().then((r) => this.logger?.info({ bytes: pcm.length, result: r, ms: this.now() - t0 }, 'clip played'), () => {}).finally(() => { this.#clips--; });
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

  /** Render `fillerText` through the TTS and cache it at `fillerPath`. */
  makeFiller() {
    if (this.#makingFiller) return this.#makingFiller;
    const t0 = this.now();
    this.#makingFiller = (async () => {
      const pcm = await this.#session.say(this.fillerText);
      await fs.mkdir(path.dirname(this.fillerPath), { recursive: true });
      await fs.writeFile(this.fillerPath, pcm);
      this.#fillerPcm = pcm;
      this.logger?.info({ path: this.fillerPath, bytes: pcm.length, ms: this.now() - t0 }, 'filler rendered');
      return pcm;
    })().catch((error) => { this.logger?.warn({ error: error.message }, 'filler failed'); throw error; })
      .finally(() => { this.#makingFiller = null; });
    return this.#makingFiller;
  }

  /**
   * Ask the vision model about a JPEG (independent of a running turn); `onToken` streams the
   * answer, the promise resolves with the whole of it.
   * @param {Buffer} jpg @param {string} question @param {{onToken?: (text: string) => void}} [options]
   */
  look(jpg, question, { onToken } = {}) {
    if (!this.llm?.configured) return Promise.reject(new Error('llm.base is not set'));
    return this.#session.look(jpg, question, { onToken });
  }

  /** Debug: speak `text` through the TTS and the Jet's speaker; resolves with the PCM size. */
  async say(text) {
    if (!this.llm?.configured) throw new Error('llm.base is not set');
    const t0 = this.now();
    const pcm = await this.#session.say(text);
    const synthMs = this.now() - t0;
    this.#play(pcm);
    return { bytes: pcm.length, seconds: +(pcm.length / 192000).toFixed(2), synthMs };
  }

  /** Debug: a 640x480 snapshot through jetd, shrunk to a 320x240 JPEG, through `look`. */
  async #snapshotLook(question) {
    const t0 = this.now();
    const frame = await this.deviceLink.snapshot({ w: 640, h: 480 });
    const { data: jpg } = jpeg.encode(uyvyToRgba(frame.data, frame.w, frame.h, { scale: 2 }), 60);
    const snapshotMs = this.now() - t0, t1 = this.now();
    let tokens = 0;
    const answer = await this.look(jpg, question, { onToken: () => tokens++ });
    return { answer, tokens, jpegBytes: jpg.length, snapshotMs, lookMs: this.now() - t1 };
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
          const json = body ? JSON.parse(body) : {};
          if (req.method === 'GET' && req.url === '/state') return reply(200, { state: this.state, turn: this.turn, transcript: this.transcript, answer: this.answer, fillerCached: this.fillerCached, configured: this.configured, llm: this.llm?.models ?? null });
          if (req.method === 'POST' && req.url === '/talk') return reply(200, { started: this.startTurn(), turn: this.turn });
          if (req.method === 'POST' && req.url === '/cancel') return reply(200, { cancelled: this.cancel() });
          if (req.method === 'POST' && req.url === '/say') return run(this.say(String(json.text ?? 'hello')));
          if (req.method === 'POST' && req.url === '/filler') return run(this.makeFiller().then((pcm) => ({ bytes: pcm.length })));
          if (req.method === 'POST' && req.url === '/look') return run(this.#snapshotLook(String(json.question ?? 'Describe what is in front of me in one short sentence.')));
          reply(404, { error: 'no such route' });
        } catch (e) { reply(400, { error: e.message }); }
      });
    }).listen(this.debugPort, '0.0.0.0', () => this.logger?.info({ port: this.debugPort }, 'voice debug http'));
  }
}
