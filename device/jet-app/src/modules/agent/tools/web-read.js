// web_read: fetch one page as text. A Firecrawl instance does the fetching and the cleaning
// (`POST {base}/v2/scrape {url, formats: ['markdown']}` -> `data.markdown`); the markdown is cut
// to `maxChars`, because a page is the most expensive thing a turn can put in an 8k context.
// `base` has no default (per-device): without it the tool is not offered to the model.
import { Schema } from '@versionzero/module-manager';
import { requestJson, under } from './http.js';

const s = Schema.create;

export class WebReadTool {
  static moduleInfo = {
    name: 'web-read-tool',
    provides: 'Tool',
    schema: s()
      .property('base', s('string').default('').meta('description', 'Firecrawl base URL, https://host (device or personal config layer; empty = off)'))
      .property('maxChars', s('number').default(3000).meta('description', 'the page is cut to this much markdown'))
      .property('timeoutMs', s('number').default(20000).meta('description', 'scrape request timeout'))
      .property('insecureTls', s('boolean').default(false).meta('description', 'accept a certificate that does not verify (this service only)'))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  base; maxChars; timeoutMs; insecureTls; logger;

  name = 'web_read';
  description = 'Read a web page: returns the start of its text. Use it on a url from web_search when the snippet is not enough.';
  parameters = { type: 'object', properties: { url: { type: 'string', description: 'the page, http(s)://...' } }, required: ['url'] };

  get available() { return Boolean(this.base); }

  /** @param {{url: string}} args @param {{signal?: AbortSignal}} [options] */
  async run({ url }, { signal } = {}) {
    if (!this.available) return 'error: web reading is not configured on this device';
    if (!/^https?:\/\//i.test(url ?? '')) throw new Error('url must start with http:// or https://');
    const reply = await requestJson('reader', under(this.base, 'v2/scrape'), { method: 'POST', json: { url, formats: ['markdown'] }, timeoutMs: this.timeoutMs, signal, insecureTls: this.insecureTls });
    const text = String(reply.data?.markdown ?? '').trim();
    if (!text) throw new Error(reply.error ? `the page could not be read: ${reply.error}` : 'the page came back empty');
    return text.length > this.maxChars ? `${text.slice(0, this.maxChars)}\n[cut: the page goes on]` : text;
  }
}
