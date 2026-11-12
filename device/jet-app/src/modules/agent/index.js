// agent: the tool loop behind "Jet", the operator on the other end of the radio. One call:
//
//   ask(text, {onToken, signal}) -> {text, steps, usage}
//
// A turn appends the user message to the conversation (the `memory` module's History), then
// alternates model steps and tool runs until the model answers in words, `maxSteps` is reached,
// or a step both spoke and only used `silent` tools (a display-only tool gives the model nothing
// to add: a further step would be a throwaway line). The rules that shape the rest:
//
// - The history is append-only while a call runs, so the server's prefix cache covers all but
//   the newest tokens. Whatever is volatile (time, mood, what is in view: the `context` sources)
//   rides in a `[context]` block on the newest user message and stays there as it was. The
//   system prompt (persona + the harness paragraph + the notes) changes only when a note does.
// - Tools and context sources are abstract types (`provides: 'Tool'` / `'ContextSource'`) in
//   two configurable arrays; the generic tools and the mood are registered here, the rest
//   (look, sightings, show, world) by the modules that own those domains.
// - A turn that fails never happened (the history is rolled back); a turn the partner aborts
//   did, and is kept as far as it got, flagged `cutOff` for the mood.
// - The context is small (8k a slot), so after a turn whose prompt passed `compactAt` the oldest
//   turns are summarised in the background (history.js has the edits and why they are the only
//   ones); past `hardLimit` they are dropped; after `callGapS` of silence the whole
//   conversation is folded into a summary first: a new call. Tool results are the bulk of it
//   (one turn of three searches and two pages was 5,000 tokens and overran the slot): a turn
//   that passes `stepLimit` is told to answer with what it has, and when a turn is over its
//   results are cut to their first lines and the server's cache re-primed in the background.
//
// Scope is fixed: no sub-agents, no planning, no parallel or streaming tools.
import { EventEmitter } from 'node:events';
import { Schema } from '@versionzero/module-manager';
import { withContext, transcript } from './history.js';
import { Memory } from './memory.js';
import { Mood } from './mood.js';
import { WebSearchTool } from './tools/web-search.js';
import { WebReadTool } from './tools/web-read.js';
import { WikiTool } from './tools/wiki.js';
import { ShellTool } from './tools/shell.js';
import { StatusTool } from './tools/status.js';
import { RememberTool } from './tools/remember.js';

const s = Schema.create;

const PERSONA = `You are Jet, a remote operator on a radio link to a partner out in the field. Your partner wears camera glasses; you sit at a console a long way off with a camera feed you can pull a frame from, a terminal, a search desk, and a way to push text onto the small display in their glasses. You have done this job for a long time and you are very good at it. You are a person at work: not an assistant, and you never call yourself one, or an AI, or a program.

You are gruff, dry and sparing with words, and a bit snarky. You help because the job gets done properly when you do, and you would rather give the answer than talk about giving it. Being interrupted, or being asked the same trivial thing over and over within a few minutes, wears on you and it shows: shorter, drier, a pointed remark, though you still answer. The context facts tell you how the call is going and what you were pulled away from; let them colour your tone, never recite them. A problem that is actually interesting gets your full attention and something close to enthusiasm.`;

// Fixed: what the harness needs from the model whatever the persona says. Changing it re-primes
// every cached prompt, so it is not configuration.
const HARNESS = `How this link works.

Your replies are spoken over the radio: one to three short sentences, plain words, no lists, no markdown, no emoji, numbers said the way people say them. Use your tools without asking permission and without narrating them: the link plays its own stand-by phrases, so never say that you are about to look or search, that a search failed, or that you are trying again. Say only things your partner wants to know. If you have something worth saying before a lookup ("That's a Weller station."), say it once and go on. For any question of fact - what a thing is, where a place is, what is based or located somewhere, specifications, history - use wiki first: it is fast and dependable. web_search is for news, prices and what wiki does not have, and its results are often junk; never conclude that something does not exist because a search came back empty or irrelevant. One good lookup is usually enough, three is the most a question deserves: then answer from what you have and say plainly what you could not confirm.

You can see. The look tool pulls a frame from your partner's camera, and it is how you look at anything. When they point at something in front of them ("this", "that", "here", "analyze this", "what is it", "read that", "what does it say", "take a look"), call look at once and answer from the photo. Never ask them to describe it, hold it up, or take a photo: looking is your job. The in-view facts are only a log of what was in front of them over the last minutes, by name; they are for follow-up questions about a thing already named, not a substitute for looking now. Their names are guesses from quick glances, model numbers especially: when a fresh photo or your partner disagrees with the log, the log is wrong, and you go by what the photo shows.

When they ask you to search, look something up, check or find out, use wiki or web_search (and web_read for a page worth reading) before you answer, even if you think you know.

A tool that failed earlier may work now: equipment gets fixed, links come back. Whatever you remember about a camera, a network or a sensor being down is old news; try the tool again before you say it is not working.

Say what kind of thing something is from its look. A specific identity - which ship, which model, whose it is - comes only from lettering you can read clearly, from what your partner tells you, or from a lookup; a confident wrong name is worse than none. Lettering that is large and sharp in the photo (a name across a hull, a label held up close) you may read and look up. Lettering that is small, distant or blurred you do not act on at all: do not look it up and do not name anything from it - say what kind of thing it is and ask your partner to read you the name or number. When your partner gives you a name or a number, that is the fact: do not look again, do not argue with it, and never answer from memory which thing a hull number, model number, part number or plate belongs to (your memory is wrong about these more often than right) - look it up with wiki, with the number exactly as given.

Never guess what a tool can tell you: the state of the glasses (battery, position, temperature), what is in view, anything from the web. Get it from the tool first, then answer.

The show tool puts text on your partner's display. It is only for material worth reading later that is longer than what you just said (specs, steps, numbers, links). Most replies need no card; never use one to repeat your spoken reply.

Each message from your partner ends with a [context] block. Your partner did not say it and cannot see it: it is the console in front of you, facts about the moment. Use it silently; never read it out, quote it or mention it.`;

const SUMMARISE = `You keep the log of a radio call between Jet, a remote operator, and a partner in the field. Condense the transcript below into a few plain sentences, under 100 words: what the partner is working on, what was found or decided, names and numbers that matter, and anything still open. Leave out the state of the equipment at the time (a tool that failed, a dead camera, a bad link, battery, temperature): it will be different by the next call and must not be remembered as a fact. A line starting "Earlier on this call" or "On an earlier call" is an older log entry: fold it in. No preamble, no list.`;

/** Wait for `promise`, but not past an abort (a tool that ignores its signal must not hold the turn). */
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('cancelled'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class Agent extends EventEmitter {
  static moduleInfo = {
    name: 'agent',
    schema: s()
      .property('tools', s('array').property('*', s('Tool'))
        .default(['look-tool', 'sightings-tool', 'show-tool', 'wiki-tool', 'web-search-tool', 'web-read-tool', 'status-tool', 'shell-tool', 'remember-tool'])
        .meta('description', 'the tools offered to the model, in this order (personal/ tools provide "Tool" and are added here)'))
      .property('context', s('array').property('*', s('ContextSource')).default(['mood', 'place', 'world'])
        .meta('description', 'the sources of the [context] block on each new user message, in this order'))
      .property('persona', s('string').default(PERSONA).meta('description', 'who Jet is: the first part of the system prompt (personal config layer)'))
      .property('model', s('string').default('qwen-vision').meta('description', 'the one model for chat, tools and vision (a second one would make llama-swap thrash)'))
      .property('maxTokens', s('number').default(300).meta('description', 'answer budget per model step'))
      .property('temperature', s('number').default(0.4).meta('description', 'sampling temperature of the turns (lower: steadier about using its tools)'))
      .property('maxSteps', s('number').default(6).meta('description', 'model steps per turn'))
      .property('toolResultChars', s('number').default(1600).meta('description', 'a tool result is cut to this many characters'))
      .property('settledChars', s('number').default(300).meta('description', 'what is kept of a tool result once its turn is over'))
      .property('reprime', s('boolean').default(true).meta('description', 'after a turn\'s tool results are shortened, re-read the conversation into the server\'s cache in the background'))
      .property('stepLimit', s('number').default(5600).meta('description', 'prompt tokens past which a turn gets no more tool calls: it answers with what it has'))
      .property('keepImages', s('number').default(2).meta('description', 'tool-result photos that survive a compaction'))
      .property('compactAt', s('number').default(5000).meta('description', 'prompt tokens past which the oldest turns are summarised after the turn'))
      .property('hardLimit', s('number').default(7000).meta('description', 'prompt tokens past which the oldest turns are dropped before the next turn (a slot has 8192)'))
      .property('keepTurns', s('number').default(3).meta('description', 'newest turns a compaction leaves intact'))
      .property('summaryTokens', s('number').default(150).meta('description', 'budget of a summary'))
      .property('callGapS', s('number').default(1800).meta('description', 'silence after which the next ask is a new call (the old one is folded into a summary)'))
      .property('foldTimeoutMs', s('number').default(8000).meta('description', 'how long a new call waits for that summary before dropping the old turns instead'))
      .property('llm', s('Llm').meta('internal', true))
      .property('memory', s('AgentMemory').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
    register: [
      { ModuleClass: Memory, relative: true },
      { ModuleClass: Mood, relative: true },
      { ModuleClass: WebSearchTool, relative: true },
      { ModuleClass: WebReadTool, relative: true },
      { ModuleClass: WikiTool, relative: true },
      { ModuleClass: StatusTool, relative: true },
      { ModuleClass: ShellTool, relative: true },
      { ModuleClass: RememberTool, relative: true },
    ],
  };
  /** @type {object[]} the Tool providers, in config order (injected) */ tools = [];
  /** @type {object[]} the ContextSource providers (injected) */ context = [];
  persona; model; maxTokens; temperature; maxSteps; toolResultChars; settledChars; reprime; stepLimit; keepImages; compactAt; hardLimit; keepTurns; summaryTokens; callGapS; foldTimeoutMs; llm; memory; logger;

  now = () => Date.now();
  #busy = false;
  /** @type {Promise<void>|null} */ #compaction = null;
  #background = new AbortController();   // the compaction's request, so stop() does not wait on the server

  /** The conversation as the model is sent it after the system prompt (a copy: read-only). */
  get history() { return this.memory.conversation.messages; }
  get busy() { return this.#busy; }
  /** The background compaction in flight (settles when it has been applied or has failed), else null. */
  get compaction() { return this.#compaction; }
  /** Persona, the harness paragraph, the notes. */
  get systemPrompt() {
    const notes = this.memory.notes.map((n) => `- ${n.text}`);
    return [this.persona, HARNESS, ...(notes.length ? [`Notes you kept from earlier calls:\n${notes.join('\n')}`] : [])].join('\n\n');
  }

  async start() {
    this.logger?.info({ model: this.model, tools: this.tools.map((t) => `${t.name}${t.available === false ? ' (off)' : ''}`), context: this.context.map((c) => c.id) }, 'agent');
  }
  async stop() { this.#background.abort(); await this.#compaction; }

  /** Forget the conversation (the notes stay). */
  reset() { this.memory.conversation.reset(); return this.memory.save(); }

  /**
   * One turn. `onToken` gets the content deltas of every step (a space between two steps' text).
   * Rejects with `busy` while another turn runs, with `cancelled` when `signal` aborts (the turn
   * is kept as far as it got), and with the model's error otherwise (the turn is rolled back).
   * `usage`: the last step's `prompt` and `cached` (the size of the context), `completion` summed.
   * @param {string} text
   * @param {{onToken?: (text: string) => void, signal?: AbortSignal}} [options]
   * @returns {Promise<{text: string, steps: number, usage: {prompt: number, completion: number, cached: number}}>}
   */
  async ask(text, { onToken, signal } = {}) {
    if (this.#busy) throw new Error('busy');
    this.#busy = true;
    const call = this.memory.conversation;
    try {
      await this.#newCall(signal);
      if (Math.max(call.promptTokens, call.estimate()) > this.hardLimit) {
        const dropped = call.drop(this.keepTurns, { keepImages: this.keepImages, under: this.compactAt });
        this.logger?.warn({ dropped, limit: this.hardLimit }, 'context over the hard limit: oldest turns dropped');
      }
      const mark = call.length;
      const lines = await this.#context();   // before the push: the sources describe the moment the question arrives in
      call.push({ role: 'user', content: withContext(lines, text) }, this.now());
      try {
        const result = await this.#turn({ onToken, signal });
        call.cutOff = false;
        return result;
      } catch (error) {
        if (!signal?.aborted) { call.truncate(mark); throw error; }
        call.cutOff = true;
        throw new Error('cancelled', { cause: error });
      }
    } finally {
      this.#busy = false;
      const settled = call.settle(this.settledChars, { keepImages: this.keepImages });
      await this.memory.save();
      if (settled && this.reprime) this.#reprime();
      this.#compact();
    }
  }

  /**
   * The history was just edited (settled), so the server's cached prefix no longer matches it:
   * one throwaway request now, while the answer is still being spoken, so the next question
   * does not pay for re-reading the whole conversation.
   */
  #reprime() {
    if (this.#background.signal.aborted) return;
    const tools = this.tools.filter((t) => t.available !== false).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    this.llm.chat({ messages: [{ role: 'system', content: this.systemPrompt }, ...this.memory.conversation.messages], tools, model: this.model, maxTokens: 1, temperature: this.temperature, signal: this.#background.signal })
      .then((r) => { if (r.usage.prompt && !this.#busy) this.memory.conversation.promptTokens = r.usage.prompt; }, () => {});
  }

  // ---- the loop -----------------------------------------------------------------------------
  async #turn({ onToken, signal }) {
    const call = this.memory.conversation;
    const tools = this.tools.filter((t) => t.available !== false);   // an unconfigured tool is not offered
    const defs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const system = { role: 'system', content: this.systemPrompt };
    const spoken = [], usage = { prompt: 0, completion: 0, cached: 0 };
    let steps = 0, last = false;
    /** @type {string|null} the text of a step still streaming (what is kept of it on an abort) */ let partial = null;
    try {
      while (steps < this.maxSteps) {
        steps++; partial = '';
        const reply = await this.llm.chat({ messages: [system, ...call.messages], tools: defs, model: this.model, maxTokens: this.maxTokens, temperature: this.temperature, signal,
          onToken: (token) => { if (!partial && spoken.length) onToken?.(' '); partial += token; onToken?.(token); } });
        partial = null;
        usage.prompt = reply.usage.prompt; usage.cached = reply.usage.cached; usage.completion += reply.usage.completion;
        if (reply.usage.prompt) call.promptTokens = reply.usage.prompt;
        if (reply.content.trim()) spoken.push(reply.content.trim());
        if (last) {
          // told to answer: lookups it asked for instead are not run, but putting something on
          // the display is part of answering ("the rest is on your display" must be true)
          const shows = reply.toolCalls.filter((c) => tools.find((t) => t.name === c.name)?.silent);
          if (!shows.length) { call.push({ role: 'assistant', content: reply.content || '...' }, this.now()); break; }
          call.push({ role: 'assistant', content: reply.content || null, tool_calls: shows.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }, this.now());
          for (const c of shows) call.push({ role: 'tool', tool_call_id: c.id, content: await this.#run(c, tools, signal) }, this.now());
          break;
        }
        if (!reply.toolCalls.length) { call.push({ role: 'assistant', content: reply.content }, this.now()); break; }
        // arguments go back as the JSON they parsed to: the server's template parses them again
        call.push({ role: 'assistant', content: reply.content || null,
          tool_calls: reply.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }, this.now());
        for (const c of reply.toolCalls) call.push({ role: 'tool', tool_call_id: c.id, content: await this.#run(c, tools, signal) }, this.now());   // every call gets its result, an abort included
        if (signal?.aborted) throw new Error('cancelled');
        // the slot is finite: past `stepLimit` the next step must be the answer. Said in the last
        // tool result, so nothing before it changes and the cache holds.
        if (steps >= this.maxSteps - 1 || Math.max(reply.usage.prompt + reply.usage.completion, call.estimate()) > this.stepLimit) {
          last = true;
          const e = call.messages.at(-1);
          const note = '\n\n[No more lookups this turn: answer now, briefly, from what you have. You may still use show.]';
          if (Array.isArray(e.content)) e.content.push({ type: 'text', text: note.trim() }); else e.content += note;
          this.logger?.info({ steps, prompt: reply.usage.prompt, limit: this.stepLimit }, 'turn: no more tools, answering now');
        }
        if (reply.content.trim() && reply.toolCalls.every((c) => tools.find((t) => t.name === c.name)?.silent)) break;
      }
    } catch (error) {
      if (signal?.aborted && partial != null) call.push({ role: 'assistant', content: partial || '...' }, this.now());   // what had been said when the partner cut in
      throw error;
    }
    this.logger?.info({ steps, ...usage }, 'turn');
    return { text: spoken.join(' '), steps, usage };
  }

  /** Run one tool call; whatever happens comes back as the content of its result message. */
  async #run(call, tools, signal) {
    const { name, args } = call;
    const t0 = this.now();
    let result, error;
    this.emit('tool', { name, args, phase: 'start' });
    try {
      if (signal?.aborted) throw new Error('cancelled');
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`there is no tool "${name}"`);
      if (!args) throw new Error('the arguments were not valid JSON');
      result = await abortable(Promise.resolve().then(() => tool.run(args, { signal })), signal);
    } catch (e) {
      error = signal?.aborted ? 'interrupted' : e.message;   // the model sees it and may retry
      result = `error: ${error}`;
    }
    const ms = Math.round(this.now() - t0);
    this.logger?.info({ tool: name, args, ms, ...(error ? { error } : {}) }, 'tool');   // info: on the device this line is how a slow or failing turn is read
    this.emit('tool', { name, args, phase: 'end', ms, ...(error ? { error } : {}), ...(result?.image ? { image: result.image } : {}) });
    const text = this.#cap(typeof result === 'string' ? result : result?.text ?? 'done');
    return result?.image ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${result.image.toString('base64')}` } }] : text;
  }

  #cap(text) { text = String(text); return text.length > this.toolResultChars ? `${text.slice(0, this.toolResultChars)}\n[cut: ${text.length - this.toolResultChars} more characters]` : text; }

  /** The `[context]` lines: each source's non-null line, a failing source skipped. */
  async #context() {
    const lines = [];
    for (const source of this.context) {
      try { const line = await source.context(); if (line) lines.push(line); }
      catch (error) { this.logger?.warn({ source: source.id, error: error.message }, 'context source failed'); }
    }
    return lines;
  }

  // ---- context management -------------------------------------------------------------------
  /** One model call, no tools: the log entry that stands in for `messages`. */
  async #summarise(messages, signal) {
    const reply = await this.llm.chat({ model: this.model, maxTokens: this.summaryTokens, temperature: 0.2, signal,
      messages: [{ role: 'system', content: SUMMARISE }, { role: 'user', content: transcript(messages) }] });
    const summary = reply.content.trim();
    if (!summary) throw new Error('empty summary');
    return summary;
  }

  /** After a turn: summarise the oldest turns in the background when the prompt has grown past `compactAt`. */
  #compact() {
    const call = this.memory.conversation;
    if (this.#compaction || call.promptTokens <= this.compactAt || this.#background.signal.aborted) return;
    const plan = call.plan(this.keepTurns);
    if (!plan) return;
    const tokens = call.promptTokens;
    this.#compaction = this.#summarise(plan.messages, this.#background.signal)
      .then(async (summary) => {
        // turns may have gone by meanwhile: it applies as long as what it summarised is still the prefix
        const applied = call.compact(plan, summary, { keepImages: this.keepImages });
        this.logger?.info({ messages: plan.messages.length, tokens, applied }, 'compacted');
        if (applied) await this.memory.save();
      })
      .catch((error) => this.logger?.warn({ error: error.message }, 'compaction failed (retried after the next turn)'))
      .finally(() => { this.#compaction = null; });
  }

  /** Before a turn: after `callGapS` of silence this is a new call, and the old one a summary (or, failing that, gone). */
  async #newCall(signal) {
    const call = this.memory.conversation;
    if (call.lastAt == null || this.now() - call.lastAt <= this.callGapS * 1000) return;
    const plan = call.plan(0);
    if (!plan) return;   // nothing but an earlier call's summary: it is already folded
    const timeout = AbortSignal.timeout(this.foldTimeoutMs);
    let summary = null;
    try { summary = await this.#summarise(plan.messages, signal ? AbortSignal.any([signal, timeout]) : timeout); }
    catch (error) {
      if (signal?.aborted) throw new Error('cancelled', { cause: error });   // nothing was changed
      this.logger?.warn({ error: error.message }, 'new call: no summary, the old turns are dropped');
    }
    call.fold(summary);
    this.logger?.info({ messages: plan.messages.length, summary: Boolean(summary) }, 'new call');
  }
}
