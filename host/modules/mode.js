// jet mode: switch jetd's mode (`M`). The one deliberate exception to "never send M": here it
// is exactly what the user asked for.
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';

const s = Schema.create;

export class ModeCommand extends Command {
  static moduleInfo = {
    name: 'mode',
    schema: s().meta('description', 'switch the device mode')
      .property('to', s('string').required().values(['remote', 'log', 'shell', 'setup'])
        .meta('general').meta('valueDescription', 'remote|log|shell|setup')),
  };
  to;

  async run(jet) {
    jet.send(`M ${this.to}`);
  }
}
