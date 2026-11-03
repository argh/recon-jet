// jet log: ask jetd's kernel-log ring for its tail (`J n`), print it, optionally keep following.
// jetd also replays a backlog of `j` lines on every connect, so lines are buffered until the
// `J n` ack and only the last n printed — the resend is the authoritative tail, no duplicates
// (jet-app's log mode reloads the same way).
import { once } from 'node:events';
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';

const s = Schema.create;

export class LogCommand extends Command {
  static moduleInfo = {
    name: 'log',
    schema: s().meta('description', 'print the kernel log (last n lines, or the whole ring)')
      .property('lines', s('number').default(0).meta('flagHint', 'n')
        .meta('description', 'how many lines (default: the whole ring)'))
      .property('follow', s('boolean').default(false).meta('flagHint', 'f')
        .meta('description', 'keep streaming new lines until Ctrl-C')),
  };
  lines; follow;

  async run(jet) {
    const tail = [];
    let live = false;
    jet.on('log', (line) => (live ? console.log(line) : tail.push(line)));
    const n = await jet.request('J', this.lines ? `J ${this.lines}` : 'J');
    for (const line of tail.slice(-n)) console.log(line);
    if (!this.follow) return;
    live = true;
    await Promise.race([this.interrupted(), once(jet, 'close')]);
  }
}
