// Shell mode: the switcher entry that hands the panel to jetd's shell and takes it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stack, fakeMode, settle } from './helpers.js';
import { readState } from '../src/modules/modes/state.js';
import { ShellMode } from '../src/modes/shell/index.js';

test('shell: enter sends M shell; leaving is pure menu nav (switcher opens, nothing re-entered); reselect returns to the pty; never persisted', async (t) => {
  const s = await stack(); t.after(s.stop);
  const shell = Object.assign(new ShellMode(), { modes: s.modes, ui: s.ui, deviceLink: s.link });
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
  assert.equal(s.modes.current, shell, 'no previous mode is re-entered');
  assert.notEqual(s.modes.switcher, null, 'leaving the shell lands on the menu');
  s.modes.closeSwitcher();
  // the backdrop: front returns to the pty, rear is unconsumed (ascends)
  const sent = s.link.sent.length;
  assert.equal(shell.onGesture('press:rear'), false, 'rear at the backdrop ascends');
  assert.equal(shell.onGesture('press:front'), true);
  assert.equal(s.link.sent.slice(sent).filter((l) => l === 'M shell').length, 1, 'front re-enters the pty');
  // picking Shell in the switcher while current re-enters too (the reselect hook)
  s.link.mode = 'remote';
  s.modes.switchTo('shell'); await settle();
  assert.equal(s.link.sent.filter((l) => l === 'M shell').length, 3, 'reselect sends M shell again');
  // a jetd restart (fresh hello in remote) while the shell is current also lands on the menu
  s.link.emit('hello', s.link.hello); await settle();
  assert.notEqual(s.modes.switcher, null);
});
