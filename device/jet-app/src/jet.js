// Jet: the main module. Referencing each subsystem here is what instantiates it.
import { AppModule, Schema } from '@versionzero/module-manager';
import { DeviceLink } from './modules/device-link/index.js';
import { Display } from './modules/display/index.js';
import { Input } from './modules/input/index.js';
import { Power } from './modules/power/index.js';
import { Ui } from './modules/ui/index.js';

const s = Schema.create;

export class Jet extends AppModule {
  static moduleInfo = {
    name: 'jet',
    inject: true,
    isMain: true,
    schema: s()
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('display', s('Display').meta('internal', true))
      .property('input', s('Input').meta('internal', true))
      .property('power', s('Power').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('logLevel', s('string').default('info').values(['debug', 'info', 'warn', 'error']).meta('description', 'log threshold'))
      .property('deviceConfig', s('string').default('/android-data/mainline/jet-app.json').meta('description', 'per-device config layer (read before configuration)'))
      .property('tickRate', s('number').default(60000).meta('hidden', true)),
    register: [DeviceLink, Display, Input, Power, Ui],
  };
  deviceLink; display; input; power; ui; logLevel; deviceConfig;

  async init() {
    await super.init();
    this.logger.setLevel?.(this.logLevel);
  }

  async start() {
    await super.start();
    this.logger.info({ node: process.version, pid: process.pid }, 'jet-app started');
  }

  /** Heartbeat with the link state, every `tickRate` ms. */
  async _tick() {
    const { connected, mode, hello } = this.deviceLink;
    this.logger.info({ connected, mode, hello, rssMb: Math.round(process.memoryUsage().rss / 1048576) }, 'tick');
  }
}
