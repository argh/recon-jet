// Shell mode: a switcher entry for jetd's own shell screen (a pty on the panel, typed into by a
// Bluetooth/USB keyboard or the hub's `I`). Entering sends `M shell`; jetd then owns the panel and
// the ui stops drawing. jetd hands back to remote on the keyboard's Ctrl+Alt+Enter, a front hold
// or a rear press: the shell's content is gone from the glass, so the mode concludes — navigating
// out lands on the menu, with nothing current under it. The pty itself is preserved; picking
// Shell again reopens it. Never persisted as the start mode (a reboot must not land in the shell).
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
    // left, its content is gone — conclude, so the menu is the screen
    this.deviceLink.on('mode', (mode) => { if (this.#current && mode === 'remote') this.modes.conclude(this); });
    this.deviceLink.on('hello', () => { if (this.#current && this.deviceLink.mode === 'remote') this.modes.conclude(this); });
  }

  enter() {
    this.#current = true;
    if (!this.deviceLink.setMode('shell')) this.logger?.warn('shell: jetd not connected');
  }
  leave() { this.#current = false; }

  /** The instant before jetd takes the panel (or jetd is not there to take it). */
  render(s) {
    heading(s, 'shell');
    paragraph(s, 6, TOP + 30, s.width - 12, 120, this.deviceLink.connected ? 'jetd is drawing its shell.' : 'jetd is not connected.', { colour: C.dim });
    hint(s, 'Ctrl+Alt+Enter, front hold or rear: back');
  }
}
