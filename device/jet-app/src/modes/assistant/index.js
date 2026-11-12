// Assistant mode: the conversation with Jet, as a view over the `feed` model (docs/agent.md).
// The conversation itself happens from anywhere (the operator answers a wake-word question
// wherever the wearer is, and nothing here switches screens for it); this mode is where it is
// held by button and where it is reviewed, drawn as a message thread (ui/chat.js): the wearer on
// the right - what was `heard`, and a `photo` the camera took for it - Jet on the left - what it
// `said`, and a `card` it put on the display, titled. Newest at the bottom, the thread
// following the newest until the wearer selects. A turn's live state is the pending bubbles
// under the thread (listening and the partial transcript on the right, thinking and the answer
// as it streams on the left) until the operator has filed them in the feed - derived from the
// feed and the voice state at each render, so entering mid-turn draws the same thing.
//
// Gestures. Front is the talk button: `operator.talk()` (again ends the capture, or barges in).
// Swipe up/down selects a message; swipe right (or front) opens the selected one - the whole
// text, the picture as large as the panel allows, its stored audio replayed once
// (`operator.replay`); inside, front replays it again, up/down scrolls, swipe left closes. Rear
// steps back: close the open message (the selection stays), let go of the selection, and at the
// root it is not consumed (the registry ascends). While a turn runs both buttons are the
// turn's: front talks, rear cancels.
//
// With the operator's `wake` off, a wake-word question is answered by voice's one-shot
// responder, which files nothing: the mode raises itself for such a question (and for no
// other), and the answer stays as the pending bubbles until the next turn replaces it.
//
// It subscribes to the feed and to the voice state only while showing; the `question` listener
// is the one thing it hears from elsewhere.
import { Schema } from '@versionzero/module-manager';
import { C, hint, panel } from '../../modules/ui/style.js';
import { ChatList } from '../../modules/ui/chat.js';
import { DetailView } from '../../modules/ui/cards.js';

const s = Schema.create;
const SIDE = { heard: 'right', photo: 'right', said: 'left', card: 'left' };   // the camera is the wearer's: a photo is theirs
const NAME = { heard: 'you', photo: 'photo', said: 'Jet', card: 'card' };      // an open item's heading (a card's own title first)
const clock = (t) => new Date(t).toTimeString().slice(0, 5);

/** A feed item as a chat message. */
const message = (item) => ({ id: item.id, side: SIDE[item.kind] ?? 'left', title: item.kind === 'card' ? item.title ?? NAME.card : undefined, text: item.body, image: item.image, time: clock(item.t), audio: !!item.audio });

export class AssistantMode {
  static moduleInfo = {
    name: 'assistant-mode',
    schema: s()
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('feed', s('Feed').meta('internal', true))
      .property('operator', s('Operator').meta('internal', true))
      .property('voice', s('Voice').meta('internal', true)),
  };
  modes; ui; feed; operator; voice;

  id = 'assistant'; label = 'Assistant'; spoken = ['radio', 'jet', 'comms'];
  #current = false;
  #list = new ChatList();
  #detail = new DetailView({ fill: true });
  /** @type {string|null} the feed item open in the detail view */ #open = null;
  #onFeed = () => { this.#sync(); this.ui.requestRender(); };   // a new item, or one that gained its audio
  #onVoice = () => this.ui.requestRender();   // partial transcripts and tokens are repainted by the voice module itself

  async start() {
    this.modes.register(this);   // before any await: registration order is the switcher's order
    // "heya jet, <question>" that no responder took (the operator's `wake` is off): the answer
    // is nowhere but in the voice state, so it is shown here. A turn the operator answers
    // switches nothing.
    this.voice.on('question', (q) => { if (q.wake && !q.responder && !this.#current) this.modes.switchTo(this.id); });
  }

  enter() {
    this.#current = true; this.#open = null; this.#list.follow();
    this.feed.on('post', this.#onFeed);       // we know we are showing: our models tell us when to repaint
    this.feed.on('change', this.#onFeed);
    this.voice.on('state', this.#onVoice);
    this.#sync();
  }
  leave() {
    this.#current = false;
    this.feed.off('post', this.#onFeed);
    this.feed.off('change', this.#onFeed);
    this.voice.off('state', this.#onVoice);
  }

  /** The item open in the detail view; null at the thread (or when the ring has dropped it). */
  get opened() { return this.#open ? this.feed.get(this.#open) : null; }
  /** The selected bubble's feed item; null while following. */
  get selected() { const m = this.#list.selected; return m ? this.feed.get(m.id) : null; }

  /** The thread as it stands: the feed, then the turn. Nothing of the model is kept here but what the list is showing. */
  #sync() { this.#list.set([...this.feed.items.map(message), ...this.#live()]); }

  /**
   * The turn as pending bubbles: whatever of it the feed does not hold. The operator files
   * `heard` when the transcript is final and `said` when the answer is whole, so the live
   * transcript and the live answer each give way to their item. A turn it did not take is
   * never filed: its transcript and answer stay, idle too, until the next turn clears them.
   */
  #live() {
    const { state, transcript = '', answer } = this.voice;
    const you = (text, colour) => ({ id: 'live:you', side: 'right', text, colour, tail: true, pending: true });
    const jet = (text, colour) => ({ id: 'live:jet', side: 'left', text, colour, tail: true, pending: true });
    if (state === 'listening') return [you(transcript || 'listening...', transcript ? undefined : C.ok)];
    const spoken = this.feed.items.filter((x) => x.kind === 'heard' || x.kind === 'said');   // a photo or a card may land between the two
    const at = spoken.findLastIndex((x) => x.kind === 'heard'), filed = at >= 0 && spoken[at].body === transcript.trim();
    const asked = transcript && !filed ? [you(transcript)] : [];
    if (answer) return filed && at < spoken.length - 1 ? [] : [...asked, jet(answer)];
    return state === 'thinking' ? [...asked, jet('thinking...', C.title)] : [];
  }

  /** Open a message: the detail from its top, its sound once (an item without a clip is the operator's to refuse). */
  #show(item) { this.#open = item.id; this.#detail.reset(); this.operator.replay(item.id); }

  onGesture(g) {
    const open = this.opened, item = this.selected, busy = this.voice.state !== 'idle';
    switch (g) {
      case 'press:front': case 'press:tap':   // the pad's tap is the front button on this device
        if (busy || !(open ?? item)) { this.operator.talk(); return true; }
        if (open) this.operator.replay(open.id); else this.#show(item);
        break;
      case 'swipe:up': case 'swipe:down': { const d = g === 'swipe:up' ? -1 : 1; if (open) this.#detail.scroll(d); else this.#list.move(d); break; }
      case 'swipe:right': if (open || !item) return false; this.#show(item); break;
      case 'swipe:left': if (!open) return false; this.#open = null; break;
      case 'press:rear':
        if (busy) { this.operator.cancel(); return true; }
        if (open) this.#open = null;
        else if (!this.#list.following) this.#list.follow();
        else return false;
        break;
      default: return false;
    }
    this.ui.requestRender();
    return true;
  }

  render(s) {
    const rect = panel(s), { state } = this.voice, busy = state === 'listening' ? 'front: done   rear: cancel' : state !== 'idle' ? 'front: interrupt   rear: cancel' : null;
    const open = this.opened;
    if (open) {
      this.#detail.render(s, rect, { title: open.title ?? NAME[open.kind] ?? NAME.card, badge: clock(open.t), image: open.image, paragraphs: [open.body ?? ''] });
      return hint(s, busy ?? `${open.audio ? 'front: replay   ' : ''}up/down: scroll   left: close`);
    }
    this.#sync();
    const messages = this.#list.messages;
    if (messages.length) this.#list.render(s, rect);
    else s.text(s.width / 2, rect.y + rect.h / 2 - s.fonts.main.height, 'press front = talk', { font: s.fonts.main, colour: C.dim, align: 'center' });
    hint(s, busy ?? (!this.voice.configured ? 'voice: not configured'
      : !this.#list.following ? 'right: open   rear: newest'
      : `front: talk${messages.some((m) => !m.pending) ? '   swipe: select' : ''}`));
  }
}
