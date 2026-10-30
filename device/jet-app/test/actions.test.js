// The spoken-command registry: transcripts are normalised (case, punctuation, the wake word's
// tail), the first matching action wins, run() is always a promise, anything else is a question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions, normalise } from '../src/modules/actions/index.js';

test('actions: normalising drops case, punctuation and what the capture kept of the wake word', () => {
  assert.equal(normalise(' Jet, look!'), 'look'); assert.equal(normalise('jet look'), 'jet look', 'no comma: kept, match() tries without it');
  assert.equal(normalise('Heya Jet, enable Bluetooth.'), 'enable bluetooth');
  assert.equal(normalise('hey ya jet  what time   is it?'), 'what time is it');
  assert.equal(normalise('jet lag is awful'), 'jet lag is awful', 'only a leading wake word goes');
  assert.equal(normalise("what's the jet's speed"), "what's the jet's speed");
  assert.equal(normalise('Running analysis.'), 'run analysis', 'the ASR inflects the verb'); assert.equal(normalise('Enabling Bluetooth'), 'enable bluetooth');
  assert.equal(normalise('opens the door'), 'open the door'); assert.equal(normalise('runner stopped'), 'runner stopped', 'only the verb forms');
  assert.equal(normalise(''), ''); assert.equal(normalise(null), '');
});

test('actions: first registered match wins, run() is a promise even for sync handlers, no match is null', async () => {
  const a = new Actions(), calls = [];
  a.register('look', /^(?:look|describe)/, () => { calls.push('look'); return 'seen'; })
    .register('bluetooth', /^(?:(enable|turn on)|(?:disable|turn off)) bluetooth/, (m) => { calls.push(`bt ${Boolean(m[1])}`); })
    .register('boom', /^boom/, () => { throw new Error('bang'); });
  const look = a.match('Jet, LOOK at this');
  assert.equal(look.name, 'look'); assert.equal(look.text, 'look at this');
  assert.equal(a.match('Dad, look.').name, 'look', 'whatever the ASR made of the wake word\'s tail, a punctuation break later');
  assert.equal(a.match('Hey, yet, look').name, 'look', 'two broken words');
  assert.equal(a.match('Hey Jarvis, look.').name, 'look', 'two words before the break');
  assert.equal(a.match('Hey there my friend, look.'), null, 'more than three words before the break: not a wake remnant');
  assert.equal(a.match('jet look').name, 'look', 'a bare jet with no comma');
  assert.deepEqual(Actions.candidates('Dad, look.'), ['dad look', 'look']);
  assert.deepEqual(Actions.candidates('Hey, yet, look'), ['hey yet look', 'yet look', 'look']);
  assert.equal(a.match('Dad, what is the time'), null, 'dropping words never makes a question into an action');
  assert.equal(await look.run(), 'seen');
  await a.match('turn off bluetooth').run(); await a.match('heya jet, enable bluetooth please').run();
  assert.deepEqual(calls, ['look', 'bt false', 'bt true']);
  assert.equal(a.match('what is the weather'), null);
  assert.equal(a.match(''), null);
  await assert.rejects(a.match('boom').run(), /bang/, 'a throwing handler rejects instead of escaping');
});

test('actions: a command registered first can decline with `when`, and a later one takes the phrase', () => {
  const a = new Actions(), modes = ['log', 'system'];
  a.register('open', /^open (\w+)$/, () => 'mode', { when: (m) => modes.includes(m[1]) })
    .register('open screen', /^open (network|status)$/, () => 'screen');
  assert.equal(a.match('open system').name, 'open');
  assert.equal(a.match('open network').name, 'open screen', 'declined by the generic open, taken by the specific one');
  assert.equal(a.match('open nothing'), null, 'declined by both: a question');
});
