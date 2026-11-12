// sightings: the agent's window on the world model. The context line only names the newest few
// things in view; this is the detail behind it. No query: the latest scene and the recent
// entities, one line each. With a query: the matching entities with their whole claims log
// (newest first), age, pin and place. Plain compact text - the model reads it, nobody else.
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;

/** "2m ago": a coarse relative age, what a person would say. */
export function ago(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

const place = (where) => (where?.lat != null && where?.lon != null ? `, at ${(+where.lat).toFixed(5)},${(+where.lon).toFixed(5)}` : '');

export class SightingsTool {
  static moduleInfo = {
    name: 'sightings-tool',
    provides: 'Tool',
    schema: s()
      .property('recent', s('number').default(12).meta('description', 'entities listed when there is no query'))
      .property('matches', s('number').default(5).meta('description', 'entities detailed for a query'))
      .property('claims', s('number').default(8).meta('description', 'claims shown per detailed entity, newest first'))
      .property('world', s('World').meta('internal', true)),
  };
  recent; matches; claims; world;

  name = 'sightings';
  description = 'What the glasses camera has recorded lately: the things seen, with notes, when and where. No query lists the recent ones; a query (a name, a kind, a word from a note, or an id like e7) gives the matching ones in detail.';
  parameters = { type: 'object', properties: { query: { type: 'string', description: 'what to look up; omit for the recent list' } } };

  /** @param {{query?: string}} [args] @returns {Promise<string>} */
  async run({ query } = {}) {
    const world = this.world, t = world.now();
    query = typeof query === 'string' ? query.trim() : '';
    const head = (e) => `${e.id} ${e.name}${e.kind ? ` (${e.kind})` : ''}${e.pinned ? ', pinned' : ''}, seen ${e.seen}x, last ${ago(t - e.lastSeen)}`;
    if (query) {
      const found = world.find(query).slice(0, this.matches ?? 5);
      if (!found.length) return `Nothing on record matching "${query}".`;
      return found.map((e) => [`${head(e)}, first ${ago(t - e.firstSeen)}${place(e.where)}`,
        ...e.claims.slice(-(this.claims ?? 8)).reverse().map((c) => `  - ${c.text} (${ago(t - c.t)}${c.source && c.source !== 'scan' ? `, ${c.source}` : ''})`)].join('\n')).join('\n');
    }
    const list = world.entities().slice(0, this.recent ?? 12);
    if (!list.length) return 'Nothing on record.';
    const last = world.sightings()[0];
    return [...(last?.scene ? [`Scene ${ago(t - last.t)}: ${last.scene}`] : []),
      ...list.map((e) => `${head(e)}${e.claims.length ? `: ${e.claims.at(-1).text}` : ''}`)].join('\n');
  }
}
