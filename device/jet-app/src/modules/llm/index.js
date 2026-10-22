// llm: the OpenAI-compatible inference server the Jet reaches over WiFi (llama-swap or
// anything with the same routes). Four calls, one keep-alive connection pool, no state:
//
//   transcribe(pcm16kMono)                 POST /audio/transcriptions  (wav + multipart in memory)
//   chatStream(messages, onToken, signal)  POST /chat/completions, stream: true (SSE)
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
import { toStereo48k } from './resample.js';

const s = Schema.create;

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
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  base; asrModel; chatModel; ttsModel; ttsVoice; visionModel; thinkingKwarg; reasoningEffort; maxTokens; visionMaxTokens; asrTimeoutMs; chatTimeoutMs; ttsTimeoutMs; logger;

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
   * Ask the vision model about a JPEG; `onToken` streams the answer, the promise resolves with
   * the whole of it.
   * @param {Buffer} jpeg @param {string} question @param {(text: string) => void} onToken @param {AbortSignal} [signal]
   */
  describe(jpeg, question, onToken, signal) {
    const content = [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }];
    return this.chatStream([{ role: 'user', content }], onToken, signal, { model: this.visionModel, maxTokens: this.visionMaxTokens });
  }

  // ---- transport ---------------------------------------------------------------------------
  /**
   * POST under `base`. With `onChunk` a 200 body is streamed to it as it arrives; otherwise the
   * body is resolved as one Buffer. A non-200 rejects with the status and the start of the body;
   * the caller's signal rejects with `cancelled`, the timeout with `timeout`.
   */
  #request(route, { headers = {}, body, signal, timeoutMs, onChunk }) {
    if (!this.#url) return Promise.reject(new Error('llm.base is not set'));
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const u = new URL(route, this.#url);
    const mod = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const fail = (error) => reject(signal?.aborted ? new Error('cancelled') : timeout.aborted ? new Error(`${route}: timeout after ${timeoutMs} ms`) : error);
      const req = mod.request(u, { method: 'POST', agent: this.#agent, signal: combined, headers: { 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
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
