// jet events: label and print the spontaneous jetd events (key, touch, mode, glance, wear,
// new-view). Inherently a stream: runs until Ctrl-C (or the device goes away) and exits 0.
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';

const s = Schema.create;

export class EventsCommand extends Command {
  static moduleInfo = {
    name: 'events',
    schema: s().meta('description', 'stream key/touch/mode/glance/wear/view events, one line each')
      .property('follow', s('boolean').default(true)
        .meta('description', 'stream until Ctrl-C (the default); =false listens for one timeout window and exits')),
  };
  follow;

  async run(jet) {
    const out = (label, text) => console.log(label.padEnd(8) + text);
    jet.on('key', (e) => out('key', `${e.code} ${e.value ? 'down' : 'up'}`));
    jet.on('touch', (e) => out('touch', `dx=${e.dx} dy=${e.dy}`));
    jet.on('mode', (m) => out('mode', m));
    jet.on('glance', (e) => out('glance', `${e.at ? 'at the glass' : 'looking ahead'} (raw ${e.raw})`));
    jet.on('wear', (e) => out('wear', `${e.worn ? 'worn' : 'off the head'} (raw ${e.raw})`));
    jet.on('view', (e) => out('view', `${e.degrees} deg`));
    await Promise.race([this.follow ? this.interrupted() : delay(this.timeoutMs), once(jet, 'close')]);
  }
}
