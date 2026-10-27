// Shell mode: the switcher entry that hands the panel to jetd's shell and takes it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stack, fakeMode, settle } from './helpers.js';
import { readState } from '../src/modules/modes/state.js';
import { ShellMode } from '../src/modes/shell/index.js';

test('shell: enter sends M shell, jetd back in remote returns to the previous mode, never persisted', async (t) => {
  const s = await stack(); t.after(s.stop);
  const shell = Object.assign(new ShellMode(), { returnTo: 'system', modes: s.modes, ui: s.ui, deviceLink: s.link });
  s.modes.register(fakeMode('log')).register(fakeMode('system'));
  await shell.start();
  await s.modes.begin(); await settle();
  assert.deepEqual(s.modes.list.map((m) => m.id), ['log', 'system', 'shell']);
  s.modes.switchTo('system'); await s.modes.saving;
  s.modes.switchTo('shell'); await settle();
  assert.equal(s.modes.current, shell);
  assert.ok(s.link.sent.includes('M shell'));
  assert.equal((await readState(s.stateFile)).mode, 'system', 'the shell is not the persisted start mode');
  s.link.mode = 'shell'; s.link.emit('mode', 'shell'); await settle();
  assert.equal(s.modes.current, shell, 'jetd drawing: still the current mode');
  s.link.mode = 'remote'; s.link.emit('mode', 'remote'); await settle();
  assert.equal(s.modes.current.id, 'system', 'back to what was showing before');
  // from the boot/log view with nothing before: a jetd restart (fresh hello in remote) also returns
  s.modes.switchTo('shell'); await settle();
  s.link.mode = 'remote'; s.link.emit('hello', s.link.hello); await settle();
  assert.equal(s.modes.current.id, 'system');
});
