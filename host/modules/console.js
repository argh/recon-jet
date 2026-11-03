// jet console: type into the on-device shell pty (`I`). Real control characters in the argument
// are encoded into the escapes jetd decodes; a literal backslash is doubled so it arrives as
// itself. Enter is a real newline: quote it as $'ls -l\n' in the shell.
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';

const s = Schema.create;
const escapes = { '\\': '\\\\', '\n': '\\n', '\r': '\\n', '\t': '\\t', '\x1b': '\\e' };

export class ConsoleCommand extends Command {
  static moduleInfo = {
    name: 'console',
    schema: s().meta('description', 'type text into the Jet\'s shell pty')
      .property('text', s('string').required().meta('general').meta('valueDescription', 'text')
        .meta('description', 'what to type; include a real newline ($\'...\\n\') to press Enter')),
  };
  text;

  async run(jet) {
    jet.send('I ' + this.text.replace(/[\\\n\r\t\x1b]/g, (c) => escapes[c]));
  }
}
