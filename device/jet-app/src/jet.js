// Jet: the main module. Referencing each subsystem here is what instantiates it; the public
// modes are listed in the order the switcher shows them, from the everyday ones down to the
// plumbing (Assistant, Scan, Describe, Doom, Map, Shell, Log, System); the boot view is looked
// up by id. Once every module has started (and every mode has registered), `main()` enters the
// start mode.
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
import { Sounds } from './modules/sounds/index.js';
import { Wear } from './modules/wear/index.js';
import { Gps } from './modules/gps/index.js';
import { Actions } from './modules/actions/index.js';
import { Agent } from './modules/agent/index.js';
import { Scanner } from './modules/scanner/index.js';
import { Curator } from './modules/curator/index.js';
import { Feed } from './modules/feed/index.js';
import { Operator } from './modules/operator/index.js';
import { AssistantMode } from './modes/assistant/index.js';
import { ScanMode } from './modes/scan/index.js';
import { LogMode } from './modes/log/index.js';
import { DemoMode } from './modes/demo/index.js';
import { SystemMode } from './modes/system/index.js';
import { ShellMode } from './modes/shell/index.js';
import { DoomMode } from './modes/doom/index.js';
import { MapMode } from './modes/map/index.js';

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
      .property('sounds', s('Sounds').meta('internal', true))
      .property('wear', s('Wear').meta('internal', true))
      .property('gps', s('Gps').meta('internal', true))
      .property('actions', s('Actions').meta('internal', true))
      .property('scanner', s('Scanner').meta('internal', true))
      .property('curator', s('Curator').meta('internal', true))
      .property('feed', s('Feed').meta('internal', true))
      .property('agent', s('Agent').meta('internal', true))
      .property('operator', s('Operator').meta('internal', true))
      .property('assistantMode', s('AssistantMode').meta('internal', true))
      .property('scanMode', s('ScanMode').meta('internal', true))
      .property('logMode', s('LogMode').meta('internal', true))
      .property('demoMode', s('DemoMode').meta('internal', true))
      .property('mapMode', s('MapMode').meta('internal', true))
      .property('systemMode', s('SystemMode').meta('internal', true))
      .property('shellMode', s('ShellMode').meta('internal', true))
      .property('doomMode', s('DoomMode').meta('internal', true))
      .property('logLevel', s('string').default('info').values(['debug', 'info', 'warn', 'error']).meta('description', 'log threshold'))
      .property('deviceConfig', s('string').default('/android-data/mainline/jet-app.json').meta('description', 'per-device config layer (read before configuration)'))
      .property('tickRate', s('number').default(60000).meta('hidden', true)),
    register: [DeviceLink, Surface, Input, Power, Sensors, Sounds, Wear, Gps, Actions, Ui, Modes, Llm, Voice, Scanner, Curator, Feed, Agent, Operator, AssistantMode, ScanMode, DemoMode, DoomMode, MapMode, ShellMode, LogMode, SystemMode],
  };
  deviceLink; surface; input; power; sensors; ui; modes; llm; voice; sounds; wear; gps; actions; scanner; curator; feed; agent; operator; assistantMode; scanMode; logMode; demoMode; mapMode; systemMode; shellMode; doomMode; logLevel; deviceConfig;

  async init() {
    await super.init();
    this.logger.setLevel?.(this.logLevel);
  }

  async start() {
    await super.start();
    this.logger.info({ node: process.version, pid: process.pid }, 'jet-app started');
  }

  /**
   * Every module has started: enter the start mode and say so, wait for the shutdown signal,
   * then say goodbye (bounded: the modules stop right after).
   */
  async main() {
    await this.modes.begin();
    if (this.deviceLink.connected) this.sounds.play('powerOn'); else this.deviceLink.once('connected', () => this.sounds.play('powerOn'));
    await super.main();
    await Promise.race([this.sounds.play('powerOff'), new Promise((r) => setTimeout(r, 1500))]);
  }

  /** Heartbeat with the link state, every `tickRate` ms. */
  async _tick() {
    const { connected, mode, hello } = this.deviceLink;
    this.logger.info({ connected, mode, hello, rssMb: Math.round(process.memoryUsage().rss / 1048576) }, 'tick');
  }
}
