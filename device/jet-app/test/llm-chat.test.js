// llm.chat (the agent's call) against a fake OpenAI-compatible server on loopback: the request
// shape, content deltas to onToken, tool-call fragments accumulated by index across SSE chunks
// (and across TCP reads), arguments parsed, usage from the final chunk, errors and cancel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Llm } from '../src/modules/llm/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake chat server: `script(call, res)` writes the reply. */
async function fakeServer(script) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => { const call = { url: req.url, body: JSON.parse(Buffer.concat(parts).toString()) }; calls.push(call); script(call, res); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, calls, base: `http://127.0.0.1:${server.address().port}/v1` };
}
const makeLlm = (base, overrides = {}) => Object.assign(new Llm(), { base, chatModel: 'chat-m', thinkingKwarg: true, reasoningEffort: 'none', maxTokens: 50, chatTimeoutMs: 2000, ...overrides });
const ev = (delta, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta }], ...extra })}\n\n`;
const tc = (index, fn, id) => ev({ tool_calls: [{ index, ...(id ? { id, type: 'function' } : {}), function: fn }] });

test('llm.chat: text and two tool calls whose arguments arrive in fragments, split over reads; usage from the last chunk', async (t) => {
  const { server, calls, base } = await fakeServer(async (call, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const stream = ev({ role: 'assistant', content: null }) + ev({ reasoning_content: 'hmm' }) + ev({ content: 'Let me ' }) + ev({ content: 'see.' })
      + tc(0, { name: 'look', arguments: '' }, 'call_a') + tc(1, { name: 'web_search', arguments: '{"que' }, 'call_b')
      + tc(1, { arguments: 'ry":"jet ' }) + tc(0, { arguments: '{}' }) + tc(1, { arguments: 'engine €"}' })
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 812, completion_tokens: 31 }, timings: { cache_n: 790 } })}\n\ndata: [DONE]\n\n`;
    const bytes = Buffer.from(stream);
    for (let i = 0; i < bytes.length; i += 37) { res.write(bytes.subarray(i, i + 37)); await sleep(1); }   // JSON objects (and the €) cut mid-way
    res.end();
  });
  t.after(() => server.close());
  const llm = makeLlm(base); await llm.start(); t.after(() => llm.stop());
  const tokens = [];
  const tools = [{ type: 'function', function: { name: 'look', description: 'd', parameters: { type: 'object', properties: {} } } }];
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'what is this?' }];
  const reply = await llm.chat({ messages, tools, model: 'qv', maxTokens: 300, temperature: 0.6, onToken: (x) => tokens.push(x) });
  assert.deepEqual(tokens, ['Let me ', 'see.'], 'content deltas only');
  assert.deepEqual(reply, { content: 'Let me see.',
    toolCalls: [{ id: 'call_a', name: 'look', args: {} }, { id: 'call_b', name: 'web_search', args: { query: 'jet engine €' } }],
    usage: { prompt: 812, completion: 31, cached: 790 } });
  assert.equal(calls[0].url, '/v1/chat/completions');
  assert.deepEqual(calls[0].body, { model: 'qv', stream: true, stream_options: { include_usage: true }, max_tokens: 300, temperature: 0.6, tools, messages,
    chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none' });
});

test('llm.chat: defaults, no tools, no usage reported, unparseable and non-object arguments, a missing id', async (t) => {
  let n = 0;
  const { server, calls, base } = await fakeServer((call, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    if (n++ === 0) return res.end(ev({ content: 'Noon.' }) + 'data: [DONE]\n\n');
    res.end(tc(0, { name: 'shell', arguments: '{"command": "ls' }, 'c1') + tc(1, { name: 'show', arguments: '[1]' }) + tc(3, { name: 'status' }, 'c3') + 'data: [DONE]\n\n');
  });
  t.after(() => server.close());
  const llm = makeLlm(base, { thinkingKwarg: false, reasoningEffort: '' }); await llm.start(); t.after(() => llm.stop());
  const plain = await llm.chat({ messages: [{ role: 'user', content: 'time?' }] });   // no onToken either
  assert.deepEqual(plain, { content: 'Noon.', toolCalls: [], usage: { prompt: 0, completion: 0, cached: 0 } });
  assert.deepEqual(calls[0].body, { model: 'chat-m', stream: true, stream_options: { include_usage: true }, max_tokens: 50, messages: [{ role: 'user', content: 'time?' }] });
  const { toolCalls } = await llm.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] });
  assert.ok(!('tools' in calls[1].body), 'an empty tool list is not sent');
  assert.deepEqual(toolCalls, [
    { id: 'c1', name: 'shell', args: null, raw: '{"command": "ls' },
    { id: 'call_1', name: 'show', args: null, raw: '[1]' },
    { id: 'c3', name: 'status', args: {} },
  ]);
});

test('llm.chat: a server error rejects with the status; the signal rejects with cancelled', async (t) => {
  let mode = 'error';
  const { server, base } = await fakeServer((call, res) => {
    if (mode === 'error') { res.statusCode = 400; return res.end('{"error":"context too long"}'); }
    res.setHeader('Content-Type', 'text/event-stream'); res.write(ev({ content: 'One ' }));   // and then nothing
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const llm = makeLlm(base); await llm.start(); t.after(() => llm.stop());
  await assert.rejects(llm.chat({ messages: [] }), /chat\/completions: 400 .*context too long/);
  mode = 'hang';
  const abort = new AbortController(), tokens = [];
  const pending = llm.chat({ messages: [], onToken: (x) => { tokens.push(x); abort.abort(); }, signal: abort.signal });
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(tokens, ['One ']);
});
