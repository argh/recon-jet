// Shell mode: a switcher entry for jetd's own shell screen (a pty on the panel, typed into by a
// Bluetooth/USB keyboard or the hub's `I`). Entering sends `M shell`; jetd then owns the panel and
// the ui stops drawing. jetd hands back to remote on the keyboard's Ctrl+Alt+Enter, a front hold
// or a rear press; this mode then returns to the previous mode with the switcher open (leaving
// the shell is an ascent).
// Never persisted as the start mode (a reboot must not land in the shell).
import { Schema } from '@versionzero/module-manager';
import { C, TOP, heading, hint, paragraph } from '../../modules/ui/style.js';

const s = Schema.create;

export class ShellMode {
  static moduleInfo = {
    name: 'shell-mode',
    schema: s()
      .property('returnTo', s('string').default('system').meta('description', 'mode to return to when nothing was showing before'))
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('deviceLink', s('DeviceLink').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  returnTo; modes; ui; deviceLink; logger;

  id = 'shell'; label = 'Shell'; transient = true; spoken = ['console'];
  /** @type {string|null} the mode showing before the shell */ previous = null;
  #current = false;

  async start() {
    this.modes.register(this);
    this.modes.on('mode', (m) => { if (m !== this) this.previous = m.id; });
    // jetd is back in remote mode (hotkey, its chooser, or a jetd restart): give the panel back to the app
    this.deviceLink.on('mode', (mode) => { if (this.#current && mode === 'remote') this.#back(); });
    this.deviceLink.on('hello', () => { if (this.#current && this.deviceLink.mode === 'remote') this.#back(); });
  }

  enter() {
    this.#current = true;
    if (!this.deviceLink.setMode('shell')) this.logger?.warn('shell: jetd not connected');
  }
  leave() { this.#current = false; }

  #back() {
    const id = this.previous && this.previous !== this.id ? this.previous : this.returnTo;
    this.logger?.info({ to: id }, 'shell closed');
    if (!this.modes.switchTo(id)) this.modes.switchTo(this.modes.list.find((m) => m !== this)?.id);
    this.modes.openSwitcher();   // leaving the shell is an ascent: land on the menu (rear or a pick dismisses)
  }

  onGesture() { return true; }   // jetd has the keys while its shell shows; nothing to do here

  /** Only visible for the instant before jetd takes the panel, or if it never does. */
  render(s) {
    heading(s, 'shell');
    paragraph(s, 6, TOP + 30, s.width - 12, 120, this.deviceLink.connected ? 'jetd is drawing its shell.' : 'jetd is not connected.', { colour: C.dim });
    hint(s, 'Ctrl+Alt+Enter, front hold or rear: back');
  }
}
