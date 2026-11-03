// jet backlight: set the panel backlight (`L`).
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';

const s = Schema.create;

export class BacklightCommand extends Command {
  static moduleInfo = {
    name: 'backlight',
    schema: s().meta('description', 'set the panel backlight')
      .property('level', s('number').required().validator({ $range: { min: 0, max: 1023 } })
        .meta('general').meta('valueDescription', '0-1023')),
  };
  level;

  async run(jet) {
    jet.send(`L ${this.level}`);
  }
}
