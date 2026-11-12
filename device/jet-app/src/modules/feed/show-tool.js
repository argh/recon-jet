// show: the agent's way of putting something on the display (docs/agent.md). It posts a `card`
// to the feed - a short title and a few lines worth reading later - and, when the card is about
// something in view, the picture the world holds of it. Display-only, so it is `silent`: after
// a step that already said something, its result does not earn another model step (the model
// otherwise adds a throwaway line). The description tells the model what a card is for; left
// alone it shows everything it says.
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;

export class ShowTool {
  static moduleInfo = {
    name: 'show-tool',
    provides: 'Tool',
    schema: s()
      .property('feed', s('Feed').meta('internal', true))
      .property('world', s('World').lax().meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  feed; world; logger;

  name = 'show';
  description = 'Put a card on your partner\'s display: a short title and a few short lines worth reading later (specs, numbers, steps, a link). Not for repeating what you just said. Name the entity (an id like e7 from the in-view context) when the card is about something in view, and its picture goes on the card.';
  parameters = {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'a few words' },
      body: { type: 'string', description: 'a few short lines, one fact per line' },
      entity: { type: 'string', description: 'optional: the id of the thing in view this is about, e.g. e7' },
    },
    required: ['title', 'body'],
  };
  silent = true;

  /** @param {{title?: string, body?: string, entity?: string}} args @returns {Promise<string>} */
  async run({ title, body, entity } = {}) {
    if (!String(title ?? '').trim() && !String(body ?? '').trim()) throw new Error('a card needs a title and a body');
    // the world's thumbnail is shared and replaced on the next sighting: the card keeps its own
    const thumb = entity ? this.world?.thumb(entity) : null;
    const image = thumb ? { width: thumb.width, height: thumb.height, data: Uint8Array.from(thumb.data) } : undefined;
    const item = this.feed.post({ kind: 'card', title, body, image, entity: image ? entity : undefined });
    this.logger?.info({ id: item.id, title: item.title, entity: item.entity }, 'show');
    return 'shown';
  }
}
