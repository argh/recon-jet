// mood: the facts a person on the other end of a radio would have in their head when the call
// button lights up - what time it is, how long this call has been going, how often they have
// been asked something in the last few minutes, whether they were just talked over, and what
// they were in the middle of when the call came in. Facts, not adjectives: the persona text says
// what to make of them. A `ContextSource`: one line in the block in front of the newest user
// message, read off the `memory` model (it holds no state of its own but the activity it rolled
// for this call).
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;

/** "3 minutes", "2 hours": as a person would say it. */
function span(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'under a minute';
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} hours` : `${Math.round(h / 24)} days`;
}

export class Mood {
  static moduleInfo = {
    name: 'mood',
    provides: 'ContextSource',
    schema: s()
      .property('activities', s('array').property('*', s('string')).default([
        'halfway through a cup of coffee that has gone cold',
        'tracing a ground fault in the relay rack',
        'eating lunch at the console',
        'reading the datasheet of a part that was discontinued years ago',
        'sorting a drawer of unlabelled connectors',
        'filling in the shift log',
        'chasing an intermittent hum in the monitor speaker',
        're-crimping a patch cable for the third time',
      ]).meta('description', 'what the operator may have been doing when a call comes in (one is picked per call)'))
      .property('windowS', s('number').default(600).meta('description', 'the "asked lately" window'))
      .property('memory', s('AgentMemory').meta('internal', true)),
  };
  activities; windowS; memory;

  id = 'mood';
  now = () => Date.now();
  random = Math.random;
  #activity = null;

  /** @returns {string} */
  context() {
    const call = this.memory.conversation, now = this.now();
    const fresh = call.startedAt == null;   // the message being answered opens a call
    if (fresh || this.#activity == null) this.#activity = this.activities?.[Math.floor(this.random() * this.activities.length)] ?? null;
    const facts = [`It is ${new Date(now).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}.`];
    if (fresh) facts.push(call.lastAt ? `A new call; the last one ended ${span(now - call.lastAt)} ago.` : 'A new call.');
    else facts.push(`This call has been going for ${span(now - call.startedAt)}.`);
    const asks = call.asksSince(now - this.windowS * 1000);
    if (asks) facts.push(`Asked ${asks} time${asks === 1 ? '' : 's'} in the last ${span(this.windowS * 1000)} before this.`);
    if (call.cutOff) facts.push('Your last reply was cut off by your partner.');
    if (this.#activity) facts.push(`When the call came in you were ${this.#activity}.`);
    return facts.join(' ');
  }
}
