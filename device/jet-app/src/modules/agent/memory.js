// agent-memory: what Jet knows across turns and across restarts, as one model. Two things live here:
// the conversation (a `History`, history.js - the agent appends to it and decides when it is
// compacted) and the notes (what the `remember` tool saved, quoted in the system prompt). Both
// are files under `dir`, written whole and atomically (tmp + rename, one write at a time):
//
//   conversation.json   the History with images stripped to a placeholder; after each turn
//   notes.json          [{t, text}], capped at `maxNotes`, oldest dropped
//
// It is a module of its own, not agent state, because three things read it without needing the
// loop: the agent, the `remember` tool and the mood. An empty `dir` keeps it all in RAM.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { History } from './history.js';

const s = Schema.create;

export class Memory {
  static moduleInfo = {
    name: 'agent-memory',   // not `memory`: registered under the agent, its config key would shadow the agent's own `memory` reference
    schema: s()
      .property('dir', s('string').default('/android-data/mainline/agent').meta('description', 'where conversation.json and notes.json are kept (empty = not persisted)'))
      .property('maxNotes', s('number').default(40).meta('description', 'notes kept; the oldest is dropped past this'))
      .property('noteChars', s('number').default(300).meta('description', 'a note is cut to this length (every note rides in every prompt)'))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  dir; maxNotes; noteChars; logger;

  /** @type {History} */ conversation = new History();
  /** @type {Array<{t: number, text: string}>} oldest first */ notes = [];
  now = () => Date.now();
  #writing = Promise.resolve(); #seq = 0;

  async start() {
    const conversation = await this.#read('conversation.json'), notes = await this.#read('notes.json');
    if (conversation) this.conversation = History.from(conversation);
    if (Array.isArray(notes)) this.notes = notes.filter((n) => typeof n?.text === 'string').slice(-this.maxNotes);
    this.logger?.info({ dir: this.dir || null, messages: this.conversation.length, notes: this.notes.length }, 'memory');
  }
  /** Let a write in flight finish. */
  async stop() { await this.#writing; }

  /** Keep a note (trimmed, cut to `noteChars`; a repeat of the newest is not added twice). */
  remember(text) {
    text = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, this.noteChars ?? 300);
    if (!text) throw new Error('nothing to remember');
    if (this.notes.at(-1)?.text !== text) {
      this.notes.push({ t: this.now(), text });
      if (this.notes.length > this.maxNotes) this.notes.splice(0, this.notes.length - this.maxNotes);
    }
    return this.#write('notes.json', this.notes).then(() => text);
  }

  /** Write the conversation as it stands now. Never rejects: a full disk must not fail a turn. */
  save() { return this.#write('conversation.json', this.conversation); }

  async #read(name) {
    if (!this.dir) return null;
    try { return JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') this.logger?.warn({ file: name, error: error.message }, 'memory unreadable, starting empty'); return null; }
  }

  #write(name, data) {
    if (!this.dir) return Promise.resolve();
    const text = JSON.stringify(data);   // now, not when the queue gets to it: the caller's snapshot
    return (this.#writing = this.#writing.then(async () => {
      const file = path.join(this.dir, name), tmp = `${file}.${process.pid}.${++this.#seq}.tmp`;
      try { await fs.mkdir(this.dir, { recursive: true }); await fs.writeFile(tmp, text); await fs.rename(tmp, file); }
      catch (error) { this.logger?.warn({ file: name, error: error.message }, 'memory not saved'); await fs.rm(tmp, { force: true }).catch(() => {}); }
    }));
  }
}
