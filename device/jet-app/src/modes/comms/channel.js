// Channel: where the conversation with Jet is reviewed, as a view over the `feed` model
// (docs/agent.md). The conversation itself happens from anywhere; this screen is its record,
// drawn as a message thread (ui/chat.js): the wearer on the right - what was `heard`, and a
// `photo` the camera took for it - Jet on the left - what it `said`, and a `card` it put on the
// display, titled. Newest at the bottom, the thread following the newest until the wearer
// selects. While a turn runs, its live state is the pending bubbles under the thread (listening
// and the partial transcript on the right, thinking and the answer as it streams on the left)
// until the operator has filed them in the feed - derived from the feed and the voice state at
// each render, so entering mid-turn draws the same thing.
//
// One button, read by where you are (the pad's tap is the front button on this device). While
// a turn runs, front is the talk button (ends the capture, or barges in) and rear cancels.
// Otherwise: following the newest, front = talk; swipe up/down selects; front on a selected
// bubble opens it - the whole text, the picture as large as the panel allows, and its stored
// audio replayed once (`operator.replay`); front inside replays it again, swipe scrolls. Rear
// steps back: close the open item (the selection stays), let go of the selection, and at the
// root it is not consumed (the registry ascends). A Comms screen module (`provides:
// 'CommsScreen'`): it subscribes to the feed and to the voice state only while showing.
import { Schema } from '@versionzero/module-manager';
import { C, hint } from '../../modules/ui/style.js';
import { ChatList } from '../../modules/ui/chat.js';
import { DetailView } from '../../modules/ui/cards.js';

const s = Schema.create;
const SIDE = { heard: 'right', photo: 'right', said: 'left', card: 'left' };   // the camera is the wearer's: a photo is theirs
const NAME = { heard: 'you', photo: 'photo', said: 'Jet', card: 'card' };      // an open item's heading (a card's own title first)
const clock = (t) => new Date(t).toTimeString().slice(0, 5);

/** A feed item as a chat message. */
const message = (item) => ({ id: item.id, side: SIDE[item.kind] ?? 'left', title: item.kind === 'card' ? item.title ?? NAME.card : undefined, text: item.body, image: item.image, time: clock(item.t), audio: !!item.audio });

export class ChannelScreen {
  static moduleInfo = {
    name: 'channel-screen',
    provides: 'CommsScreen',
    schema: s()
      .property('feed', s('Feed').meta('internal', true))
      .property('operator', s('Operator').meta('internal', true))
      .property('voice', s('Voice').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true)),
  };
  feed; operator; voice; ui;

  id = 'channel'; label = 'Channel';
  #list = new ChatList();
  #detail = new DetailView({ fill: true });
  /** @type {string|null} the feed item open in the detail view */ #open = null;
  #onFeed = () => { this.#sync(); this.ui.requestRender(); };   // a new item, or one that gained its audio
  #onVoice = () => this.ui.requestRender();   // partial transcripts and tokens are repainted by the voice module itself

  enter() {
    this.#open = null; this.#list.follow();
    this.feed.on('post', this.#onFeed);       // we know we are showing: our models tell us when to repaint
    this.feed.on('change', this.#onFeed);
    this.voice.on('state', this.#onVoice);
    this.#sync();
  }
  leave() {
    this.feed.off('post', this.#onFeed);
    this.feed.off('change', this.#onFeed);
    this.voice.off('state', this.#onVoice);
  }

  /** The item open in the detail view; null at the thread (or when the ring has dropped it). */
  get opened() { return this.#open ? this.feed.get(this.#open) : null; }
  /** The selected bubble's feed item; null while following. */
  get selected() { const m = this.#list.selected; return m ? this.feed.get(m.id) : null; }

  /** The thread as it stands: the feed, then the running turn. Nothing of the model is kept here but what the list is showing. */
  #sync() { this.#list.set([...this.feed.items.map(message), ...this.#live()]); }

  /**
   * The running turn as pending bubbles: whatever of it the feed does not hold yet. The
   * operator files `heard` when the transcript is final and `said` when the answer is whole,
   * so the live transcript and the live answer each give way to their item.
   */
  #live() {
    const { state, transcript = '', answer } = this.voice;
    if (state === 'idle') return [];
    const you = (text, colour) => ({ id: 'live:you', side: 'right', text, colour, tail: true, pending: true });
    const jet = (text, colour) => ({ id: 'live:jet', side: 'left', text, colour, tail: true, pending: true });
    const spoken = this.feed.items.filter((x) => x.kind === 'heard' || x.kind === 'said');   // a photo or a card may land between the two
    if (answer) return spoken.at(-1)?.kind === 'said' ? [] : [jet(answer)];
    if (state === 'listening') return [you(transcript || 'listening...', transcript ? undefined : C.ok)];
    if (state !== 'thinking') return [];
    const filed = spoken.findLast((x) => x.kind === 'heard')?.body === transcript.trim();
    return [...(transcript && !filed ? [you(transcript)] : []), jet('thinking...', C.title)];
  }

  onGesture(g) {
    const open = this.opened, busy = this.voice.state !== 'idle';
    switch (g) {
      case 'press:front': case 'press:tap': {
        const item = open ?? (busy ? null : this.selected);
        if (busy || !item) { this.operator.talk(); return true; }
        if (!open) { this.#open = item.id; this.#detail.reset(); }
        this.operator.replay(item.id);   // on opening, and again on each press inside; an item without a clip is the operator's to refuse
        break;
      }
      case 'swipe:up': case 'swipe:down': { const d = g === 'swipe:up' ? -1 : 1; if (open) this.#detail.scroll(d); else this.#list.move(d); break; }
      case 'swipe:left': case 'swipe:right': if (!open) return false; break;   // an open item is a place of its own: the tabs are a step back
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

  render(s, rect) {
    const { state } = this.voice, busy = state === 'listening' ? 'front: done   rear: cancel' : state !== 'idle' ? 'front: interrupt   rear: cancel' : null;
    const open = this.opened;
    if (open) {
      this.#detail.render(s, rect, { title: open.title ?? NAME[open.kind] ?? NAME.card, badge: clock(open.t), image: open.image, paragraphs: [open.body ?? ''] });
      return hint(s, busy ?? `${open.audio ? 'front: replay   ' : ''}swipe: scroll   rear: close`);
    }
    this.#sync();
    const any = this.#list.messages.length > 0;
    if (any) this.#list.render(s, rect);
    else s.text(s.width / 2, rect.y + rect.h / 2 - s.fonts.main.height, 'press front = talk', { font: s.fonts.main, colour: C.dim, align: 'center' });
    hint(s, busy ?? (!this.voice.configured ? 'voice: not configured' : !any ? 'front: talk' : this.#list.following ? 'front: talk   swipe: select' : 'front: open   rear: newest'));
  }
}
