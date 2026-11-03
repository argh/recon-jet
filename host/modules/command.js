// The command base: every `jet <command>` is a module providing 'Command', selected by the app's
// `command` selector (the zws pattern from module-manager's examples). Connection settings live
// on the app so they read as `jet --host ... <command>` and `JET_HOST`; they are inherited here.
// Hard rule for subclasses: inert by default — never send M/K/E or drawing commands unless the
// user's command is exactly that, so attaching to a live device never disturbs jet-app.
import { Schema } from '@versionzero/module-manager';
import { JetClient } from '../lib/client.js';

const s = Schema.create;

export class Command {
  static moduleInfo = {
    schema: s()
      .selection()
      .property('host', Schema.inherit().required())
      .property('port', Schema.inherit().required())
      .property('timeoutMs', Schema.inherit().required()),
    provides: 'Command',
  };
  host; port; timeoutMs;

  /** Connect, run the command, always tear the socket down (one-shot process model). */
  async execute() {
    const jet = new JetClient(this);
    await jet.connect();
    try { return await this.run(jet); }
    finally { await jet.close(); }
  }

  /** @param {JetClient} jet */
  async run(jet) { throw new Error('not implemented'); }   // eslint-disable-line no-unused-vars

  /** Resolves on Ctrl-C so streaming commands can exit 0 through the normal lifecycle. */
  interrupted() {
    return new Promise((resolve) => process.once('SIGINT', () => { process.stdout.write('\n'); resolve(); }));
  }
}
