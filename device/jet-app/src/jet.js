// Jet: the main module. Referencing each subsystem here is what instantiates it; the public
// modes are listed in the order the switcher shows them (Log first: it is also the boot view).
// Once every module has started (and every mode has registered), `main()` enters the start mode.
import { AppModule, Schema } from '@versionzero/module-manager';
import { DeviceLink } from './modules/device-link/index.js';
import { Surface } from './modules/surface/index.js';
import { Input } from './modules/input/index.js';
import { Power } from './modules/power/index.js';
import { Sensors } from './modules/sensors/index.js';
import { Ui } from './modules/ui/index.js';
import { Modes } from './modules/modes/index.js';
import { Llm } from './modules/llm/index.js';
import { Voice } from './modules/voice/index.js';
import { LogMode } from './modes/log/index.js';
import { DemoMode } from './modes/demo/index.js';
import { SystemMode } from './modes/system/index.js';
import { AssistantMode } from './modes/assistant/index.js';
import { ShellMode } from './modes/shell/index.js';
import { DoomMode } from './modes/doom/index.js';

const s = Schema.create;

export class Jet extends AppModule {
  static moduleInfo = {
    name: 'jet',
    inject: true,
    isMain: true,
    schema: s()
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('surface', s('Surface').meta('internal', true))
      .property('input', s('Input').meta('internal', true))
      .property('power', s('Power').meta('internal', true))
      .property('sensors', s('Sensors').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('modes', s('Modes').meta('internal', true))
      .property('llm', s('Llm').meta('internal', true))
      .property('voice', s('Voice').meta('internal', true))
      .property('logMode', s('LogMode').meta('internal', true))
      .property('demoMode', s('DemoMode').meta('internal', true))
      .property('systemMode', s('SystemMode').meta('internal', true))
      .property('assistantMode', s('AssistantMode').meta('internal', true))
      .property('shellMode', s('ShellMode').meta('internal', true))
      .property('doomMode', s('DoomMode').meta('internal', true))
      .property('logLevel', s('string').default('info').values(['debug', 'info', 'warn', 'error']).meta('description', 'log threshold'))
      .property('deviceConfig', s('string').default('/android-data/mainline/jet-app.json').meta('description', 'per-device config layer (read before configuration)'))
      .property('tickRate', s('number').default(60000).meta('hidden', true)),
    register: [DeviceLink, Surface, Input, Power, Sensors, Ui, Modes, Llm, Voice, LogMode, DemoMode, SystemMode, AssistantMode, ShellMode, DoomMode],
  };
  deviceLink; surface; input; power; sensors; ui; modes; llm; voice; logMode; demoMode; systemMode; assistantMode; shellMode; doomMode; logLevel; deviceConfig;

  async init() {
    await super.init();
    this.logger.setLevel?.(this.logLevel);
  }

  async start() {
    await super.start();
    this.logger.info({ node: process.version, pid: process.pid }, 'jet-app started');
  }

  /** Every module has started: enter the start mode, then wait for the shutdown signal. */
  async main() {
    await this.modes.begin();
    return super.main();
  }

  /** Heartbeat with the link state, every `tickRate` ms. */
  async _tick() {
    const { connected, mode, hello } = this.deviceLink;
    this.logger.info({ connected, mode, hello, rssMb: Math.round(process.memoryUsage().rss / 1048576) }, 'tick');
  }
}
