// Doom mode: a child process owns the panel; the ui is suspended while it runs, frozen/resumed
// around the switcher, killed by leaving, and its own exit opens the menu (pure menu navigation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stack, fakeMode, fakeSounds, settle, tmpdir } from './helpers.js';
import { readState } from '../src/modules/modes/state.js';
import { DoomMode } from '../src/modes/doom/index.js';

const until = async (fn, what, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 20)); } };

/** Stands in for doom: announces itself, reports the freeze signals, dies on SIGTERM like any process. */
function fakeDoom() {
  const file = path.join(tmpdir('jet-doom-'), 'doom.sh');
  fs.writeFileSync(file, "#!/bin/sh\ntrap 'echo freeze' USR1\ntrap 'echo thaw' USR2\necho 'jet: fb 428x240'\nwhile :; do sleep 0.05; done\n", { mode: 0o755 });
  return file;
}

async function setup(t, command) {
  const s = await stack(); t.after(s.stop);
  const wad = path.join(s.dir, 'x.wad'); fs.writeFileSync(wad, 'IWAD');
  const actions = { registered: [], register(name, pattern, run) { this.registered.push({ name, pattern, run }); return this; } };
  const doom = Object.assign(new DoomMode(), { command, args: `-iwad ${wad}`, dataDir: path.join(s.dir, 'doom'), modes: s.modes, ui: s.ui, sounds: fakeSounds(), actions });
  s.modes.register(fakeMode('log')).register(fakeMode('system'));
  await doom.start(); t.after(() => doom.stop());
  await s.modes.begin(); await settle();
  s.modes.switchTo('system'); await s.modes.saving;
  return { s, doom };
}

test('doom: runs the child with the ui suspended, freezes around the switcher, leaving kills it', async (t) => {
  const { s, doom } = await setup(t, fakeDoom());
  s.modes.switchTo('doom'); await settle();
  assert.equal(s.modes.current, doom);
  assert.ok(doom.child, 'spawned');
  assert.deepEqual(doom.child.spawnargs.slice(1), ['-iwad', path.join(s.dir, 'x.wad')]);
  assert.ok(fs.existsSync(path.join(s.dir, 'doom')), 'data dir created (doom writes its config and saves to the cwd)');
  assert.equal((await readState(s.stateFile)).mode, 'system', 'never the persisted start mode');
  await until(() => s.ui.suspended, 'suspended once doom prints');
  assert.equal(s.ui.active, false, 'nothing drawn over doom');
  let now = 1000;
  s.k.frontHold(now); now += 2000;
  assert.ok(s.modes.switcher, 'switcher open');
  assert.equal(doom.frozen, true); assert.equal(s.ui.active, true, 'the ui paints again (switcher over the frozen frame)');
  await until(() => doom.tail.includes('freeze'), 'SIGUSR1 delivered');
  s.k.rearPress(now); now += 500;
  assert.equal(s.modes.switcher, null); assert.equal(doom.frozen, false); assert.equal(s.ui.active, false, 'suspended again');
  await until(() => doom.tail.includes('thaw'), 'SIGUSR2 delivered');
  s.k.frontPress(now); now += 500;
  assert.ok(doom.child, 'gestures while running do not reach the mode logic');
  const child = doom.child;
  s.k.frontHold(now); now += 2000; s.k.up(now); now += 500;   // doom is last in the list: up = system
  assert.equal(s.modes.switcher.item.id, 'system');
  s.k.frontPress(now); now += 500; await settle();
  assert.equal(s.modes.current.id, 'system'); assert.equal(doom.child, null); assert.equal(s.ui.active, true);
  await until(() => child.exitCode !== null || child.signalCode !== null, 'child gone');
  assert.equal(child.signalCode, 'SIGTERM');
});

test('doom: quitting by itself concludes onto the menu; a crash shows why and rear ascends', async (t) => {
  const { s, doom } = await setup(t, fakeDoom());
  s.modes.switchTo('doom'); await settle();
  await until(() => s.ui.suspended, 'running');
  doom.child.kill('SIGTERM');   // what Esc > Quit amounts to: a clean end not caused by leave()
  await until(() => s.modes.switcher, 'the menu is the screen: navigating out, nothing re-entered');
  assert.equal(s.modes.current, null, 'nothing current under the menu');
  assert.equal(s.modes.switcher.item.id, 'doom', 'opened on the mode that ended');
  assert.equal(s.ui.active, true); assert.equal(doom.error, null);
  let now = 1000;
  s.k.rearPress(now); now += 500;
  assert.notEqual(s.modes.switcher, null, 'rear cannot dismiss the menu: nothing to go back into');
  s.k.frontHold(now); now += 2000;
  assert.notEqual(s.modes.switcher, null, 'front hold cannot either');
  s.k.frontPress(now); now += 500; await settle();
  assert.ok(doom.child, 'picking Doom again relaunches it');
  assert.equal(s.modes.current, doom);
  doom.child.kill('SIGTERM');
  await until(() => s.modes.switcher, 'menu again after the second quit');
  s.k.up(now); now += 500; s.k.frontPress(now); now += 500; await settle();
  assert.equal(s.modes.current.id, 'system', 'another mode is a menu pick away');
  s.modes.switchTo('doom'); await settle();
  await until(() => s.ui.suspended, 'running again');
  doom.child.kill('SIGKILL');
  await until(() => doom.error, 'crash reported');
  assert.match(doom.error, /SIGKILL/); assert.deepEqual(doom.sounds.played, ['error'], 'a crash is heard'); assert.equal(s.modes.current, doom); assert.equal(s.ui.active, true);
  assert.equal(s.modes.switcher, null, 'a crash keeps the mode, showing why');
  s.k.rearPress(now); now += 500;
  assert.notEqual(s.modes.switcher, null, 'rear on the error screen ascends to the menu');
  s.k.frontPress(now); now += 500; await settle();
  assert.ok(doom.child, 'picking Doom from the crash screen relaunches (reselect)');
});

test('doom: without the binary or the WAD the switcher lists it disabled and it cannot be entered', async (t) => {
  const { s, doom } = await setup(t, fakeDoom());
  fs.unlinkSync(path.join(s.dir, 'x.wad'));
  assert.equal(doom.unavailable(), 'no WAD');
  assert.equal(s.modes.switchTo('doom'), false); assert.equal(s.modes.current.id, 'system');
  let now = 1000;
  s.k.frontHold(now); now += 2000;
  const item = s.modes.switcher.items.find((i) => i.id === 'doom');
  assert.equal(item.disabled, true); assert.equal(item.label, 'Doom  no WAD');
  s.k.down(now); now += 500;   // doom is last: down from system wraps past it
  assert.notEqual(s.modes.switcher.item.id, 'doom');
  s.modes.switcher.select('doom'); assert.notEqual(s.modes.switcher.item.id, 'doom', 'never selectable');
  s.k.rearPress(now); now += 500;
  doom.command = path.join(s.dir, 'nope');
  assert.equal(doom.unavailable(), 'no binary');
  fs.writeFileSync(path.join(s.dir, 'x.wad'), 'IWAD'); doom.command = fakeDoom();
  assert.equal(doom.unavailable(), null, 'checked live: dropping the files in is enough');
  const [run] = doom.actions.registered;
  assert.equal(run.name, 'doom'); assert.ok(run.pattern.test('run doom') && run.pattern.test('random') === false && run.pattern.test('run random') && !run.pattern.test('doom is scary'));
  fs.unlinkSync(path.join(s.dir, 'x.wad'));
  await assert.rejects(Promise.resolve().then(() => run.run([], 'run doom')), /Doom: no WAD/, 'spoken while unavailable: the reason comes back');
  assert.equal(s.modes.current.id, 'system');
  fs.writeFileSync(path.join(s.dir, 'x.wad'), 'IWAD');
  run.run([], 'run doom'); await settle();
  assert.equal(s.modes.current, doom, '"run doom" enters the mode');
});
