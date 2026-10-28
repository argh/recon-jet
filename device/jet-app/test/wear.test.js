// The display follows the glasses: dark after a delay once not worn (backlight 0, camera held
// off, LED pulsing), lit again on worn, relit by any gesture without a cue, a brief off reading
// changes nothing, stop never leaves it dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Wear } from '../src/modules/wear/index.js';
import { fakeLink, fakeSounds, tmpdir } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup({ initial = 1, sysfs = true } = {}) {
  const dir = tmpdir('jet-wear-'), led = path.join(dir, 'led');
  const link = Object.assign(fakeLink(), { worn: async () => ({ worn: initial, raw: 150 }) });
  const input = new EventEmitter(), sounds = fakeSounds();
  const surface = { paused: 0, resumed: 0, pauseViewfinder() { this.paused++; }, resumeViewfinder() { this.resumed++; } };
  const wear = Object.assign(new Wear(), { enabled: true, offDelayMs: 40, backlightSysfs: path.join(dir, 'brightness'), backlightFile: path.join(dir, 'backlight'), led, deviceLink: link, surface, input, sounds });
  if (sysfs) {
    fs.writeFileSync(wear.backlightSysfs, '400\n');
    fs.mkdirSync(led); for (const [f, v] of [['brightness', 16], ['trigger', 'none'], ['delay_on', 500], ['delay_off', 500]]) fs.writeFileSync(path.join(led, f), `${v}\n`);
  }
  fs.writeFileSync(wear.backlightFile, '208\n');
  const changes = []; wear.on('change', (lit) => changes.push(lit));
  await wear.start(); await sleep(1);
  const read = (f) => fs.readFileSync(f, 'utf8').trim();
  return { wear, link, input, sounds, surface, changes, level: () => (sysfs ? read(wear.backlightSysfs) : null), led: (f) => read(path.join(led, f)) };
}

test('wear: not worn -> dark after the delay with a boop; worn -> the level comes back with a beep', async () => {
  const { wear, link, sounds, surface, changes, level, led } = await setup();
  assert.equal(wear.worn, true, 'asked jetd at start'); assert.equal(wear.lit, true);
  link.emit('worn', { worn: 0, raw: 230 });
  assert.equal(wear.lit, true, 'not yet'); await sleep(15); assert.equal(level(), '400', 'still lit inside the delay');
  await sleep(50);
  assert.equal(wear.lit, false); assert.equal(level(), '0'); assert.deepEqual(sounds.played, ['removed']);
  assert.equal(surface.paused, 1, 'the camera is held off');
  assert.deepEqual([led('trigger'), led('delay_on'), led('delay_off')], ['timer', '150', '2850'], 'the LED pulses on the kernel timer');
  link.emit('worn', { worn: 1, raw: 140 }); await sleep(5);
  assert.equal(wear.lit, true); assert.equal(level(), '400', 'the level it had, not the saved one');
  assert.equal(surface.resumed, 1); assert.deepEqual([led('trigger'), led('brightness')], ['none', '16'], 'steady again at its old brightness');
  assert.deepEqual(sounds.played, ['removed', 'worn']); assert.deepEqual(changes, [false, true]);
});

test('wear: a brief off reading changes nothing; -1 is ignored; a gesture relights silently and holds', async () => {
  const { wear, link, input, sounds, surface, level } = await setup();
  link.emit('worn', { worn: 0, raw: 230 }); await sleep(15); link.emit('worn', { worn: 1, raw: 140 }); await sleep(60);
  assert.equal(wear.lit, true); assert.equal(level(), '400'); assert.deepEqual(sounds.played, []); assert.equal(surface.paused, 0);
  link.emit('worn', { worn: -1, raw: -1 }); await sleep(60); assert.equal(wear.worn, true, 'undecided readings are not a state');
  link.emit('worn', { worn: 0, raw: 230 }); await sleep(60);
  assert.equal(level(), '0');
  input.emit('gesture', 'press:front'); await sleep(5);
  assert.equal(wear.lit, true); assert.equal(level(), '400'); assert.deepEqual(sounds.played, ['removed'], 'no cue for a button');
  await sleep(60); assert.equal(level(), '400', 'stays lit: the sensor still says not worn, but the user is here');
  link.emit('worn', { worn: 0, raw: 230 }); await sleep(60); assert.equal(level(), '0', 'a fresh not-worn darkens again');
  await wear.stop(); assert.equal(level(), '400', 'stop never leaves it dark'); assert.equal(surface.resumed, 2);
});

test('wear: without a readable live level the saved file is restored; without sysfs nothing is written', async () => {
  const a = await setup({ initial: 0 });
  fs.writeFileSync(a.wear.backlightSysfs, 'x');
  await sleep(60); assert.equal(a.level(), '0');
  a.link.emit('worn', { worn: 1, raw: 140 }); await sleep(5); assert.equal(a.level(), '208', 'the saved level');
  const b = await setup({ initial: 0, sysfs: false });
  await sleep(60); assert.equal(b.wear.lit, false); assert.equal(b.surface.paused, 1);
  assert.ok(!fs.existsSync(b.wear.backlightSysfs) && !fs.existsSync(b.wear.led), 'no sysfs on this machine: no files created');
});

test('wear: off by default it only follows the sensor; System turns it on and off live', async () => {
  const { wear, link, sounds, surface, changes, level } = await setup();
  wear.setEnabled(false);
  link.emit('worn', { worn: 0, raw: 230 }); await sleep(60);
  assert.equal(wear.worn, false, 'the sensor is still read'); assert.equal(wear.lit, true); assert.equal(level(), '400'); assert.deepEqual(sounds.played, []);
  wear.setEnabled(true);
  assert.equal(wear.lit, true, 'not at once: the usual delay'); await sleep(60);
  assert.equal(wear.lit, false); assert.equal(level(), '0'); assert.equal(surface.paused, 1);
  wear.setEnabled(false); await sleep(5);
  assert.equal(wear.lit, true); assert.equal(level(), '400'); assert.equal(surface.resumed, 1); assert.deepEqual(sounds.played, ['removed'], 'relit without a cue');
  assert.deepEqual(changes, [false, true]);
  const fresh = Object.assign(new Wear(), { deviceLink: new EventEmitter(), input: new EventEmitter(), sounds: fakeSounds() });
  assert.equal(fresh.enabled, undefined, 'the schema default (false) applies through the configurator; nothing here assumes on');
});
