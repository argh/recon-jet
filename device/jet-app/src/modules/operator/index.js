// operator: the glue between the voice turn and the agent (docs/agent.md). It is the voice
// module's **responder** for the turns it is given: a question comes in as text, goes through
// `agent.ask` (history, tools, the world), and the answer streams back out as tokens for the
// session to speak. Around that it does what makes it a conversation rather than a request:
//
// - It keeps the record, in the feed: what was heard and what was said, each with its sound,
//   and the photo when the agent looked. The conversation belongs to no screen - the Channel is
//   a view over the feed - so it works the same from Status, a map, or the Scan screen.
// - It fixes which picture a question is about. If the wearer has something selected (the
//   world's focus) that is "this"; otherwise a frame is taken as the question arrives and held
//   for the look tool, so the model sees what they were looking at when they asked, not what
//   the camera points at seconds later. Whether the question is about the view at all is the
//   model's call: the frame is only used if it looks.
// - It covers the silences. A slow tool gets a phrase as it starts ("Let me see.", "Looking it
//   up.") and another every `fillEveryMs` while it runs; the session slips them in between
//   sentences, never over one.
//
// Wake-word turns belong to no mode, so with `wake` on the operator claims them: "heya jet, ..."
// from anywhere is answered here (spoken commands are still matched first, in voice). A mode
// that wants a push-to-talk turn answered by the operator calls `talk()`; nothing else in the
// app needs to know the agent exists.
import { EventEmitter } from 'node:events';
import jpegJs from 'jpeg-js';
import { Schema } from '@versionzero/module-manager';
import { crop } from '../camera/index.js';

const s = Schema.create;

export class Operator extends EventEmitter {
  static moduleInfo = {
    name: 'operator',
    schema: s()
      .property('wake', s('boolean').default(true).meta('description', 'answer wake-word questions ("heya jet, ...") from any mode; off = the built-in one-shot chat answers them'))
      .property('fillers', s('any').default({ look: 'look', wiki: 'search', web_search: 'search', web_read: 'search' }).meta('description', 'tool name -> phrase set spoken when that tool starts'))
      .property('fillEveryMs', s('number').default(6000).meta('description', 'while a tool is still running, a wait phrase this often'))
      .property('hold', s('string').default('streaming').values(['streaming', 'always', 'never']).meta('description', 'take a frame as a question arrives, for the look tool: only while the camera is already streaming, always, or never'))
      .property('photoW', s('number').default(160).meta('description', 'a photo the agent took is kept in the feed fitted to this width'))
      .property('photoH', s('number').default(120).meta('description', '... and this height'))
      .property('agent', s('Agent').meta('internal', true))
      .property('voice', s('Voice').meta('internal', true))
      .property('feed', s('Feed').meta('internal', true))
      .property('camera', s('Camera').lax().meta('internal', true))
      .property('world', s('World').lax().meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  wake; fillers; fillEveryMs; hold; photoW; photoH; agent; voice; feed; camera; world; logger;

  /** The responder's name: what `question` events and the session log call us. */
  name = 'operator';
  /** @type {string|null} the tool running right now, for a view that wants to say so */ activity = null;
  /** @type {Promise<unknown>|null} the turn in flight (a superseding one waits for it to unwind) */ #running = null;
  /** @type {string|null} the feed item of the answer being spoken: its sound is attached when the speech is done */ #saidId = null;
  #waitTimer = null;
  #release = null;

  async start() {
    this.agent.on('tool', (e) => this.#onTool(e));
    this.voice.on?.('spoken', (clip) => this.#onSpoken(clip));
    if (this.wake) this.#release = this.voice.claimWake(this);
  }
  async stop() { this.#release?.(); clearInterval(this.#waitTimer); }

  /** Push-to-talk, answered here (the Assistant mode's front press); voice's own semantics apply (again = end the capture, or barge in). */
  talk() { return this.voice.startTurn({ responder: this }); }
  /** Abort the running turn. */
  cancel() { return this.voice.cancel(); }

  /**
   * Play a feed item's sound again. False when it has none or a turn is running.
   * @param {string} id @returns {boolean} whether it will play
   */
  replay(id) {
    if (this.voice.state !== 'idle' || !this.feed.get(id)?.audio) return false;
    this.feed.audio(id).then((clip) => { if (clip && this.voice.state === 'idle') this.voice.playAudio(clip); },
      (error) => this.logger?.warn({ id, error: error.message }, 'operator: no replay'));
    return true;
  }

  /**
   * The responder contract (voice/session.js): answer `text`, streaming through `onToken`.
   * @param {string} text
   * @param {{onToken?: (t: string) => void, signal?: AbortSignal, wake?: boolean, heard?: {rate: number, channels: number, pcm: Buffer}}} [options]
   *   heard: the question as it was captured, kept with the words
   * @returns {Promise<string>} the whole answer
   */
  respond(text, { onToken, signal, wake = false, heard } = {}) {
    // a barge-in aborted the turn before this one through its signal; this one queues behind its
    // unwinding (the agent runs one turn at a time) rather than bounce off `busy`. Chained
    // synchronously, so two calls in one tick still run in order.
    const prior = this.#running;
    const run = this.#running = (async () => {
      await prior?.catch(() => {});
      this.#saidId = null;
      this.emit('turn', { text, wake });
      this.feed.post({ kind: 'heard', body: text, ...(heard?.pcm?.length ? { audio: heard } : {}) });
      // "this": the selected item if there is one, else what is in front of them now. By default
      // only while the camera is already streaming: a frame taken cold is a sensor start, and
      // on this hardware every stream start is suspected of scribbling over user memory
      // (docs/agent.md, "The crashes"); most questions are not about the view at all.
      if (!this.world?.focus() && (this.hold === 'always' || (this.hold === 'streaming' && this.camera?.streaming))) this.camera.hold();
      this.voice.warm?.();   // the TTS may have been unloaded: start it loading while the model thinks
      const t0 = Date.now();
      const { text: answer, steps } = await this.agent.ask(text, { onToken, signal });
      if (answer) this.#saidId = this.feed.post({ kind: 'said', body: answer }).id;
      this.logger?.info({ ms: Date.now() - t0, steps, wake, chars: answer.length }, 'operator: answered');
      return answer;
    })();
    return run.finally(() => { if (this.#running === run) { this.#running = null; this.#setActivity(null); } });
  }

  #onTool({ name, phase, image }) {
    clearInterval(this.#waitTimer);
    if (phase !== 'start') {
      if (image) this.#photo(image);
      return this.#setActivity(null);
    }
    this.#setActivity(name);
    const set = this.fillers?.[name];
    if (set) this.voice.fill?.(set);
    this.#waitTimer = setInterval(() => this.voice.fill?.('wait'), this.fillEveryMs);
    this.#waitTimer.unref?.();
  }

  /** The picture the agent looked at joins the conversation, small. */
  #photo(jpg) {
    try {
      const d = jpegJs.decode(jpg, { useTArray: true, formatAsRGBA: true });
      const image = crop({ width: d.width, height: d.height, data: d.data }, { x: 0, y: 0, w: d.width, h: d.height }, { maxW: this.photoW, maxH: this.photoH });
      if (image) this.feed.post({ kind: 'photo', image });
    } catch (error) { this.logger?.warn({ error: error.message }, 'operator: photo not kept'); }
  }

  /** The answer has been spoken: its sound goes with its words (24 kHz mono is what the TTS made; the rest was upsampling). */
  #onSpoken({ responder, rate, channels, pcm }) {
    const id = this.#saidId;
    this.#saidId = null;
    if (responder !== this.name || !id) return;
    this.feed.attach(id, { audio: rate === 48000 && channels === 2 ? { rate: 24000, channels: 1, pcm: halve(pcm) } : { rate, channels, pcm } });
  }

  #setActivity(name) {
    if (this.activity === name) return;
    this.activity = name;
    this.emit('activity', name);
  }
}

/** 48 kHz stereo S16 -> 24 kHz mono: every other frame, the left sample. */
function halve(pcm) {
  const frames = pcm.length >> 3, out = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) out.writeInt16LE(pcm.readInt16LE(i * 8), i * 2);
  return out;
}
