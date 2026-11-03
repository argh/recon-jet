// jet raw: the power-user escape hatch — protocol lines verbatim, every line jetd sends back
// printed for a beat, then exit. The connect-time kernel backlog may precede your replies;
// binary payloads show as their header line only.
import { setTimeout as delay } from 'node:timers/promises';
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';

const s = Schema.create;

export class RawCommand extends Command {
  static moduleInfo = {
    name: 'raw',
    schema: s().meta('description', 'send protocol lines verbatim and print the replies (see docs/jetd.md)')
      .property('cmds', s('array').required().meta('general')
        .property('*', s('string').meta('valueDescription', 'cmd')))
      .property('waitMs', s('number').default(1000).meta('advanced')
        .meta('description', 'how long to listen for replies')),
  };
  cmds; waitMs;

  async run(jet) {
    jet.on('line', (line) => console.log(line));
    jet.send(...this.cmds);
    await delay(this.waitMs);
  }
}
