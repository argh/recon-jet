// volume: the level arithmetic, the soft limiter, the spoken command, persistence; and the
// backlight's spoken level.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Volume, parseLevel, gainOf, scale } from '../src/modules/volume/index.js';
import { Backlight, levelOf } from '../src/modules/backlight/index.js';
import { Actions } from '../src/modules/actions/index.js';
import { tmpdir } from './helpers.js';

const pcmOf = (...v) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => b.writeInt16LE(x, i * 2)); return b; };
const samples = (b) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));

test('volume: levels are 3 dB steps around 5; words and digits both name a level', () => {
  assert.equal(gainOf(0), 0); assert.equal(gainOf(5), 1);
  assert.ok(Math.abs(gainOf(10) - 5.62) < 0.01, '+15 dB'); assert.ok(Math.abs(gainOf(3) - 0.5) < 0.01, '-6 dB');
  assert.deepEqual(['7', 'seven', 'ten', 'max', 'mute', '0', 'to', 'for'].map(parseLevel), [7, 7, 10, 10, 0, 0, 2, 4]);
  assert.deepEqual(['11', 'loud', '', '-1', '3.5'].map(parseLevel), [null, null, null, null, null]);
});

test('volume: scaling boosts quiet speech cleanly and rounds off what would clip', () => {
  const quiet = pcmOf(1000, -1000, 4000, -4000);
  assert.equal(scale(quiet, 1), quiet, 'unity is the same buffer');
  assert.deepEqual(samples(scale(quiet, 2)), [2000, -2000, 8000, -8000]);
  assert.deepEqual(samples(scale(quiet, 0)), [0, 0, 0, 0]);
  const hot = samples(scale(pcmOf(6000, 20000, 32000, -32000), 4));   // 24000 is under the knee; 80000 and 128000 are far over
  assert.equal(hot[0], 24000); assert.ok(hot[1] > 30000 && hot[1] <= 32767 && hot[2] >= hot[1] && hot[2] <= 32767, `limited, not wrapped: ${hot}`);
  const knee = samples(scale(pcmOf(7000, 7500), 4));   // 28000 and 30000: just over the knee, squeezed but still in order
  assert.ok(knee[0] > 26214 && knee[0] < 28000 && knee[1] > knee[0] && knee[1] < 30000, `rounded above the knee: ${knee}`);
  assert.equal(hot[3], -hot[2], 'symmetrically');
});

test('volume: "set volume 7" sets it at once and for the next start; a bad level is refused', async () => {
  const deviceConfig = path.join(tmpdir('jet-vol-'), 'jet-app.json');
  fs.writeFileSync(deviceConfig, JSON.stringify({ llm: { base: 'x' } }));
  const actions = new Actions(), strips = [];
  const v = Object.assign(new Volume(), { level: 8, deviceConfig, actions, ui: { setStrip: (t) => strips.push(t) }, logger: null });
  await v.start();
  assert.equal(v.level, 8); assert.ok(Math.abs(v.gain - 2.82) < 0.01);
  for (const said of ['Set volume 7.', 'heya jet, set the volume to seven', 'Set volume level to 7']) { v.level = 1; await actions.match(said).run(); assert.equal(v.level, 7, said); }
  assert.deepEqual(JSON.parse(fs.readFileSync(deviceConfig, 'utf8')), { llm: { base: 'x' }, volume: { level: 7 } }, 'persisted beside what was there');
  assert.equal(strips.at(-1), 'volume 7');
  await assert.rejects(actions.match('set volume eleven').run(), /0 to 10/); assert.equal(v.level, 7);
  await actions.match('set volume max').run(); assert.equal(v.level, 10);
  assert.equal(actions.match('what is the volume of a sphere'), null, 'a question stays a question');
  assert.deepEqual(samples(v.apply(pcmOf(1000))), [Math.round(1000 * gainOf(10))]);
});

test('backlight: "set backlight 3" maps 1..10 onto the panel range, applies and saves it', async () => {
  assert.deepEqual([1, 10].map(levelOf), [16, 1023], 'the ends are the panel\'s ends'); assert.equal(levelOf(5), 16 + 9 * 48); assert.ok(levelOf(3) > levelOf(2));
  const dir = tmpdir('jet-bl-'), file = path.join(dir, 'backlight'), sysfs = path.join(dir, 'brightness');
  fs.writeFileSync(sysfs, '208\n');
  const actions = new Actions(), strips = [];
  const b = Object.assign(new Backlight(), { file, sysfs, actions, ui: { setStrip: (t) => strips.push(t) }, logger: null });
  await b.start();
  await actions.match('Set backlight 3.').run();
  assert.equal(b.level, levelOf(3)); assert.equal(fs.readFileSync(sysfs, 'utf8').trim(), String(levelOf(3))); assert.equal(fs.readFileSync(file, 'utf8').trim(), String(levelOf(3)));
  await actions.match('set the brightness to ten').run(); assert.equal(b.level, 1023);
  await assert.rejects(actions.match('set backlight zero').run(), /1 to 10/);
  assert.equal(strips.at(-1), 'backlight 10');
});
