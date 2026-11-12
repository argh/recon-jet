// History: the conversation as the model is sent it, and the only four ways it ever changes.
// It is append-only while a call runs (the server's prefix cache covers everything but the
// newest tokens as long as nothing in the middle is edited), so the edits are few and explicit:
//
//   settle(keepChars)       a finished turn's tool results shrink to their first lines (the
//                           answer that was built from them stays whole)
//   compact(plan, summary)  the oldest turns become one `Earlier on this call: ...` message
//   drop(keepTurns)         the same cut without a summary (the hard limit)
//   fold(summary)           the whole of it becomes `On an earlier call: ...` (a new call)
//
// Each of them invalidates the cache once, which is why the images age out there and nowhere
// else. A cut always lands on a user message, so a tool call is never separated from its result.
// Pure state and no I/O: the agent decides when, `memory` persists it (`toJSON` / `from`).

export const PHOTO_GONE = '[photo, no longer attached]';
const CONTEXT = '[context]';
const EARLIER = 'Earlier on this call: ', PREVIOUS = 'On an earlier call: ';
const SUMMARY = /^(Earlier on this call|On an earlier call): /;

/**
 * The newest user message as it is sent and kept: what was said, then the volatile facts. The
 * words come first - with the block in front the model took it for the start of the conversation
 * and opened its own reply with a copy.
 */
export function withContext(lines, text) { return lines.length ? `${text}\n\n${CONTEXT}\n${lines.join('\n')}` : text; }
/** ...and what was said, for a reader that does not want the block (the summariser). */
export function withoutContext(content) {
  const at = content.lastIndexOf(`\n\n${CONTEXT}\n`);
  return at < 0 ? content : content.slice(0, at);
}

const hasImage = (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url');
const textOf = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : m.content ?? '');
/** A message without its image: the text it came with and a placeholder. */
function stripImage(m) { return hasImage(m) ? { ...m, content: `${textOf(m)}\n${PHOTO_GONE}`.trim() } : m; }

/**
 * Messages as plain text for the summariser: who said what and what each tool returned
 * (shortened), no images, no context blocks.
 * @param {object[]} messages @param {number} [toolChars] how much of a tool result is kept
 */
export function transcript(messages, toolChars = 300) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'user') lines.push(SUMMARY.test(m.content) ? m.content : `Partner: ${withoutContext(textOf(m))}`);
    else if (m.role === 'assistant') {
      if (m.content) lines.push(`Jet: ${m.content}`);
      for (const c of m.tool_calls ?? []) lines.push(`Jet used ${c.function.name} ${c.function.arguments}`);
    } else if (m.role === 'tool') lines.push(`Result: ${textOf(m).slice(0, toolChars)}`);
  }
  return lines.join('\n');
}

export class History {
  /** @type {Array<{t: number, m: object, summary?: boolean}>} */ #entries = [];
  /** @type {number[]} when the partner asked something (kept across compaction: the mood counts them) */ #asks = [];
  /** @type {number|null} when this call's first message arrived */ startedAt = null;
  /** The prompt size the server last reported for this conversation (0 = not measured since it was cut). */ promptTokens = 0;
  /** The partner interrupted the last turn. */ cutOff = false;

  /** What is sent to the model after the system prompt. */
  get messages() { return this.#entries.map((e) => e.m); }
  get length() { return this.#entries.length; }
  /** When the newest message was added (null when empty). */
  get lastAt() { return this.#entries.at(-1)?.t ?? null; }
  /** How many times the partner has asked since `t`. */
  asksSince(t) { return this.#asks.filter((at) => at >= t).length; }

  /** @param {object} message an OpenAI chat message @param {number} t epoch ms */
  push(message, t) {
    this.startedAt ??= t;
    if (message.role === 'user') { this.#asks.push(t); if (this.#asks.length > 100) this.#asks.shift(); }
    this.#entries.push({ t, m: message });
  }

  /** Back to `length` messages: a turn that failed never happened (the tail is not cached yet). */
  truncate(length) {
    this.#entries.length = Math.min(length, this.#entries.length);
    if (this.#entries.every((e) => e.summary)) this.startedAt = null;   // it was the call's first: the call has not begun
  }

  reset() { this.#entries = []; this.#asks = []; this.startedAt = null; this.promptTokens = 0; this.cutOff = false; }

  // ---- the edits --------------------------------------------------------------------------------
  /**
   * Roughly how many tokens the conversation is now (characters / 3.3, 400 a photo). The server's
   * own count (`promptTokens`) is exact but only known after a call; this is for deciding before.
   */
  estimate() {
    let chars = 0, images = 0;
    for (const { m } of this.#entries) {
      if (Array.isArray(m.content)) for (const p of m.content) { if (p.type === 'image_url') images++; else chars += p.text?.length ?? 0; }
      else chars += m.content?.length ?? 0;
      for (const c of m.tool_calls ?? []) chars += c.function.arguments.length + c.function.name.length + 20;
    }
    return Math.round(chars / 3.3) + images * 400 + this.#entries.length * 6;
  }

  /**
   * The turn is over: what its tools returned has been used. Each result longer than `keepChars`
   * is cut to that with a note (a search page is 500 tokens the next ten turns would carry for
   * nothing; three of them in one turn filled an 8k context). Photos stay, the newest
   * `keepImages` of them. This edits the middle of the history, so the cache is lost once, at a
   * moment nobody is waiting. @returns {boolean} whether anything changed
   */
  settle(keepChars = 300, { keepImages = 2 } = {}) {
    let changed = false;
    const short = (text) => (text.length > keepChars ? (changed = true, `${text.slice(0, keepChars)}\n[shortened: this result was ${text.length} characters when you used it]`) : text);
    for (const e of this.#entries) {
      if (e.m.role !== 'tool') continue;
      if (Array.isArray(e.m.content)) e.m = { ...e.m, content: e.m.content.map((p) => (p.type === 'text' ? { ...p, text: short(p.text ?? '') } : p)) };
      else e.m = { ...e.m, content: short(e.m.content ?? '') };
    }
    const images = this.#entries.filter((e) => hasImage(e.m)).length;
    if (changed || images > keepImages) { this.#cut(keepImages); changed = true; }
    return changed;
  }

  /**
   * What a compaction would replace: everything before the user message that starts the
   * `keepTurns`-th newest turn. Null when that is nothing (or only an earlier summary).
   * @returns {{entries: object[], messages: object[]}|null}
   */
  plan(keepTurns) {
    const starts = this.#entries.flatMap((e, i) => (e.m.role === 'user' && !e.summary ? [i] : []));
    const cut = keepTurns > 0 ? starts.at(-keepTurns) : this.#entries.length;
    if (cut == null || cut <= (this.#entries[0]?.summary ? 1 : 0)) return null;
    const entries = this.#entries.slice(0, cut);
    return { entries, messages: entries.map((e) => e.m) };
  }

  /**
   * Replace a planned prefix by its summary. The plan may be old (the summary was written in the
   * background while turns went on): it applies as long as the prefix it was made from is still
   * the prefix, and is refused (false) otherwise.
   */
  compact(plan, summary, { keepImages = 2 } = {}) {
    const n = plan.entries.length;
    if (!plan.entries.every((e, i) => this.#entries[i] === e)) return false;
    this.#entries.splice(0, n, { t: plan.entries[n - 1].t, summary: true, m: { role: 'user', content: EARLIER + summary } });
    this.#cut(keepImages);
    return true;
  }

  /**
   * The hard limit: forget the oldest turns with no summary, keeping the newest `keepTurns` (fewer
   * when that would remove nothing) and an earlier summary. Returns how many messages went.
   */
  drop(keepTurns, { keepImages = 2, under = Infinity } = {}) {
    let gone = 0;
    for (let keep = keepTurns; keep >= 0; keep--) {
      const plan = this.plan(keep);
      if (!plan) continue;
      const from = this.#entries[0]?.summary ? 1 : 0;
      this.#entries.splice(from, plan.entries.length - from);
      this.#cut(keepImages);
      gone += plan.entries.length - from;
      if (this.estimate() <= under) break;   // else fewer turns still: one turn of searches can be the whole problem
    }
    return gone;
  }

  /** A new call: all that is left of the old one is its summary (or nothing, without one). */
  fold(summary) {
    this.#entries = summary ? [{ t: this.lastAt, summary: true, m: { role: 'user', content: PREVIOUS + summary } }] : [];
    this.startedAt = null; this.promptTokens = 0; this.cutOff = false;
  }

  /** After any cut the cache is gone anyway: the moment to let old photos go, and to re-measure. */
  #cut(keepImages) {
    let kept = 0;
    for (const e of this.#entries.toReversed()) if (hasImage(e.m) && ++kept > keepImages) e.m = stripImage(e.m);
    this.promptTokens = 0;
  }

  // ---- persistence ------------------------------------------------------------------------------
  /** Everything but the images (a restart is a cold cache: nothing is lost by dropping them). */
  toJSON() {
    return { startedAt: this.startedAt, promptTokens: this.promptTokens, cutOff: this.cutOff, asks: this.#asks,
      entries: this.#entries.map((e) => ({ ...e, m: stripImage(e.m) })) };
  }

  static from(json) {
    const h = new History();
    h.#entries = (json?.entries ?? []).filter((e) => e?.m?.role);
    h.#asks = json?.asks ?? [];
    h.startedAt = json?.startedAt ?? h.#entries[0]?.t ?? null;
    h.promptTokens = json?.promptTokens ?? 0; h.cutOff = Boolean(json?.cutOff);
    return h;
  }
}
