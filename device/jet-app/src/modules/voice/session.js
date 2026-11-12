// VoiceSession: one push-to-talk turn, in process, driving the `llm` module directly (the Jet
// talks to the inference server over WiFi; no Mac in the loop). The state machine in
// `index.js` feeds it (`start`, `audio`, `end`, `cancel`) and consumes its events:
//
//   partial {turn, text}                 transcript so far (every `partialMs` while listening,
//                                        the whole buffer each time)
//   final   {turn, text}                 the transcript the answer is based on
//   token   {turn, text}                 answer text as the model streams it
//   audio   {turn, pcm, bytes, sentence} one spoken sentence, 48 kHz stereo S16, in order
//   done    {turn, answer}               the turn is complete (an empty transcript: done at once)
//   error   {turn, message}
//
// Sentences are synthesised in order while the model is still talking, so the first audio does
// not wait for the whole answer. `cancel()` aborts every request in flight through one
// AbortController per turn; events of a cancelled turn are never emitted. `say(text)` (filler,
// debug) and `look(jpeg, question)` (the Demo mode's vision request) are independent of the
// turn. Stage timings (ms) go to the log, as the host session logged them.
//
// Who answers is a strategy, the **responder**: `{name, respond(text, {onToken, signal, wake})
// -> Promise<string>}`. The built-in one (`chat`: one system prompt, one question, no memory) is
// what a turn gets unless `start()` is handed another (the operator: the agent loop, docs/agent.md).
// Everything around it - transcript, sentence-by-sentence speech, cancel - is the same either way.
//
// Two more things a turn can do. `intercept` may answer `'more'` for a transcript that is not
// the question yet (a wake word caught with nothing after it): the turn goes back to listening
// with an empty buffer, `more` is emitted, and the next `end()` is the real one. And while the
// answer is being spoken `interject(pcm)` slips a ready clip (a filler) into the speech queue,
// in order: after the sentences already waiting, never over one.
import { EventEmitter } from 'node:events';
import { SentenceSplitter } from './sentences.js';

export const SYSTEM_PROMPT = 'You are a voice assistant on a pair of smart glasses. Reply as spoken words: one to three short plain sentences, no lists, no markdown, no preamble.';

export class VoiceSession extends EventEmitter {
  /**
   * @param {import('../llm/index.js').Llm} llm
   * @param {{partialMs?: number, systemPrompt?: string, sentenceGapMs?: number, logger?: object}} [options]
   *   sentenceGapMs: silence after each sentence's audio; the TTS voices run "Roger. Say..." together
   */
  constructor(llm, { partialMs = 1000, systemPrompt = SYSTEM_PROMPT, sentenceGapMs = 400, streamTts = true, logger } = {}) {
    super();
    this.llm = llm; this.partialMs = partialMs; this.systemPrompt = systemPrompt; this.sentenceGapMs = sentenceGapMs; this.streamTts = streamTts; this.logger = logger;
    /** The built-in responder: the question alone under the system prompt, nothing remembered. */
    this.chat = { name: 'chat', respond: (text, { onToken, signal }) => this.llm.chatStream([{ role: 'system', content: this.systemPrompt }, { role: 'user', content: text }], onToken, signal) };
  }
  now = () => performance.now();
  /** @type {object|null} the running turn */ #turn = null;
  /**
   * Asked with the final transcript before the model: true = an action took the turn, 'more' =
   * not the question yet (keep listening), false = a question for the responder.
   * @type {((text: string, info: {seconds: number, wake: boolean, phase: number}) => boolean|'more')|null}
   */
  intercept = null;

  get busy() { return this.#turn !== null; }
  get turn() { return this.#turn?.id ?? null; }

  /**
   * Begin a turn: capture chunks are collected and transcribed every `partialMs`.
   * @param {number} id @param {{responder?: {name: string, respond: Function}, wake?: boolean}} [options]  who answers (default: `chat`)
   */
  start(id, { responder = this.chat, wake = false } = {}) {
    this.cancel();
    const t = this.#turn = { id, responder, wake, phase: 1, chunks: [], bytes: 0, abort: new AbortController(), t0: this.now(), listening: true, partial: null, partials: 0, say: null };
    this.logger?.info({ turn: id, responder: responder.name }, 'session start');
    t.timer = setInterval(() => this.#partial(t), this.partialMs);
    t.timer.unref?.();
  }

  /** A 16 kHz mono S16 capture chunk; ignored outside listening. */
  audio(pcm) {
    const t = this.#turn;
    if (!t?.listening) return false;
    t.chunks.push(pcm); t.bytes += pcm.length;
    return true;
  }

  /** The capture is over: final transcript, answer, speech. Resolves when the turn has ended. */
  end() {
    const t = this.#turn;
    if (!t?.listening) return Promise.resolve(false);
    t.listening = false;
    clearInterval(t.timer);
    t.partial?.abort();   // the ASR is needed for the final transcript now
    return this.#answer(t);
  }

  /**
   * Put a ready clip (48 kHz stereo S16) into the running answer's speech, in order. False when
   * no answer is being produced (listening, or no turn).
   */
  interject(pcm) {
    if (!this.#turn?.say) return false;
    this.#turn.say({ pcm });
    return true;
  }

  /** Abort the running turn; no more events for it. */
  cancel() {
    const t = this.#turn;
    if (!t) return false;
    clearInterval(t.timer);
    t.abort.abort(); t.partial?.abort();
    this.#turn = null;
    this.logger?.info({ turn: t.id, ms: this.#ms(t.t0) }, 'session cancel');
    return true;
  }

  /** @param {string} text @returns {Promise<Buffer>} 48 kHz stereo S16 */
  async say(text, { signal } = {}) {
    const t0 = this.now();
    const pcm = await this.llm.speak(text, signal);
    this.logger?.info({ ms: this.#ms(t0), bytes: pcm.length, audioS: +(pcm.length / 192000).toFixed(2), text }, 'say');
    return pcm;
  }

  /**
   * @param {Buffer} jpeg @param {string} question @param {{onToken?: (text: string) => void, signal?: AbortSignal}} [options]
   * @returns {Promise<string>} the answer
   */
  async look(jpeg, question, { onToken, signal } = {}) {
    const t0 = this.now();
    let tokens = 0, first = null;
    const answer = await this.llm.describe(jpeg, question, (tok) => { tokens++; first ??= this.#ms(t0); onToken?.(tok); }, signal);
    this.logger?.info({ ms: this.#ms(t0), firstTokenMs: first, jpegBytes: jpeg.length, tokens, answer }, 'look');
    return answer;
  }

  // ---- the turn --------------------------------------------------------------------------------
  #ms(t0) { return Math.round(this.now() - t0); }
  #current(t) { return this.#turn === t; }
  #emit(t, type, fields) { if (this.#current(t)) this.emit(type, { type, turn: t.id, ...fields }); }

  async #partial(t) {
    if (t.partial || t.bytes < 3200) return;
    const pcm = Buffer.concat(t.chunks), t0 = this.now();
    t.partial = new AbortController();
    try {
      const text = await this.llm.transcribe(pcm, { signal: AbortSignal.any([t.abort.signal, t.partial.signal]) });
      if (!this.#current(t) || !t.listening) return;
      t.partials++;
      this.logger?.info({ turn: t.id, ms: this.#ms(t0), seconds: +(pcm.length / 32000).toFixed(2), chars: text.length }, 'partial');
      this.#emit(t, 'partial', { text });
    } catch (error) {
      if (this.#current(t) && t.listening) this.logger?.warn({ turn: t.id, error: error.message }, 'partial failed');
    } finally { t.partial = null; }
  }

  async #answer(t) {
    const { signal } = t.abort, tEnd = this.now();
    try {
      const pcm = Buffer.concat(t.chunks);
      const text = await this.llm.transcribe(pcm, { signal });
      if (!this.#current(t)) return false;
      this.logger?.info({ turn: t.id, ms: this.#ms(tEnd), seconds: +(pcm.length / 32000).toFixed(2), partials: t.partials, text }, 'final');
      const routed = this.intercept?.(text, { seconds: pcm.length / 32000, wake: t.wake, phase: t.phase }) ?? false;
      if (routed === 'more') {   // the wake word and nothing after it: the question is still to come
        this.logger?.info({ turn: t.id, text }, 'not the question yet: listening on');
        t.chunks = []; t.bytes = 0; t.phase++; t.partials = 0; t.listening = true;
        t.timer = setInterval(() => this.#partial(t), this.partialMs); t.timer.unref?.();
        this.#emit(t, 'more', { text });
        return true;
      }
      this.#emit(t, 'final', { text });
      if (text && routed) {   // an action took it: no model, no speech
        this.logger?.info({ turn: t.id, ms: this.#ms(t.t0), text }, 'turn routed');
        this.#emit(t, 'done', { answer: '' });
        return true;
      }
      if (!text) {
        this.logger?.info({ turn: t.id, ms: this.#ms(t.t0), answer: '' }, 'turn');
        this.#emit(t, 'done', { answer: '' });
        return true;
      }

      // stream the answer; synthesise each sentence in order while the model is still talking
      const splitter = new SentenceSplitter();
      const queue = [];
      let drain = Promise.resolve(), ttsError = null, firstToken = null, firstAudio = null, sentences = 0, tokens = 0;
      // the TTS chain never rejects (a rejected promise waiting for the chat stream to end would
      // be an unhandled rejection): a failure is kept and aborts the turn, the error goes out once
      const gap = () => this.sentenceGapMs > 0 && this.#emit(t, 'audio', { pcm: Buffer.alloc(Math.round(this.sentenceGapMs * 192)), bytes: Math.round(this.sentenceGapMs * 192), sentence: '' });   // 48 kHz stereo S16: 192 bytes/ms
      const speakQueued = () => {
        drain = drain.then(async () => {
          while (queue.length && this.#current(t) && !ttsError) {
            const sentence = queue.shift(), t0 = this.now();
            if (typeof sentence !== 'string') {   // an interjected clip: ready as it is
              this.#emit(t, 'audio', { pcm: sentence.pcm, bytes: sentence.pcm.length, sentence: '', filler: true });
              continue;
            }
            if (this.streamTts) {
              // stream the sentence as it renders: each chunk is played as it arrives, so the first
              // sound does not wait for the whole clip (the consumer plays one `W` per audio event)
              let chunks = 0;
              await this.llm.speakStream(sentence, (pcm) => {
                if (!this.#current(t)) return;
                chunks++; firstAudio ??= this.#ms(tEnd);
                this.#emit(t, 'audio', { pcm, bytes: pcm.length, sentence: chunks === 1 ? sentence : '' });
              }, signal);
              if (!this.#current(t)) return;
              gap(); sentences++;
              this.logger?.info({ turn: t.id, ms: this.#ms(t0), chunks, sentence }, 'tts');
            } else {
              const spoken = await this.llm.speak(sentence, signal);
              if (!this.#current(t)) return;
              const audio = this.sentenceGapMs > 0 ? Buffer.concat([spoken, Buffer.alloc(Math.round(this.sentenceGapMs * 192))]) : spoken;
              sentences++; firstAudio ??= this.#ms(tEnd);
              this.logger?.info({ turn: t.id, ms: this.#ms(t0), bytes: audio.length, audioS: +(audio.length / 192000).toFixed(2), sentence }, 'tts');
              this.#emit(t, 'audio', { pcm: audio, bytes: audio.length, sentence });
            }
          }
        }).catch((error) => { if (this.#current(t) && !ttsError) { ttsError = error; t.abort.abort(); } });
      };
      // an interjection comes when the responder pauses to do something: whatever it had said so
      // far is a finished thought, so the sentence still held in the splitter goes out first
      t.say = (item) => { if (!this.#current(t) || ttsError) return; const held = splitter.flush(); if (held) queue.push(held); queue.push(item); speakQueued(); };
      const tChat = this.now();
      const answer = await t.responder.respond(text, { signal, wake: t.wake, heard: { rate: 16000, channels: 1, pcm }, onToken: (tok) => {
        if (!this.#current(t) || ttsError) return;
        tokens++; firstToken ??= this.#ms(tChat);
        this.#emit(t, 'token', { text: tok });
        const ready = splitter.push(tok);
        if (ready.length) { queue.push(...ready); speakQueued(); }
      } }).catch((error) => { if (ttsError) return ''; throw error; });
      if (!this.#current(t)) return false;
      if (ttsError) throw ttsError;
      this.logger?.info({ turn: t.id, responder: t.responder.name, ms: this.#ms(tChat), firstTokenMs: firstToken, tokens, chars: answer.length }, 'llm');
      const rest = splitter.flush();
      if (rest) { queue.push(rest); speakQueued(); }
      await drain;
      if (!this.#current(t)) return false;
      if (ttsError) throw ttsError;
      this.logger?.info({ turn: t.id, ms: this.#ms(t.t0), sinceEndMs: this.#ms(tEnd), firstAudioMs: firstAudio, sentences, answer }, 'turn');
      this.#emit(t, 'done', { answer });
      return true;
    } catch (error) {
      if (!this.#current(t)) return false;
      this.logger?.warn({ turn: t.id, error: error.message }, 'turn failed');
      this.#emit(t, 'error', { message: error.message });
      return false;
    } finally { if (this.#current(t) && !t.listening) this.#turn = null; }
  }
}
