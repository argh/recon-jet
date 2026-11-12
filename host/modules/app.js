// The jet CLI application module: connection settings plus a `command` selector; each command is
// its own module in this directory, registered relative so the command line reads
// `jet [--host ...] <command> [options]` and the environment reads JET_HOST / JET_PORT.
import { Schema } from '@versionzero/module-manager';
import { StateCommand } from './state.js';
import { SnapshotCommand } from './snapshot.js';
import { ScreenshotCommand } from './screenshot.js';
import { LogCommand } from './log.js';
import { EventsCommand } from './events.js';
import { ConsoleCommand } from './console.js';
import { ModeCommand } from './mode.js';
import { BacklightCommand } from './backlight.js';
import { RawCommand } from './raw.js';
import { LiveCommand } from './live.js';
import { DialogCommand } from './dialog.js';

const s = Schema.create;

export class JetApp {
  static moduleInfo = {
    name: 'jet',
    schema: s()
      .property('host', s('string').default('jet.local').meta('flagHint', 'H').meta('description', 'jetd host (JET_HOST)'))
      .property('port', s('number').default(7777).meta('description', 'jetd port'))
      .property('timeoutMs', s('number').default(8000).meta('advanced').meta('description', 'connect/reply timeout in ms'))
      .property('command', s('Command').selector().required().normalizer('$kebab-case').serializer('$kebab-case').meta('description', 'what to do')),
    register: [
      { ModuleClass: StateCommand, relative: true },
      { ModuleClass: SnapshotCommand, relative: true },
      { ModuleClass: ScreenshotCommand, relative: true },
      { ModuleClass: LogCommand, relative: true },
      { ModuleClass: EventsCommand, relative: true },
      { ModuleClass: ConsoleCommand, relative: true },
      { ModuleClass: ModeCommand, relative: true },
      { ModuleClass: BacklightCommand, relative: true },
      { ModuleClass: RawCommand, relative: true },
      { ModuleClass: LiveCommand, relative: true },
      { ModuleClass: DialogCommand, relative: true },
    ],
  };
  command;

  async main() {
    await this.command.execute();
  }
}
