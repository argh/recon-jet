// shell: `sh -c` on the device, for the questions no other tool answers (what is running, what
// a sysfs node says, whether a host resolves). The sandbox is the user it runs as: jet-app is
// root on the Jet, so the command is run through `setpriv` as an unprivileged user (`user` /
// `group`, all supplementary groups cleared) - read access to /proc and /sys, no writes that
// matter. If jet-app is root and that drop does not work (no setpriv in the rootfs, no such
// user), the tool refuses: there is no "just this once" as root. Not root (a dev box): the
// command runs as whoever we are. Bounded in time (`timeoutMs`, then the whole process group is
// killed) and in output (`maxChars`), with a bare environment, so nothing of jet-app's own
// leaks into what the model reads.
import { spawn } from 'node:child_process';
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;

export class ShellTool {
  static moduleInfo = {
    name: 'shell-tool',
    provides: 'Tool',
    schema: s()
      .property('timeoutMs', s('number').default(5000).meta('description', 'a command is killed after this long'))
      .property('maxChars', s('number').default(2000).meta('description', 'output handed to the model (the end is kept: that is where the answer usually is)'))
      .property('user', s('string').default('nobody').meta('description', 'the user commands run as when jet-app is root'))
      .property('group', s('string').default('nogroup').meta('description', '...and the group'))
      .property('setpriv', s('string').default('setpriv').meta('advanced').meta('description', 'the setpriv binary that drops to them'))
      .property('path', s('string').default('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin').meta('advanced').meta('description', 'PATH of the commands'))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  timeoutMs; maxChars; user; group; setpriv; path; logger;

  name = 'shell';
  description = 'Run a shell command on the glasses (Linux, busybox-style userland) and get its output. Read-only use: inspecting processes, files under /proc and /sys, the network. A few seconds at most.';
  parameters = { type: 'object', properties: { command: { type: 'string', description: 'passed to sh -c' } }, required: ['command'] };

  /** Who we are (a field so a test can be root without being root). */
  uid = () => process.getuid?.() ?? -1;
  /** @type {Promise<boolean>|null} whether the drop works, probed once */ #drop = null;

  /** @param {{command: string}} args @param {{signal?: AbortSignal}} [options] */
  async run({ command }, { signal } = {}) {
    if (!command?.trim()) throw new Error('command is empty');
    let argv = ['sh', '-c', command];
    if (this.uid() === 0) {
      const drop = [this.setpriv, '--reuid', this.user, '--regid', this.group, '--clear-groups'];
      this.#drop ??= this.#exec([...drop, 'true'], {}).then((r) => r.code === 0, () => false);
      if (!(await this.#drop)) {
        this.logger?.warn({ setpriv: this.setpriv, user: this.user }, 'shell tool: cannot drop root, refusing');
        return 'error: the shell is not available (it would run as root and cannot drop privileges on this device)';
      }
      argv = [...drop, ...argv];
    }
    const { code, killed, output } = await this.#exec(argv, { signal });
    const text = output.trim();
    const shown = text.length > this.maxChars ? `[cut: ${text.length - this.maxChars} earlier characters]\n${text.slice(-this.maxChars)}` : text;
    const status = killed ? `[killed: still running after ${this.timeoutMs / 1000} s]` : code ? `[exit ${code}]` : '';
    return [shown, status].filter(Boolean).join('\n') || '(no output)';
  }

  /** Run argv in its own process group; stdout and stderr as one text. Rejects when it cannot start, or `cancelled`. */
  #exec(argv, { signal }) {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: '/', env: { PATH: this.path, HOME: '/', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const limit = this.maxChars * 8;   // bytes kept while it runs: the tail
      let output = '', killed = false;
      const collect = (d) => { output += d; if (output.length > limit * 2) output = output.slice(-limit); };
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };   // the group: sh's children hold the pipes
      const timer = setTimeout(() => { killed = true; kill(); }, this.timeoutMs);
      const onAbort = () => kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = (fn, value) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(value); };
      child.stdout.setEncoding('utf8').on('data', collect); child.stderr.setEncoding('utf8').on('data', collect);
      child.on('error', (error) => done(reject, error));
      child.on('close', (code) => (signal?.aborted ? done(reject, new Error('cancelled')) : done(resolve, { code, killed, output })));
      if (signal?.aborted) kill();
    });
  }
}
