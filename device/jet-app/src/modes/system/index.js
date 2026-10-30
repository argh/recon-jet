// System mode: a chooser-style menu of the device's own screens. Status is display-only and
// carries everything worth reading (power, network, radios, sensors, versions); every other
// item controls something settable - Pad calibration, Glance calibration, Brightness, Wear,
// Bluetooth, Location (GPS) - and shows its own detail. Front press opens the selected screen,
// rear press returns to the menu (and does nothing at the menu: that is the mode's root).
//
// First use: when the pad or glance calibration file is missing on userdata, `firstUse()` tells
// the registry to start here as a wizard that walks Pad calibration, then Glance calibration,
// then Brightness, with an "n of 3" hint; the same screens are reachable from the menu later.
// Calibration results go to the files jetd reads at boot (`mainline/ofm-args`,
// `mainline/glance`, `mainline/backlight`) and are applied live (jet-ofm sysfs parameters, the
// backlight sysfs, jetd's `U` reload), so nothing needs a restart.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Schema } from '@versionzero/module-manager';
import { Chooser } from '../../modules/ui/chooser.js';
import { C } from '../../modules/ui/style.js';
import { appRoot, patchLayer } from '../../lib/config.js';
import { writeIfPresent } from '../../lib/sysfs.js';
import { ofmArgs, glanceFile, BACKLIGHT } from './calibration.js';

/** What the ASR makes of a screen's name when it gets it wrong, back to the screen. */
const SCREEN_ALIAS = { stages: 'status', glands: 'glance', where: 'wear', ware: 'wear' };
import { StatusScreen } from './status.js';
import { PadCalScreen } from './pad-cal.js';
import { GlanceCalScreen } from './glance-cal.js';
import { BrightnessScreen } from './brightness.js';
import { BluetoothScreen } from './bluetooth.js';
import { LocationScreen } from './location.js';
import { WearScreen } from './wear.js';

const s = Schema.create;
const WIZARD = ['pad', 'glance', 'brightness'];

export class SystemMode {
  static moduleInfo = {
    name: 'system-mode',
    schema: s()
      .property('ofmArgsFile', s('string').default('/android-data/mainline/ofm-args').meta('description', 'pad thresholds for the next boot'))
      .property('ofmSysfs', s('string').default('/sys/module/jet_ofm/parameters').meta('description', 'jet-ofm parameters (thr_x, thr_y), applied live'))
      .property('glanceFile', s('string').default('/android-data/mainline/glance').meta('description', 'glance thresholds "on off"'))
      .property('iioDir', s('string').default('/sys/bus/iio/devices').meta('description', 'where the tmd2771 proximity channel is looked for'))
      .property('backlightFile', s('string').default('/android-data/mainline/backlight').meta('description', 'saved backlight level'))
      .property('backlightSysfs', s('string').default('/sys/class/backlight/kopin-a230/brightness').meta('description', 'backlight control'))
      .property('netDir', s('string').default('/sys/class/net').meta('description', 'interfaces the Status screen lists'))
      .property('btMarker', s('string').default('/android-data/mainline/bt').meta('description', 'exists = init powers the Bluetooth radio on at boot'))
      .property('gpsScript', s('string').default('/opt/jet-app/scripts/gps.sh').meta('description', 'the GPS bring-up script the Location screen runs (start|stop)'))
      .property('deviceConfig', s('string').default('/android-data/mainline/jet-app.json').meta('description', 'per-device config layer, where System screens persist settings'))
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('input', s('Input').meta('internal', true))
      .property('power', s('Power').meta('internal', true))
      .property('sensors', s('Sensors').meta('internal', true))
      .property('wear', s('Wear').meta('internal', true))
      .property('gps', s('Gps').meta('internal', true))
      .property('voice', s('Voice').lax().meta('internal', true))
      .property('checkFixS', s('number').default(180).meta('description', '"check my location": how long to hunt for a fix before giving up'))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('sounds', s('Sounds').meta('internal', true))
      .property('actions', s('Actions').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  ofmArgsFile; ofmSysfs; glanceFile; iioDir; backlightFile; backlightSysfs; netDir; btMarker; gpsScript; deviceConfig; checkFixS; modes; ui; input; power; sensors; wear; gps; voice; deviceLink; sounds; actions; logger;

  id = 'system'; label = 'System'; spoken = ['settings'];
  /** @type {Chooser} */ menu;
  /** @type {Record<string, object>} */ screens;
  /** @type {object|null} the open screen, null at the menu */ screen = null;
  /** @type {string[]|null} remaining wizard steps while the first-use wizard runs */ wizard = null;
  wizardIndex = 0;
  backlight = { level: BACKLIGHT.fallback, apply: (level) => this.#applyBacklight(level), save: (level) => this.#saveBacklight(level) };

  async start() {
    this.modes.register(this);   // before any await: registration order is the switcher's order
    const version = await fs.readFile(path.join(appRoot, 'package.json'), 'utf8').then((t) => JSON.parse(t).version, () => '?');
    this.screens = {
      status: new StatusScreen(this, version), pad: new PadCalScreen(this), glance: new GlanceCalScreen(this), brightness: new BrightnessScreen(this), wear: new WearScreen(this),
      bluetooth: new BluetoothScreen(this), location: new LocationScreen(this),
    };
    this.menu = new Chooser({ title: 'SYSTEM', items: [
      { id: 'status', label: 'Status' }, { id: 'pad', label: 'Pad calibration' }, { id: 'glance', label: 'Glance calibration' },
      { id: 'brightness', label: 'Brightness' }, { id: 'wear', label: 'Wear' }, { id: 'bluetooth', label: 'Bluetooth' }, { id: 'location', label: 'Location' },
    ], hint: 'swipe: move   front: open' });
    this.input.on('motion', (m) => { if (this.#current && this.screen === this.screens.pad) this.screens.pad.onMotion(m); });
    this.power.on('update', () => { if (this.#current && this.screen === this.screens.status && this.screens.status.onPower()) this.ui.requestRender(); });
    this.gps?.on('update', () => { if (this.#current && (this.screen === this.screens.location || this.screen === this.screens.status)) this.ui.requestRender(); });
    this.backlight.level = await this.#readBacklight();
    // "heya jet, open bluetooth": come here and show the screen (the Modes "open" declines names
    // that are no mode, so this gets them whatever the start order); the nouns the ASR has been
    // heard to bend ("stages", "where") are accepted as aliases
    this.actions?.register('open screen', /^open (?:the )?(status|stages|pad|glance|glands|brightness|wear|where|ware|bluetooth|location)$/, (m) => {
      if (this.modes.current !== this) this.modes.switchTo(this.id);
      this.wizard = null; this.open(SCREEN_ALIAS[m[1]] ?? m[1]);
    });
    // "heya jet, check my location": GPS on if it is off, then a spoken running commentary in
    // the background until the fix lands (the Location screen comes up) or the hunt times out.
    // The action itself resolves at once, so the voice route's ack is all the registry says.
    this.actions?.register('check location', /^check (?:my |the )?(location|position|gps)\b/, () => { this.#checkLocation(); });
    // "heya jet, enable bluetooth" / "disable wear": a setting's switch, from any mode (the ASR
    // sometimes hears the past tense, hence the optional d)
    this.actions?.register('setting', /^(enabled?|disabled?) (bluetooth|wear|where|ware|dark|gps|location)$/, (m) => {
      const on = m[1].startsWith('enable'), screen = m[2] === 'bluetooth' ? this.screens.bluetooth : m[2] === 'gps' || m[2] === 'location' ? this.screens.location : this.screens.wear;
      return screen.set(on);
    });
  }
  #current = false;

  // ---- "check my location" --------------------------------------------------------------------
  #checking = false;
  checkStepMs = 2000;   // the watch cadence (tests shrink it)

  /** The spoken hunt: progressive satellite news until the gated fix lands or time runs out. */
  async #checkLocation() {
    if (this.#checking) return;
    this.#checking = true;
    try {
      if (!(await this.screens.location.probe())) await this.screens.location.set(true);
      this.voice?.warm?.();
      if (this.gps?.goodFix()) return await this.#fixFound();
      await this.voice?.say?.('Getting a fix on you.');
      const t0 = Date.now();
      let saidSats = 0;
      while (Date.now() - t0 < this.checkFixS * 1000) {
        await new Promise((r) => setTimeout(r, this.checkStepMs));
        if (this.gps?.goodFix()) return await this.#fixFound();
        const sats = this.gps?.state.satsUsed ?? 0;
        if (sats >= 2 && sats !== saidSats) { saidSats = sats; await this.voice?.say?.(`${sats} satellites locked.`); }
      }
      await this.voice?.say?.('No fix yet. I will keep looking; your display has the hunt.');
      if (this.modes.current !== this) this.modes.switchTo(this.id);
      this.open('location');
    } catch (error) {
      this.logger?.warn({ error: error.message }, 'check location failed');
      await this.voice?.say?.('The receiver did not come up.').catch(() => {});
    } finally { this.#checking = false; }
  }

  /** The fix landed: the screen first, then the word. */
  async #fixFound() {
    if (this.modes.current !== this) this.modes.switchTo(this.id);
    this.open('location');
    await this.voice?.say?.('Got a fix. On your display.');
  }

  /** First use: no pad or glance calibration on userdata yet. */
  async firstUse() {
    const missing = [];
    for (const f of [this.ofmArgsFile, this.glanceFile]) if (!(await fs.access(f).then(() => true, () => false))) missing.push(f);
    if (missing.length) this.logger?.info({ missing }, 'first use: calibration missing');
    return missing.length > 0;
  }

  enter({ wizard = false } = {}) {
    this.#current = true;
    this.menu.selected = 0;
    if (wizard) { this.wizard = [...WIZARD]; this.wizardIndex = 0; this.open(this.wizard[0]); }
    else { this.wizard = null; this.open(null); }
  }
  leave() { this.#current = false; this.screen?.leave?.(); this.screen = null; this.wizard = null; }

  /** Show a screen by id (null: the menu). */
  open(id) {
    this.screen?.leave?.();
    this.screen = id ? this.screens[id] : null;
    this.screen?.enter?.();
    this.logger?.info({ screen: id ?? 'menu', wizard: this.wizard ? `${this.wizardIndex + 1}/${this.wizard.length}` : undefined }, 'system screen');
    this.ui.requestRender();
  }

  /** A calibration/brightness screen finished: next wizard step, or back to the menu. */
  stepDone() {
    this.sounds.play('success');
    if (this.wizard && ++this.wizardIndex < this.wizard.length) return this.open(this.wizard[this.wizardIndex]);
    if (this.wizard) { this.wizard = null; this.ui.setStrip('setup complete', { colour: C.ok, ms: 3000 }); }
    this.open(null);
  }
  /** Screen title with the wizard progress ("2 of 3") when the wizard is running. */
  stepTitle(title) { return this.wizard ? `${title}  ${this.wizardIndex + 1} of ${this.wizard.length}` : title; }

  onGesture(g) {
    if (this.screen) {
      if (this.screen.onGesture?.(g)) return true;
      if (g === 'press:rear') { this.wizard = null; this.open(null); return true; }
      return false;
    }
    switch (g) {
      case 'swipe:up': this.menu.move(-1); break;
      case 'swipe:down': this.menu.move(1); break;
      case 'press:front': case 'press:tap': this.open(this.menu.item.id); return true;
      default: return false;
    }
    this.ui.requestRender();
    return true;
  }

  tick() { this.screen?.tick?.(); }
  render(s) { if (this.screen) this.screen.render(s); else this.menu.render(s); }

  // ---- files and sysfs ------------------------------------------------------------------------
  /** A setting into the per-device config layer (deep-merged), e.g. `{ wear: { enabled } }`. */
  saveSetting(patch) { return patchLayer(this.deviceConfig, patch); }
  /** Pad thresholds: live to jet-ofm, and to the args file for the next boot. */
  async savePad({ thrX, thrY }) {
    await Promise.all([writeIfPresent(path.join(this.ofmSysfs, 'thr_x'), `${thrX}\n`), writeIfPresent(path.join(this.ofmSysfs, 'thr_y'), `${thrY}\n`)]);
    await writeFile(this.ofmArgsFile, ofmArgs({ thrX, thrY }));
  }

  /** Glance thresholds: to the file jetd reads, then `U` so jetd uses them now. */
  async saveGlance(result) {
    await writeFile(this.glanceFile, glanceFile(result));
    await this.deviceLink.reloadCalibration().then((r) => this.logger?.info(r, 'jetd calibration reloaded'), (error) => this.logger?.warn({ error: error.message }, 'jetd U failed'));
  }

  /** Average of `n` reads of the tmd2771 proximity channel, ~20 ms apart. */
  async readGlance(n) {
    const file = await this.#glancePath();
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (i) await new Promise((r) => setTimeout(r, 20));
      sum += parseInt(await fs.readFile(file, 'utf8'), 10) || 0;
    }
    return Math.trunc(sum / n);
  }
  #glance = null;
  async #glancePath() {
    if (this.#glance) return this.#glance;
    for (const d of await fs.readdir(this.iioDir).catch(() => [])) {
      const name = await fs.readFile(path.join(this.iioDir, d, 'name'), 'utf8').catch(() => '');
      if (name.startsWith('tmd2771')) return (this.#glance = path.join(this.iioDir, d, 'in_proximity0_raw'));
    }
    throw new Error(`no tmd2771 under ${this.iioDir}`);
  }

  async #readBacklight() {
    const saved = parseInt(await fs.readFile(this.backlightFile, 'utf8').catch(() => ''), 10);
    if (saved >= BACKLIGHT.min && saved <= BACKLIGHT.max) return saved;
    const live = parseInt(await fs.readFile(this.backlightSysfs, 'utf8').catch(() => ''), 10);
    return live >= BACKLIGHT.min && live <= BACKLIGHT.max ? live : BACKLIGHT.fallback;
  }
  #backlightWrite = Promise.resolve();
  #applyBacklight(level) {   // writes are serialised: a swipe burst must end on the last level
    this.backlight.level = level;
    this.#backlightWrite = this.#backlightWrite.then(() => writeIfPresent(this.backlightSysfs, `${level}\n`)).catch((error) => this.logger?.warn({ error: error.message }, 'backlight'));
  }
  async #saveBacklight(level) { this.backlight.level = level; await writeFile(this.backlightFile, `${level}\n`); this.logger?.info({ level }, 'backlight saved'); }
}

async function writeFile(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
/** Write a sysfs attribute when it exists (a dev box has none). */