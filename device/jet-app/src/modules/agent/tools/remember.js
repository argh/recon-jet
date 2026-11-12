// remember: the model's way to keep something past this call. A note goes into the `memory`
// module (notes.json) and from there into every later system prompt, so the description asks
// for short and durable.
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;

export class RememberTool {
  static moduleInfo = {
    name: 'remember-tool',
    provides: 'Tool',
    schema: s().property('memory', s('AgentMemory').meta('internal', true)),
  };
  memory;

  name = 'remember';
  description = 'Keep a short note for later calls: a lasting fact about your partner, their gear or their work, in one sentence. Not for things that only matter right now.';
  parameters = { type: 'object', properties: { text: { type: 'string', description: 'the note, one sentence' } }, required: ['text'] };

  /** @param {{text: string}} args */
  async run({ text }) { return `noted: ${await this.memory.remember(text)}`; }
}
