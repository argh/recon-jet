// Doom mode: runs the native doom binary (device/doom, a doomgeneric port) and gets out of its
// way. doom is a jetd client of its own: it takes keys over the socket and writes its frames
// straight into fb0, so while it runs the ui is suspended and this mode swallows every gesture.
// The switcher still works: while it is open doom is frozen (SIGUSR1: paused, not drawing or
// sounding, keys discarded) and the ui paints over its last frame; closing the switcher resumes
// it (SIGUSR2), picking another mode kills it (SIGTERM) — modes are modal, nothing runs behind
// the menu. doom ending by itself (Esc > Quit) is pure menu navigation like everywhere else:
// this mode stays current (showing "not running") and the switcher opens over it; a crash shows
// the reason and rear ascends. Without the binary or the IWAD
// (not in the repo: device/doom/README.md) the switcher lists Doom disabled with what is missing.
// Never persisted as the start mode.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { Schema } from '@versionzero/module-manager';
import { C, TOP, heading, hint, paragraph } from '../../modules/ui/style.js';

const s = Schema.create;

export class DoomMode {
  static moduleInfo = {
    name: 'doom-mode',
    schema: s()
      .property('command', s('string').default('/usr/local/bin/doom').meta('description', 'the doom binary (device/doom)'))
      .property('args', s('string').default('-iwad /usr/local/share/doom/DOOM1.WAD').meta('description', 'its arguments, space separated (-stretch fills the glass)'))
      .property('dataDir', s('string').default('/android-data/mainline/doom').meta('description', 'doom runs here: its default.cfg and savegames (it writes to the current directory)'))
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('sounds', s('Sounds').meta('internal', true))
      .property('actions', s('Actions').meta('internal', true))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  command; args; dataDir; modes; ui; sounds; actions; logger;

  id = 'doom'; label = 'Doom'; transient = true;
  /** @type {import('node:child_process').ChildProcess|null} */ child = null;
  /** @type {string|null} why the last run ended badly */ error = null;
  /** @type {string[]} the last lines doom printed */ tail = [];
  frozen = false;

  async start() {
    this.modes.register(this);
    this.modes.on('switcher', (open) => this.#switcher(open));
    // "heya jet, run doom" (the ASR hears "random" more often than not): the switcher's refusal
    // (no binary, no WAD) is the error the voice reports
    this.actions?.register('doom', /^run (?:doom|random|dune)\b/, () => { if (!this.modes.switchTo(this.id)) throw new Error(`Doom: ${this.unavailable() ?? 'unavailable'}`); });
  }
  async stop() { this.#kill(); }

  /** Why Doom cannot run: the binary or the IWAD named by `-iwad` is not there (device/doom/deploy.sh puts both in place). */
  unavailable() {
    const args = this.args.split(/\s+/).filter(Boolean), wad = args[args.indexOf('-iwad') + 1];
    try { fs.accessSync(this.command, fs.constants.X_OK); } catch { return 'no binary'; }
    if (args.includes('-iwad') && !fs.existsSync(wad)) return 'no WAD';
    return null;
  }

  enter() { this.error = null; this.#launch(); }
  leave() { this.#kill(); this.ui.suspend(false); }
  /** Picking Doom in the menu while this mode is current (it quit underneath): run it again. */
  reselect() { if (!this.child) { this.error = null; this.#launch(); } }

  /** doom has the keys (from jetd) while it runs; with it gone, rear ascends to the menu. */
  onGesture(g) {
    if (this.child) return true;
    return g !== 'press:rear';
  }

  render(s) {
    heading(s, 'doom');
    const text = this.error ? this.error : this.child ? (this.frozen ? 'paused' : 'starting...') : 'not running';
    paragraph(s, 6, TOP + 30, s.width - 12, 120, text, { colour: this.error ? C.bad : C.dim });
    hint(s, this.child ? 'front hold: menu   Esc > Quit ends' : 'rear: back');
  }

  #launch() {
    if (this.child) return;
    this.tail = []; this.frozen = false;
    const args = this.args.split(/\s+/).filter(Boolean);
    let child;
    try { fs.mkdirSync(this.dataDir, { recursive: true }); child = spawn(this.command, args, { cwd: this.dataDir, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { this.#failed(error.message); return; }
    this.child = child;
    this.logger?.info({ pid: child.pid, command: this.command, args }, 'doom started');
    let suspended = false;
    const lines = (level) => (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) { this.tail.push(line); this.logger?.[level]?.({ doom: line }, 'doom'); }
      this.tail = this.tail.slice(-8);
      if (!suspended && this.child === child) { suspended = true; this.ui.suspend(true); }   // it is about to draw
    };
    child.stdout.on('data', lines('debug'));
    child.stderr.on('data', lines('warn'));
    child.on('error', (error) => { if (this.child === child) { this.child = null; this.#failed(error.message); } });   // e.g. ENOENT
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ui.suspend(false);
      this.logger?.info({ code, signal, tail: this.tail.slice(-3) }, 'doom ended');
      if (this.modes.current !== this) return;
      // pure menu navigation: a clean quit lands on the menu over this mode's "not running"
      if (code === 0 || signal === 'SIGTERM') this.modes.openSwitcher();
      else this.#failed(`doom ended (${signal ?? `exit ${code}`}): ${this.tail.at(-1) ?? ''}`);
    });
  }

  #failed(message) { this.error = message; this.sounds.play('error'); this.frozen = false; this.ui.suspend(false); this.logger?.warn({ error: message }, 'doom failed'); this.ui.requestRender(); }

  #kill() { const c = this.child; if (!c) return; this.child = null; c.kill('SIGTERM'); this.frozen = false; }

  #switcher(open) {
    if (this.modes.current !== this || !this.child) return;
    this.frozen = open;
    if (open) { this.child.kill('SIGUSR1'); this.ui.suspend(false); }
    else { this.ui.suspend(true); this.child.kill('SIGUSR2'); }
  }
}
