// System mode: a chooser-style menu of the device's own screens. The screens are modules of
// their own (`provides: 'Screen'`, each with its own schema and injected models - see status.js
// for the shape); this mode holds the configurable `screens` array (menu order; personal/ can
// add to it), the menu, the first-use wizard sequencing, and the gesture tree: front press opens
// the selected screen, rear press returns to the menu (and does nothing at the menu: that is the
// mode's root). A screen gets `enter(ctx)` / `leave()` from here - it subscribes to its own
// models while showing - with `ctx.wizard` ("n of 3") and `ctx.done()` to step the wizard.
//
// First use: when a screen says `needsSetup()` (pad or glance calibration missing on userdata),
// `firstUse()` tells the registry to start here as a wizard that walks Pad calibration, then
// Glance calibration, then Brightness; the same screens are reachable from the menu later.
import { Schema } from '@versionzero/module-manager';
import { Chooser } from '../../modules/ui/chooser.js';
import { C } from '../../modules/ui/style.js';
import { StatusScreen } from './status.js';
import { PadCalScreen } from './pad-cal.js';
import { GlanceCalScreen } from './glance-cal.js';
import { BrightnessScreen } from './brightness.js';
import { BluetoothScreen } from './bluetooth.js';
import { LocationScreen } from './location.js';
import { WearScreen } from './wear.js';

/** What the ASR makes of a screen's name when it gets it wrong, back to the screen. */
const SCREEN_ALIAS = { stages: 'status', glands: 'glance', where: 'wear', ware: 'wear' };

const s = Schema.create;
const WIZARD = ['pad', 'glance', 'brightness'];

export class SystemMode {
  static moduleInfo = {
    name: 'system-mode',
    schema: s()
      .property('screens', s('array').property('*', s('Screen'))
        .default(['status-screen', 'pad-cal-screen', 'glance-cal-screen', 'brightness-screen', 'wear-screen', 'bluetooth-screen', 'location-screen'])
        .meta('description', 'the System screens, in menu order (personal/ screens provide "Screen" and are added here)'))
      .property('checkFixS', s('number').default(180).meta('description', '"check my location": how long to hunt for a fix before giving up'))
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('gps', s('Gps').meta('internal', true))
      .property('voice', s('Voice').lax().meta('internal', true))
      .property('sounds', s('Sounds').meta('internal', true))
      .property('actions', s('Actions').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
    register: [
      { ModuleClass: StatusScreen, relative: true },
      { ModuleClass: PadCalScreen, relative: true },
      { ModuleClass: GlanceCalScreen, relative: true },
      { ModuleClass: BrightnessScreen, relative: true },
      { ModuleClass: WearScreen, relative: true },
      { ModuleClass: BluetoothScreen, relative: true },
      { ModuleClass: LocationScreen, relative: true },
    ],
  };
  /** @type {object[]} the Screen providers, in menu order (injected) */ screens = [];
  checkFixS; modes; ui; gps; voice; sounds; actions; logger;

  id = 'system'; label = 'System'; spoken = ['settings'];
  /** @type {Chooser} */ menu;
  /** @type {object|null} the open screen, null at the menu */ screen = null;
  /** @type {string[]|null} remaining wizard steps while the first-use wizard runs */ wizard = null;
  wizardIndex = 0;

  async start() {
    this.modes.register(this);   // before any await: registration order is the switcher's order
    this.menu = new Chooser({ title: 'SYSTEM', items: this.screens.map((sc) => ({ id: sc.id, label: sc.label ?? sc.id })), hint: 'swipe: move   front: open' });
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
      const on = m[1].startsWith('enable'), id = m[2] === 'bluetooth' ? 'bluetooth' : m[2] === 'gps' || m[2] === 'location' ? 'location' : 'wear';
      const screen = this.getScreen(id);
      if (!screen?.set) throw new Error(`no ${id} screen`);
      return screen.set(on);
    });
  }
  #current = false;

  /** The screen with this id (undefined when the configured array has no such screen). */
  getScreen(id) { return this.screens.find((sc) => sc.id === id); }

  // ---- "check my location" --------------------------------------------------------------------
  #checking = false;
  checkStepMs = 2000;   // the watch cadence (tests shrink it)

  /** The spoken hunt: progressive satellite news until the gated fix lands or time runs out. */
  async #checkLocation() {
    if (this.#checking) return;
    this.#checking = true;
    try {
      if (!(await this.gps.probe())) await this.gps.set(true);
      this.voice?.warm?.();
      if (this.gps.goodFix()) return await this.#fixFound();
      await this.voice?.say?.('Getting a fix on you.');
      const t0 = Date.now();
      let saidSats = 0;
      while (Date.now() - t0 < this.checkFixS * 1000) {
        await new Promise((r) => setTimeout(r, this.checkStepMs));
        if (this.gps.goodFix()) return await this.#fixFound();
        const sats = this.gps.state.satsUsed ?? 0;
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

  /** The fix landed: the map (centred on the fix), then the word. Falls back to the Location
   * screen if the map mode is not available. */
  async #fixFound() {
    if (!this.modes.switchTo('map')) { if (this.modes.current !== this) this.modes.switchTo(this.id); this.open('location'); }
    await this.voice?.say?.('Got a fix. On your display.');
  }

  /** First use: a screen reports its setup missing (pad or glance calibration). */
  async firstUse() {
    const missing = [];
    for (const sc of this.screens) if (await Promise.resolve(sc.needsSetup?.()).catch(() => false)) missing.push(sc.id);
    if (missing.length) this.logger?.info({ missing }, 'first use: setup missing');
    return missing.length > 0;
  }

  enter({ wizard = false } = {}) {
    this.#current = true;
    this.menu.selected = 0;
    if (wizard) { this.wizard = WIZARD.filter((id) => this.getScreen(id)); this.wizardIndex = 0; this.open(this.wizard[0]); }
    else { this.wizard = null; this.open(null); }
  }
  leave() { this.#current = false; this.screen?.leave?.(); this.screen = null; this.wizard = null; }

  /** Show a screen by id (null: the menu). The screen hears `enter(ctx)` / `leave()` and does
   * its own model subscriptions while showing. */
  open(id) {
    this.screen?.leave?.();
    this.screen = id ? this.getScreen(id) ?? null : null;
    this.screen?.enter?.({ wizard: this.wizard ? { n: this.wizardIndex + 1, of: this.wizard.length } : null, done: () => this.stepDone() });
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
}
