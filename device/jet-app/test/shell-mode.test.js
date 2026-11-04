// Shell mode: the switcher entry that hands the panel to jetd's shell and takes it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stack, fakeMode, settle } from './helpers.js';
import { readState } from '../src/modules/modes/state.js';
import { ShellMode } from '../src/modes/shell/index.js';

test('shell: enter sends M shell; leaving concludes (the menu is the screen); never persisted', async (t) => {
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
  assert.equal(s.modes.current, null, 'concluded: nothing current, the menu is the screen');
  assert.notEqual(s.modes.switcher, null, 'leaving the shell lands on the menu');
  assert.equal(s.modes.switcher.item.id, 'shell', 'opened on the mode that ended');
  let now = 1000;
  s.k.rearPress(now); now += 500;
  assert.notEqual(s.modes.switcher, null, 'rear cannot dismiss the menu: nothing to go back into');
  s.k.frontHold(now); now += 2000;
  assert.notEqual(s.modes.switcher, null, 'front hold cannot either');
  s.k.frontPress(now); now += 500; await settle();
  assert.equal(s.modes.current, shell, 'picking Shell re-enters it');
  assert.equal(s.modes.switcher, null);
  assert.equal(s.link.sent.filter((l) => l === 'M shell').length, 2, 'the pty is reopened');
  // a jetd restart (fresh hello in remote) while the shell is current also concludes
  s.link.mode = 'remote';
  s.link.emit('hello', s.link.hello); await settle();
  assert.equal(s.modes.current, null);
  assert.notEqual(s.modes.switcher, null);
});
