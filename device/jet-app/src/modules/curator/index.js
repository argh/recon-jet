// curator: the background sanity checks on the world model (docs/agent.md). The world files an
// observation by the name the scan gave it, at once, because the glass wants an answer now; that
// is a string match, and a string match is wrong in both directions (the same station under two
// names, a mug filed under the magazine whose logo it carries). The curator goes back over those
// decisions with the evidence: it puts the observation's crop beside a crop of an entity it could
// be, as ONE picture (left | right), asks the model whether the two halves show the very same
// object, and revises the world to match (`merge`, `split`). An observation is settled once; the
// outcome is recorded on it.
//
// One picture, two halves, one candidate at a time - not a line-up of separate pictures. Measured
// on qwen-vision with real crops: asked "which of pictures 1-3 is X" it mixed the pictures up
// (3 of 6 right, with reasons taken from the wrong image); asked about the two halves of one
// composite it was right 10 of 10. So a check is up to `maxCandidates` yes/no questions, the
// entity it was filed under first, and stops at the first "same".
//
// What is asked first follows from temporal coherence. Consecutive frames mostly show the same
// things, so an observation that joined an entity of the current set is the least doubtful and
// waits; a brand-new entity might be a known thing under a new name, and an observation that
// joined something NOT in the recent frames (you looked away and back - or the name was reused
// for something else) is where the string match is most often wrong. Those two go first.
//
// One request at a time, at most `perMinute`: the model has four slots and a conversation must
// never wait behind housekeeping.
import { EventEmitter } from 'node:events';
import jpegJs from 'jpeg-js';
import { Schema } from '@versionzero/module-manager';
import { sideBySide } from '../camera/index.js';

const s = Schema.create;

const PROMPT = 'This picture is two crops from a head-mounted camera side by side, separated by a white bar: LEFT and RIGHT. '
  + 'They were taken minutes apart in the same place; angle, distance and light may differ. '
  + 'Do LEFT and RIGHT show the very same physical object (the same item, not merely the same kind of thing)? '
  + 'Answer on one line: SAME, DIFFERENT, or UNSURE if too unclear to tell; then a dash and at most eight words of why.';

const WORDS = new Set('a an the of and with on in black white grey gray red blue green yellow small large big old new'.split(' '));
const words = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length > 2 && !WORDS.has(w));

/** @returns {{verdict: 'same'|'different'|'unsure', why: string}} what the model's line says */
export function parseVerdict(text) {
  const line = String(text ?? '').trim().split('\n')[0] ?? '', head = line.split(/[-–—:;,.]/)[0].toUpperCase();
  const why = line.replace(/^[^-–—:;,.]*[-–—:;,.]\s*/, '').slice(0, 80);
  return { verdict: /^\W*SAME\b/.test(head) ? 'same' : /^\W*DIFFERENT\b/.test(head) ? 'different' : 'unsure', why: why === line ? '' : why };
}

const decode = (jpg) => { const d = jpegJs.decode(jpg, { useTArray: true, formatAsRGBA: true }); return { width: d.width, height: d.height, data: d.data }; };

export class Curator extends EventEmitter {
  static moduleInfo = {
    name: 'curator',
    schema: s()
      .property('enabled', s('boolean').default(true).meta('description', 'check the world model\'s identity decisions in the background'))
      .property('apply', s('boolean').default(true).meta('description', 'act on the verdicts (merge, split); off = only log what would be done'))
      .property('model', s('string').default('qwen-vision').meta('description', 'the vision model asked (the one everything else uses)'))
      .property('perMinute', s('number').default(6).meta('description', 'observations checked per minute at most (each is up to maxCandidates questions)'))
      .property('maxCandidates', s('number').default(3).meta('description', 'entities an observation is compared against, one question each, until one is the same'))
      .property('pairHeight', s('number').default(200).meta('description', 'height of the side-by-side picture a question shows'))
      .property('recentS', s('number').default(120).meta('description', 'frames this recent are "the current set": joining one of their entities is trusted first, checked last'))
      .property('minArea', s('number').default(4800).meta('description', 'crops smaller than this many pixels are not evidence (80x60): such an observation is left as filed'))
      .property('world', s('World').meta('internal', true))
      .property('llm', s('Llm').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  enabled; apply; model; perMinute; maxCandidates; pairHeight; recentS; minArea; world; llm; logger;

  now = () => Date.now();
  /** counters, for a status readout and the tests */ stats = { checked: 0, questions: 0, same: 0, merged: 0, split: 0, moved: 0, unsure: 0, failed: 0 };
  /** @type {{obs: string, frame: string[], doubt: number}[]} waiting, most doubtful first; `frame`: the observations of the same frame */ #queue = [];
  #running = false; #timer = null; #lastAt = -Infinity;
  #abort = new AbortController();
  #onObserved = (f) => this.#observed(f);

  async start() { if (this.enabled) this.world.on('observed', this.#onObserved); }
  async stop() { this.world.off('observed', this.#onObserved); clearTimeout(this.#timer); this.#abort.abort(); }

  /** Observations waiting for their check. */
  get pending() { return this.#queue.length; }
  /** Resolves when nothing is waiting or running (tests). */
  async idle() {
    const keep = setInterval(() => {}, 1000);   // the pump's own timer does not hold the process
    try { while (this.#running || this.#queue.length) await new Promise((r) => this.once('checked', r)); } finally { clearInterval(keep); }
  }

  // ---- what to ask about ------------------------------------------------------------------------
  #observed({ t, entries }) {
    const frame = entries.map((x) => x.obs);   // by observation: where each is filed may change before its turn comes
    // the current set: what the frames before this one showed, within `recentS`
    const recent = new Set(this.world.sightings().slice(1).filter((x) => t - x.t <= this.recentS * 1000).flatMap((x) => x.entityIds));
    for (const { obs, entity, created } of entries) this.#queue.push({ obs, frame, doubt: created ? 2 : recent.has(entity) ? 0 : 3 });
    this.#queue.sort((a, b) => b.doubt - a.doubt);   // stable: oldest first within a level
    this.#pump();
  }

  #pump() {
    if (this.#running || this.#timer || !this.#queue.length || this.#abort.signal.aborted) return;
    const wait = Math.max(0, this.#lastAt + 60000 / this.perMinute - this.now());
    this.#timer = setTimeout(() => { this.#timer = null; this.#next(); }, wait);
    this.#timer.unref?.();
  }

  async #next() {
    const job = this.#queue.shift();
    if (!job) return;
    this.#running = true; this.#lastAt = this.now();
    try { await this.#check(job); }
    catch (error) { this.stats.failed++; if (!this.#abort.signal.aborted) this.logger?.warn({ obs: job.obs, error: error.message }, 'curator: check failed'); }
    finally { this.#running = false; this.emit('checked', job.obs); this.#pump(); }
  }

  // ---- one check --------------------------------------------------------------------------------
  /** The entities this observation could be: its own (if it has other evidence) first, then the likeliest others. */
  #candidates(entity, obs, frame) {
    const mine = new Set(words(obs.name));
    const near = new Set(this.world.sightings().filter((x) => x.entityIds.some((id) => frame.includes(id))).flatMap((x) => x.entityIds));
    const evidence = (e) => e.obs.filter((o) => o.id !== obs.id && (o.area ?? 0) >= this.minArea).sort((a, b) => b.area - a.area)[0];
    const out = [];
    const own = evidence(entity);
    if (own) out.push({ entity, crop: own });
    const scored = [];
    for (const e of this.world.entities()) {
      // not itself, and nothing else seen in the same frame: one frame does not show a thing twice
      if (e.id === entity.id || frame.includes(e.id)) continue;
      const crop = evidence(e);
      if (!crop) continue;
      const score = (e.kind && e.kind === obs.kind ? 2 : 0) + 2 * words([e.name, ...(e.aliases ?? [])].join(' ')).filter((w) => mine.has(w)).length + (near.has(e.id) ? 1 : 0);
      if (score >= 2) scored.push({ score, entity: e, crop });
    }
    scored.sort((a, b) => b.score - a.score || b.entity.lastSeen - a.entity.lastSeen);
    return [...out, ...scored.slice(0, this.maxCandidates - out.length)];
  }

  async #check({ obs: id, frame }) {
    const found = this.world.observation(id);
    if (!found || found.obs.checked) return;   // trimmed, expired, or already asked
    const { entity, obs } = found, x = (obs.area ?? 0) >= this.minArea ? this.world.crop(id) : null;
    frame = frame.map((o) => this.world.observation(o)?.entity.id).filter(Boolean);   // the entities that frame showed, as they stand now
    if (!x) return this.world.mark(id, 'no evidence');
    const candidates = this.#candidates(entity, obs, frame).map((c) => ({ ...c, jpeg: this.world.crop(c.crop.id) })).filter((c) => c.jpeg);
    if (!candidates.length) return this.world.mark(id, 'nothing to compare');
    const left = decode(x), t0 = this.now(), asked = [];
    const ownOffered = candidates[0].entity.id === entity.id;
    let picked = null, why = '', unsure = false;
    for (const c of candidates) {
      const { verdict, why: reason } = await this.#same(left, decode(c.jpeg));
      asked.push(`${c.entity.id} ${c.entity.name}: ${verdict}`);
      if (verdict === 'same') { picked = c.entity; why = reason; break; }
      // not sure about the entity it is filed under: leave it there, and do not shop it around
      if (verdict === 'unsure') { unsure = true; if (c.entity.id === entity.id) break; } else why ||= reason;
    }
    // what the answers mean for the world
    const action = picked ? (picked.id === entity.id ? 'same' : entity.obs.length > 1 ? 'moved' : 'merged')
      : unsure ? 'unsure' : ownOffered ? 'split' : 'same';   // nothing known is the same: filed right as its own thing
    this.stats.checked++; this.stats[action]++;
    this.logger?.info({ obs: id, as: `${entity.id} ${obs.name}`, asked, action, why, applied: this.apply, ms: Math.round(this.now() - t0) }, 'curator: check');
    this.world.mark(id, why ? `${action}: ${why}` : action);
    if (!this.apply) return;
    if (action === 'merged') this.world.merge(entity.id, picked.id);
    else if (action === 'moved') { const n = this.world.split(id); if (n) this.world.merge(n.id, picked.id); }
    else if (action === 'split') this.world.split(id);
  }

  /** One question: are these two crops the same object? */
  async #same(left, right) {
    const jpg = jpegJs.encode(sideBySide(left, right, { height: this.pairHeight }), 80).data;
    this.stats.questions++;
    const reply = await this.llm.chat({ model: this.model, maxTokens: 30, temperature: 0, signal: this.#abort.signal,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpg.toString('base64')}` } }, { type: 'text', text: PROMPT }] }] });
    return parseVerdict(reply.content);
  }
}
