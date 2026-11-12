// Chat: a conversation drawn the way a phone draws one, the third list box of the house grammar
// (next to the Chooser and the card tiles).
//
// `ChatList` lays messages out as bubbles: the wearer's on the right in blue (`C.you`), the
// other party's on the left in slate (`C.jet`), so who said what is read from where the block
// sits before a word of it is. A bubble is as wide as its text, up to 80% of the list: the free
// fifth on the far side is what makes the two sides two sides, and it is where the time (small,
// grey) and the "this one has sound" mark go, level with the bubble's last row, costing no row
// of their own. A picture sits at the left of its bubble with the title and the text beside it;
// a title (a card) is one big-font row in yellow. Long text is cut to four rows (three under a
// title) and marked `~`: the list is for finding a message, opening it is for reading it. The
// selected bubble is the Chooser's selected row at bubble size: filled green, black text.
//
// It is a view helper: the messages are handed in (`set`), the only state here is the selection
// and the window (list.js: it follows the newest until the wearer moves). A `pending` message
// (a turn still being heard or answered) is shown but stepped over by the selection: there is
// nothing to open yet.
import { C, wrapWords } from './style.js';
import { ListWindow, fit, scrollBar } from './list.js';
import { parseIcon } from '../surface/icons.js';

const PAD = { x: 5, y: 3 };       // inside a bubble
const GAP = 3;                    // between bubbles
const BAR = 4;                    // the right edge kept free for the scroll bar
const SHARE = 0.8;                // of the list's width a bubble may take
const PICTURE = { w: 80, h: 60 }; // the picture box in a bubble (4:3; a title and three rows stand beside it)
const ROWS = 4;                   // small-font rows of text in a bubble (a title takes one)
const BESIDE = 6;                 // between the picture and its text, and between a bubble and its time
const SOUND = parseIcon([         // a loudspeaker: the message can be played back
  '...#...',
  '..##.#.',
  '####..#',
  '####..#',
  '####..#',
  '####..#',
  '..##.#.',
  '...#...',
]);

/**
 * @typedef {{width: number, height: number, data: Uint8Array}} Image
 * @typedef {object} Message
 * @property {string} id
 * @property {'left'|'right'} side  right: the wearer; left: the other party
 * @property {string} [title]  big font, yellow, one row, truncated: what makes a bubble a card
 * @property {string} [text]  small font, wrapped, cut to the row budget
 * @property {Image|null} [image]
 * @property {string} [time]  small and grey, outside the bubble
 * @property {boolean} [audio]  the sound mark, next to the time
 * @property {number} [colour]  of the text (default white)
 * @property {boolean} [tail]  show the last rows instead of the first (text still being written)
 * @property {boolean} [pending]  not a message yet: shown, never selected
 * @typedef {{x: number, y: number, w: number, h: number}} Rect
 * @typedef {{message: Message, x: number, y: number, w: number, h: number, rows: string[], picture: {w: number, h: number}|null, room: number, selected: boolean}} Bubble  room: px its text column has
 */

export class ChatList {
  #window = new ListWindow({ anchor: 'end', gap: GAP, selectable: (m) => !m.pending });

  /** Hand in the messages (oldest first). A selection whose message is gone lets go. */
  set(messages) { this.#window.set(messages); return this; }
  /** @returns {Message[]} */
  get messages() { return this.#window.items; }

  /** @returns {Message|null} the selected message; null while following */
  get selected() { return this.#window.selected; }
  /** Nothing selected: the window stays on the newest. */
  get following() { return this.#window.following; }
  /** Let go of the selection and return to the newest. */
  follow() { this.#window.follow(); }
  /** Select the message with this id (no-op when absent or pending). */
  select(id) { this.#window.select(id); }
  /** Move the selection by `d` messages: up from following selects the newest, down past it follows again, the oldest clamps. */
  move(d) { this.#window.move(d); }

  /** Small-font columns a bubble's text has in a `width` px list. */
  cols(s, width, { picture = false } = {}) { return Math.max(1, Math.floor((this.#inner(width) - (picture ? PICTURE.w + BESIDE : 0)) / s.fonts.small.width)); }
  #inner(width) { return Math.floor((width - BAR) * SHARE) - 2 * PAD.x; }

  /** A message's rows (wrapped, cut to the budget, a cut marked `~`), its picture size and the bubble's size: no wider than what it holds. */
  #measure(s, message, width) {
    const { main, small } = s.fonts, { title, text, image, tail } = message;
    const picture = image ? fit(image, PICTURE) : null, room = this.#inner(width) - (picture ? picture.w + BESIDE : 0);
    const cols = Math.max(1, Math.floor(room / small.width)), max = ROWS - (title ? 1 : 0);
    const all = text ? wrapWords(text, cols) : [];
    const rows = tail ? all.slice(-max) : all.slice(0, max);
    if (!tail && all.length > max) rows[max - 1] = `${rows[max - 1].slice(0, cols - 1)}~`;
    const words = Math.max(title ? Math.min(room, s.measureText(title, { font: main }).w) : 0, ...rows.map((r) => r.length * small.width));
    const w = (picture ? picture.w + (words ? BESIDE : 0) : 0) + (picture ? words : Math.max(words, small.width)) + 2 * PAD.x;
    const h = Math.max(picture?.h ?? 0, (title ? main.height : 0) + rows.length * small.height, small.height) + 2 * PAD.y;
    return { rows, picture, room, w, h };
  }

  /**
   * Where the bubbles go: whole bubbles only, bottom-aligned, the selected one always among them.
   * @param {object} s the surface (fonts) @param {Rect} rect @returns {Bubble[]} top to bottom
   */
  layout(s, rect) {
    const memo = new Map(), m = (message) => memo.get(message) ?? memo.set(message, this.#measure(s, message, rect.w)).get(message);
    return this.#window.place(rect, (message) => m(message).h).map(({ item, y, h, selected }) => {
      const { rows, picture, room, w } = m(item);
      return { message: item, x: item.side === 'right' ? rect.x + rect.w - BAR - w : rect.x, y, w, h, rows, picture, room, selected };
    });
  }

  /** Draw the conversation into `rect` (the caller's clear is the background). @returns {Bubble[]} what was drawn */
  render(s, rect) {
    const { main, small } = s.fonts, bubbles = this.layout(s, rect);
    for (const { message, x, y, w, h, rows, picture, room, selected } of bubbles) {
      const right = message.side === 'right', ink = (colour) => (selected ? C.black : colour);
      s.fillRect(x, y, w, h, selected ? C.ok : right ? C.you : C.jet);
      for (const [cx, cy] of [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]]) s.fillRect(cx, cy, 1, 1, C.black);   // the corners off: a bubble, not a table row
      let tx = x + PAD.x, ty = y + PAD.y;
      if (picture) { s.blitImage(message.image, tx, ty, picture); tx += picture.w + BESIDE; }
      if (message.title) { s.text(tx, ty, message.title, { font: main, colour: ink(C.title), maxWidth: room }); ty += main.height; }
      rows.forEach((r, i) => s.text(tx, ty + i * small.height, r, { font: small, colour: ink(message.colour ?? C.white) }));
      // the time and the sound mark, in the free fifth beside the bubble, level with its last row
      const my = y + h - PAD.y - small.height, dir = right ? -1 : 1;
      let mx = right ? x - BESIDE : x + w + BESIDE;
      if (message.time) { const box = s.text(mx, my, message.time, { font: small, colour: C.dim, align: right ? 'right' : 'left' }); mx += dir * (box.w + 4); }
      if (message.audio) s.icon(right ? mx - SOUND.w : mx, my + ((small.height - SOUND.h) >> 1), SOUND, C.dim);
    }
    const all = this.messages;
    if (bubbles.length) scrollBar(s, rect, all.indexOf(bubbles[0].message), all.indexOf(bubbles.at(-1).message), all.length);
    return bubbles;
  }
}
