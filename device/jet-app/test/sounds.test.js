// The cue vocabulary: every cue renders to 48 kHz stereo S16 within the speaker's comfort, plays
// as one clip through the link, and is silent (not an error) when the link is down or sounds are off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sounds, SOUNDS } from '../src/modules/sounds/index.js';
import { fakeLink } from './helpers.js';

test('sounds: each cue renders once, short, stereo, fading to silence, within the gain', () => {
  for (const [name, def] of Object.entries(SOUNDS)) {
    const pcm = Sounds.pcm(name);
    const ms = def.notes.reduce((a, n) => a + n.ms, 0);
    assert.equal(pcm.length, Math.round(48000 * ms / 1000) * 4, `${name}: ${ms} ms of stereo S16`);
    assert.ok(ms <= 450, `${name} is short`);
    let peak = 0; for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    assert.ok(peak <= (def.gain ?? 0.3) * 32767 + 1 && peak > 1000, `${name}: peak ${peak}`);
    assert.ok(Math.abs(pcm.readInt16LE(pcm.length - 2)) < 200, `${name} ends near silence`);
    assert.equal(Sounds.pcm(name), pcm, 'cached');
  }
  assert.throws(() => Sounds.pcm('nope'), /no sound/);
  // the language: powerOn rises, powerOff falls, error falls slowly, worn above removed
  const hz = (n) => SOUNDS[n].notes.map((x) => x.hz);
  assert.deepEqual(hz('powerOn'), hz('powerOff').slice().reverse());
  assert.ok(hz('error')[0] > hz('error')[1] && SOUNDS.error.notes[1].ms > SOUNDS.powerOff.notes[1].ms);
  assert.ok(hz('worn')[0] > hz('removed')[0]);
});

test('sounds: play sends one clip and resolves with the result; off or unlinked it resolves false', async () => {
  const link = fakeLink();
  const sounds = Object.assign(new Sounds(), { enabled: true, gain: 0.5, deviceLink: link });
  assert.equal(await sounds.play('ack'), 'done');
  assert.deepEqual(link.sent, [`W ${Sounds.pcm('ack', 0.5).length}`, 'w']);
  assert.ok(Sounds.pcm('ack', 0.5) !== Sounds.pcm('ack'), 'gain renders its own copy');
  link.sent.length = 0; link.play = () => false;
  assert.equal(await sounds.play('error'), false, 'link down: silent');
  sounds.enabled = false; link.play = (pcm) => link.send(`W ${pcm.length}`);
  assert.equal(await sounds.play('success'), false); assert.deepEqual(link.sent, [], 'off: nothing sent');
  link.play = (pcm) => link.send(`W ${pcm.length}`); link.playEnd = () => Promise.reject(new Error('timeout')); sounds.enabled = true;
  assert.equal(await sounds.play('worn'), false, 'a lost reply is not an error');
});
