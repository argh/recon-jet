// actions: what a spoken command can do without the model. Modules register a command (a name,
// a pattern over the normalised transcript, a handler); the voice module asks `match()` with
// every final transcript before it goes to the chat model, so a command runs offline and at once
// while anything else is a question for the persona. The vocabulary is one verb per tier and one
// noun after it, no synonyms on the verbs (docs/jet-app.md "Spoken commands"):
//   open <screen>            navigation: a mode or a System screen ("open settings", "open status")
//   enable|disable <setting> a toggle ("enable bluetooth", "disable wear", "enable gps")
//   run <app>                the app tier ("run analysis", "run doom")
//   set <level> <0-10>       a level ("set volume 7", "set backlight 3")
//   stop | cancel            end the turn, nothing asked
// Nouns carry aliases only where the ASR has been heard to mishear them ("run doom" comes back
// "random", "wear" as "where"); the verbs were never confused in testing, though the ASR inflects
// them ("run analysis" comes back "Running analysis."), so a leading verb is folded to its stem.
// Normalising lower-cases, drops punctuation and strips what is left of the wake word when the
// capture caught its tail ("jet, run analysis"). The ASR renders that tail as anything ("Dad, look.", "Hey Jarvis,
// look."), so `match()` also tries the transcript without the words before a punctuation break in
// its first three, and without a bare leading "jet"; a candidate only wins if what follows is a
// command, so "jet lag is awful" stays a question. A command may add `when(m)`: a pattern that
// matched but is declined (an unknown mode name) lets the next registered command try, so a
// generic "open <anything>" can sit beside a specific "open <screen>" whatever the start order.
import { Schema } from '@versionzero/module-manager';

const s = Schema.create;
const WAKE_REMNANT = /^(?:(?:hey|heya|hey ya|hiya|okay|ok) jet|jet,)[,.!?]* /;
const VERB_FORMS = /^(run|open|check|enabl|disabl)(?:ning|king|ing|e?s|e?d) /;   // "running" -> "run", "checking" -> "check"
const STEM = { run: 'run', open: 'open', check: 'check', enabl: 'enable', disabl: 'disable' };

/** @param {string} text @returns {string} */
export function normalise(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(WAKE_REMNANT, '')
    .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(VERB_FORMS, (_, v) => STEM[v] + ' ');
}

export class Actions {
  static moduleInfo = {
    name: 'actions',
    schema: s().property('logger', s('Logger').lax().meta('internal', true)),
  };
  logger;

  /** @type {{name: string, pattern: RegExp, run: (m: RegExpExecArray, text: string) => unknown, when?: (m: RegExpExecArray) => boolean}[]} in registration order */
  list = [];

  /**
   * @param {string} name  shown on the strip while it runs
   * @param {RegExp} pattern  tested against the normalised transcript
   * @param {(m: RegExpExecArray, text: string) => unknown} run  may return a promise; a throw is reported
   * @param {{when?: (m: RegExpExecArray) => boolean}} [options]  `when`: decline a match (false) and let later commands try
   */
  register(name, pattern, run, { when } = {}) {
    this.list.push({ name, pattern, run, when });
    this.logger?.debug({ action: name, pattern: String(pattern) }, 'action registered');
    return this;
  }

  /** The readings of a transcript to try, most literal first (see the header). */
  static candidates(text) {
    const raw = String(text ?? '').trim(), out = [normalise(raw)];
    // without the words before a punctuation break in the first three ("Hey Jarvis, look." -> "look.")
    for (const m of raw.matchAll(/[,.!?:;]+\s+(?=\S)/g)) {
      const words = raw.slice(0, m.index).trim().split(/\s+/).length;
      if (words > 3) break;
      out.push(normalise(raw.slice(m.index + m[0].length)));
    }
    for (const c of [...out]) if (c.startsWith('jet ')) out.push(c.slice(4));
    return [...new Set(out)].filter(Boolean);
  }

  /** The first action whose pattern matches a candidate reading, with a `run()` that always returns a promise; null for a question. */
  match(text) {
    for (const candidate of Actions.candidates(text)) {
      for (const a of this.list) {
        const m = a.pattern.exec(candidate);
        if (m && (a.when?.(m) ?? true)) return { name: a.name, text: candidate, run: () => Promise.resolve().then(() => a.run(m, candidate)) };
      }
    }
    return null;
  }
}
