// The in-process voice session against a fake llm: event ordering for a turn (partials while
// listening, final, tokens, one audio frame per sentence in order even when a later sentence
// synthesises faster, done), an empty transcript, cancel mid-stream (nothing more emitted, the
// requests aborted), an upstream failure, say and look; and the sentence splitter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { VoiceSession } from '../src/modules/voice/session.js';
import { SentenceSplitter } from '../src/modules/voice/sentences.js';

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const h = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(h); reject(new Error('cancelled')); }, { once: true });
});

/** Transcript = the byte count; the answer is two sentences; audio = sentence length bytes. */
function fakeLlm({ chatDelayMs = 2, speakMs = () => 2, tokens = ['It is', ' sunny', '.', ' Take a', ' hat.'], fail = {} } = {}) {
  const calls = { transcribe: [], chat: [], speak: [], speakStream: [], aborted: [] };
  return { calls, configured: true,
    async transcribe(pcm, { signal } = {}) {
      calls.transcribe.push(pcm.length);
      signal?.addEventListener('abort', () => calls.aborted.push(`asr ${pcm.length}`), { once: true });
      await wait(2, signal);
      if (fail.transcribe) throw new Error('asr down');
      return pcm.length ? `heard ${pcm.length}` : '';
    },
    async chatStream(messages, onToken, signal) {
      calls.chat.push(messages);
      signal?.addEventListener('abort', () => calls.aborted.push('chat'), { once: true });
      let text = '';
      for (const t of tokens) { await wait(chatDelayMs, signal); if (fail.chat) throw new Error('chat down'); text += t; onToken(t); }
      return text;
    },
    async speak(text, signal) {
      calls.speak.push(text);
      signal?.addEventListener('abort', () => calls.aborted.push(`tts ${text}`), { once: true });
      await wait(speakMs(text), signal);
      if (fail.speak) throw new Error('tts down');
      return Buffer.alloc(text.length, 7);
    },
    async speakStream(text, onPcm, signal) {
      calls.speakStream.push(text);
      signal?.addEventListener('abort', () => calls.aborted.push(`tts ${text}`), { once: true });
      await wait(speakMs(text), signal);
      if (fail.speak) throw new Error('tts down');
      const buf = Buffer.alloc(text.length, 7), mid = Math.ceil(buf.length / 2);   // two chunks, like the TTS deltas
      onPcm(buf.subarray(0, mid)); onPcm(buf.subarray(mid));
    },
    async describe(jpeg, question, onToken, signal) { calls.look = { jpeg, question }; for (const t of ['a ', 'desk']) { await wait(2, signal); onToken(t); } return 'a desk'; },
  };
}

function make(opts) {
  const llm = fakeLlm(opts);
  const session = new VoiceSession(llm, { partialMs: 15, sentenceGapMs: 0, streamTts: opts?.streamTts ?? false });   // no gap: audio bytes = sentence bytes below
  const events = [];
  for (const type of ['partial', 'final', 'token', 'audio', 'done', 'error']) session.on(type, (m) => events.push(m));
  return { llm, session, events, types: () => events.map((e) => e.type) };
}

test('session: a turn: partials while listening, final, tokens, per-sentence audio in order, done', async () => {
  // the first sentence takes longer to synthesise than the second: audio must still come out in order
  const { llm, session, events, types } = make({ speakMs: (s) => (s.startsWith('It') ? 30 : 2) });
  session.start(7);
  assert.equal(session.busy, true); assert.equal(session.turn, 7);
  assert.equal(session.audio(Buffer.alloc(3200, 1)), true); session.audio(Buffer.alloc(3200, 2));
  await sleep(40);
  assert.ok(events.filter((e) => e.type === 'partial').length >= 1, 'a partial arrived');
  assert.deepEqual(events[0], { type: 'partial', turn: 7, text: 'heard 6400' });
  assert.equal(session.audio(Buffer.alloc(3200, 3)), true);
  const ended = session.end();
  assert.equal(session.audio(Buffer.alloc(10)), false, 'no audio after end');
  assert.equal(await ended, true);
  const after = events.slice(events.findIndex((e) => e.type === 'final'));
  assert.deepEqual(after.map((e) => e.type), ['final', 'token', 'token', 'token', 'token', 'token', 'audio', 'audio', 'done']);
  assert.equal(after[0].text, 'heard 9600');
  assert.deepEqual(after.filter((e) => e.type === 'audio').map((e) => [e.sentence, e.bytes, e.pcm.length]), [['It is sunny.', 12, 12], ['Take a hat.', 11, 11]]);
  assert.deepEqual(after.at(-1), { type: 'done', turn: 7, answer: 'It is sunny. Take a hat.' });
  assert.ok(after.every((e) => e.turn === 7));
  assert.deepEqual(llm.calls.speak, ['It is sunny.', 'Take a hat.']);
  assert.equal(llm.calls.chat[0][0].role, 'system'); assert.equal(llm.calls.chat[0][1].content, 'heard 9600');
  assert.equal(llm.calls.transcribe.at(-1), 9600, 'the final transcribes the whole buffer');
  assert.equal(session.busy, false);
  // the partial's request was aborted when the capture ended, if one was in flight; no stray partials after
  assert.ok(!types().slice(types().indexOf('final')).includes('partial'));
});

test('session: streamTts emits each sentence as chunks, in order, with the sentence label on its first chunk', async () => {
  // sentence 1 renders slower than sentence 2: chunks must still come out sentence-by-sentence in order
  const { llm, session, events } = make({ streamTts: true, speakMs: (s) => (s.startsWith('It') ? 30 : 2) });
  session.start(7); session.audio(Buffer.alloc(3200));
  assert.equal(await session.end(), true);
  const audio = events.filter((e) => e.type === 'audio');
  assert.equal(audio.length, 4, 'two sentences x two chunks');
  assert.deepEqual(audio.map((e) => e.sentence), ['It is sunny.', '', 'Take a hat.', ''], 'the sentence label rides the first chunk only');
  assert.equal(audio[0].pcm.length + audio[1].pcm.length, 'It is sunny.'.length, 'chunks of a sentence sum to the whole');
  assert.equal(audio[2].pcm.length + audio[3].pcm.length, 'Take a hat.'.length);
  assert.deepEqual(llm.calls.speakStream, ['It is sunny.', 'Take a hat.']);
  assert.equal(llm.calls.speak.length, 0, 'the whole-clip path is not used when streaming');
  assert.deepEqual(events.at(-1), { type: 'done', turn: 7, answer: 'It is sunny. Take a hat.' });
});

test('session: nothing heard: final "" then done "" with no chat', async () => {
  const { llm, session, events } = make();
  session.start(1);
  assert.equal(await session.end(), true);
  assert.deepEqual(events, [{ type: 'final', turn: 1, text: '' }, { type: 'done', turn: 1, answer: '' }]);
  assert.equal(llm.calls.chat.length, 0);
  assert.equal(await session.end(), false, 'no turn');
});

test('session: cancel mid-answer aborts the requests and emits nothing more; a new turn is clean', async () => {
  const { llm, session, events, types } = make({ chatDelayMs: 10, speakMs: () => 50 });
  session.start(1); session.audio(Buffer.alloc(3200));
  const ended = session.end();
  await sleep(45);   // the final is in, the chat is streaming, the first sentence is in the TTS
  assert.ok(types().includes('token'));
  assert.equal(session.cancel(), true);
  const n = events.length;
  assert.equal(await ended, false);
  await sleep(80);
  assert.equal(events.length, n, 'no events after cancel');
  assert.ok(!types().includes('done') && !types().includes('audio') && !types().includes('error'));
  assert.ok(llm.calls.aborted.includes('chat'), `aborted: ${llm.calls.aborted}`);
  assert.equal(session.cancel(), false);
  // the next turn's events carry its own id and nothing from turn 1 leaks
  session.start(2); session.audio(Buffer.alloc(3200));
  await session.end();
  assert.ok(events.slice(n).every((e) => e.turn === 2));
  assert.equal(events.at(-1).type, 'done');
  // start() while a turn runs cancels it
  session.start(3); session.audio(Buffer.alloc(3200)); const e3 = session.end();
  session.start(4);
  assert.equal(await e3, false); assert.equal(session.turn, 4);
  session.cancel();
});

test('session: an upstream failure is one error event; a failing partial is only logged', async () => {
  const { session, events } = make({ fail: { chat: true } });
  session.start(1); session.audio(Buffer.alloc(3200));
  assert.equal(await session.end(), false);
  assert.deepEqual(events.map((e) => e.type), ['final', 'error']);
  assert.equal(events[1].message, 'chat down'); assert.equal(session.busy, false);
  // the TTS fails while the chat is still streaming (the common case: the first sentence is
  // synthesised mid-answer): the turn stops, tokens stop, one error, no unhandled rejection
  const tts = make({ chatDelayMs: 15, fail: { speak: true } });
  let unhandled = null; const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  tts.session.start(1); tts.session.audio(Buffer.alloc(3200));
  assert.equal(await tts.session.end(), false);
  await sleep(50);
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null, 'no unhandled rejection');
  assert.equal(tts.events.at(-1).type, 'error'); assert.equal(tts.events.at(-1).message, 'tts down');
  assert.equal(tts.events.filter((e) => e.type === 'error').length, 1);
  assert.ok(!tts.events.some((e) => e.type === 'done'));
  assert.ok(tts.events.filter((e) => e.type === 'token').length < 5, 'the stream was abandoned');
  assert.ok(tts.llm.calls.aborted.includes('chat'));
  const asr = make({ fail: { transcribe: true } });
  asr.session.start(1); asr.session.audio(Buffer.alloc(3200));
  await sleep(40);
  assert.equal(asr.events.length, 0, 'a failing partial emits nothing');
  assert.equal(await asr.session.end(), false);
  assert.deepEqual(asr.events.map((e) => e.type), ['error']);
});

test('session: say and look are independent of the turn', async () => {
  const { llm, session } = make();
  session.start(1);
  const pcm = await session.say('hmm');
  assert.equal(pcm.length, 3); assert.deepEqual(llm.calls.speak, ['hmm']);
  const toks = [];
  assert.equal(await session.look(Buffer.from('JPEG'), 'what?', { onToken: (t) => toks.push(t) }), 'a desk');
  assert.deepEqual(toks, ['a ', 'desk']); assert.deepEqual(llm.calls.look, { jpeg: Buffer.from('JPEG'), question: 'what?' });
  assert.equal(session.busy, true);
  session.cancel();
});

test('sentence splitter: boundaries on streamed tokens, decimals and short fragments kept', () => {
  const s = new SentenceSplitter();
  const out = [];
  for (const tok of ['Hello', ' there', '.', ' It', ' is 3', '.5 degrees', ' today!', ' Really', '?', ' Yes', '.']) out.push(...s.push(tok));
  assert.deepEqual(out, ['Hello there.', 'It is 3.5 degrees today!', 'Really?']);   // a one-word sentence is a sentence (the TTS gets a gap after it)
  out.push(...s.push(' '));
  assert.deepEqual(out, ['Hello there.', 'It is 3.5 degrees today!', 'Really?'], '"Yes." waits to see how the next word starts');
  assert.equal(s.flush(), 'Yes.');
  const s2 = new SentenceSplitter();
  assert.deepEqual(s2.push('No. 5 is fine. "Sure!" she said.\nNext line'), ['No. 5 is fine.', '"Sure!" she said.']);
  assert.equal(s2.flush(), 'Next line');
  const s3 = new SentenceSplitter();
  assert.deepEqual(s3.push('one\ntwo\n'), ['one', 'two']);
});

test('session: an intercepted final transcript ends the turn with no chat and no speech', async () => {
  const llm = fakeLlm();
  const s = new VoiceSession(llm, { partialMs: 1000 });
  const events = []; for (const e of ['partial', 'final', 'token', 'audio', 'done', 'error']) s.on(e, (m) => events.push(m.type));
  const routed = []; s.intercept = (text) => { routed.push(text); return text.startsWith('heard'); };
  s.start(1); s.audio(Buffer.alloc(3200)); await s.end(); await sleep(10);
  assert.deepEqual(routed, ['heard 3200']); assert.deepEqual(events, ['final', 'done']);
  assert.equal(llm.calls.chat.length, 0); assert.equal(llm.calls.speak.length, 0);
});

test('session: "more" sends a turn back to listening with an empty buffer; an interjected clip is spoken in order', async () => {
  const llm = fakeLlm();
  const s = new VoiceSession(llm, { partialMs: 100000, sentenceGapMs: 0, streamTts: false });
  const events = []; for (const e of ['more', 'partial', 'final', 'token', 'audio', 'done', 'error']) s.on(e, (m) => events.push(m));
  const seen = [];
  s.intercept = (text, info) => { seen.push([text, info.phase, info.wake, Math.round(info.seconds * 10) / 10]); return info.phase === 1 ? 'more' : false; };
  let interjected = false;
  const responder = { name: 'op', async respond(text, { onToken, heard }) {
    assert.equal(heard.pcm.length, 6400, 'only the second capture is the question\'s sound'); assert.equal(heard.rate, 16000);
    onToken('It is a meter. ');
    interjected = s.interject(Buffer.from('FILLER'));
    onToken('A cheap one.');
    return 'It is a meter. A cheap one.';
  } };
  s.start(1, { responder, wake: true });
  assert.equal(s.interject(Buffer.from('x')), false, 'nothing to interject into while listening');
  s.audio(Buffer.alloc(32000));
  assert.equal(await s.end(), true);
  assert.equal(s.busy, true, 'the turn lives on');
  assert.deepEqual(events.map((e) => e.type), ['more']);
  s.audio(Buffer.alloc(6400));
  await s.end();
  assert.deepEqual(seen, [['heard 32000', 1, true, 1], ['heard 6400', 2, true, 0.2]]);
  assert.equal(interjected, true);
  const audio = events.filter((e) => e.type === 'audio');
  assert.deepEqual(audio.map((e) => (e.filler ? 'FILLER' : e.sentence)), ['It is a meter.', 'FILLER', 'A cheap one.'], 'after the sentence already waiting, before the next');
  assert.equal(events.at(-1).type, 'done'); assert.equal(s.busy, false);
});
