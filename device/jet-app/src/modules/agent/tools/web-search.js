// web_search: the search desk. A SearXNG instance's JSON API (`GET {base}/search?q=...&format=json`),
// the top few results as title / url / snippet - enough for the model to answer from or to pick
// one for `web_read`. `base` has no default (a per-device endpoint, like `llm.base`): without it
// the tool is not offered to the model at all.
import { Schema } from '@versionzero/module-manager';
import { requestJson, under } from './http.js';

const s = Schema.create;

export class WebSearchTool {
  static moduleInfo = {
    name: 'web-search-tool',
    provides: 'Tool',
    schema: s()
      .property('base', s('string').default('').meta('description', 'SearXNG base URL, https://host (device or personal config layer; empty = off)'))
      .property('results', s('number').default(5).meta('description', 'results handed to the model'))
      .property('snippetChars', s('number').default(240).meta('description', 'each result\'s snippet is cut to this'))
      .property('timeoutMs', s('number').default(15000).meta('description', 'search request timeout'))
      .property('insecureTls', s('boolean').default(false).meta('description', 'accept a certificate that does not verify (this service only)'))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  base; results; snippetChars; timeoutMs; insecureTls; logger;

  name = 'web_search';
  description = 'Search the web. Returns the top results as title, url and a snippet.';
  parameters = { type: 'object', properties: { query: { type: 'string', description: 'what to search for' } }, required: ['query'] };

  get available() { return Boolean(this.base); }

  /** @param {{query: string}} args @param {{signal?: AbortSignal}} [options] */
  async run({ query }, { signal } = {}) {
    if (!this.available) return 'error: web search is not configured on this device';
    if (!query?.trim()) throw new Error('query is empty');
    const url = under(this.base, 'search');
    url.searchParams.set('q', query); url.searchParams.set('format', 'json');
    const reply = await requestJson('search', url, { timeoutMs: this.timeoutMs, signal, insecureTls: this.insecureTls });
    const hits = (reply.results ?? []).slice(0, this.results);
    if (!hits.length) return 'no results';
    return hits.map((r, i) => `${i + 1}. ${r.title ?? '(untitled)'}\n${r.url}\n${String(r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, this.snippetChars)}`.trim()).join('\n\n');
  }
}
