// wiki: the reference shelf. One request to a MediaWiki API (Wikipedia by default): the best
// few articles for a query, each with the opening of its text. For "which ship is WMSL-750",
// "what is a Legend-class cutter", "who makes this" it is one fast, dependable call, where a
// general web search is at the mercy of whichever engines the search service has not been
// locked out of that hour (seen: every engine but one suspended, and that one answering a
// Coast Guard question with a chatbot's login page). News and prices are still `web_search`.
import { Schema } from '@versionzero/module-manager';
import { requestJson, under } from './http.js';

const s = Schema.create;

export class WikiTool {
  static moduleInfo = {
    name: 'wiki-tool',
    provides: 'Tool',
    schema: s()
      .property('base', s('string').default('https://en.wikipedia.org').meta('description', 'MediaWiki site (its /w/api.php is used); empty = off'))
      .property('results', s('number').default(3).meta('description', 'articles handed to the model'))
      .property('introChars', s('number').default(450).meta('description', 'each article\'s opening is cut to this'))
      .property('timeoutMs', s('number').default(10000).meta('description', 'request timeout'))
      .property('userAgent', s('string').default('jet-app/0.1 (wearable assistant; reference lookups)').meta('description', 'sent as User-Agent (the API asks clients to identify themselves)'))
      .property('logger', s('Logger').lax().meta('internal', true)),
  };
  base; results; introChars; timeoutMs; userAgent; logger;

  name = 'wiki';
  description = 'Look something up in the encyclopedia: the best few articles for a name, designation or topic (a ship by hull number, a product, a place, a term), each with its opening lines. Use this first for facts about a named thing; use web_search for news, prices and anything recent.';
  parameters = { type: 'object', properties: { query: { type: 'string', description: 'the name, designation or topic' } }, required: ['query'] };

  get available() { return Boolean(this.base); }

  /** @param {{query: string}} args @param {{signal?: AbortSignal}} [options] */
  async run({ query }, { signal } = {}) {
    if (!this.available) return 'error: the encyclopedia is not configured on this device';
    if (!query?.trim()) throw new Error('query is empty');
    const url = under(this.base, 'w/api.php');
    for (const [k, v] of Object.entries({ action: 'query', format: 'json', generator: 'search', gsrsearch: query, gsrlimit: this.results, prop: 'extracts', exintro: 1, explaintext: 1, exlimit: 'max', exchars: this.introChars })) url.searchParams.set(k, v);
    const reply = await requestJson('the encyclopedia', url, { timeoutMs: this.timeoutMs, signal, headers: { 'User-Agent': this.userAgent } });
    const pages = Object.values(reply.query?.pages ?? {}).sort((a, b) => a.index - b.index);
    if (!pages.length) return 'no article found';
    return pages.map((p, i) => `${i + 1}. ${p.title}\n${String(p.extract ?? '').replace(/\s+/g, ' ').trim() || '(no summary)'}`).join('\n\n');
  }
}
