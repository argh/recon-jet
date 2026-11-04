// voice: one push-to-talk turn at a time, run on the device against the `llm` module (the
// inference server over WiFi; see `session.js`). No gesture is read here: a mode (Assistant)
// calls `startTurn()` / `cancel()`; `look(jpeg, question)` is the vision request the Demo mode
// makes.
//
//   idle --startTurn--> listening --A--> thinking --audio--> speaking --done+played--> idle
//
// listening: the ack cue plays at once, jetd captures (`V maxSeconds`, energy VAD) and every `a`
//   chunk goes to the session, which transcribes the whole buffer every `partialMs`; `A` ends it
//   (`session.end()`); a second press ends the capture early (`v`).
// thinking: partial transcripts are shown as they arrive; `fillerMs` after the final transcript
//   with no audio yet, a cached "wait" phrase plays, or a soft beep while the cache is being made.
//   A spoken command (`route()` matched an action) is answered the same way, from the phrase
//   bank (`phrases.js`: ack / wait / error sets, rendered once in the current voice and kept
//   under `phraseDir`): an ack at once, a wait phrase every `actionWaitMs` while it runs, an
//   error phrase if it fails. A button-started action says nothing; only spoken ones are answered.
// speaking: audio frames are queued to jetd (`W`) as they arrive, `w` at `done`, idle once jetd
//   reports the clip played. The answer and transcript stay for the mode to show.
// `startTurn()` during thinking/speaking is a barge-in: `Y` flushes jetd's playback, the session
// aborts its requests, and a new turn starts. Nothing here blocks: audio goes to jetd as it
// arrives, the filler file is read and written asynchronously.
//
// Debug: `voice.debugPort` (JET_VOICE_DEBUG_PORT) serves POST /talk (start a turn, as the
// Assistant mode's front press would), POST /cancel, POST /say {text} (TTS round trip to the
// speaker), POST /phrases (render the missing phrases), POST /action {text} (route a
// transcript to the command registry, no mic involved), POST /look {question?} (a camera snapshot
// through the vision model, as the Demo mode's front press), GET /state, GET /screen.png?scale=N (the
// framebuffer as a PNG: what the panel shows).
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import { screenshot } from '../../lib/screenshot.js';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { Schema } from '@versionzero/module-manager';
import { C } from '../ui/style.js';
import { uyvyToRgba } from '../../lib/uyvy.js';
import { VoiceSession, SYSTEM_PROMPT } from './session.js';
import { PhraseBank, PHRASES } from './phrases.js';

const s = Schema.create;
const STATES = ['idle', 'listening', 'thinking', 'speaking'];

export class Voice extends EventEmitter {
  static moduleInfo = {
    name: 'voice',
    schema: s()
      .property('enabled', s('boolean').default(true).meta('description', 'voice turns allowed'))
      .property('systemPrompt', s('string').default(SYSTEM_PROMPT).meta('description', 'the chat model\'s system prompt for a turn'))
      .property('partialMs', s('number').default(1000).meta('description', 'partial transcript interval while listening'))
      .property('sentenceGapMs', s('number').default(400).meta('description', 'silence appended to each spoken sentence (the TTS runs them together)'))
      .property('fillerMs', s('number').default(700).meta('description', 'play the filler when no answer audio has arrived this long after the transcript'))
      .property('phrases', s('any').default(PHRASES).meta('description', 'spoken replies by set: ack (a command heard), wait (slow), error (failed); rendered once in the TTS voice'))
      .property('phraseDir', s('string').default('/android-data/mainline/voice/phrases').meta('description', 'phrase cache (48 kHz stereo S16 raw clips)'))
      .property('actionWaitMs', s('number').default(6000).meta('description', 'a wait phrase every this long while a spoken command is still running (a different one each time)'))
      .property('maxSeconds', s('number').default(8).meta('description', 'longest capture (jetd V argument)'))
      .property('captureDelayMs', s('number').default(250).meta('description', 'ms between the ack cue and opening the mic'))
      .property('wake', s('boolean').default(true).meta('description', 'hands-free: jetd listens for the wake word (needs mainline/wake.tflite on the device) and a hit starts a turn'))
      .property('wakeCutoff', s('number').default(0.97).meta('description', 'detection probability cutoff, from the model manifest'))
      .property('wakeWindow', s('number').default(5).meta('description', 'probabilities averaged for a detection'))
      .property('debugPort', s('number').default(0).meta('description', 'debug HTTP port (POST /talk, /cancel, /say, /phrases, /look, /action; GET /state, /screen.png?scale=N); 0 = off'))
      .property('llm', s('Llm').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('sounds', s('Sounds').meta('internal', true))
      .property('actions', s('Actions').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  enabled; systemPrompt; partialMs; sentenceGapMs; fillerMs; phrases; phraseDir; actionWaitMs; maxSeconds; captureDelayMs; wake; wakeCutoff; wakeWindow; debugPort; llm; deviceLink; ui; sounds; actions; logger;

  /** @type {'idle'|'listening'|'thinking'|'speaking'} */ state = 'idle';
  turn = 0;           // the current (or last) turn id; events from older turns are ignored
  transcript = '';
  answer = '';
  audioFrames = 0;    // answer audio frames received this turn
  /** The session factory (tests inject a fake). @type {(llm: object) => VoiceSession} */
  createSession = (llm) => new VoiceSession(llm, { partialMs: this.partialMs, systemPrompt: this.systemPrompt, sentenceGapMs: this.sentenceGapMs, logger: this.logger });
  now = () => Date.now();
  /** @type {VoiceSession|null} */ #session = null;
  #fillerTimer = null;
  #waitTimer = null;  // wait phrases while a spoken command runs
  /** @type {PhraseBank|null} */ #bank = null;
  #debug = null;
  #stateT = 0;
  #clips = 0;         // clips queued with #play that jetd has not reported played yet
  #wakeTurn = false;  // the running turn began with the wake word
  #routed = false;    // the running turn went to an action, not the model

  /** Cached phrase clips per set ({ack, wait, error}); {} before start. */
  get phraseStatus() { return this.#bank?.status() ?? {}; }
  /** An inference server is configured and turns are allowed. */
  get configured() { return this.enabled && Boolean(this.llm?.configured); }

  async start() {
    this.#stateT = this.now();
    this.deviceLink.on('captureChunk', (pcm) => this.#onChunk(pcm));
    this.deviceLink.on('captureEnd', (reason) => this.#onCaptureEnd(reason));
    this.deviceLink.on('disconnected', () => { if (this.state !== 'idle') this.#fail('link down'); });
    this.deviceLink.on('wake', (d) => this.#wake(d));
    this.deviceLink.on('listen', (state) => this.logger?.info({ state }, 'wake word listening'));
    const arm = () => { if (this.wake && this.configured) this.deviceLink.wakeListen(true, this.wakeCutoff, this.wakeWindow).catch((error) => this.logger?.warn({ error: error.message }, 'wake word listening not started')); };
    this.deviceLink.on('connected', arm);
    if (this.deviceLink.connected) arm();
    this.#session = this.#wire(this.createSession(this.llm));
    this.#session.intercept = (text) => this.route(text);
    // "heya jet, stop" / "cancel": a wake that was a mistake, or a change of mind; nothing is asked
    this.actions?.register('stop', /^(?:stop|cancel|never ?mind)$/, () => {});
    if (!this.llm?.configured) this.logger?.warn('llm.base is not set: voice is off');
    // the phrase bank: what is on disk is usable at once; what is missing (first run, a new
    // voice) is rendered in the background, one clip at a time
    const m = this.llm?.models;
    this.#bank = new PhraseBank({ dir: this.phraseDir, sets: this.phrases, tag: m ? `${m.tts}/${m.voice}` : '', say: (text) => this.#session.say(text), logger: this.logger });
    this.#bank.load().then((status) => {
      this.logger?.info({ status, missing: this.#bank.missing().length }, 'phrases cached');
      if (this.llm?.configured && this.#bank.missing().length) this.renderPhrases().catch(() => {});
    });
    if (this.debugPort) this.#serveDebug();
  }

  async stop() {
    clearTimeout(this.#fillerTimer); clearInterval(this.#waitTimer);
    if (this.wake && this.deviceLink.connected) this.deviceLink.wakeListen(false).catch(() => {});
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

  // ---- announcements ---------------------------------------------------------------------------
  // Voice as an observer to state, not an owner of it: a module pursuing something (a GPS fix)
  // registers an announcement and feeds it lines as its state lands, instead of a control-flow
  // method awaiting say(). The policy is explicit, and user intent wins: a new user-initiated
  // turn (press or wake word) supersedes every announcement registered before it.
  #announcements = new Set();

  /**
   * Register a pending announcement. `say(text)` speaks at once while the handle is live (it
   * interrupts nothing: clips queue to the speaker in order, so speech mid-answer follows the
   * answer). A new user turn supersedes the handle: by default its later results are dropped;
   * with `queue: true` they are held and spoken once that turn is over, after which the handle
   * is live again. `cancel()` releases it.
   * @param {{queue?: boolean}} [options]
   * @returns {{say: (text: string) => void, cancel: () => void, superseded: boolean}}
   */
  announce({ queue = false } = {}) {
    const a = {
      queue, superseded: false, buffered: [],
      say: (text) => this.#announceSay(a, text),
      cancel: () => { a.buffered.length = 0; this.#announcements.delete(a); },
    };
    this.#announcements.add(a);
    return a;
  }

  #announceSay(a, text) {
    if (!this.#announcements.has(a)) { this.logger?.info({ text }, 'announcement dropped'); return; }   // cancelled, or superseded with the default policy
    if (a.superseded) { a.buffered.push(text); return; }   // queue: true - spoken after the turn
    this.logger?.info({ text }, 'announcement');
    this.say(text).catch((error) => this.logger?.warn({ error: error.message, text }, 'announcement failed'));
  }

  /** A user turn begins: their intent wins over anything registered before it. */
  #supersedeAnnouncements() {
    for (const a of this.#announcements) {
      if (a.queue) a.superseded = true;
      else { this.#announcements.delete(a); this.logger?.info('announcement superseded'); }
    }
  }

  /** The turn is over: queued announcements speak, in the order their results landed. */
  #flushAnnouncements() {
    for (const a of this.#announcements) {
      if (!a.superseded) continue;
      a.superseded = false;
      for (const text of a.buffered.splice(0)) this.#announceSay(a, text);
    }
  }

  /**
   * The session asks with every final transcript before the model answers: a registered action
   * runs instead (true, the strip names it, a failure is a cue and a message); otherwise the turn
   * is a question and `question` is emitted (the Assistant brings itself up for a wake-word one).
   */
  route(text) {
    // the ASR renders near-silence as a word in some other script ("对。"): nothing was said
    if (!/[a-z]/i.test(text)) { this.logger?.info({ turn: this.turn, text }, 'transcript discarded'); this.#routed = true; this.ui.setStrip('nothing heard', { colour: C.dim, ms: 2000 }); return true; }
    const a = this.actions?.match(text);
    if (!a) { this.emit('question', { turn: this.turn, text, wake: this.#wakeTurn }); return false; }
    this.#routed = true;
    this.logger?.info({ turn: this.turn, action: a.name, text: a.text, wake: this.#wakeTurn }, 'action');
    this.ui.setStrip(a.name, { colour: C.ok, ms: 1500 });
    // spoken, so answered in speech: an ack now, a wait phrase every actionWaitMs while it runs
    // (three at most, never the same one twice), an error phrase if it fails; 'stop' needs no ack
    if (a.name !== 'stop') this.phrase('ack');
    clearInterval(this.#waitTimer);
    let waits = 0; const used = new Set();
    const waitTimer = this.#waitTimer = setInterval(() => { if (++waits > 3) return clearInterval(waitTimer); this.logger?.info({ action: a.name, waits }, 'action slow'); this.phrase('wait', 'thinking', used); }, this.actionWaitMs);
    waitTimer.unref?.();
    a.run().catch((error) => {
      this.logger?.warn({ action: a.name, error: error.message }, 'action failed');
      this.ui.setStrip(`${a.name}: ${error.message}`, { colour: C.bad, ms: 3000 });
      this.phrase('error', 'error');
    }).finally(() => { clearInterval(waitTimer); if (this.#waitTimer === waitTimer) this.#waitTimer = null; });
    return true;
  }

  /** jetd heard the wake word and is already capturing: a turn without the cue or `V`. */
  #wake(d) {
    if (!this.configured || !this.wake) { this.deviceLink.captureStop(); return; }
    if (this.state === 'listening') return;
    this.logger?.info({ avg: d.avg, max: d.max, state: this.state }, 'wake word');
    if (this.state !== 'idle') this.#bargeIn();
    this.#begin({ wake: true });
  }

  #begin({ wake = false } = {}) {
    this.#supersedeAnnouncements();
    const turn = ++this.turn;
    this.transcript = ''; this.answer = ''; this.audioFrames = 0; this.#wakeTurn = wake; this.#routed = false;
    this.#setState('listening');
    this.ui.setStrip('listening', { colour: C.ok });
    if (wake) { this.#session.start(turn); return; }   // the mic is open and the user is mid-sentence: no cue over it
    this.#cue('ack');
    // open the mic only after the cue has played, so jetd's noise-floor window (its first
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
    if (!this.#routed) this.ui.setStrip(why === 'nothing heard' ? 'nothing heard' : null, { colour: C.dim, ms: 2000 });   // an action owns the strip after a routed turn
  }

  #fail(why) {
    clearTimeout(this.#fillerTimer);
    this.logger?.warn({ turn: this.turn, state: this.state, why }, 'turn failed');
    if (this.state === 'listening') this.deviceLink.captureStop();
    this.#session.cancel();
    this.#setState('idle');
    this.ui.setStrip(`voice: ${why}`, { colour: C.bad, ms: 3000 });
    this.phrase('error', 'error');
  }

  #setState(next) {
    if (!STATES.includes(next)) throw new Error(`bad state ${next}`);
    const t = this.now(), from = this.state;
    this.logger?.info({ from, to: next, turn: this.turn, afterMs: t - this.#stateT, at: new Date(t).toISOString() }, 'voice state');
    this.state = next; this.#stateT = t;
    this.emit('state', { from, to: next, turn: this.turn });
    this.ui.requestRender();
    if (next === 'idle') this.#flushAnnouncements();
  }

  // ---- speaker --------------------------------------------------------------------------------
  /** A cue from the sounds module, counted like a clip of our own so a barge-in flushes it. */
  #cue(name) { this.#clips++; this.sounds.play(name).finally(() => { this.#clips--; }); }

  /** One clip (the filler): queue it and close it; jetd's `w` reply is logged, not waited for. */
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

  /** The answer is late: a wait phrase (or the soft beep until one is cached). */
  #filler() { this.logger?.info({ turn: this.turn }, 'filler'); this.phrase('wait', 'thinking'); }

  /**
   * Play a random cached phrase of the set; without one, the cue named as fallback (if any) plays
   * and the missing clips get rendered for next time. `used` (a Set kept for one command) makes
   * every pick a different clip; once they are all used nothing plays.
   */
  phrase(set, fallbackCue = null, used = null) {
    const pcm = this.#bank?.pick(set, used);
    if (pcm) { this.logger?.info({ set, bytes: pcm.length }, 'phrase'); return this.#play(pcm); }
    if (used && this.#bank?.status()[set]) { this.logger?.info({ set }, 'phrases all used'); return; }
    this.logger?.info({ set, fallback: fallbackCue }, 'phrase not cached');
    if (fallbackCue) this.#cue(fallbackCue);
    if (this.llm?.configured) this.renderPhrases().catch(() => {});
  }

  /** Render the phrases not cached yet (one TTS call each); resolves with the clips per set. */
  renderPhrases() {
    if (!this.#bank) return Promise.reject(new Error('not started'));
    const t0 = this.now(), n = this.#bank.missing().length;
    return this.#bank.render().then((status) => { if (n) this.logger?.info({ status, rendered: n, ms: Math.round(this.now() - t0) }, 'phrases rendered'); return status; });
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

  /** `text` through the TTS: 48 kHz stereo S16 PCM, not played (a mode queues it when it fits). */
  synth(text) {
    if (!this.llm?.configured) return Promise.reject(new Error('llm.base is not set'));
    return this.#session.say(text);
  }

  /** Queue a clip (from `synth` or a phrase) to the speaker; a barge-in flushes it like any other. */
  playClip(pcm) { this.#play(pcm); }

  /**
   * Wake the TTS up (the server unloads idle models): a one-word synth, discarded, at most once
   * a minute, so a remark made a few seconds from now is not the request that pays the load.
   */
  warm() {
    if (!this.llm?.configured || this.now() - this.#warmedAt < 60000) return;
    this.#warmedAt = this.now();
    const t0 = this.now();
    this.#session.say('Okay.').then((pcm) => this.logger?.info({ ms: Math.round(this.now() - t0), bytes: pcm.length }, 'tts warmed'), (error) => this.logger?.warn({ error: error.message }, 'tts warm-up failed'));
  }
  #warmedAt = -Infinity;

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
          if (req.method === 'GET' && req.url.startsWith('/screen.png')) {   // the panel as shown (jetd, jet-app and the viewfinder); ?scale=N enlarges
            const scale = Number(new URL(req.url, 'http://x').searchParams.get('scale')) || 1;
            return screenshot({ scale }).then(({ png }) => { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); res.end(png); }, (e) => reply(500, { error: e.message }));
          }
          if (req.method === 'GET' && req.url === '/state') return reply(200, { state: this.state, turn: this.turn, transcript: this.transcript, answer: this.answer, phrases: this.phraseStatus, configured: this.configured, llm: this.llm?.models ?? null });
          if (req.method === 'POST' && req.url === '/talk') return reply(200, { started: this.startTurn(), turn: this.turn });
          if (req.method === 'POST' && req.url === '/cancel') return reply(200, { cancelled: this.cancel() });
          if (req.method === 'POST' && req.url === '/say') return run(this.say(String(json.text ?? 'hello')));
          if (req.method === 'POST' && req.url === '/phrases') return run(this.renderPhrases());
          if (req.method === 'POST' && req.url === '/action') {   // a spoken command without the mic: { text: "open status" }
            const a = this.actions?.match(String(json.text ?? ''));
            return a ? run(a.run().then(() => ({ matched: a.name }))) : reply(200, { matched: null });
          }
          if (req.method === 'POST' && req.url === '/look') return run(this.#snapshotLook(String(json.question ?? 'Describe what is in front of me in one short sentence.')));
          reply(404, { error: 'no such route' });
        } catch (e) { reply(400, { error: e.message }); }
      });
    }).listen(this.debugPort, '0.0.0.0', () => this.logger?.info({ port: this.debugPort }, 'voice debug http'));
  }
}
