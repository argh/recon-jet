// world: what the glasses have seen, as a model. The record is a log of sightings (one analysed
// frame each: when, where, the scene line, which entities were in it); entities are an index
// over that log, each a timestamped list of *claims* rather than a truth. Association is naive
// on purpose (same name or one name containing the other, and the same kind): the scanner hands
// the known names to the vision model and asks it to reuse them, which does most of the work,
// and a wrong merge or a duplicate costs nothing downstream. An entity keeps one thumbnail (the
// crop of its newest sighting, a JPEG under `dir/thumbs`); unpinned entities expire `ttlS`
// after they were last seen. Everything handed out is a copy: the records stay ours.
// Persistence is `dir/world.json`, written atomically a little after the last change.
// The world is also a ContextSource for the agent: one line naming the newest few things.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import jpegJs from 'jpeg-js';
import { Schema } from '@versionzero/module-manager';
import { crop } from '../camera/index.js';
import { SightingsTool } from './sightings-tool.js';

const s = Schema.create;

/** A name as association compares it: lower case, punctuation to spaces, no leading article. */
export const normaliseName = (name) => String(name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^(?:a|an|the|some) (?=\S)/, '');

/**
 * Same thing by name: equal, or one holding the other as whole words ("fluke meter" in "fluke
 * meter probe", never "pen" in "pencil"). The held name must be two words or more: a one-word
 * name is a category, not an identity, and on the device "Box" swallowed every box on the desk.
 */
const holds = (long, short) => short.includes(' ') && ` ${long} `.includes(` ${short} `);
const sameName = (a, b) => a === b || holds(a, b) || holds(b, a);

/**
 * A model box (`[x1, y1, x2, y2]`, 0..1000 against the image) as a pixel rectangle, grown by
 * `pad` of its own size on every side. Not clamped: `crop` does that.
 * @returns {{x: number, y: number, w: number, h: number}|null} null for anything that is not a box
 */
export function boxRect(box, width, height, pad = 0) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return null;
  const x1 = Math.min(box[0], box[2]) * width / 1000, x2 = Math.max(box[0], box[2]) * width / 1000;
  const y1 = Math.min(box[1], box[3]) * height / 1000, y2 = Math.max(box[1], box[3]) * height / 1000;
  const w = x2 - x1, h = y2 - y1;
  if (!(w > 0 && h > 0)) return null;
  return { x: x1 - w * pad, y: y1 - h * pad, w: w * (1 + 2 * pad), h: h * (1 + 2 * pad) };
}

/**
 * Does the name carry a model number that no observation read off the object? The scan prompt
 * asks for readable text in double quotes, so "read" means: quoted in some claim.
 */
export function unreadModel(e) {
  const models = e.name.match(/[A-Za-z-]*\d[\w-]*/g);
  if (!models) return false;
  const read = e.claims.flatMap((c) => c.text.match(/"[^"]+"/g) ?? []).join(' ').toLowerCase();
  return models.some((m) => !read.includes(m.toLowerCase()));
}

const text = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
const copy = (e) => ({ ...e, ...(e.where && { where: { ...e.where } }), claims: e.claims.map((c) => ({ ...c })), obs: (e.obs ?? []).map((o) => ({ ...o })) });
const number = (id) => +String(id).slice(1) || 0;
const FILLER = new Set('a an the some is are was were where what which when did do does you i my me it that this there here of in on at to and or have has seen see saw'.split(' '));

export class World extends EventEmitter {
  static moduleInfo = {
    name: 'world',
    provides: 'ContextSource',
    schema: s()
      .property('dir', s('string').default('/android-data/mainline/world').meta('description', 'world.json and thumbs/ live here; empty = nothing is persisted'))
      .property('ttlS', s('number').default(1800).meta('description', 'an unpinned entity not seen for this long expires'))
      .property('maxEntities', s('number').default(60).meta('description', 'entities kept; past it the longest unseen go, unpinned first'))
      .property('maxClaims', s('number').default(20).meta('description', 'claims kept per entity, oldest dropped'))
      .property('maxSightings', s('number').default(200).meta('description', 'analysed frames kept in the sightings log'))
      .property('thumbW', s('number').default(96).meta('description', 'thumbnail fits this width'))
      .property('thumbH', s('number').default(72).meta('description', 'thumbnail fits this height'))
      .property('thumbPad', s('number').default(0.08).meta('description', 'the box is grown by this fraction of its size before the crop'))
      .property('thumbQuality', s('number').default(75).meta('advanced').meta('description', 'thumbnail JPEG quality'))
      .property('cropW', s('number').default(320).meta('description', 'an observation\'s crop fits this width (never enlarged): the evidence a later check looks at'))
      .property('cropH', s('number').default(240).meta('description', 'an observation\'s crop fits this height'))
      .property('maxCrops', s('number').default(4).meta('description', 'observations (with their crops) kept per entity: the newest ones and always the largest crop'))
      .property('contextItems', s('number').default(5).meta('description', 'entities named on the agent context line'))
      .property('saveMs', s('number').default(2000).meta('advanced').meta('description', 'world.json is written this long after a change'))
      .property('logger', s('Logger').lax().meta('internal', true)),
    register: [{ ModuleClass: SightingsTool, relative: true }],
  };
  dir; ttlS; maxEntities; maxClaims; maxSightings; thumbW; thumbH; thumbPad; thumbQuality; cropW; cropH; maxCrops; contextItems; saveMs; logger;

  /** ContextSource id */ id = 'world';
  /** the clock, a field so tests own time */ now = () => Date.now();
  /** @type {Map<string, object>} id -> entity record */ #entities = new Map();
  /** @type {object[]} the sightings log, oldest first */ #sightings = [];
  #seq = 0; #sightingSeq = 0; #obsSeq = 0;
  /** @type {Map<string, Buffer>} observation crops (JPEG) not on disk yet */ #cropUnsaved = new Map();
  /** @type {Set<string>} observation crops to remove from disk */ #cropDead = new Set();
  /** @type {Map<string, object|null>} decoded thumbnails; null = looked for, none */ #thumbs = new Map();
  /** @type {Map<string, Buffer>} thumbnails not on disk yet */ #unsaved = new Map();
  /** @type {Set<string>} thumbnails to remove from disk */ #dead = new Set();
  #saveTimer = null; #writing = Promise.resolve();

  /** Read what the last run left. A missing or damaged file is an empty world. */
  async start() {
    if (!this.dir) return;
    try {
      const o = JSON.parse(await fs.promises.readFile(path.join(this.dir, 'world.json'), 'utf8'));
      for (const e of Array.isArray(o.entities) ? o.entities : []) {
        if (e && typeof e.id === 'string' && typeof e.name === 'string') this.#entities.set(e.id, { ...e, claims: Array.isArray(e.claims) ? e.claims : [], obs: Array.isArray(e.obs) ? e.obs : [] });
      }
      this.#sightings = Array.isArray(o.sightings) ? o.sightings.filter((x) => x && Array.isArray(x.entityIds)) : [];
      this.#seq = Math.max(+o.seq || 0, ...[...this.#entities.keys()].map(number));
      this.#sightingSeq = Math.max(+o.sightingSeq || 0, ...this.#sightings.map((x) => number(x.id)));
      this.#obsSeq = Math.max(+o.obsSeq || 0, ...[...this.#entities.values()].flatMap((e) => (e.obs ?? []).map((o) => number(o.id))));
      this.#sweep(this.now());
      this.logger?.info({ entities: this.#entities.size, sightings: this.#sightings.length }, 'world: loaded');
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.warn({ error: error.message }, 'world: not loaded');
    }
  }

  /** Lifecycle: whatever is unsaved goes to disk. */
  async stop() { await this.flush(); }

  // ---- reading ----------------------------------------------------------------------------------
  /** The live entities, most recently seen first. */
  entities() { return this.#live().map(copy); }

  /** @returns {object|null} the entity, or null when unknown or expired */
  get(id) { const e = this.#entities.get(id); return e && !this.#expired(e, this.now()) ? copy(e) : null; }

  /**
   * Entities a free-text query touches: an id, or any of its words in the name, the kind or a
   * claim. Best match first (more of the words), then most recent.
   */
  find(query) {
    const q = normaliseName(query);
    if (!q) return [];
    // the model asks in sentences ("where are the spools"): filler never matches, a longer word
    // matches as a word prefix with its plural s off, a short one only whole
    const words = q.split(' ').filter((w) => !FILLER.has(w)).map((w) => (w.length > 3 ? ` ${w.replace(/s$/, '')}` : ` ${w} `));
    const scored = [];
    for (const e of this.#live()) {
      if (e.id === q) { scored.push([Infinity, e]); continue; }
      const hay = ` ${normaliseName(`${e.name} ${e.kind} ${e.claims.map((c) => c.text).join(' ')}`)} `;
      const hits = words.reduce((n, w) => n + hay.includes(w), 0);
      if (hits) scored.push([hits, e]);
    }
    return scored.sort((a, b) => b[0] - a[0]).map(([, e]) => copy(e));   // stable: recency within a score
  }

  /** The sightings log, newest first: `{id, t, where?, scene, entityIds}`. */
  sightings() { return this.#sightings.map((x) => ({ ...x, ...(x.where && { where: { ...x.where } }), entityIds: [...x.entityIds] })).reverse(); }

  /**
   * An entity's thumbnail as RGBA (shared: read-only). Decoded from its JPEG on first use
   * after a restart, then kept in memory.
   * @returns {{width: number, height: number, data: Uint8Array}|null}
   */
  thumb(id) {
    if (this.#thumbs.has(id)) return this.#thumbs.get(id);
    let image = null;
    if (this.dir && this.#entities.has(id)) {
      try { image = jpegJs.decode(fs.readFileSync(this.#thumbFile(id)), { useTArray: true, formatAsRGBA: true }); image = { width: image.width, height: image.height, data: image.data }; }
      catch { /* never had one, or it is gone */ }
    }
    this.#thumbs.set(id, image);
    return image;
  }

  /**
   * What the wearer has picked out on their display (the Scan screen's selection), or null. It
   * is state of the world model, not of a screen: "this" in a question means it wherever the
   * question is answered. @param {string|null} [id] set it (null clears); no argument reads it
   * @returns {object|null} the focused entity (a copy), null when none or it has expired
   */
  focus(id) {
    if (id !== undefined) this.#focus = id && this.#entities.has(id) ? id : null;
    return this.#focus ? this.get(this.#focus) : null;
  }
  #focus = null;

  /** ContextSource: what is selected, and the newest few things in view; null when there is nothing to say. */
  context() {
    const t = this.now(), recent = this.#live().filter((e) => t - e.lastSeen <= this.ttlS * 1000).slice(0, this.contextItems ?? 5);
    const f = this.focus();
    const selected = f ? `Selected on your partner's display right now: ${f.name} [${f.id}]. "This", "that" or "it" means that item: see it with look item ${f.id}, do not take a new photo.` : null;
    if (!recent.length) return selected;
    return [selected, this.#inView(recent)].filter(Boolean).join('\n');
  }

  #inView(recent) {
    // a model number nobody read off the object is the model's guess, and a guess stated as a
    // fact outvotes the photo in front of it: say which names are guesses
    return `In view lately (names are from earlier glances and may be wrong): ${recent.map((e) => { const c = e.claims.at(-1)?.text; return `${e.name}${unreadModel(e) ? ' (model number is a guess)' : ''} [${e.id}]${c ? ` (${c.length > 48 ? `${c.slice(0, 47)}…` : c})` : ''}`; }).join(', ')}`;
  }

  // ---- writing ----------------------------------------------------------------------------------
  /**
   * File one analysed frame: each item joins the entity it names (or founds one), its note
   * becomes a claim, its box the entity's new thumbnail; the frame itself goes on the
   * sightings log. Items without a name are ignored; a missing or bad box just means no crop.
   * @param {{t?: number, image?: {width: number, height: number, data: Uint8Array}, where?: {lat: number, lon: number}, scene?: string, items?: {name: string, kind?: string, box?: number[], note?: string}[]}} frame
   * @returns {object[]} the entities this frame touched, in item order
   */
  observe({ t = this.now(), image, where, scene, items = [] } = {}) {
    this.#sweep(t);
    const touched = new Map(), entries = [];
    for (const item of Array.isArray(items) ? items : []) {
      const name = text(item?.name, 60), kind = text(item?.kind, 24).toLowerCase(), key = normaliseName(name);
      if (!key) continue;
      let e = this.#match(key, kind);
      const created = !e;
      if (!e) {
        e = { id: `e${++this.#seq}`, name, kind, firstSeen: t, lastSeen: t, seen: 0, pinned: false, claims: [], obs: [] };
        this.#entities.set(e.id, e);
      }
      if (!touched.has(e.id)) {   // twice in one frame is still one sighting
        touched.set(e.id, e);
        e.seen++; e.lastSeen = t;
        if (!e.kind) e.kind = kind;
        if (where) e.where = { ...where };
        if (image) this.#setThumb(e.id, image, item.box);
      }
      this.#claim(e, item.note, 'scan', t);
      // the observation: what was claimed, under which name, and the pixels it was claimed of.
      // It is the evidence a later check works from, so it keeps the model's own words. (The
      // claims are the readable log: deduplicated text. These are the record behind it.)
      const id = `o${++this.#obsSeq}`, area = this.#keepCrop(id, image, item.box);
      (e.obs ??= []).push({ id, t, name, kind, note: text(item.note, 200), ...(area && { area }) });
      this.#trim(e);
      entries.push({ obs: id, entity: e.id, created });
    }
    this.#sightings.push({ id: `s${++this.#sightingSeq}`, t, ...(where && { where: { ...where } }), scene: text(scene, 200), entityIds: [...touched.keys()] });
    if (this.#sightings.length > this.maxSightings) this.#sightings.splice(0, this.#sightings.length - this.maxSightings);
    this.#evict(touched);
    this.#changed();
    // for whoever checks identities in the background (the curator): which observation went where
    this.emit('observed', { t, entries: entries.filter((x) => this.#entities.has(x.entity)) });
    return [...touched.values()].filter((e) => this.#entities.has(e.id)).map(copy);
  }

  // ---- identity: an entity is a hypothesis over its observations, and can be revised -----------
  /** An observation's crop as a JPEG (the evidence), or null when it was not kept. */
  crop(obs) {
    if (this.#cropUnsaved.has(obs)) return this.#cropUnsaved.get(obs);
    if (!this.dir || this.#cropDead.has(obs)) return null;
    try { return fs.readFileSync(this.#cropFile(obs)); } catch { return null; }
  }

  /** Where an observation is filed now. @returns {{entity: object, obs: object}|null} copies */
  observation(id) {
    const found = this.#obsOf(id);
    return found ? { entity: copy(found.entity), obs: { ...found.obs } } : null;
  }

  /** Record what a check concluded about an observation (so it is not asked again). */
  mark(obs, verdict) {
    const o = this.#obsOf(obs)?.obs;
    if (!o) return false;
    o.checked = text(verdict, 40);
    this.#changed();
    return true;
  }

  /**
   * Whether two entities are known to be different things (a check compared them and said so),
   * and with `set` the recording of it: a pair is asked about once.
   * @returns {boolean}
   */
  distinct(a, b, set = false) {
    const ea = this.#entities.get(a), eb = this.#entities.get(b);
    if (!ea || !eb || a === b) return false;
    if (set && !ea.distinct?.includes(b)) {
      ea.distinct = [...(ea.distinct ?? []), b].slice(-24); eb.distinct = [...(eb.distinct ?? []), a].slice(-24);
      this.#changed();
    }
    return Boolean(ea.distinct?.includes(b));
  }

  /**
   * Two entities turned out to be one thing: `from`'s observations join `into` (which keeps its
   * name and id; the other name is remembered as an alias), and `from` is gone.
   * @returns {object|null} the merged entity
   */
  merge(fromId, intoId) {
    const from = this.#entities.get(fromId), into = this.#entities.get(intoId);
    if (!from || !into || from === into) return null;
    into.claims = [...into.claims, ...from.claims].sort((a, b) => a.t - b.t);
    into.obs = [...(into.obs ?? []), ...(from.obs ?? [])].sort((a, b) => a.t - b.t);
    into.seen += from.seen; into.firstSeen = Math.min(into.firstSeen, from.firstSeen); into.lastSeen = Math.max(into.lastSeen, from.lastSeen);
    into.pinned ||= from.pinned;
    if (from.where && !into.where) into.where = from.where;
    if (from.distinct || into.distinct) into.distinct = [...new Set([...(into.distinct ?? []), ...(from.distinct ?? [])])].filter((id) => id !== intoId && id !== fromId).slice(-24);
    if (normaliseName(from.name) !== normaliseName(into.name)) into.aliases = [...new Set([...(into.aliases ?? []), from.name, ...(from.aliases ?? [])])].slice(-6);
    from.obs = [];   // its crops live on under `into`
    this.#drop(fromId);
    for (const x of this.#sightings) if (x.entityIds.includes(fromId)) x.entityIds = [...new Set(x.entityIds.map((id) => (id === fromId ? intoId : id)))];
    this.#trim(into); this.#rethumb(into);
    this.logger?.info({ from: `${fromId} ${from.name}`, into: `${intoId} ${into.name}` }, 'world: merged');
    this.#changed();
    return copy(into);
  }

  /**
   * An observation turned out not to be of the entity it was filed under: it becomes an entity
   * of its own, under the name it was observed by.
   * @returns {object|null} the new entity (null: unknown observation, or it is all its entity has)
   */
  split(obs) {
    const found = this.#obsOf(obs);
    if (!found || found.entity.obs.length < 2) return null;
    const { entity: e, obs: o } = found;
    e.obs.splice(e.obs.indexOf(o), 1);
    // the claim that observation made goes with it, unless another observation made it too
    const claim = e.claims.find((c) => c.t === o.t && c.text === o.note && !e.obs.some((x) => x.note === o.note));
    if (claim) e.claims.splice(e.claims.indexOf(claim), 1);
    e.seen = Math.max(1, e.seen - 1); e.lastSeen = Math.max(...e.obs.map((x) => x.t));
    const n = { id: `e${++this.#seq}`, name: o.name || e.name, kind: o.kind || e.kind, firstSeen: o.t, lastSeen: o.t, seen: 1, pinned: false,
      claims: o.note ? [{ t: o.t, text: o.note, source: 'scan' }] : [], obs: [o], ...(e.where && { where: { ...e.where } }) };
    this.#entities.set(n.id, n);
    this.#rethumb(e); this.#rethumb(n);
    this.logger?.info({ obs, from: `${e.id} ${e.name}`, as: `${n.id} ${n.name}` }, 'world: split');
    this.#changed();
    return copy(n);
  }

  /** Pin (or unpin) an entity: a pinned one does not expire. @returns {boolean} whether it exists */
  pin(id, on = true) {
    const e = this.#entities.get(id);
    if (!e) return false;
    if (e.pinned !== !!on) { e.pinned = !!on; this.#changed(); }
    return true;
  }

  /** Drop an entity and its thumbnail (the sightings that mention it stay, as history). */
  forget(id) {
    if (!this.#drop(id)) return false;
    this.#changed();
    return true;
  }

  /** Add a claim by hand (the agent, the wearer). @returns {object|null} the entity */
  note(id, claim, source = 'user') {
    const e = this.#entities.get(id);
    if (!e) return null;
    if (this.#claim(e, claim, source, this.now())) this.#changed();
    return copy(e);
  }

  /** Write now whatever is waiting (shutdown, tests). Resolves when it is on disk. */
  flush() {
    clearTimeout(this.#saveTimer); this.#saveTimer = null;
    if (!this.dir) return Promise.resolve();
    this.#writing = this.#writing.then(() => this.#write()).catch((error) => this.logger?.warn({ error: error.message }, 'world: not saved'));
    return this.#writing;
  }

  // ---- internals --------------------------------------------------------------------------------
  #expired(e, t) { return !e.pinned && t - e.lastSeen > this.ttlS * 1000; }

  /** Live records, most recently seen first; within one frame, in the order the model listed them. */
  #live() {
    const t = this.now();
    return [...this.#entities.values()].filter((e) => !this.#expired(e, t)).sort((a, b) => b.lastSeen - a.lastSeen || number(a.id) - number(b.id));
  }

  /** The entity an item belongs to: an exact name before a containing one, the latest seen first. */
  #match(key, kind) {
    let best = null, bestExact = false;
    for (const e of this.#entities.values()) {
      if (e.kind && kind && e.kind !== kind) continue;
      const other = normaliseName(e.name);
      if (!sameName(key, other)) continue;
      const exact = other === key;
      if (!best || (exact && !bestExact) || (exact === bestExact && e.lastSeen > best.lastSeen)) { best = e; bestExact = exact; }
    }
    return best;
  }

  /** Append a claim unless it only repeats the latest one. */
  #claim(e, claim, source, t) {
    claim = text(claim, 200);
    if (!claim || e.claims.at(-1)?.text.toLowerCase() === claim.toLowerCase()) return false;
    e.claims.push({ t, text: claim, source });
    if (e.claims.length > this.maxClaims) e.claims.splice(0, e.claims.length - this.maxClaims);
    return true;
  }

  #obsOf(id) {
    for (const entity of this.#entities.values()) { const obs = entity.obs?.find((o) => o.id === id); if (obs) return { entity, obs }; }
    return null;
  }

  /** Keep the bounds: `maxCrops` observations per entity, the newest ones and always the one with the largest crop. */
  #trim(e) {
    const over = (e.obs?.length ?? 0) - (this.maxCrops ?? 4);
    if (over <= 0) return;
    const largest = e.obs.reduce((a, b) => ((b.area ?? 0) > (a.area ?? 0) ? b : a));
    for (const o of e.obs.filter((x) => x !== largest).slice(0, over)) { this.#dropCrop(o); e.obs.splice(e.obs.indexOf(o), 1); }
  }

  #dropCrop(o) {
    if (!o.area) return;
    delete o.area;
    this.#cropUnsaved.delete(o.id);
    if (this.dir) this.#cropDead.add(o.id);
  }

  /** Cut the observation's crop out of the frame and keep it as a JPEG. @returns {number} its area in pixels, 0 when there is none */
  #keepCrop(obs, image, box) {
    const rect = image && boxRect(box, image.width, image.height, this.thumbPad);
    const cut = rect && crop(image, rect, { maxW: this.cropW ?? 320, maxH: this.cropH ?? 240 });
    if (!cut) return 0;
    this.#cropUnsaved.set(obs, jpegJs.encode(cut, this.thumbQuality ?? 75).data);
    return cut.width * cut.height;
  }

  /** The thumbnail again, from the newest crop the entity still has (after a merge or a split). */
  #rethumb(e) {
    const o = e.obs?.findLast((x) => x.area), jpg = o && this.crop(o.id);
    if (!jpg) return;   // no crop left to make one from: the thumbnail it has stays (a picture that vanishes from a list reads as a fault)
    this.#thumbs.delete(e.id);
    try {
      const d = jpegJs.decode(jpg, { useTArray: true, formatAsRGBA: true });
      const thumb = crop({ width: d.width, height: d.height, data: d.data }, { x: 0, y: 0, w: d.width, h: d.height }, { maxW: this.thumbW, maxH: this.thumbH });
      this.#thumbs.set(e.id, thumb);
      if (this.dir) { this.#unsaved.set(e.id, jpegJs.encode(thumb, this.thumbQuality ?? 75).data); this.#dead.delete(e.id); }
    } catch (error) { this.logger?.warn({ id: e.id, error: error.message }, 'world: no thumbnail'); }
  }

  #setThumb(id, image, box) {
    const rect = boxRect(box, image.width, image.height, this.thumbPad);
    const thumb = rect && crop(image, rect, { maxW: this.thumbW, maxH: this.thumbH });
    if (!thumb) return;
    this.#thumbs.set(id, thumb);
    if (this.dir) { this.#unsaved.set(id, jpegJs.encode(thumb, this.thumbQuality ?? 75).data); this.#dead.delete(id); }
  }

  #drop(id) {
    for (const o of this.#entities.get(id)?.obs ?? []) this.#dropCrop(o);
    if (!this.#entities.delete(id)) return false;
    this.#thumbs.delete(id); this.#unsaved.delete(id);
    if (this.dir) this.#dead.add(id);
    return true;
  }

  /** Expired entities go. @returns {number} how many */
  #sweep(t) {
    let n = 0;
    for (const e of [...this.#entities.values()]) if (this.#expired(e, t) && this.#drop(e.id)) n++;
    return n;
  }

  /**
   * Hold the bound: the longest unseen go first, pinned ones only when nothing else is left,
   * and what the current frame holds last of all (a world full of pins still sees).
   */
  #evict(current) {
    const over = this.#entities.size - this.maxEntities;
    if (over <= 0) return;
    const oldest = [...this.#entities.values()].sort((a, b) => current.has(a.id) - current.has(b.id) || a.pinned - b.pinned || a.lastSeen - b.lastSeen || number(a.id) - number(b.id));
    for (const e of oldest.slice(0, over)) this.#drop(e.id);
  }

  #changed() {
    if (this.dir && !this.#saveTimer) {
      this.#saveTimer = setTimeout(() => { this.#saveTimer = null; this.flush(); }, this.saveMs ?? 2000);
      this.#saveTimer.unref?.();
    }
    this.emit('change');
  }

  #thumbFile(id) { return path.join(this.dir, 'thumbs', `${id}.jpg`); }
  #cropFile(obs) { return path.join(this.dir, 'crops', `${obs}.jpg`); }

  /** Thumbnails first, then the index, temp file + rename: a power cut leaves the old world. */
  async #write() {
    const unsaved = [...this.#unsaved], dead = [...this.#dead];
    this.#unsaved.clear(); this.#dead.clear();
    await fs.promises.mkdir(path.join(this.dir, 'thumbs'), { recursive: true });
    for (const [id, jpg] of unsaved) await fs.promises.writeFile(this.#thumbFile(id), jpg);
    for (const id of dead) await fs.promises.rm(this.#thumbFile(id), { force: true });
    const crops = [...this.#cropUnsaved], cropsDead = [...this.#cropDead];
    this.#cropDead.clear();
    await fs.promises.mkdir(path.join(this.dir, 'crops'), { recursive: true });
    for (const [obs, jpg] of crops) { await fs.promises.writeFile(this.#cropFile(obs), jpg); if (this.#cropUnsaved.get(obs) === jpg) this.#cropUnsaved.delete(obs); }
    for (const obs of cropsDead) await fs.promises.rm(this.#cropFile(obs), { force: true });
    const file = path.join(this.dir, 'world.json'), tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ v: 2, seq: this.#seq, sightingSeq: this.#sightingSeq, obsSeq: this.#obsSeq, entities: [...this.#entities.values()], sightings: this.#sightings }) + '\n');
    await fs.promises.rename(tmp, file);
  }
}
