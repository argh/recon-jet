// scanner: turns frames into the world. A scan is capture -> JPEG -> one vision call with a
// terse line-format prompt (and the names the world already knows, so the model reuses them) ->
// tolerant parse -> `world.observe`. One scan at a time, always: a `scanOnce` asked for while
// one runs joins it. While scanning is on (`start()`), the next scan follows a new-view event
// from the head tracker or `intervalS` after the last one finished, never sooner than
// `minGapMs` after it, and the whole thing switches itself off after `maxScanS` so a forgotten
// scan cannot hold the model. A failed scan is logged and counted (`failures`, `lastError`),
// never thrown: views watch `state` and `scan` events.
//
// `start()`/`stop()` are the scanning switch (the contract in docs/agent.md), so the container's
// start hook is renamed to `attach` (`lifecycleStart`); its stop hook lands on `stop()`, which
// is what shutdown should do anyway.
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';
import { Camera, crop } from '../camera/index.js';
import { World } from '../world/index.js';
import { LookTool } from './look-tool.js';

const s = Schema.create;

// Verified against qwen-vision on a real frame: boxes come back normalised 0..1000. The reply
// is asked for as plain `|`-separated lines, not JSON: the model indents JSON whatever it is told
// (~75 tokens an object, so a 400-token budget ended at the fifth), where a line is ~30 (scene +
// six objects: 226 tokens, 5 s). Everything here that asks for brevity is load: a sentence per
// object is 17 s. The parser still takes JSON, which is what the model falls back to sometimes.
// No concrete example names in here: the model copies them into what it "sees" (an example
// "white Withings box" turned up on a bench that had none).
const PROMPT = 'List what is in this picture as plain text lines, nothing else.\n'
  + 'First line: SCENE: one short line, the kind of place and what is going on.\n'
  + 'Then at most {maxItems} lines, one per distinct notable object (skip background surfaces), each exactly:\n'
  + 'name | kind | x1,y1,x2,y2 | note\n'
  + 'Only physical objects: not bare text, patterns, reflections, or parts of something already listed. Stop after {maxItems}.\n'
  + 'name: two to four words that tell it apart from similar things nearby (its colour, and a brand or title only if readable); a bare category word is not a name. '
  + 'kind: one generic word (tool, instrument, component, cable, container, ...). '
  + 'x1,y1,x2,y2: the bounding box. '
  + 'note: at most 12 words of visible detail; put any text or number you can actually read on the object in "double quotes". '
  + 'Never guess a brand or model number: one belongs in the name only if you can read it in the picture.';
const KNOWN_NAMES = 12;   // names offered for reuse: the newest, enough to cover what is in view

const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** A model box as `[x1, y1, x2, y2]` integers within 0..1000, or null when it is not one (wrong shape, or nothing left after clamping). */
function cleanBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const v = box.map((n) => (typeof n === 'number' || typeof n === 'string' ? Math.round(Math.min(1000, Math.max(0, Number(n)))) : NaN));
  if (v.some(Number.isNaN)) return null;
  const out = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  return out[2] - out[0] >= 2 && out[3] - out[1] >= 2 ? out : null;
}

/** Every innermost `{...}` in a text that parses on its own: what survives of a reply cut off at the token limit. */
function flatObjects(text) {
  const found = [];
  let open = -1, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{') open = i;
    else if (c === '}' && open >= 0) {
      try { found.push(JSON.parse(text.slice(open, i + 1))); } catch { /* not one of ours */ }
      open = -1;
    }
  }
  return found;
}

/**
 * The scan reply as data, whatever shape the model gave it: the object asked for, the same in
 * a ```json fence or with prose around it, a bare array of items, `label` for `name`,
 * `bbox_2d`/`bbox` for `box`, or a reply truncated mid-item (the complete items are kept).
 * Items without a name are dropped; a box is clamped to 0..1000 and is null when unusable
 * (the item still stands: it is a claim without a crop).
 * @param {string} text
 * @returns {{scene: string, items: {name: string, kind: string, box: number[]|null, note: string}[]}}
 */
export function parseScan(text) {
  text = String(text ?? '');
  const lines = parseLines(text);
  if (lines.items.length) return lines;
  let doc, scene = '', raw = [];
  const from = text.search(/[{[]/), to = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (from >= 0 && to > from) { try { doc = JSON.parse(text.slice(from, to + 1)); } catch { /* salvage below */ } }
  if (Array.isArray(doc)) raw = doc;
  else if (doc && typeof doc === 'object') {
    scene = doc.scene;
    raw = [doc.items, doc.objects].find(Array.isArray) ?? (doc.name ?? doc.label ? [doc] : []);
  } else {
    raw = flatObjects(text);
    const m = /"scene"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
    if (m) { try { scene = JSON.parse(m[1]); } catch { /* no scene then */ } }
  }
  const items = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const name = str(it.name ?? it.label, 60);
    if (!name) continue;
    items.push({ name, kind: str(it.kind ?? it.type, 24).toLowerCase().split(' ')[0], box: cleanBox(it.box ?? it.bbox_2d ?? it.bbox), note: str(it.note ?? it.description, 160) });
  }
  return { scene: str(scene, 200), items };
}

/** Mean brightness of an RGBA frame, 0..255, from a sparse sample (every 16th pixel of every 16th row). */
export function brightness({ width, height, data }) {
  let sum = 0, n = 0;
  for (let y = 0; y < height; y += 16) for (let x = 0, i = y * width * 4; x < width; x += 16, i += 64, n++) sum += (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  return n ? sum / n : 0;
}

/** The line format the prompt asks for: `SCENE: ...` and `name | kind | x1,y1,x2,y2 | note` rows (a note may hold a `|`). */
function parseLines(text) {
  let scene = '';
  const items = [];
  for (const line of text.split('\n')) {
    const m = /^\s*scene\s*:\s*(.+)$/i.exec(line);
    if (m) { scene ||= m[1]; continue; }
    const f = line.split('|').map((x) => x.trim());
    if (f.length < 3) continue;
    const name = str(f[0].replace(/^[-*\d.)\s]+/, ''), 60), nums = f[2].match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (!name || /^name$/i.test(name)) continue;   // the header row echoed back
    items.push({ name, kind: str(f[1], 24).toLowerCase().split(' ')[0], box: cleanBox(nums.length === 4 ? nums : null), note: str(f.slice(3).join(' | '), 160) });
  }
  return { scene: str(scene, 200), items };
}

export class Scanner extends EventEmitter {
  static moduleInfo = {
    name: 'scanner',
    lifecycleStart: 'attach',   // `start()` is the scanning switch here
    schema: s()
      .property('model', s('string').default('qwen-vision').meta('description', 'the vision model a scan asks (the same one the agent talks to: one resident model, no swap)'))
      .property('prompt', s('string').default(PROMPT).meta('description', 'the scan prompt; {maxItems} is filled in, the known names are appended'))
      .property('maxItems', s('number').default(6).meta('description', 'objects asked for (and kept) per scan: ~40 tokens each'))
      .property('maxTokens', s('number').default(400).meta('description', 'reply budget per scan; a reply cut off there keeps its complete items'))
      .property('intervalS', s('number').default(10).meta('description', 'while scanning: the next scan this long after the last finished, if no new view came first'))
      .property('minGapMs', s('number').default(3000).meta('description', 'while scanning: never start a scan sooner than this after the last finished'))
      .property('maxScanS', s('number').default(180).meta('description', 'scanning switches itself off after this long'))
      .property('jpegQuality', s('number').default(70).meta('description', 'quality of the frame sent to the model'))
      .property('frameW', s('number').default(120).meta('advanced').meta('description', 'the frame under analysis is offered to views fitted to this width'))
      .property('frameH', s('number').default(90).meta('advanced').meta('description', '... and this height'))
      .property('minLuma', s('number').default(14).meta('description', 'a frame whose mean brightness (0..255) is under this is not scanned'))
      .property('darkRetryMs', s('number').default(500).meta('advanced').meta('description', 'a dark frame of our own capture is retaken once after this long'))
      .property('camera', s('Camera').meta('internal', true))
      .property('world', s('World').meta('internal', true))
      .property('llm', s('Llm').meta('internal', true))
      .property('sensors', s('Sensors').lax().meta('internal', true))
      .property('gps', s('Gps').lax().meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
    register: [Camera, World, { ModuleClass: LookTool, relative: true }],
  };
  model; prompt; maxItems; maxTokens; intervalS; minGapMs; maxScanS; jpegQuality; frameW; frameH; minLuma; darkRetryMs; camera; world; llm; sensors; gps; logger;

  /** scanning is switched on (a scan may or may not be running right now) */ active = false;
  /** scans that filed a frame / that did not, since start */ scans = 0; failures = 0;
  /** @type {string|null} why the last scan failed; null after a good one */ lastError = null;
  /** the clock, a field so tests own time */ now = () => Date.now();
  /**
   * The frame being analysed right now, small (fits `frameW`x`frameH`), for a view to show what
   * "looking" is looking at; null between scans. Set when the frame is taken (`frame` event),
   * cleared when its scan ends.
   * @type {{width: number, height: number, data: Uint8Array}|null}
   */
  frame = null;
  /**
   * When the next scan is due while scanning is on and none is running: `{from, at}` (ms) - a
   * view draws the wait as progress. A head turn can bring it forward. Null when off or looking.
   * @type {{from: number, at: number}|null}
   */
  due = null;
  /** @type {Promise<object[]>|null} the scan in flight */ #running = null;
  #state = 'off'; #timer = null; #deadline = null; #lastEnd = -Infinity; #viewPending = false;
  #onView = () => { if (this.#running) this.#viewPending = this.active; else this.#trigger(); };

  /** @returns {'off'|'idle'|'looking'} `looking` whenever a scan runs, switched on or not (a `look` scans too) */
  get state() { return this.#state; }

  /** Lifecycle start (renamed, see the header): follow the head tracker. */
  async attach() { this.sensors?.on?.('view', this.#onView); }

  /** Scanning on: a scan now (or as soon as the gap allows), then one per new view / interval. */
  start() {
    if (this.active) return;
    this.active = true;
    this.#deadline = setTimeout(() => { this.logger?.info({ s: this.maxScanS }, 'scanner: time is up'); this.stop(); }, this.maxScanS * 1000);
    this.#deadline.unref?.();
    this.#sync();
    this.#trigger();
  }

  /** Scanning off. A scan in flight still finishes and is filed; nothing follows it. */
  stop() {
    if (!this.active) return;
    this.active = false; this.#viewPending = false;
    clearTimeout(this.#timer); clearTimeout(this.#deadline); this.#timer = this.#deadline = null; this.due = null;
    this.#sync();
  }

  /** @returns {boolean} whether scanning is on now */
  toggle() { if (this.active) this.stop(); else this.start(); return this.active; }

  /**
   * One scan, whether scanning is on or not: of `image` when given (the `look` tool's frame),
   * else of a fresh capture. Joins the scan in flight when there is one (its frame, not this
   * one). Never rejects: a failure resolves `[]` and shows in `failures` / `lastError`.
   * @param {{image?: {width: number, height: number, data: Uint8Array, t?: number}}} [options]
   * @returns {Promise<object[]>} the entities the frame touched
   */
  scanOnce({ image } = {}) {
    if (this.#running) return this.#running;
    clearTimeout(this.#timer); this.#timer = null; this.due = null;
    const t0 = this.now();
    const done = () => {
      this.#running = null; this.#lastEnd = this.now();
      if (this.frame) { this.frame = null; this.emit('frame', null); }
      if (this.active) this.#arm(this.#viewPending ? this.minGapMs : Math.max(this.intervalS * 1000, this.minGapMs));
      this.#viewPending = false;
      this.#sync();
    };
    this.#running = this.#scan(image).then((result) => {
      this.scans++; this.lastError = null;
      const ms = this.now() - t0;
      this.logger?.info({ ms, items: result.items, entities: result.entities.map((e) => e.id).join(' '), tokens: result.usage?.completion }, 'scanner: scan');
      done();
      this.emit('scan', { entities: result.entities, ms });
      return result.entities;
    }, (error) => {
      this.failures++; this.lastError = error.message;
      this.logger?.warn({ error: error.message, failures: this.failures, ms: this.now() - t0 }, 'scanner: scan failed');
      done();
      return [];
    });
    this.#sync();
    return this.#running;
  }

  async #scan(image) {
    const own = !image;
    image ??= await this.camera.capture();
    // The first frames of a camera stream are black (auto-exposure has not found its level; jetd
    // has been seen to hand one out). A black frame costs a model call, comes back as "the image
    // is completely black", and its crops replace good thumbnails with dark ones: not worth
    // sending. Our own capture gets one more try; a frame handed to us is the caller's choice.
    if (own && brightness(image) < this.minLuma) {
      await new Promise((r) => setTimeout(r, this.darkRetryMs));
      image = await this.camera.capture();
    }
    if (brightness(image) < this.minLuma) throw new Error('the frame is too dark to scan');
    this.frame = crop(image, { x: 0, y: 0, w: image.width, h: image.height }, { maxW: this.frameW ?? 120, maxH: this.frameH ?? 90 });
    this.emit('frame', this.frame);
    const fix = this.gps?.goodFix?.();   // where we are as the frame is taken, not ~4 s later
    const jpeg = this.camera.jpeg(image, { quality: this.jpegQuality });
    const known = this.world.entities();
    const { content, usage } = await this.llm.chat({
      model: this.model, maxTokens: this.maxTokens, temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }, { type: 'text', text: this.#prompt(known) }] }],
    });
    const { scene, items } = parseScan(content);
    if (!scene && !items.length) throw new Error(`unreadable reply: ${String(content ?? '').slice(0, 80) || '(empty)'}`);
    // a known name coming back is the model saying "that one again", but it words the kind
    // afresh each time (tool / soldering): the kind on record goes with a reused name, so the
    // world's name-and-kind association sees the same thing
    const kinds = new Map(known.toReversed().map((e) => [e.name.toLowerCase(), e.kind]));
    for (const item of items) item.kind = kinds.get(item.name.toLowerCase()) || item.kind;
    const entities = this.world.observe({ t: image.t, image, where: fix ? { lat: fix.lat, lon: fix.lon } : undefined, scene, items: items.slice(0, this.maxItems) });
    return { entities, items: items.length, usage };
  }

  #prompt(known) {
    known = [...new Set(known.map((e) => e.name))].slice(0, KNOWN_NAMES);
    return this.prompt.replaceAll('{maxItems}', this.maxItems) + (known.length ? `\nSeen here before: ${known.join(', ')}. Reuse one of these names, exactly, only for the very same physical object; a different object gets a new name even if it carries the same brand or text.` : '');
  }

  /** Scan now if the gap since the last one allows, else when it does. */
  #trigger() {
    if (!this.active || this.#running) return;
    const wait = this.#lastEnd + this.minGapMs - this.now();
    if (wait > 0) this.#arm(wait); else this.scanOnce();
  }

  #arm(ms) {
    clearTimeout(this.#timer);
    const from = this.now();
    this.due = { from, at: from + ms };
    this.emit('due', this.due);
    this.#timer = setTimeout(() => { this.#timer = null; this.#trigger(); }, ms);
    this.#timer.unref?.();
  }

  #sync() {
    const state = this.#running ? 'looking' : this.active ? 'idle' : 'off';
    if (state === this.#state) return;
    this.#state = state;
    this.emit('state', state);
  }
}
