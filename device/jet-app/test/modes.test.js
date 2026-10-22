// The mode registry and switcher through the real input/surface/ui stack: start mode choice
// (first-use wizard, persisted, default, first registered), the switcher overlay, gesture
// routing to the mode, persistence, and which modes start a voice turn on a front press.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stack, fakeMode, fakeLink, settle, tmpdir } from './helpers.js';
import { readState, writeState } from '../src/modules/modes/state.js';
import { AssistantMode } from '../src/modes/assistant/index.js';
import { DemoMode } from '../src/modes/demo/index.js';
import { SystemMode } from '../src/modes/system/index.js';

test('modes: the boot mode shows until begin(); the first registered mode is the fallback start', async (t) => {
  const s = await stack(); t.after(s.stop);
  const log = fakeMode('log'), demo = fakeMode('demo');
  assert.deepEqual(s.link.sent.filter((l) => l[0] === 'K'), ['K 1']);
  s.modes.register(log).register(demo);
  await settle();
  assert.ok(log.rendered >= 1, 'the boot (log) mode is painted before any mode is entered');
  assert.equal(s.modes.current, null); assert.deepEqual(log.events, []);
  await s.modes.begin(); await settle();
  assert.equal(s.modes.current, log); assert.deepEqual(log.events, [['enter', false]]);
  assert.throws(() => s.modes.register(fakeMode('log')), /twice/);
  assert.throws(() => s.modes.register({ id: 'x' }), /render/);
});

test('modes: persisted mode wins over ui.defaultMode, which wins over the first registered', async (t) => {
  const stateFile = path.join(tmpdir(), 'state.json');
  const a = await stack({ stateFile, defaultMode: 'demo' }); t.after(a.stop);
  a.modes.register(fakeMode('log')).register(fakeMode('demo')).register(fakeMode('system'));
  await a.modes.begin();
  assert.equal(a.modes.current.id, 'demo', 'default mode');
  assert.ok(!fs.existsSync(stateFile), 'begin() does not persist what it only restored');
  assert.equal(a.modes.switchTo('system'), true);
  assert.equal(a.modes.switchTo('nope'), false);
  await a.modes.saving;
  assert.deepEqual(await readState(stateFile), { mode: 'system' });
  await a.stop();
  const b = await stack({ stateFile, defaultMode: 'demo' }); t.after(b.stop);
  b.modes.register(fakeMode('log')).register(fakeMode('demo')).register(fakeMode('system'));
  await b.modes.begin();
  assert.equal(b.modes.current.id, 'system', 'restored');
  await writeState(stateFile, { mode: 'gone' });
  await b.stop();
  const c = await stack({ stateFile, defaultMode: 'demo' }); t.after(c.stop);
  c.modes.register(fakeMode('log')).register(fakeMode('demo'));
  await c.modes.begin();
  assert.equal(c.modes.current.id, 'demo', 'an unknown persisted mode falls back');
  assert.deepEqual(await readState(stateFile), { mode: 'gone' }, 'state keeps other keys and is merged on write');
});

test('modes: a mode asking for first use starts as the wizard', async (t) => {
  const s = await stack({ defaultMode: 'demo' }); t.after(s.stop);
  const system = fakeMode('system', { firstUse: async () => true });
  s.modes.register(fakeMode('log')).register(fakeMode('demo')).register(system);
  await s.modes.begin();
  assert.equal(s.modes.current, system); assert.deepEqual(system.events, [['enter', true]]);
});

test('modes: front hold opens the switcher, swipes move, front picks (enter/leave, persisted), rear cancels', async (t) => {
  const s = await stack(); t.after(s.stop);
  const log = fakeMode('log'), demo = fakeMode('demo'), sys = fakeMode('system');
  s.modes.register(log).register(demo).register(sys);
  await s.modes.begin(); await settle();
  let now = 1000;
  s.k.frontHold(now); now += 2000;
  assert.ok(s.modes.switcher, 'switcher open on hold');
  assert.deepEqual(s.modes.switcher.items.map((i) => i.label), ['Log', 'Demo', 'System']);
  assert.equal(s.modes.switcher.item.id, 'log', 'opens on the current mode');
  s.k.down(now); now += 500; assert.equal(s.modes.switcher.item.id, 'demo');
  s.k.down(now); now += 500; assert.equal(s.modes.switcher.item.id, 'system');
  s.k.down(now); now += 500; assert.equal(s.modes.switcher.item.id, 'log', 'wraps');
  s.k.up(now); now += 500; assert.equal(s.modes.switcher.item.id, 'system');
  s.k.up(now - 400); assert.equal(s.modes.switcher.item.id, 'system', 'a second swipe 100 ms after the last is dropped');
  const before = s.ui.renders; await settle();
  assert.ok(s.ui.renders > before, 'moves repaint');
  assert.deepEqual(log.gestures, [], 'the mode sees nothing while the switcher is open');
  s.k.rearPress(now); now += 500;
  assert.equal(s.modes.switcher, null, 'rear cancels'); assert.equal(s.modes.current, log);
  s.k.frontHold(now); now += 2000; assert.ok(s.modes.switcher);
  s.k.frontHold(now); now += 2000; assert.equal(s.modes.switcher, null, 'a second hold cancels');
  s.k.frontHold(now); now += 2000; s.k.down(now); now += 500;
  s.k.frontPress(now); now += 500;
  assert.equal(s.modes.switcher, null); assert.equal(s.modes.current, demo);
  assert.deepEqual(log.events, [['enter', false], ['leave']]); assert.deepEqual(demo.events, [['enter', false]]);
  await s.modes.saving;
  assert.deepEqual(await readState(s.stateFile), { mode: 'demo' });
  s.k.frontHold(now); now += 2000; s.k.down(now); now += 500; s.k.tap(now); now += 500;
  assert.equal(s.modes.current, sys, 'a pad tap picks too');
  await settle();
  assert.ok(!s.link.sent.some((l) => l[0] === 'M'), 'jetd stays in remote mode');
});

test('modes: inside a mode every gesture but front hold goes to onGesture; rear at the root does nothing', async (t) => {
  const s = await stack(); t.after(s.stop);
  const log = fakeMode('log');
  s.modes.register(log);
  await s.modes.begin();
  let now = 1000;
  s.k.frontPress(now); now += 500; s.k.rearPress(now); now += 500; s.k.up(now); now += 500; s.k.left(now); now += 500; s.k.tap(now); now += 500;
  assert.deepEqual(log.gestures, ['press:front', 'press:rear', 'swipe:up', 'swipe:left', 'press:tap']);
  assert.equal(s.modes.switcher, null, 'plain presses never open the switcher');
  s.key(86, 1, now); now += 300;
  assert.deepEqual(log.gestures.length, 5, 'nothing fires on a key down');
  s.key(86, 0, now); now += 500;
  assert.equal(log.gestures.at(-1), 'press:front', 'the release classifies the press');
  s.link.mode = 'log';
  s.k.frontPress(now); now += 500;
  assert.equal(log.gestures.length, 6, 'jetd in one of its own modes keeps the keys');
  s.link.mode = 'remote';
  // ticks reach the current mode only while the panel is ours
  s.modes.tickMs = 5;
  await s.modes.begin();   // idempotent
  assert.equal(log.ticks, 0);
});

test('modes: a front press starts a voice turn in Assistant only; Demo looks, System navigates', async (t) => {
  const s = await stack({ defaultMode: 'assistant' }); t.after(s.stop);
  const calls = [];
  const voice = Object.assign(new (await import('node:events')).EventEmitter(), { state: 'idle', answer: '', transcript: '', configured: true,
    startTurn() { calls.push('startTurn'); this.state = 'listening'; return true; }, cancel() { calls.push('cancel'); const was = this.state !== 'idle'; this.state = 'idle'; return was; }, clear() {},
    async look(jpg, q, { onToken }) { calls.push(`look ${jpg.length > 100 ? 'jpeg' : 'small'}`); onToken('seen'); return 'seen'; } });
  const dir = tmpdir('jet-sys-');
  const system = Object.assign(new SystemMode(), { ofmArgsFile: path.join(dir, 'ofm-args'), ofmSysfs: dir, glanceFile: path.join(dir, 'glance'), iioDir: dir, backlightFile: path.join(dir, 'backlight'), backlightSysfs: path.join(dir, 'brightness'), netDir: dir, modes: s.modes, ui: s.ui, input: s.input, power: s.power, sensors: s.sensors, deviceLink: s.link });
  fs.writeFileSync(system.ofmArgsFile, 'thr_x=20 thr_y=20\n'); fs.writeFileSync(system.glanceFile, '180 197\n');
  const demo = Object.assign(new DemoMode(), { question: 'what?', jpegQuality: 50, modes: s.modes, ui: s.ui, surface: s.surface, deviceLink: s.link, power: s.power, sensors: s.sensors, voice });
  const assistant = Object.assign(new AssistantMode(), { modes: s.modes, ui: s.ui, voice });
  await system.start(); await demo.start(); await assistant.start();
  await s.modes.begin(); await settle();
  assert.equal(s.modes.current, assistant);
  let now = 1000;
  s.k.frontPress(now); now += 500;
  assert.deepEqual(calls, ['startTurn']);
  s.k.rearPress(now); now += 500;
  assert.deepEqual(calls, ['startTurn', 'cancel'], 'rear cancels the running turn');
  s.modes.switchTo('system'); await settle();
  assert.deepEqual(calls.at(-1), 'cancel', 'leaving the mode cancels');
  calls.length = 0;
  s.k.frontPress(now); now += 500;
  assert.deepEqual(calls, [], 'front press in System opens a screen, no voice');
  assert.equal(system.screen, system.screens.status);
  s.k.rearPress(now); now += 500;
  assert.equal(system.screen, null, 'rear returns to the System menu');
  s.k.rearPress(now); now += 500;
  assert.equal(s.modes.current, system, 'rear at the menu does nothing');
  s.modes.switchTo('demo'); await settle();
  assert.ok(s.surface.viewfinderRect, 'Demo runs the camera');
  s.k.frontPress(now); now += 500;
  await settle(); await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, ['look jpeg'], 'front press in Demo is a look, not a voice turn');
  assert.equal(demo.answer, 'seen');
  s.modes.switchTo('log');   // not registered: stays
  assert.equal(s.modes.current, demo);
  s.modes.switchTo('assistant'); await settle();
  assert.equal(s.surface.viewfinderRect, null, 'leaving Demo stops the camera');
  await s.stop();
});
