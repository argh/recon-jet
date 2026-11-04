// Shell mode: a switcher entry for jetd's own shell screen (a pty on the panel, typed into by a
// Bluetooth/USB keyboard or the hub's `I`). Entering sends `M shell`; jetd then owns the panel and
// the ui stops drawing. jetd hands back to remote on the keyboard's Ctrl+Alt+Enter, a front hold
// or a rear press; the exit is pure menu navigation: this mode stays current as a quiet backdrop
// and the switcher opens over it — nothing else is re-entered or re-launched. Front (or picking
// Shell again, or Ctrl+Alt+Enter) returns to the pty, which is preserved; rear ascends.
// Never persisted as the start mode (a reboot must not land in the shell).
import { Schema } from '@versionzero/module-manager';
import { C, TOP, heading, hint, paragraph } from '../../modules/ui/style.js';

const s = Schema.create;

export class ShellMode {
  static moduleInfo = {
    name: 'shell-mode',
    schema: s()
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  modes; ui; deviceLink; logger;

  id = 'shell'; label = 'Shell'; transient = true; spoken = ['console'];
  #current = false;

  async start() {
    this.modes.register(this);
    // jetd is back in remote mode (hotkey, front hold, rear, or a jetd restart): the shell was
    // left — land on the menu
    this.deviceLink.on('mode', (mode) => { if (this.#current && mode === 'remote') this.#back(); });
    this.deviceLink.on('hello', () => { if (this.#current && this.deviceLink.mode === 'remote') this.#back(); });
  }

  enter() {
    this.#current = true;
    if (!this.deviceLink.setMode('shell')) this.logger?.warn('shell: jetd not connected');
  }
  leave() { this.#current = false; }

  #back() {
    // pure menu navigation: no "previous mode" is re-entered (that misread once re-launched
    // doom underneath the menu) — the shell stays current as a backdrop and the menu opens
    this.logger?.info('shell closed: menu');
    this.modes.openSwitcher();
    this.ui.requestRender();
  }

  /** Picking Shell in the switcher while it is already current: back into the pty. */
  reselect() { this.enter(); }

  onGesture(g) {
    if (this.deviceLink.mode !== 'remote') return true;   // jetd has the keys while its shell shows
    // the backdrop (shell left, menu dismissed): front returns to the pty, rear ascends
    if (g === 'press:front' || g === 'press:tap') { this.enter(); return true; }
    return false;
  }

  /** The instant before jetd takes the panel — or, after the shell was left, a truly neutral
   *  backdrop (black + one hint): modes are modal, nothing pretends to still be showing. */
  render(s) {
    if (this.deviceLink.connected && this.deviceLink.mode !== 'shell') { hint(s, 'front: shell   rear: menu'); return; }
    heading(s, 'shell');
    paragraph(s, 6, TOP + 30, s.width - 12, 120, this.deviceLink.connected ? 'jetd is drawing its shell.' : 'jetd is not connected.', { colour: C.dim });
    hint(s, 'Ctrl+Alt+Enter, front hold or rear: back');
  }
}
