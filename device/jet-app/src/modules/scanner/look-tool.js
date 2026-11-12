// look: the agent's eyes. One frame, handed back to the model as an image so it can answer
// about "this" and "that"; the same frame also goes to the scanner in the background, so asking
// about something files it in the world as a side effect. The scan is not awaited and cannot
// fail the look: the answer should not wait ~4 s for bookkeeping.
//
// Which frame is predictable: the one taken when the question was asked, if the operator held
// one (`camera.hold`), else a fresh one. And with `item` it is no frame at all but the picture
// on record of a thing already in the world - what the wearer has selected on the Scan screen,
// or something seen earlier ("the mug I saw a minute ago").
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;

export class LookTool {
  static moduleInfo = {
    name: 'look-tool',
    provides: 'Tool',
    schema: s()
      .property('jpegQuality', s('number').default(70).meta('description', 'quality of the photo the model gets (640x480 is ~390 tokens whatever the quality)'))
      .property('heldMs', s('number').default(30000).meta('description', 'a frame held at question time is used if it is no older than this'))
      .property('camera', s('Camera').meta('internal', true))
      .property('world', s('World').lax().meta('internal', true))
      .property('scanner', s('Scanner').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  jpegQuality; heldMs; camera; world; scanner; logger;

  name = 'look';
  description = 'See through the glasses. With no arguments: the photo of what your partner is looking at as they ask - use it whenever they say "this", "that" or "here", ask you to look or analyze, or ask about anything in front of them now. With item (an id like e7 from the in-view facts or the sightings tool): the picture on record of that thing - use it for the item selected on their display, or for something they saw earlier.';
  parameters = { type: 'object', properties: { item: { type: 'string', description: 'optional: the id of a logged thing (e7) to see its recorded picture instead of taking a photo' } } };

  /** @returns {Promise<{text: string, image?: Buffer}>} the picture as a JPEG for the model */
  async run({ item } = {}) {
    if (item) return this.#recorded(String(item).trim());
    const image = await (this.camera.held(this.heldMs ?? 30000) ?? this.camera.capture({ w: 640, h: 480 }));
    const jpeg = this.camera.jpeg(image, { quality: this.jpegQuality ?? 70 });
    Promise.resolve().then(() => this.scanner.scanOnce({ image }))
      .catch((error) => this.logger?.warn({ error: error.message }, 'look: scan failed'));
    return { text: 'The photo, taken through the glasses as they asked.', image: jpeg };
  }

  /** The best picture the world has of an entity (its largest crop), with what is known of it. */
  #recorded(id) {
    const e = this.world?.get(id);
    if (!e) throw new Error(`nothing logged as ${id}`);
    const best = [...e.obs].filter((o) => o.area).sort((a, b) => b.area - a.area)[0], jpeg = best && this.world.crop(best.id);
    const known = `${e.name} [${e.id}], ${e.kind || 'thing'}, last seen ${Math.max(0, Math.round((Date.now() - e.lastSeen) / 1000))} s ago. Noted: ${e.claims.slice(-4).map((c) => c.text).join(' / ') || 'nothing'}.`;
    return jpeg ? { text: `The picture on record of ${known} Names and notes are guesses from quick glances; go by the picture.`, image: jpeg }
      : { text: `No picture is on record of ${known}` };
  }
}
