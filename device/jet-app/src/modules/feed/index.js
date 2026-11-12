// feed: what Jet sent and what was said, as one model (docs/agent.md). An append-only ring of
// items - `heard` (the wearer's words), `said` (Jet's), `photo` (a picture the camera took for
// the conversation), `card` (something put on the display to be read later, with an optional
// picture) - that the Assistant mode draws and nothing else holds. The operator posts the
// conversation, the `show` tool (show-tool.js) posts the cards. A `heard` or `said` item can
// carry its sound (`attach`: the clip arrives after the words), kept as raw PCM beside the index
// and read back on demand (`audio(id)`), never held in memory.
//
// It survives a restart: the text lives in `dir/feed.json` (written `saveMs` after a post,
// temp file + rename, so a power cut leaves the old feed), each picture beside it as
// `<id>.jpg`. In memory a picture is RGBA, ready for `surface.blitImage`; the JPEG round trip
// happens off the posting call, one write at a time.
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { Schema } from '@versionzero/module-manager';
import { ShowTool } from './show-tool.js';
import { pcmToWav } from '../llm/wav.js';

const s = Schema.create;
const KINDS = ['heard', 'said', 'photo', 'card'];
const number = (id) => parseInt(String(id).slice(1), 10) || 0;
const text = (v) => (v == null ? '' : String(v).trim());

/**
 * @typedef {{width: number, height: number, data: Uint8Array}} Image  RGBA
 * @typedef {object} FeedItem  frozen: the feed is a record
 * @property {string} id  `f12`, unique across restarts
 * @property {number} t  when it was posted (ms)
 * @property {'heard'|'said'|'photo'|'card'} kind
 * @property {string} [title]
 * @property {string} [body]
 * @property {string} [entity]  the world entity a card is about
 * @property {Image} [image]
 * @property {{rate: number, channels: number, seconds: number}} [audio]  a clip is stored (`feed.audio(id)`)
 */

export class Feed extends EventEmitter {
  static moduleInfo = {
    name: 'feed',
    schema: s()
      .property('dir', s('string').default('/android-data/mainline/feed').meta('description', 'feed.json and the card pictures live here; empty = nothing is persisted'))
      .property('maxItems', s('number').default(100).meta('description', 'items kept; past it the oldest go'))
      .property('saveMs', s('number').default(1000).meta('advanced').meta('description', 'feed.json is written this long after a post'))
      .property('jpegQuality', s('number').default(75).meta('advanced').meta('description', 'quality of a card picture on disk'))
      .property('logger', s('Logger').lax().meta('internal', true)),
    register: [{ ModuleClass: ShowTool, relative: true }],
  };
  dir; maxItems; saveMs; jpegQuality; logger;

  /** the clock, a field so tests own time */ now = () => Date.now();
  /** @type {FeedItem[]} oldest first */ #items = [];
  #seq = 0; #saveTimer = null;
  /** disk work, one job at a time: pictures in posting order, the index after them */ #io = Promise.resolve();
  /** @type {Map<string, Buffer>} clips when nothing is persisted (`dir` empty: tests, a dev run) */ #clips = new Map();

  /** Read what the last run left. A missing or damaged file is an empty feed. */
  async start() {
    if (!this.dir) return;
    const t0 = Date.now();
    try {
      const o = JSON.parse(await fs.readFile(this.#index, 'utf8'));
      const saved = (Array.isArray(o.items) ? o.items : []).filter((x) => x && typeof x.id === 'string' && KINDS.includes(x.kind)).slice(-this.maxItems);
      for (const { image, ...item } of saved) {
        if (image) item.image = await this.#readImage(item.id);
        if (!item.image) delete item.image;
        this.#items.push(Object.freeze(item));
      }
      this.#seq = Math.max(+o.seq || 0, ...this.#items.map((x) => number(x.id)));
      await this.#sweep();
      this.logger?.info({ items: this.#items.length, ms: Date.now() - t0 }, 'feed: loaded');
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.warn({ error: error.message }, 'feed: not loaded');
    }
  }

  /** Lifecycle: whatever is unsaved goes to disk. */
  async stop() { await this.flush(); }

  /** The items, oldest first (a copy: the ring is ours). */
  get items() { return this.#items.slice(); }

  /** @returns {FeedItem|null} */
  get(id) { return this.#items.find((x) => x.id === id) ?? null; }

  /**
   * Append an item; the oldest fall off past `maxItems`. Emits `post` with the item.
   * @param {{kind: 'heard'|'said'|'photo'|'card', title?: string, body?: string, image?: Image, entity?: string, audio?: {rate: number, channels: number, pcm: Buffer}}} post
   * @returns {FeedItem}
   */
  post({ kind, title, body, image, entity, audio } = {}) {
    if (!KINDS.includes(kind)) throw new Error(`feed: unknown kind ${kind}`);
    const item = { id: `f${++this.#seq}`, t: this.now(), kind };
    if (text(title)) item.title = text(title);
    if (text(body)) item.body = text(body);
    if (text(entity)) item.entity = text(entity);
    if (image?.data && image.width > 0 && image.height > 0) item.image = image;
    Object.freeze(item);
    this.#items.push(item);   // always at the end: the feed is a message thread, in the order things happened
    if (item.image) this.#job(() => this.#writeImage(item));
    while (this.#items.length > this.maxItems) {
      const old = this.#items.shift();
      if (old.image) this.#job(() => fs.rm(this.#jpg(old.id), { force: true }));
      if (old.audio) { this.#clips.delete(old.id); this.#job(() => fs.rm(this.#pcm(old.id), { force: true })); }
    }
    this.#saveSoon();
    this.emit('post', item);
    return audio ? this.attach(item.id, { audio }) ?? item : item;
  }

  /**
   * Give an item its sound once it exists (the words are posted first; the speech is rendered
   * after). S16 PCM at `rate`/`channels`. Emits `change` with the item as it is now.
   * @param {string} id @param {{audio: {rate: number, channels: number, pcm: Buffer}}} parts
   * @returns {FeedItem|null} the updated item; null when it is gone or the clip is empty
   */
  attach(id, { audio } = {}) {
    const i = this.#items.findIndex((x) => x.id === id);
    if (i < 0 || !audio?.pcm?.length || !(audio.rate > 0)) return null;
    const channels = audio.channels ?? 1;
    const item = Object.freeze({ ...this.#items[i], audio: { rate: audio.rate, channels, seconds: +(audio.pcm.length / (2 * channels * audio.rate)).toFixed(2) } });
    this.#items[i] = item;
    if (this.dir) this.#job(async () => { await fs.mkdir(this.dir, { recursive: true }); await fs.writeFile(this.#pcm(id), audio.pcm); });
    else this.#clips.set(id, audio.pcm);
    this.#saveSoon();
    this.emit('change', item);
    return item;
  }

  /** Forget everything (a clean slate before a recording); the files go too. Emits `change` with null. */
  clear() {
    const old = this.#items.splice(0);
    this.#clips.clear();
    for (const x of old) {
      if (x.image) this.#job(() => fs.rm(this.#jpg(x.id), { force: true }));
      if (x.audio) this.#job(() => fs.rm(this.#pcm(x.id), { force: true }));
    }
    this.#saveSoon();
    this.emit('change', null);
    return old.length;
  }

  /**
   * The newest `n` items as files for taking off the device: each item's fields, its sound as
   * a WAV and its picture as a JPEG (Buffers; absent where there is none).
   * @returns {Promise<Array<{id: string, t: number, kind: string, title?: string, body?: string, entity?: string, wav?: Buffer, jpeg?: Buffer}>>}
   */
  async export(n = 10) {
    const out = [];
    for (const { image, audio, ...item } of this.#items.slice(-Math.max(1, n))) {
      const clip = audio ? await this.audio(item.id) : null;
      out.push({ ...item, ...(clip ? { wav: pcmToWav(clip.pcm, clip.rate, clip.channels) } : {}), ...(image ? { jpeg: Buffer.from(jpeg.encode(image, 85).data) } : {}) });
    }
    return out;
  }

  /** An item's clip, read from disk. @returns {Promise<{rate: number, channels: number, pcm: Buffer}|null>} */
  async audio(id) {
    const item = this.get(id);
    if (!item?.audio) return null;
    await this.#io;   // a clip attached a moment ago may still be on its way to disk
    const pcm = this.dir ? await fs.readFile(this.#pcm(id)).catch(() => null) : this.#clips.get(id);
    return pcm?.length ? { rate: item.audio.rate, channels: item.audio.channels, pcm } : null;
  }

  #saveSoon() {
    if (!this.dir || this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => { this.#saveTimer = null; this.flush(); }, this.saveMs ?? 1000);
    this.#saveTimer.unref?.();
  }

  /** Write now whatever is waiting (shutdown, tests). Resolves when it is on disk. */
  flush() {
    clearTimeout(this.#saveTimer); this.#saveTimer = null;
    this.#job(() => this.#writeIndex());
    return this.#io;
  }

  // ---- internals --------------------------------------------------------------------------------
  get #index() { return path.join(this.dir, 'feed.json'); }
  #jpg(id) { return path.join(this.dir, `${id}.jpg`); }
  #pcm(id) { return path.join(this.dir, `${id}.pcm`); }

  /** Queue disk work behind what is already running; a failure is logged, never thrown at a poster. */
  #job(work) {
    if (!this.dir) return;
    this.#io = this.#io.then(work).catch((error) => this.logger?.warn({ error: error.message }, 'feed: not saved'));
  }

  async #writeImage(item) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.#jpg(item.id), jpeg.encode(item.image, this.jpegQuality ?? 75).data);
  }

  /** @returns {Promise<Image|null>} null when the picture is missing or damaged: the card stays, without it */
  async #readImage(id) {
    try { const { width, height, data } = jpeg.decode(await fs.readFile(this.#jpg(id)), { useTArray: true, formatAsRGBA: true }); return { width, height, data }; }
    catch { return null; }
  }

  /** The index, temp file + rename. A picture is named by its item's id, so the index only notes that there is one. */
  async #writeIndex() {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.#index}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ v: 1, seq: this.#seq, items: this.#items.map(({ image, ...item }) => (image ? { ...item, image: true } : item)) }) + '\n');
    await fs.rename(tmp, this.#index);
  }

  /** Pictures no item owns (a run that ended between a picture and its index) are removed, so the directory stays bounded. */
  async #sweep() {
    const mine = new Set([...this.#items.filter((x) => x.image).map((x) => `${x.id}.jpg`), ...this.#items.filter((x) => x.audio).map((x) => `${x.id}.pcm`)]);
    for (const name of await fs.readdir(this.dir)) if (/^f\d+\.(jpg|pcm)$/.test(name) && !mine.has(name)) await fs.rm(path.join(this.dir, name), { force: true });
  }
}
