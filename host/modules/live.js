// jet live: a stub on purpose. Mirroring the panel needs jetd support that does not exist yet;
// grabbing the surface (`E`) from here would yank it away from jet-app, which this CLI must
// never do. Prints the plan and exits nonzero so scripts cannot mistake it for working.
import { Schema } from '@versionzero/module-manager';
import { Command } from './command.js';

const s = Schema.create;

export class LiveCommand extends Command {
  static moduleInfo = {
    name: 'live',
    schema: s().meta('description', 'live panel view (not implemented yet)'),
  };

  // Overrides execute(): the stub never even connects.
  async execute() {
    console.error(
      'jet live is not implemented yet: it needs a read-only mirror mode in jetd (a second client ' +
      'receiving panel updates without owning the surface). Taking the surface with `E` from here ' +
      'would blank jet-app on a live device, so this command stays a stub until jetd grows that ' +
      'mode — a planned follow-up. Meanwhile, `jet snapshot` grabs the camera and tools/jetshot.sh ' +
      'grabs the panel as shown.');
    process.exitCode = 1;
  }
}
