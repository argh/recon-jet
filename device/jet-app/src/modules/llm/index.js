// llm: the OpenAI-compatible inference server the Jet reaches over WiFi (llama-swap or
// anything with the same routes). Five calls, one keep-alive connection pool, no state:
//
//   transcribe(pcm16kMono)                 POST /audio/transcriptions  (wav + multipart in memory)
//   chatStream(messages, onToken, signal)  POST /chat/completions, stream: true (SSE)
//   chat({messages, tools, ...})           the same route with tool calls and usage (the agent's call)
//   speak(text, signal)                    POST /audio/speech -> wav -> 48 kHz stereo S16 for jetd's `W`
//   describe(jpeg, question, onToken)      chat with an image_url data URI, the vision model
//
// Reasoning models stream `reasoning_content` deltas before `content`: those are dropped (the
// glasses only ever speak the answer). Two request fields ask the server not to think:
// `chat_template_kwargs: {enable_thinking: false}` (unless `thinkingKwarg` is off, for servers
// that reject unknown fields) and `reasoning_effort` (`none` by default; measured on llama.cpp
// with qwen-27b, this is the one that actually stops the reasoning stream). TLS is the public
// chain: plain https, nothing insecure. `base` has no default: it is per-device configuration.
import http from 'node:http';
import https from 'node:https';
import { Schema } from '@versionzero/module-manager';
import { pcmToWav, parseWav } from './wav.js';
import { multipart } from './multipart.js';
import { SseParser } from './sse.js';
import { toStereo48k, createStereo48kStream } from './resample.js';

const s = Schema.create;
const THINK_END = /<\/think>/g;
/** Connection-level failures worth one more try when no reply had begun. */
const RETRYABLE = /ECONNRESET|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|socket hang up/;

export class Llm {
  static moduleInfo = {
    name: 'llm',
    schema: s()
      .property('base', s('string').default('').meta('description', 'OpenAI-compatible base URL, https://host/v1 (device or personal config layer; empty = off)'))
      .property('asrModel', s('string').default('qwen3-asr').meta('description', 'speech to text model'))
      .property('chatModel', s('string').default('qwen-27b').meta('description', 'the assistant model'))
      .property('ttsModel', s('string').default('kokoro').meta('description', 'text to speech model'))
      .property('ttsVoice', s('string').default('af_heart').meta('description', 'TTS voice'))
      .property('visionModel', s('string').default('qwen-vision').meta('description', 'the model `describe` asks about a JPEG'))
      .property('thinkingKwarg', s('boolean').default(true).meta('description', 'send chat_template_kwargs {enable_thinking: false} (off for servers that reject the field)'))
      .property('reasoningEffort', s('string').default('none').meta('description', 'reasoning_effort sent with chat requests (what stops qwen-27b thinking on llama.cpp; empty = not sent)'))
      .property('maxTokens', s('number').default(200).meta('description', 'answer budget per chat turn'))
      .property('visionMaxTokens', s('number').default(150).meta('description', 'answer budget per describe'))
      .property('asrTimeoutMs', s('number').default(20000).meta('description', 'transcription request timeout'))
      .property('chatTimeoutMs', s('number').default(90000).meta('description', 'chat/describe request timeout (whole stream)'))
      .property('ttsTimeoutMs', s('number').default(30000).meta('description', 'speech request timeout'))
      .property('ttsStreamHz', s('number').default(24000).meta('description', 'sample rate of the streaming TTS `speech.audio.delta` PCM (mono); the clone emits 24 kHz'))
      .property('retryDelayMs', s('number').default(400).meta('description', 'pause before the one retry of a request whose connection failed before any reply'))
      .property('warmCooldownMs', s('number').default(60000).meta('description', 'ignore a `warm` for a model warmed this recently (the vision model unloads after ~300 s idle)'))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  base; asrModel; chatModel; ttsModel; ttsVoice; visionModel; thinkingKwarg; reasoningEffort; maxTokens; visionMaxTokens; asrTimeoutMs; chatTimeoutMs; ttsTimeoutMs; ttsStreamHz; retryDelayMs; warmCooldownMs; logger;

  #url = null; #agent = null;
  now = () => performance.now();

  /** A server is configured (`base` set). */
  get configured() { return Boolean(this.base); }
  get models() { return { asr: this.asrModel, chat: this.chatModel, tts: this.ttsModel, voice: this.ttsVoice, vision: this.visionModel }; }

  async start() {
    if (!this.base) { this.logger?.warn('llm.base is not set: voice and vision are off'); return; }
    this.#url = new URL(this.base.replace(/\/+$/, '') + '/');
    const Agent = this.#url.protocol === 'https:' ? https.Agent : http.Agent;
    this.#agent = new Agent({ keepAlive: true, maxSockets: 4 });
    this.logger?.info({ base: this.#url.origin, models: this.models }, 'llm');
  }
  async stop() { this.#agent?.destroy(); }

  // ---- the calls ----------------------------------------------------------------------------
  /**
   * 16 kHz mono S16 -> text (empty for nothing heard, and without a request under 100 ms).
   * @param {Buffer} pcm @param {{signal?: AbortSignal, rate?: number}} [options]
   */
  async transcribe(pcm, { signal, rate = 16000 } = {}) {
    if (pcm.length < rate / 10 * 2) return '';
    const t0 = this.now();
    const { body, contentType } = multipart([{ name: 'model', value: this.asrModel }, { name: 'file', filename: 'jet.wav', type: 'audio/wav', data: pcmToWav(pcm, rate) }]);
    const reply = JSON.parse((await this.#request('audio/transcriptions', { headers: { 'Content-Type': contentType }, body, signal, timeoutMs: this.asrTimeoutMs })).toString());
    const text = String(reply.text ?? '').trim();
    this.logger?.debug({ ms: Math.round(this.now() - t0), seconds: +(pcm.length / (rate * 2)).toFixed(2), chars: text.length }, 'asr');
    return text;
  }

  /**
   * Stream a chat completion: `onToken` gets each content delta, the promise resolves with the
   * whole answer. Reasoning deltas are ignored.
   * @param {Array<{role: string, content: any}>} messages
   * @param {(text: string) => void} onToken
   * @param {AbortSignal} [signal]
   * @param {{model?: string, maxTokens?: number}} [options]
   */
  async chatStream(messages, onToken, signal, { model = this.chatModel, maxTokens = this.maxTokens } = {}) {
    const sse = new SseParser();
    let text = '', reasoning = 0;
    const body = JSON.stringify({ model, stream: true, max_tokens: maxTokens, messages,
      ...(this.thinkingKwarg ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}) });
    await this.#request('chat/completions', { headers: { 'Content-Type': 'application/json' }, body, signal, timeoutMs: this.chatTimeoutMs, onChunk: (chunk) => {
      for (const ev of sse.feed(chunk)) {
        const delta = ev.choices?.[0]?.delta;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content.length;
        if (delta?.content) { text += delta.content; onToken(delta.content); }
      }
    } });
    if (reasoning) this.logger?.debug({ model, reasoningChars: reasoning }, 'reasoning ignored');
    return text;
  }

  /**
   * A chat completion with tools: streams like `chatStream` (`onToken` gets content deltas only,
   * reasoning is dropped, the same thinking switches are sent) and also collects what a tool loop
   * needs. `delta.tool_calls` arrive as fragments keyed by `index` (the id and name once, the
   * arguments a few characters at a time): they are accumulated per index and parsed at the end -
   * `args` is the parsed object (`{}` when the model sent none); arguments that are not a JSON
   * object come back as `args: null` with the text in `raw`, for the caller to report to the
   * model. `usage` is read from the final chunk (`stream_options.include_usage`); `cached` is
   * llama.cpp's `timings.cache_n`, the prompt tokens it did not have to evaluate again.
   * @param {{messages: object[], tools?: object[], model?: string, maxTokens?: number, temperature?: number, onToken?: (text: string) => void, signal?: AbortSignal}} request
   * @returns {Promise<{content: string, toolCalls: Array<{id: string, name: string, args: object|null, raw?: string}>, usage: {prompt: number, completion: number, cached: number}}>}
   */
  async chat({ messages, tools, model = this.chatModel, maxTokens = this.maxTokens, temperature, onToken, signal }) {
    const sse = new SseParser();
    const calls = [];   // sparse by `index`
    const usage = { prompt: 0, completion: 0, cached: 0 };
    let content = '';
    const body = JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens,
      ...(temperature == null ? {} : { temperature }), ...(tools?.length ? { tools } : {}), messages,
      ...(this.thinkingKwarg ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}) });
    await this.#request('chat/completions', { headers: { 'Content-Type': 'application/json' }, body, signal, timeoutMs: this.chatTimeoutMs, onChunk: (chunk) => {
      for (const ev of sse.feed(chunk)) {
        const delta = ev.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          const said = delta.content.replace(THINK_END, ' ');   // the tag is never for the listener
          if (said) onToken?.(said);
        }
        for (const part of delta?.tool_calls ?? []) {
          const call = (calls[part.index ?? 0] ??= { id: '', name: '', raw: '' });
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.raw += part.function.arguments;
        }
        if (ev.usage) { usage.prompt = ev.usage.prompt_tokens ?? 0; usage.completion = ev.usage.completion_tokens ?? 0; }
        if (ev.timings?.cache_n != null) usage.cached = ev.timings.cache_n;
      }
    } });
    const toolCalls = calls.filter(Boolean).map(({ id, name, raw }, i) => {
      id ||= `call_${i}`;   // a server that omits ids still gets results matched to calls
      if (!raw.trim()) return { id, name, args: {} };
      try { const args = JSON.parse(raw); if (args && typeof args === 'object' && !Array.isArray(args)) return { id, name, args }; } catch { /* reported below */ }
      return { id, name, args: null, raw };
    });
    // With thinking switched off the model now and then still closes a thought it never opened
    // ("I'm checking the screen now.</think> You're looking at..."): what precedes the tag was
    // a thought, so the answer of record is what follows it (the stream had already passed).
    const end = content.lastIndexOf('</think>');
    if (end >= 0) content = content.slice(end + 8).trim();
    return { content, toolCalls, usage };
  }

  /**
   * Text -> speech as 48 kHz stereo S16 PCM (what jetd's `W` plays).
   * @param {string} text @param {AbortSignal} [signal] @returns {Promise<Buffer>}
   */
  async speak(text, signal) {
    const t0 = this.now();
    const body = JSON.stringify({ model: this.ttsModel, input: text, voice: this.ttsVoice, response_format: 'wav' });
    const wav = await this.#request('audio/speech', { headers: { 'Content-Type': 'application/json' }, body, signal, timeoutMs: this.ttsTimeoutMs });
    const t1 = this.now();
    const { rate, channels, data } = parseWav(wav);
    const pcm = toStereo48k(data, { rate, channels });
    this.logger?.debug({ httpMs: Math.round(t1 - t0), resampleMs: Math.round(this.now() - t1), rate, channels, bytes: pcm.length }, 'tts');
    return pcm;
  }

  /**
   * Streamed text -> speech: `onPcm` gets each 48 kHz stereo S16 chunk as the server renders it
   * (the voice clone streams `speech.audio.delta` events, raw PCM at `ttsStreamHz` mono), so the
   * first sound comes out in ~0.15 s instead of waiting for the whole clip (~2 s). The chunks are
   * resampled with continuity across boundaries, so they play gaplessly through jetd's `W` buffer.
   * @param {string} text @param {(pcm: Buffer) => void} onPcm @param {AbortSignal} [signal]
   */
  async speakStream(text, onPcm, signal) {
    const sse = new SseParser(), resample = createStereo48kStream({ rate: this.ttsStreamHz, channels: 1 });
    const body = JSON.stringify({ model: this.ttsModel, input: text, voice: this.ttsVoice, stream_format: 'sse' });
    await this.#request('audio/speech', { headers: { 'Content-Type': 'application/json' }, body, signal, timeoutMs: this.ttsTimeoutMs, onChunk: (chunk) => {
      for (const ev of sse.feed(chunk)) {
        if (ev.type === 'speech.audio.delta' && ev.audio) { const pcm = resample(Buffer.from(ev.audio, 'base64')); if (pcm.length) onPcm(pcm); }
      }
    } });
  }

  /**
   * Ask the vision model about a JPEG; `onToken` streams the answer, the promise resolves with
   * the whole of it.
   * @param {Buffer} jpeg @param {string} question @param {(text: string) => void} onToken @param {AbortSignal} [signal]
   */
  describe(jpeg, question, onToken, signal) {
    const content = [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }];
    return this.chatStream([{ role: 'user', content }], onToken, signal, { model: this.visionModel, maxTokens: this.visionMaxTokens });
  }

  /**
   * Pre-load a model (the vision model by default) with a one-token request, so the next real
   * call is warm instead of eating the cold load (~7 s for the 34 GB vision model vs ~0.1 s warm).
   * Fire-and-forget and debounced per model, so it is safe to call on every head-turn; it only
   * displaces the other big LLM on the server, never the resident voice model.
   */
  warm(model = this.visionModel, cooldownMs = this.warmCooldownMs) {
    if (!this.configured) return;
    const nowMs = this.now();
    if (nowMs - (this.#warmedAt.get(model) ?? -Infinity) < cooldownMs) return;
    this.#warmedAt.set(model, nowMs);
    const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: '.' }],
      ...(this.thinkingKwarg ? { chat_template_kwargs: { enable_thinking: false } } : {}) });
    this.#request('chat/completions', { headers: { 'Content-Type': 'application/json' }, body, timeoutMs: this.chatTimeoutMs })
      .then(() => this.logger?.debug({ model, ms: Math.round(this.now() - nowMs) }, 'warmed'), (error) => this.logger?.debug({ model, error: error.message }, 'warm skipped'));
  }
  #warmedAt = new Map();

  // ---- transport ---------------------------------------------------------------------------
  /**
   * POST under `base`. With `onChunk` a 200 body is streamed to it as it arrives; otherwise the
   * body is resolved as one Buffer. A non-200 rejects with the status and the start of the body;
   * the caller's signal rejects with `cancelled`, the timeout with `timeout`.
   */
  #request(route, options) {
    if (!this.#url) return Promise.reject(new Error('llm.base is not set'));
    // The link is WiFi at the edge of its range: a keep-alive socket the far end has dropped
    // ("socket hang up", ECONNRESET) or a resolver that did not answer (EAI_AGAIN) fails the
    // request before a byte of reply. Those are tried once more, on a fresh connection; a
    // failure after the reply began, a timeout or a cancel is final.
    return this.#attempt(route, options).catch(async (error) => {
      if (!error.retryable || options.signal?.aborted) throw error;
      this.logger?.info({ route, error: error.message }, 'llm: connection failed, trying once more');
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      if (options.signal?.aborted) throw new Error('cancelled');
      return this.#attempt(route, options);
    });
  }

  #attempt(route, { headers = {}, body, signal, timeoutMs, onChunk }) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const u = new URL(route, this.#url);
    const mod = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      let replied = false;
      const fail = (error) => {
        if (signal?.aborted) return reject(new Error('cancelled'));
        if (timeout.aborted) return reject(new Error(`${route}: timeout after ${timeoutMs} ms`));
        if (!replied && RETRYABLE.test(`${error.code ?? ''} ${error.message}`)) error.retryable = true;
        reject(error);
      };
      const req = mod.request(u, { method: 'POST', agent: this.#agent, signal: combined, headers: { 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
        replied = true;
        const parts = [];
        const streaming = onChunk && res.statusCode === 200;
        res.on('data', (c) => (streaming ? onChunk(c) : parts.push(c)));
        res.on('error', fail);
        res.on('end', () => {
          const b = Buffer.concat(parts);
          if (res.statusCode !== 200) return reject(new Error(`${route}: ${res.statusCode} ${b.toString().slice(0, 200)}`));
          resolve(b);
        });
      });
      req.on('error', fail);
      req.end(body);
    });
  }
}
