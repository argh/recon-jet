// VoiceSession: the WebSocket client side of host/voice-session.js. Text frames are JSON, binary
// frames are audio; an `audio` event tag is paired with the binary frame that follows it and
// emitted as one `audio` event `{sentence, bytes, pcm, turn}`. Every other server message is
// emitted under its `type` ('partial', 'final', 'token', 'done', 'error'), plus 'open'/'close'.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class VoiceSession extends EventEmitter {
  /** @param {string} url ws://host:port @param {{connectTimeoutMs?: number, logger?: object}} [options] */
  constructor(url, { connectTimeoutMs = 3000, logger } = {}) {
    super();
    this.url = url; this.connectTimeoutMs = connectTimeoutMs; this.logger = logger;
    /** @type {WebSocket|null} */ this.ws = null;
    this.#connecting = null;
    this.#pendingAudio = null;
  }
  #connecting; #pendingAudio;

  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  /** Resolves once the socket is open (at once if it already is). */
  connect() {
    if (this.open) return Promise.resolve();
    if (this.#connecting) return this.#connecting;
    this.#connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { handshakeTimeout: this.connectTimeoutMs });
      const fail = (error) => { this.#connecting = null; if (this.ws === ws) this.ws = null; reject(error); };
      ws.once('open', () => { this.#connecting = null; this.ws = ws; this.logger?.info({ url: this.url }, 'voice session open'); this.emit('open'); resolve(); });
      ws.on('error', (error) => { this.logger?.warn({ error: error.message }, 'voice session error'); if (this.#connecting) fail(error); });
      ws.on('close', () => { if (this.ws === ws) { this.ws = null; this.#pendingAudio = null; this.logger?.info('voice session closed'); this.emit('close'); } else if (this.#connecting) fail(new Error('closed')); });
      ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    });
    return this.#connecting;
  }

  close() { this.ws?.close(); this.ws = null; }

  /** Send a control frame; false when not open. */
  send(obj) { if (!this.open) return false; this.ws.send(JSON.stringify(obj)); return true; }
  /** Send a capture chunk; false when not open. */
  sendAudio(pcm) { if (!this.open) return false; this.ws.send(pcm, { binary: true }); return true; }

  #onMessage(data, isBinary) {
    if (isBinary) {
      const tag = this.#pendingAudio; this.#pendingAudio = null;
      if (!tag) return this.logger?.warn({ bytes: data.length }, 'audio frame without a tag');
      return this.emit('audio', { ...tag, pcm: Buffer.from(data) });
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return this.logger?.warn('bad frame from the voice session'); }
    if (msg.type === 'audio') { this.#pendingAudio = msg; return; }
    this.emit(msg.type, msg);
  }

  /**
   * Synthesise `text` on the host: resolves with the 48 kHz stereo S16 PCM of all audio frames.
   * Only when no turn is running on this session (the server answers `busy` otherwise).
   */
  say(text, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      const parts = [];
      const cleanup = () => { clearTimeout(timer); this.off('audio', onAudio); this.off('done', onDone); this.off('error', onError); this.off('close', onClose); };
      const onAudio = (a) => parts.push(a.pcm);
      const onDone = () => { cleanup(); resolve(Buffer.concat(parts)); };
      const onError = (e) => { cleanup(); reject(new Error(e.message)); };
      const onClose = () => { cleanup(); reject(new Error('session closed')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('say timeout')); }, timeoutMs);
      this.on('audio', onAudio); this.on('done', onDone); this.on('error', onError); this.on('close', onClose);
      if (!this.send({ type: 'say', text })) { cleanup(); reject(new Error('not connected')); }
    });
  }
}
