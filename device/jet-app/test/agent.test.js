// The agent: the tool loop over a scripted model (every request recorded as it was sent), the
// history's cache-preserving shape, compaction / hard limit / new call, persistence and notes,
// the mood, each generic tool against loopback fakes and temp files, and the container wiring
// (Tool and ContextSource arrays injected by @versionzero/module-manager).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { ModuleManager, Schema } from '@versionzero/module-manager';
import { Agent } from '../src/modules/agent/index.js';
import { Memory } from '../src/modules/agent/memory.js';
import { Mood } from '../src/modules/agent/mood.js';
import { History, PHOTO_GONE, transcript } from '../src/modules/agent/history.js';
import { WebSearchTool } from '../src/modules/agent/tools/web-search.js';
import { WebReadTool } from '../src/modules/agent/tools/web-read.js';
import { ShellTool } from '../src/modules/agent/tools/shell.js';
import { StatusTool } from '../src/modules/agent/tools/status.js';
import { RememberTool } from '../src/modules/agent/tools/remember.js';
import { tmpdir, settle } from './helpers.js';

const JPEG = Buffer.from('not really a jpeg');
const IMAGE_URL = `data:image/jpeg;base64,${JPEG.toString('base64')}`;
/** What a real request does on its signal: rejects, also when the abort came first. */
const untilAbort = (signal, message = 'cancelled') => new Promise((_, reject) => { const fail = () => reject(new Error(message)); if (signal.aborted) fail(); else signal.addEventListener('abort', fail); });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

/**
 * A scripted model: each `chat` takes the next entry (a reply `{content?, tokens?, toolCalls?,
 * usage?}`, an Error to reject with, or a function of the request returning either); past the
 * end it says "ok". Requests are recorded as sent (cloned: the history moves on).
 */
function fakeLlm(script = []) {
  const calls = [];
  return { calls, script, async chat(request) {
    const { onToken, signal, ...sent } = request;
    calls.push(structuredClone(sent));
    let next = script.shift() ?? { content: 'ok' };
    if (typeof next === 'function') next = await next(request);
    if (next instanceof Error) throw next;
    const tokens = next.tokens ?? (next.content ? [next.content] : []);
    for (const token of tokens) onToken?.(token);
    return { content: next.content ?? tokens.join(''), toolCalls: next.toolCalls ?? [], usage: { prompt: 0, completion: 0, cached: 0, ...next.usage } };
  } };
}
const call = (id, name, args = {}) => ({ id, name, args });
/** A Tool that records its runs; `run` may be overridden. */
const tool = (name, extra = {}) => ({ name, description: `the ${name} tool`, parameters: { type: 'object', properties: {} }, ran: [], run(args) { this.ran.push(args); return `${name} result`; }, ...extra });

function make({ script = [], tools = [], context = [], dir = '', ...overrides } = {}) {
  let clock = Date.UTC(2026, 10, 10, 14, 0, 0);
  const now = () => clock;
  const memory = Object.assign(new Memory(), { dir, maxNotes: 40, noteChars: 300, logger: null, now });
  const llm = fakeLlm(script);
  const agent = Object.assign(new Agent(), { tools, context, persona: 'PERSONA', model: 'qv', maxTokens: 300, temperature: 0.6, maxSteps: 6, toolResultChars: 2500,
    settledChars: 300, stepLimit: 5600, reprime: false, keepImages: 2, compactAt: 5000, hardLimit: 7000, keepTurns: 3, summaryTokens: 150, callGapS: 1800, foldTimeoutMs: 300, llm, memory, logger: null, now, ...overrides });
  return { agent, memory, llm, tick: (ms) => { clock += ms; } };
}
const roles = (messages) => messages.map((m) => m.role).join(' ');

// ---- the loop -----------------------------------------------------------------------------------
test('agent: a step with text and a tool call speaks, runs the tool, and the next step answers', async () => {
  const echo = tool('echo', { parameters: { type: 'object', properties: { x: { type: 'number' } } } });
  const { agent, llm } = make({ tools: [echo], script: [
    { tokens: ['Let me ', 'check.'], toolCalls: [call('c1', 'echo', { x: 1 })], usage: { prompt: 700, completion: 12, cached: 650 } },
    { content: 'It is one.', usage: { prompt: 740, completion: 5, cached: 712 } },
  ] });
  const tokens = [], events = [];
  agent.on('tool', (e) => events.push(e));
  const result = await agent.ask('what is x?', { onToken: (t) => tokens.push(t) });
  assert.deepEqual(result, { text: 'Let me check. It is one.', steps: 2, usage: { prompt: 740, completion: 17, cached: 712 } });
  assert.deepEqual(tokens, ['Let me ', 'check.', ' ', 'It is one.'], 'a space separates two steps of speech');
  assert.deepEqual(echo.ran, [{ x: 1 }]);
  assert.deepEqual(events.map(({ ms, ...e }) => e), [{ name: 'echo', args: { x: 1 }, phase: 'start' }, { name: 'echo', args: { x: 1 }, phase: 'end' }]);
  assert.equal(typeof events[1].ms, 'number');
  assert.deepEqual(agent.history, [
    { role: 'user', content: 'what is x?' },
    { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"x":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'echo result' },
    { role: 'assistant', content: 'It is one.' },
  ]);
  // what the model was sent: system prompt first, the tools as OpenAI functions, the agent's own model settings
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(llm.calls[0].messages.map((m) => m.role), ['system', 'user']);
  assert.match(llm.calls[0].messages[0].content, /^PERSONA\n\nHow this link works\./);
  assert.deepEqual(llm.calls[0].tools, [{ type: 'function', function: { name: 'echo', description: 'the echo tool', parameters: echo.parameters } }]);
  assert.deepEqual([llm.calls[0].model, llm.calls[0].maxTokens, llm.calls[0].temperature], ['qv', 300, 0.6]);
  assert.equal(roles(llm.calls[1].messages), 'system user assistant tool');
  assert.equal(agent.busy, false);
});

test('agent: a tool call with no text has null content; several calls in a step run in order', async () => {
  const order = [];
  const a = tool('a', { run() { order.push('a'); return 'A'; } }), b = tool('b', { async run() { await settle(); order.push('b'); return { text: 'B' }; } });
  const { agent } = make({ tools: [a, b], script: [{ toolCalls: [call('1', 'b'), call('2', 'a')] }, { content: 'Done.' }] });
  const tokens = [];
  assert.equal((await agent.ask('go', { onToken: (t) => tokens.push(t) })).text, 'Done.');
  assert.deepEqual(tokens, ['Done.'], 'no leading space when nothing was said before');
  assert.deepEqual(order, ['b', 'a']);
  assert.equal(agent.history[1].content, null);
  assert.deepEqual(agent.history.slice(2, 4).map((m) => [m.tool_call_id, m.content]), [['1', 'B'], ['2', 'A']]);
});

test('agent: the silent rule - speech plus only silent tools ends the turn; anything else goes on', async () => {
  const show = tool('show', { silent: true }), look = tool('look');
  // spoke + silent only: one model call
  let { agent, llm } = make({ tools: [show, look], script: [{ content: 'Sent you the pinout.', toolCalls: [call('1', 'show', { title: 'Pinout' })] }, { content: 'Keep me posted.' }] });
  assert.deepEqual(await agent.ask('pinout?').then((r) => [r.text, r.steps]), ['Sent you the pinout.', 1]);
  assert.equal(llm.calls.length, 1);
  assert.equal(roles(agent.history), 'user assistant tool', 'the result is still recorded');
  assert.equal(show.ran.length, 1);
  // silent but nothing said: the model gets another step to say it
  ({ agent, llm } = make({ tools: [show, look], script: [{ toolCalls: [call('1', 'show')] }, { content: 'On your display.' }] }));
  assert.deepEqual(await agent.ask('pinout?').then((r) => [r.text, r.steps]), ['On your display.', 2]);
  // spoke, but one of the tools is not silent: its result needs a step
  ({ agent, llm } = make({ tools: [show, look], script: [{ content: 'One second.', toolCalls: [call('1', 'show'), call('2', 'look')] }, { content: 'A multimeter.' }] }));
  assert.equal((await agent.ask('what is it?')).text, 'One second. A multimeter.');
  assert.equal(llm.calls.length, 2);
});

test('agent: a throwing tool, an unknown tool and unparseable arguments all become error results; results are capped; an image rides as image_url', async () => {
  const boom = tool('boom', { run() { throw new Error('no route to host'); } });
  const big = tool('big', { run: () => 'x'.repeat(100) });
  const look = tool('look', { run: () => ({ text: 'Photo taken.', image: JPEG }) });
  const { agent, llm } = make({ tools: [boom, big, look], toolResultChars: 40, script: [
    { toolCalls: [call('1', 'boom'), call('2', 'nope'), { id: '3', name: 'big', args: null, raw: '{"a' }, call('4', 'big'), call('5', 'look')] },
    { content: 'Well.' },
  ] });
  const events = [];
  agent.on('tool', (e) => { if (e.phase === 'end') events.push([e.name, e.error]); });
  await agent.ask('try everything');
  const results = agent.history.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.deepEqual(results.slice(0, 3), ['error: no route to host', 'error: there is no tool "nope"', 'error: the arguments were not valid JSON']);
  assert.equal(results[3], `${'x'.repeat(40)}\n[cut: 60 more characters]`);
  assert.deepEqual(results[4], [{ type: 'text', text: 'Photo taken.' }, { type: 'image_url', image_url: { url: IMAGE_URL } }]);
  assert.deepEqual(events, [['boom', 'no route to host'], ['nope', 'there is no tool "nope"'], ['big', 'the arguments were not valid JSON'], ['big', undefined], ['look', undefined]]);
  assert.equal(agent.history[1].tool_calls[2].function.arguments, '{}', 'broken arguments are not replayed to the server');
  assert.deepEqual(llm.calls[1].messages.at(-1).content[1], { type: 'image_url', image_url: { url: IMAGE_URL } }, 'the model sees the photo in the next step');
});

test('agent: maxSteps bounds a model that keeps calling tools', async () => {
  const again = tool('again');
  const { agent, llm } = make({ tools: [again], maxSteps: 3, script: Array.from({ length: 10 }, (_, i) => ({ content: i === 0 ? 'Hm.' : '', toolCalls: [call(`c${i}`, 'again')] })) });
  const result = await agent.ask('loop');
  assert.deepEqual([result.text, result.steps], ['Hm.', 3]);
  assert.equal(llm.calls.length, 3); assert.equal(again.ran.length, 2, 'the last step was told to answer: the tool it asked for instead is not run');
  assert.match(llm.calls[2].messages.at(-1).content, /\[No more lookups this turn: answer now, briefly, from what you have\. You may still use show\.\]$/);
  assert.equal(agent.history.at(-1).role, 'assistant', 'and the turn ends on words, not on a dangling call');
});

test('agent: busy while a turn runs; a model error rolls the turn back', async () => {
  const gate = deferred();
  const { agent, llm } = make({ tools: [tool('t')], script: [() => gate.promise, { toolCalls: [call('1', 't')] }, new Error('chat/completions: 503 loading')] });
  const first = agent.ask('one');
  await assert.rejects(agent.ask('two'), /^Error: busy$/);
  gate.resolve({ content: 'First.' });
  assert.equal((await first).text, 'First.');
  await assert.rejects(agent.ask('three'), /503 loading/);
  assert.deepEqual(agent.history, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'First.' }], 'the failed turn (question, tool step) never happened');
  assert.equal(agent.busy, false);
  assert.equal((await agent.ask('four')).text, 'ok');
  assert.equal(roles(llm.calls.at(-1).messages), 'system user assistant user');
});

test('agent: abort mid-tool ends the turn at once, every call gets a result, and the turn is kept as interrupted', async () => {
  const abort = new AbortController();
  const started = deferred();
  const slow = tool('slow', { run(args, { signal }) { this.signal = signal; started.resolve(); return new Promise(() => {}); } });   // ignores its signal: the agent must not wait
  const after = tool('after');
  const { agent, memory } = make({ tools: [slow, after], script: [{ content: 'Looking.', toolCalls: [call('1', 'slow'), call('2', 'after')] }] });
  const events = [];
  agent.on('tool', (e) => { if (e.phase === 'end') events.push([e.name, e.error]); });
  const turn = agent.ask('look it up', { signal: abort.signal });
  await started.promise;
  abort.abort();
  await assert.rejects(turn, /^Error: cancelled$/);
  assert.equal(slow.signal, abort.signal, 'the tool was handed the signal');
  assert.equal(after.ran.length, 0, 'the remaining call is not run');
  assert.deepEqual(agent.history.slice(2).map((m) => [m.role, m.tool_call_id, m.content]), [['tool', '1', 'error: interrupted'], ['tool', '2', 'error: interrupted']]);
  assert.deepEqual(events, [['slow', 'interrupted'], ['after', 'interrupted']]);
  assert.equal(memory.conversation.cutOff, true);
  assert.equal(agent.busy, false);
  assert.equal((await agent.ask('never mind')).text, 'ok');
  assert.equal(memory.conversation.cutOff, false, 'a finished turn clears it');
});

test('agent: abort mid-answer keeps what had been said', async () => {
  const abort = new AbortController();
  const { agent, memory } = make({ script: [
    ({ onToken, signal }) => { onToken('The red wire '); return untilAbort(signal); },
    ({ signal }) => untilAbort(signal),
  ] });
  const turn = agent.ask('which wire?', { onToken: () => abort.abort(), signal: abort.signal });
  await assert.rejects(turn, /cancelled/);
  assert.deepEqual(agent.history, [{ role: 'user', content: 'which wire?' }, { role: 'assistant', content: 'The red wire ' }]);
  assert.equal(memory.conversation.cutOff, true);
  // cut off before a word: the turn still alternates
  const second = new AbortController();
  const turn2 = agent.ask('hello?', { signal: second.signal });
  await settle(); second.abort();
  await assert.rejects(turn2, /cancelled/);
  assert.deepEqual(agent.history.slice(2), [{ role: 'user', content: 'hello?' }, { role: 'assistant', content: '...' }]);
});

// ---- context, system prompt, the prefix ---------------------------------------------------------
test('agent: the context block rides on the newest user message only, old ones stay as they were, and every request extends the previous one', async () => {
  let view = 'In view lately: multimeter [e7]';
  const sources = [{ id: 'clock', context: () => `It is ${view ? 'early' : 'late'}.` }, { id: 'world', context: async () => view }, { id: 'broken', context() { throw new Error('nope'); } }];
  const look = tool('look', { run: () => ({ text: 'Photo.', image: JPEG }) });
  const off = tool('web_search', { get available() { return false; } });
  const { agent, llm } = make({ tools: [look, off, tool('status')], context: sources, script: [
    { content: 'A meter.' },
    { content: 'Let me see.', toolCalls: [call('1', 'look')] }, { content: 'Two point two kilohms.' },
    { content: 'Yes.' },
  ] });
  await agent.ask('what is that?');
  view = 'In view lately: solder spool [e8], multimeter [e7]';
  await agent.ask('what does it read?');
  view = null;
  await agent.ask('sure?');
  const h = agent.history;
  assert.equal(h[0].content, 'what is that?\n\n[context]\nIt is early.\nIn view lately: multimeter [e7]');
  assert.equal(h[2].content, 'what does it read?\n\n[context]\nIt is early.\nIn view lately: solder spool [e8], multimeter [e7]', 'a failing source is skipped');
  assert.equal(h.at(-2).content, 'sure?\n\n[context]\nIt is late.', 'a null line is left out');
  // prefix stability: each request is the one before it plus new messages at the end, so the server's cache holds
  assert.equal(llm.calls.length, 4);
  for (let k = 1; k < llm.calls.length; k++) {
    const before = llm.calls[k - 1].messages, now = llm.calls[k].messages;
    assert.ok(now.length > before.length);
    assert.deepEqual(now.slice(0, before.length), before, `request ${k} extends request ${k - 1}`);
    assert.deepEqual(llm.calls[k].tools, llm.calls[0].tools, 'and the tool list does not move');
  }
  assert.deepEqual(llm.calls[0].tools.map((t) => t.function.name), ['look', 'status'], 'an unavailable tool is not offered');
  // no sources at all: no block
  const bare = make();
  await bare.agent.ask('hi');
  assert.equal(bare.agent.history[0].content, 'hi');
  assert.ok(!('tools' in bare.llm.calls[0]) || bare.llm.calls[0].tools.length === 0);
});

test('agent: notes are part of the system prompt, capped at maxNotes; reset forgets the conversation and keeps them', async () => {
  const { agent, memory, llm } = make();
  memory.maxNotes = 3;
  const remember = Object.assign(new RememberTool(), { memory });
  agent.tools = [remember];
  llm.script.push({ toolCalls: [call('1', 'remember', { text: '  Partner is   called Sam. ' })] }, { content: 'Noted.' });
  await agent.ask('remember my name is Sam');
  assert.equal(agent.history[2].content, 'noted: Partner is called Sam.');
  assert.ok(!llm.calls[0].messages[0].content.includes('Notes you kept'));
  assert.equal(llm.calls[1].messages[0].content, llm.calls[0].messages[0].content, 'not mid-turn: the prompt is fixed for the turn that is running');
  await agent.ask('who am I?');
  assert.match(llm.calls[2].messages[0].content, /\n\nNotes you kept from earlier calls:\n- Partner is called Sam\.$/);
  for (const text of ['two', 'three', 'three', 'four']) await memory.remember(text);
  assert.deepEqual(memory.notes.map((n) => n.text), ['two', 'three', 'four'], 'oldest dropped, an immediate repeat not added');
  assert.equal(typeof memory.notes[0].t, 'number');
  await assert.rejects(async () => memory.remember('   '), /nothing to remember/);
  await agent.reset();
  assert.deepEqual(agent.history, []);
  assert.match(agent.systemPrompt, /- two\n- three\n- four$/);
});

// ---- context management -------------------------------------------------------------------------
/** Five finished turns; the third looked (an image result). The last reported `prompt` tokens. */
async function fiveTurns(prompt, overrides = {}) {
  const look = tool('look', { run: () => ({ text: 'Photo.', image: JPEG }) });
  const m = make({ tools: [look], compactAt: 1e9, ...overrides });
  for (let i = 1; i <= 5; i++) {
    m.llm.script.push({ content: `seeing ${i}`, toolCalls: [call(`c${i}`, 'look')] }, { content: `answer ${i}`, usage: { prompt: i === 5 ? prompt : 1000 } });
    await m.agent.ask(`question ${i}`);
    m.tick(1000);
  }
  m.agent.compactAt = overrides.compactAt ?? 5000;
  return m;
}

test('agent: past compactAt the oldest turns become one summary at a user boundary, in the background, and old photos go', async () => {
  const { agent, memory, llm } = await fiveTurns(1000, { keepImages: 1 });
  assert.equal(agent.compaction, null, 'under the threshold: nothing');
  assert.equal(agent.history.length, 20);
  llm.script.push({ content: 'answer 6', usage: { prompt: 5200 } }, { content: ' Partner asked three questions about a meter. ' });
  await agent.ask('question 6');
  assert.ok(agent.compaction, 'started after the turn ended, not awaited by it');
  assert.equal(agent.history.length, 22, 'the turn returned before it landed');
  await agent.compaction;
  assert.equal(agent.compaction, null);
  // the summary request: no tools, a small budget, a transcript rather than the messages
  const req = llm.calls.at(-1);
  assert.ok(!req.tools); assert.equal(req.maxTokens, 150); assert.equal(req.model, 'qv');
  assert.equal(roles(req.messages), 'system user');
  assert.match(req.messages[1].content, /^Partner: question 1\nJet: seeing 1\nJet used look \{\}\nResult: Photo\.\n(\[photo, no longer attached\]\n)?Jet: answer 1\nPartner: question 2\n/);
  assert.ok(!req.messages[1].content.includes('question 4'), 'the newest keepTurns turns are not summarised');
  assert.ok(!req.messages[1].content.includes('base64'));
  // the history: summary, then turns 4..6 untouched
  const h = agent.history;
  assert.deepEqual(h[0], { role: 'user', content: 'Earlier on this call: Partner asked three questions about a meter.' });
  assert.deepEqual(h[1], { role: 'user', content: 'question 4' });
  assert.equal(roles(h), 'user user assistant tool assistant user assistant tool assistant user assistant');
  assert.equal(h[3].content, `Photo.\n${PHOTO_GONE}`, 'beyond keepImages: the placeholder');
  assert.equal(h[7].content[1].type, 'image_url', 'the newest photo stays');
  assert.equal(memory.conversation.promptTokens, 0, 'not compacted again until the prompt is measured again');
  // and the next request starts from the summary
  await agent.ask('question 7');
  assert.equal(llm.calls.at(-1).messages[1].content, h[0].content);
});

test('agent: a compaction that lands after another turn has started still applies; one in flight at a time; a failure retries after the next turn', async () => {
  const { agent, llm } = await fiveTurns(1000);
  const summary = deferred(), answer = deferred();
  llm.script.push({ content: 'answer 6', usage: { prompt: 6000 } }, () => summary.promise, () => answer.promise, new Error('chat/completions: 503'));
  await agent.ask('question 6');
  const compaction = agent.compaction;
  const turn = agent.ask('question 7');   // starts while the summary is being written
  await settle();
  summary.resolve({ content: 'Three questions so far.' });
  await compaction;
  assert.equal(agent.history[0].content, 'Earlier on this call: Three questions so far.', 'applied under the running turn: the prefix it replaced had not changed');
  assert.deepEqual(agent.history.at(-1), { role: 'user', content: 'question 7' });
  assert.equal(llm.calls.length, 13, 'ten steps, turn 6, one summary, turn 7: no second summary was asked for meanwhile');
  answer.resolve({ content: 'answer 7', usage: { prompt: 5600 } });
  await turn;
  // that turn was over the threshold again: the next compaction starts, fails, and is retried after the next turn
  const before = agent.history;
  assert.ok(agent.compaction);
  await agent.compaction;   // the 503: logged, not thrown
  assert.deepEqual(agent.history, before, 'a failed compaction changes nothing');
  llm.script.push({ content: 'answer 8', usage: { prompt: 5700 } }, { content: 'Second summary.' });
  await agent.ask('question 8');
  await agent.compaction;
  assert.equal(agent.history[0].content, 'Earlier on this call: Second summary.');
  assert.match(llm.calls.at(-1).messages[1].content, /^Earlier on this call: Three questions so far\.\nPartner: question 4\n/, 'the earlier summary is folded into the next');
  assert.deepEqual(agent.history.filter((m) => m.role === 'user').map((m) => m.content).slice(1), ['question 6', 'question 7', 'question 8']);
});

test('agent: a compaction whose prefix is gone is refused; past hardLimit the oldest turns are dropped before the next call', async () => {
  const { agent, memory, llm } = await fiveTurns(1000);
  const summary = deferred();
  llm.script.push({ content: 'answer 6', usage: { prompt: 7400 } }, () => summary.promise);
  await agent.ask('question 6');
  const compaction = agent.compaction;
  // the summary has not landed and the context is past the hard limit: the next ask drops without one
  llm.script.push({ content: 'answer 7', usage: { prompt: 3000 } });
  await agent.ask('question 7');
  const sent = llm.calls.at(-1).messages;
  assert.deepEqual(sent.slice(1).filter((m) => m.role === 'user').map((m) => m.content), ['question 4', 'question 5', 'question 6', 'question 7'], 'keepTurns turns and the new one');
  assert.equal(memory.conversation.promptTokens, 3000);
  summary.resolve({ content: 'Too late.' });
  await compaction;
  assert.ok(!agent.history.some((m) => String(m.content).includes('Too late')), 'its prefix no longer exists: not applied');
  assert.equal(agent.history[0].content, 'question 4');
});

test('agent: after callGapS of silence the next ask is a new call - the old one folded into a summary first, or dropped when that fails', async () => {
  const mood = { id: 'mood', seen: [], context() { this.seen.push(this.memory.conversation.startedAt); return null; } };
  const { agent, memory, llm, tick } = make({ context: [mood], script: [{ content: 'A meter.' }, { content: 'Yes.' }] });
  mood.memory = memory;
  await agent.ask('what is that?'); tick(60_000);
  await agent.ask('sure?');
  const started = memory.conversation.startedAt;
  tick(1800_000);   // exactly the gap: still this call
  await agent.ask('still there?');
  assert.equal(agent.history.length, 6); assert.equal(memory.conversation.startedAt, started);
  tick(1800_001);
  llm.script.push({ content: 'Partner identified a multimeter.' }, { content: 'Morning.' });
  await agent.ask('hello again');
  assert.deepEqual(agent.history, [
    { role: 'user', content: 'On an earlier call: Partner identified a multimeter.' },
    { role: 'user', content: 'hello again' }, { role: 'assistant', content: 'Morning.' },
  ]);
  const [fold, turn] = llm.calls.slice(-2);
  assert.match(fold.messages[1].content, /^Partner: what is that\?\nJet: A meter\.\nPartner: sure\?/); assert.ok(!fold.tools);
  assert.equal(turn.messages[1].content, 'On an earlier call: Partner identified a multimeter.', 'awaited: the turn already runs on the folded history');
  assert.equal(mood.seen.at(-1), null, 'the context sources see a call that has not started');
  assert.ok(memory.conversation.startedAt > started, 'the new call starts with this message');
  // the summary fails (or times out): the old turns are just dropped
  tick(3600_000);
  llm.script.push(({ signal }) => untilAbort(signal, 'timeout'), { content: 'What.' });
  const alive = setTimeout(() => {}, 5000);   // AbortSignal.timeout does not hold the event loop open
  await agent.ask('anyone?');
  clearTimeout(alive);
  assert.deepEqual(agent.history, [{ role: 'user', content: 'anyone?' }, { role: 'assistant', content: 'What.' }]);
});

test('history: plan, compact, drop and fold cut at user boundaries; transcript skips the context block', () => {
  const h = new History();
  const say = (role, content, t) => h.push({ role, content }, t);
  assert.equal(h.plan(0), null); assert.equal(h.drop(3), 0);
  say('user', 'one\n\n[context]\nIt is late.', 1); say('assistant', 'A', 2); say('user', 'two', 3); say('assistant', 'B', 4);
  assert.equal(h.plan(2), null, 'two turns, keep two: nothing to compact');
  assert.equal(h.plan(3), null);
  assert.deepEqual(h.plan(1).messages.map((m) => m.content), ['one\n\n[context]\nIt is late.', 'A']);
  assert.equal(transcript(h.messages), 'Partner: one\nJet: A\nPartner: two\nJet: B');
  const plan = h.plan(1);
  h.promptTokens = 6000;
  assert.equal(h.compact(plan, 'S'), true);
  assert.deepEqual(h.messages.map((m) => m.content), ['Earlier on this call: S', 'two', 'B']);
  assert.equal(h.compact(plan, 'again'), false, 'a plan applies once');
  assert.equal(h.plan(1), null, 'only the summary is in front of the kept turn');
  say('user', 'three', 5); say('assistant', 'C', 6);
  assert.equal(h.drop(1), 2, 'drops turn two, keeps the summary');
  assert.deepEqual(h.messages.map((m) => m.content), ['Earlier on this call: S', 'three', 'C']);
  assert.equal(h.drop(3), 2, 'fewer turns than keepTurns: it still makes room');
  assert.deepEqual(h.messages.map((m) => m.content), ['Earlier on this call: S']);
  assert.equal(h.asksSince(3), 2); assert.equal(h.asksSince(0), 3, 'asks are remembered across cuts');
  assert.equal(h.lastAt, 2, 'a summary is as old as what it replaced');
  h.fold(null);
  assert.equal(h.length, 0); assert.equal(h.startedAt, null);
});

// ---- persistence --------------------------------------------------------------------------------
test('memory: the conversation and the notes survive a restart, images stripped, writes atomic', async () => {
  const dir = path.join(tmpdir('jet-agent-'), 'agent');   // created on first write
  const look = tool('look', { run: () => ({ text: 'Photo.', image: JPEG }) });
  const { agent, memory } = make({ dir, tools: [look], script: [{ content: 'Let me see.', toolCalls: [call('1', 'look')] }, { content: 'A meter.', usage: { prompt: 900 } }] });
  await memory.start();   // nothing there yet
  assert.equal(agent.history.length, 0);
  await agent.ask('what is that?');
  await memory.remember('Partner solders with lead-free.');
  await memory.stop();
  const file = fs.readFileSync(path.join(dir, 'conversation.json'), 'utf8');
  assert.ok(!file.includes('base64'), 'no image on disk');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['conversation.json', 'notes.json'], 'no temp files left');
  assert.equal(agent.history[2].content[1].type, 'image_url', 'the live conversation keeps its photo');

  const again = make({ dir });
  await again.memory.start();
  assert.deepEqual(again.agent.history, [
    { role: 'user', content: 'what is that?' },
    { role: 'assistant', content: 'Let me see.', tool_calls: [{ id: '1', type: 'function', function: { name: 'look', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', content: `Photo.\n${PHOTO_GONE}` },
    { role: 'assistant', content: 'A meter.' },
  ]);
  assert.equal(again.memory.conversation.promptTokens, 900);
  assert.equal(again.memory.conversation.startedAt, memory.conversation.startedAt);
  assert.equal(again.memory.conversation.asksSince(0), 1);
  assert.deepEqual(again.memory.notes.map((n) => n.text), ['Partner solders with lead-free.']);
  await again.agent.ask('and now?');
  assert.equal(roles(again.llm.calls[0].messages), 'system user assistant tool assistant user', 'the conversation goes on where it stopped');
  assert.match(again.llm.calls[0].messages[0].content, /- Partner solders with lead-free\.$/);
  // a corrupt file is a fresh start, not a crash; an unwritable dir does not fail a turn
  fs.writeFileSync(path.join(dir, 'conversation.json'), '{"entries": [');
  const fresh = make({ dir });
  await fresh.memory.start();
  assert.equal(fresh.agent.history.length, 0);
  const blocked = make({ dir: path.join(dir, 'notes.json', 'sub') });
  await blocked.memory.start();
  assert.equal((await blocked.agent.ask('hi')).text, 'ok');
});

// ---- the mood -----------------------------------------------------------------------------------
test('mood: facts about the call - its age, recent asks, an interruption, the activity rolled once per call', async () => {
  const { agent, memory, llm, tick } = make();
  const rolls = [0, 0.99, 0.5];
  const mood = Object.assign(new Mood(), { activities: ['eating lunch', 'filling in the log'], windowS: 600, memory, now: agent.now, random: () => rolls.shift() });
  agent.context = [mood];
  const block = () => agent.history.findLast((m) => m.role === 'user').content.split('\n').at(-1);
  await agent.ask('one');
  assert.match(block(), /^It is \w+day,? \d\d:\d\d\. A new call\. When the call came in you were eating lunch\.$/);
  tick(4 * 60_000); await agent.ask('two');
  assert.match(block(), /This call has been going for 4 minutes\. Asked 1 time in the last 10 minutes before this\. When the call came in you were eating lunch\.$/);
  tick(30_000);
  const abort = new AbortController();
  llm.script.push(() => { abort.abort(); return new Error('cancelled'); });
  await assert.rejects(agent.ask('three', { signal: abort.signal }));
  tick(8 * 60_000); await agent.ask('four');
  assert.match(block(), /going for 13 minutes\. Asked 2 times in the last 10 minutes before this\. Your last reply was cut off by your partner\. When/, 'the ask from 12 minutes ago has left the window');
  tick(3 * 3600_000); await agent.ask('five');
  assert.match(block(), /A new call; the last one ended 3 hours ago\. When the call came in you were filling in the log\.$/, 're-rolled for the new call');
});

// ---- the generic tools --------------------------------------------------------------------------
/** A loopback JSON server; `reply(call)` returns `[status, body]`. */
async function fakeHttp(t, reply) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() };
      calls.push(call);
      const answer = reply(call);
      if (!answer) return;   // hang
      res.statusCode = answer[0]; res.end(typeof answer[1] === 'string' ? answer[1] : JSON.stringify(answer[1]));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { calls, base: `http://127.0.0.1:${server.address().port}` };
}

test('web_search: SearXNG JSON, the top results as title / url / snippet; unconfigured, empty and failing', async (t) => {
  let answer = [200, { results: Array.from({ length: 8 }, (_, i) => ({ title: `Title ${i + 1}`, url: `https://example.com/${i + 1}`, content: `snippet\n  number ${i + 1} ${'z'.repeat(50)}` })) }];
  const { calls, base } = await fakeHttp(t, () => answer);
  const search = Object.assign(new WebSearchTool(), { base: `${base}/`, results: 2, snippetChars: 20, timeoutMs: 300, insecureTls: false });
  assert.equal(search.name, 'web_search'); assert.equal(search.available, true); assert.deepEqual(search.parameters.required, ['query']);
  assert.equal(await search.run({ query: 'fluke 87 & fuse' }), '1. Title 1\nhttps://example.com/1\nsnippet number 1 zzz\n\n2. Title 2\nhttps://example.com/2\nsnippet number 2 zzz');
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].url, '/search?q=fluke+87+%26+fuse&format=json');
  answer = [200, { results: [] }];
  assert.equal(await search.run({ query: 'nothing' }), 'no results');
  answer = [429, 'Too Many Requests'];
  await assert.rejects(search.run({ query: 'x' }), /search answered 429: Too Many Requests/);
  answer = [200, '<html>'];
  await assert.rejects(search.run({ query: 'x' }), /did not answer with JSON/);
  answer = null;
  await assert.rejects(search.run({ query: 'x' }), /timeout after 300 ms/);
  const abort = new AbortController(); setTimeout(() => abort.abort(), 20);
  await assert.rejects(search.run({ query: 'x' }, { signal: abort.signal }), /cancelled/);
  await assert.rejects(search.run({ query: ' ' }), /query is empty/);
  const off = Object.assign(new WebSearchTool(), { base: '' });
  assert.equal(off.available, false);
  assert.match(await off.run({ query: 'x' }), /^error: web search is not configured/);
});

test('web_read: Firecrawl scrape to markdown, cut to maxChars; unconfigured and failing', async (t) => {
  let answer = [200, { success: true, data: { markdown: `# Fluke 87V\n\n${'spec '.repeat(40)}` } }];
  const { calls, base } = await fakeHttp(t, () => answer);
  const read = Object.assign(new WebReadTool(), { base, maxChars: 30, timeoutMs: 300, insecureTls: false });
  assert.equal(read.name, 'web_read');
  assert.equal(await read.run({ url: 'https://example.com/87v' }), '# Fluke 87V\n\nspec spec spec sp\n[cut: the page goes on]');
  assert.deepEqual([calls[0].method, calls[0].url, calls[0].headers['content-type']], ['POST', '/v2/scrape', 'application/json']);
  assert.deepEqual(JSON.parse(calls[0].body), { url: 'https://example.com/87v', formats: ['markdown'] });
  read.maxChars = 3000;
  answer = [200, { data: { markdown: 'short page' } }];
  assert.equal(await read.run({ url: 'http://example.com' }), 'short page');
  answer = [200, { success: false, error: 'blocked by robots' }];
  await assert.rejects(read.run({ url: 'https://example.com' }), /could not be read: blocked by robots/);
  answer = [500, { error: 'boom' }];
  await assert.rejects(read.run({ url: 'https://example.com' }), /reader answered 500/);
  await assert.rejects(read.run({ url: 'file:///etc/passwd' }), /must start with http/);
  assert.equal(calls.length, 4, 'a non-http url never reaches the service');
  const off = Object.assign(new WebReadTool(), { base: '' });
  assert.equal(off.available, false);
  assert.match(await off.run({ url: 'https://example.com' }), /^error: web reading is not configured/);
});

test('shell: output, exit status, the timeout kills the whole group, the tail is kept, a bare environment', async () => {
  const shell = () => Object.assign(new ShellTool(), { timeoutMs: 2000, maxChars: 2000, user: 'nobody', group: 'nogroup', setpriv: 'setpriv', path: process.env.PATH, logger: null });
  const sh = shell();
  assert.equal(sh.name, 'shell');
  assert.equal(await sh.run({ command: 'echo hello; echo oops >&2' }), 'hello\noops');
  assert.equal(await sh.run({ command: 'true' }), '(no output)');
  assert.equal(await sh.run({ command: 'echo no; exit 3' }), 'no\n[exit 3]');
  assert.match(await sh.run({ command: 'definitely-not-a-command' }), /not found\n\[exit 127\]$/);
  process.env.JET_SECRET = 'hunter2';
  assert.equal(await sh.run({ command: 'echo "[$JET_SECRET]" "$HOME"; pwd' }), '[] /\n/', 'jet-app\'s environment is not the command\'s');
  delete process.env.JET_SECRET;
  await assert.rejects(sh.run({ command: '  ' }), /command is empty/);
  const small = Object.assign(shell(), { maxChars: 10 });
  assert.equal(await small.run({ command: 'printf "%s" 0123456789abcdefghij' }), '[cut: 10 earlier characters]\nabcdefghij');
  // a child that outlives sh's patience: the group is killed, so the pipes close and we return
  const quick = Object.assign(shell(), { timeoutMs: 150 });
  const t0 = Date.now();
  assert.equal(await quick.run({ command: 'echo started; sleep 30 & sleep 30' }), 'started\n[killed: still running after 0.15 s]');
  assert.ok(Date.now() - t0 < 2000);
  const abort = new AbortController(); setTimeout(() => abort.abort(), 50);
  await assert.rejects(sh.run({ command: 'sleep 30' }, { signal: abort.signal }), /cancelled/);
});

test('shell: as root the command runs through setpriv as the unprivileged user; root that cannot drop is refused', async () => {
  const dir = tmpdir('jet-shell-');
  const setpriv = path.join(dir, 'setpriv');
  // stands in for setpriv: records its options, then runs the rest
  fs.writeFileSync(setpriv, `#!/bin/sh\necho "$1 $2 $3 $4 $5" >> ${dir}/dropped\nshift 5\nexec "$@"\n`); fs.chmodSync(setpriv, 0o755);
  const root = Object.assign(new ShellTool(), { timeoutMs: 2000, maxChars: 2000, user: 'nobody', group: 'nogroup', setpriv, path: process.env.PATH, logger: null, uid: () => 0 });
  assert.equal(await root.run({ command: 'echo as nobody' }), 'as nobody');
  assert.equal(await root.run({ command: 'echo again' }), 'again');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'dropped'), 'utf8').trim().split('\n'), Array(3).fill('--reuid nobody --regid nogroup --clear-groups'), 'one probe, then every command');
  for (const broken of [path.join(dir, 'missing'), 'false']) {   // no binary; a binary that fails (no such user)
    const stuck = Object.assign(new ShellTool(), { timeoutMs: 2000, maxChars: 2000, user: 'nobody', group: 'nogroup', setpriv: broken, path: process.env.PATH, logger: null, uid: () => 0 });
    fs.rmSync(path.join(dir, 'ran-as-root'), { force: true });
    assert.match(await stuck.run({ command: `touch ${dir}/ran-as-root` }), /^error: the shell is not available .*cannot drop privileges/);
    assert.equal(fs.existsSync(path.join(dir, 'ran-as-root')), false, 'nothing ran');
  }
});

test('status: battery, GPS, uptime and temperature from the models and /sys; a missing model leaves its line out', async () => {
  const dir = tmpdir('jet-status-');
  for (const [zone, temp] of [['thermal_zone0', '91500\n'], ['thermal_zone1', '96234\n'], ['cooling_device0', '0\n']]) {
    fs.mkdirSync(path.join(dir, zone)); fs.writeFileSync(path.join(dir, zone, zone.startsWith('thermal') ? 'temp' : 'cur_state'), temp);
  }
  fs.mkdirSync(path.join(dir, 'thermal_zone2'));   // a zone with no reading
  const fix = { fix: '3d', lat: 37.774929, lon: -122.419416, altM: 15.6, hdop: 1.2, satsUsed: 7, satsInView: 11, speedKmh: 0.4 };
  const gps = { running: true, state: fix, goodFix: () => fix };
  const power = { smoothed: { vbat: 3990, ma: -120, vsys: 4010, vbus: 0 }, soc: { percent: 78, full: false, charging: false } };
  const status = Object.assign(new StatusTool(), { thermalDir: dir, netDir: path.join(dir, 'net'), power, gps });
  assert.equal(status.name, 'status'); assert.deepEqual(status.parameters, { type: 'object', properties: {} });
  const lines = (await status.run({})).split('\n');
  assert.equal(lines[0], 'Battery 78%, 3.99 V, drawing 120 mA.');
  assert.equal(lines[1], 'GPS 3d fix at 37.77493, -122.41942 (altitude 16 m, 0.4 km/h, 7 satellites, hdop 1.2).');
  assert.match(lines[2], /^WiFi /);
  assert.match(lines[3], /^Uptime (\d+ d )?(\d+ h )?\d+ (h|min), load \d+\.\d\d \d+\.\d\d \d+\.\d\d\.$/);
  assert.equal(lines[4], 'Temperature 96°C, 92°C.');
  power.smoothed.ma = 310; power.soc = null; gps.goodFix = () => null;
  const charging = (await status.run({})).split('\n');
  assert.equal(charging[0], 'Battery 3.99 V, charging at 310 mA.');
  assert.equal(charging[1], 'GPS on, no fix (7 satellites used, 11 in view).');
  gps.running = false; power.smoothed = null;
  assert.deepEqual((await status.run({})).split('\n').slice(0, 2), ['Battery: no reading yet.', 'GPS is off.']);
  const bare = Object.assign(new StatusTool(), { thermalDir: path.join(dir, 'none'), netDir: path.join(dir, 'net'), power: null, gps: undefined });
  const out = await bare.run({});
  assert.ok(!/Battery|GPS|Temperature/.test(out)); assert.match(out, /Uptime/);
});

// ---- the container ------------------------------------------------------------------------------
test('agent: tools and context sources are DI modules, injected into the arrays in config order', async () => {
  const s = Schema.create;
  const dir = tmpdir('jet-agent-di-');
  // class instances, not plain objects: injection deep-merges plain objects but assigns instances
  const inst = (shape) => Object.assign(new (class Fake {})(), shape);
  class LookTool { static moduleInfo = { name: 'look-tool', provides: 'Tool' }; name = 'look'; description = 'take a photo'; parameters = { type: 'object', properties: {} }; run() { return 'a photo'; } }
  class World { static moduleInfo = { name: 'world', provides: 'ContextSource' }; id = 'world'; context() { return 'In view lately: pliers [e3]'; } }
  class Harness { static moduleInfo = { name: 'harness', isMain: true, schema: s().property('agent', s('Agent').required()) }; agent; }
  const container = async (agentConfig, { power = true } = {}) => {
    const mm = new ModuleManager();
    const llm = inst(fakeLlm());
    mm.registerInstance(llm, { name: 'llm', lifecycle: false });
    if (power) mm.registerInstance(inst({ smoothed: null }), { name: 'power', lifecycle: false });
    mm.register(Harness).register(Agent).register(LookTool).register(World);
    const config = await mm.configure({ argv: [], env: {}, defaults: { agent: { agentMemory: { dir }, ...agentConfig } } });
    await mm.initModules(config);
    return { agent: mm.getModuleInstance('harness').agent, llm, mm };
  };

  // the generic tools plus one from another module; the mood plus the world
  const { agent, llm, mm } = await container({
    tools: ['look-tool', 'web-search-tool', 'web-read-tool', 'status-tool', 'shell-tool', 'remember-tool'], context: ['mood', 'world'],
    persona: 'A test persona.', webSearchTool: { base: 'https://search.example', insecureTls: true }, shellTool: { timeoutMs: 1234 }, mood: { activities: ['testing'] },
  });
  assert.ok(agent instanceof Agent);
  assert.deepEqual(agent.tools.map((t) => t.name), ['look', 'web_search', 'web_read', 'status', 'shell', 'remember'], 'config order');
  assert.deepEqual(agent.context.map((c) => c.id), ['mood', 'world']);
  const [look, search, read, status, shell, remember] = agent.tools;
  assert.ok(look instanceof LookTool); assert.ok(search instanceof WebSearchTool); assert.ok(shell instanceof ShellTool);
  assert.deepEqual([search.base, search.insecureTls, search.results], ['https://search.example', true, 4], 'a tool\'s config rides the agent.<tool> layer over its own defaults');
  assert.deepEqual([read.base, read.available, read.maxChars], ['', false, 3000], 'an endpoint has no default');
  assert.deepEqual([shell.timeoutMs, shell.user, shell.group], [1234, 'nobody', 'nogroup']);
  assert.equal(status.power, mm.getModuleInstance('power'), 'a tool gets its own models');
  assert.equal(status.gps ?? null, null, 'and does without one that is not there (lax)');
  assert.ok(agent.memory instanceof Memory);
  assert.equal(remember.memory, agent.memory, 'one memory: the agent, the remember tool and the mood share it');
  assert.equal(agent.context[0].memory, agent.memory);
  assert.equal(agent.memory.dir, dir); assert.equal(agent.memory.maxNotes, 40);
  assert.deepEqual(agent.context[0].activities, ['testing']);
  assert.equal(agent.llm, llm);
  assert.deepEqual([agent.model, agent.maxTokens, agent.temperature, agent.maxSteps, agent.toolResultChars, agent.keepImages, agent.compactAt, agent.hardLimit, agent.keepTurns, agent.callGapS, agent.persona],
    ['qwen-vision', 300, 0.4, 6, 1600, 2, 5000, 7000, 3, 1800, 'A test persona.']);

  // a turn through the container-built agent: the unconfigured reader is not offered, both sources speak
  await agent.memory.start(); await agent.start();
  llm.script.push({ toolCalls: [call('1', 'look')] }, { content: 'Pliers.' });
  assert.equal((await agent.ask('what is that?')).text, 'Pliers.');
  assert.deepEqual(llm.calls[0].tools.map((t) => t.function.name), ['look', 'web_search', 'status', 'shell', 'remember']);
  assert.match(agent.history[0].content, /^what is that\?\n\n\[context\]\nIt is .* When the call came in you were testing\.\nIn view lately: pliers \[e3\]$/);
  await agent.stop(); await agent.memory.stop();

  // the arrays are configuration: a subset reshapes what the model is offered
  const second = await container({ tools: ['remember-tool', 'look-tool'], context: ['world'] }, { power: false });
  assert.deepEqual(second.agent.tools.map((t) => t.name), ['remember', 'look']);
  assert.deepEqual(second.agent.context.map((c) => c.id), ['world']);
  assert.match(second.agent.persona, /^You are Jet, a remote operator/, 'the default persona');
});

test('agent: a turn that fills the slot is told to answer; its tool results shrink once it is over', async () => {
  const big = 'x'.repeat(1500);
  const search = tool('search', { run: async () => big });
  const { agent, llm } = make({ tools: [search], toolResultChars: 1600, script: [
    { toolCalls: [call('c1', 'search', { q: 'a' })], usage: { prompt: 3000, completion: 10 } },
    { toolCalls: [call('c2', 'search', { q: 'b' })], usage: { prompt: 5700, completion: 10 } },   // past the step limit
    { content: 'Here is what I have.', toolCalls: [call('c3', 'search', { q: 'c' })], usage: { prompt: 6200, completion: 20 } },   // asks for a tool anyway
    { content: 'Second answer.', usage: { prompt: 1200, completion: 5 } },
  ] });
  const out = await agent.ask('find it');
  assert.equal(out.text, 'Here is what I have.'); assert.equal(out.steps, 3, 'the third step was the answer: its tool call was not run');
  const sent = llm.calls[2].messages;
  assert.match(sent.at(-1).content, /\[No more lookups this turn: answer now, briefly, from what you have\. You may still use show\.\]$/, 'said in the last tool result, so the prefix is untouched');
  assert.equal(sent.at(-3).content, big, 'the earlier result was still whole while the turn ran');
  const h = agent.history;
  assert.equal(roles(h), 'user assistant tool assistant tool assistant');
  assert.equal(h.at(-1).tool_calls, undefined, 'the answer is filed without the call it did not get to make');
  for (const m of h.filter((x) => x.role === 'tool')) assert.match(m.content, /^x{300}\n\[shortened: this result was \d+ characters when you used it\]$/);
  await agent.ask('and again');
  assert.ok(llm.calls[3].messages.filter((m) => m.role === 'tool').every((m) => m.content.length < 400), 'the next turn carries the short ones');
});

test('history: estimate counts text and photos; drop goes on until the conversation fits', () => {
  const h = new History();
  for (let i = 0; i < 4; i++) { h.push({ role: 'user', content: `q${i} ${'w'.repeat(3300)}` }, i * 10); h.push({ role: 'assistant', content: 'a' }, i * 10 + 1); }
  assert.ok(Math.abs(h.estimate() - 4050) < 80, String(h.estimate()));
  h.push({ role: 'tool', tool_call_id: 'x', content: [{ type: 'text', text: 'Photo.' }, { type: 'image_url', image_url: { url: 'data:...' } }] }, 99);
  assert.ok(h.estimate() > 4400, 'a photo is about 400');
  assert.equal(h.drop(3, { under: 2500 }), 4, 'keeping three turns was not enough: two are kept');
  assert.ok(h.estimate() <= 2500 + 420);
});
