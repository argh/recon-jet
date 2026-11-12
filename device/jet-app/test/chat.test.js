// The chat drawing (ui/chat.js) into the real surface: which side and colour a bubble gets, that
// it is as wide as what it holds and never more than 80% of the list, what is cut and how it is
// marked, the picture in a bubble, the time and the sound mark beside it, the pixels that say
// "selected", and the follow / select / window rules with bubbles of different heights and a
// pending one that the selection steps over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatList } from '../src/modules/ui/chat.js';
import { C } from '../src/modules/ui/style.js';
import { to565 } from '../src/modules/surface/raster.js';
import { stack } from './helpers.js';

const RECT = { x: 2, y: 28, w: 424, h: 198 };   // what the Comms mode hands a screen on the 428x240 panel
const EDGE = RECT.x + RECT.w - 4;               // where a right bubble ends: the scroll bar keeps the last 4 px
const LONG = 'the quick brown fox jumps over the lazy dog and keeps on running far past the end of the row, over the hill, through the wood, across the river and the road, round the barn and back again, twice more for luck, until the light is gone and there is nothing left to chase but its own tail';
const you = (id, text, extra = {}) => ({ id, side: 'right', text, ...extra });
const jet = (id, text, extra = {}) => ({ id, side: 'left', text, ...extra });
const ids = (bubbles) => bubbles.map((b) => b.message.id);

/** The real surface, with every text call recorded and a pixel reader. */
async function surface(t) {
  const st = await stack(); t.after(st.stop);
  const s = st.surface, texts = [], draw = s.text.bind(s);
  s.text = (x, y, str, options) => { const box = draw(x, y, str, options); texts.push({ x, y, str, box, options }); return box; };
  const px = (x, y) => s.raster.px[y * s.raster.pitch + x];
  return { s, texts, px, clear: () => { s.clear(); texts.length = 0; } };
}
function picture(w, h, rgb) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
}
const RED = [255, 0, 0];

test('chat: the wearer is on the right in blue, Jet on the left in slate; a bubble is as wide as its words', async (t) => {
  const { s, texts, px } = await surface(t);
  const list = new ChatList().set([you('a', 'hello there'), jet('b', 'Hello yourself.'), you('c', LONG), jet('d', LONG)]);
  const [a, b, c, d] = list.render(s, RECT);
  assert.deepEqual([a.x + a.w, c.x + c.w], [EDGE, EDGE], 'right bubbles end at the right edge');
  assert.deepEqual([b.x, d.x], [RECT.x, RECT.x], 'left bubbles start at the left edge');
  assert.deepEqual([a.w, b.w], [11 * 6 + 10, 15 * 6 + 10], 'the text and 5 px either side');
  assert.deepEqual([a.h, b.h], [18, 18], 'one row and 3 px above and below');
  assert.ok(c.w <= 336 && d.w <= 336 && c.w > 300, 'a long one stops at 80% of the list');
  assert.ok(c.x - RECT.x >= 84 && EDGE - (d.x + d.w) >= 84, 'the far fifth stays free: that is what makes two sides');
  assert.deepEqual([a, b, c, d].map((m) => px(m.x + 1, m.y + 1)), [C.you, C.jet, C.you, C.jet].map(to565), 'the fill says who');
  assert.deepEqual([[a.x, a.y], [a.x + a.w - 1, a.y], [a.x, a.y + a.h - 1], [a.x + a.w - 1, a.y + a.h - 1]].map(([x, y]) => px(x, y)), [0, 0, 0, 0], 'the corners are off');
  assert.equal(px(a.x - 1, a.y + 5), 0, 'nothing left of a right bubble');
  const hello = texts.find((x) => x.str === 'hello there');
  assert.deepEqual([hello.x, hello.y, hello.options.font, hello.options.colour], [a.x + 5, a.y + 3, s.fonts.small, C.white]);
  assert.equal(d.y + d.h, RECT.y + RECT.h, 'the newest sits on the bottom');
  assert.deepEqual([b.y - (a.y + a.h), c.y - (b.y + b.h), d.y - (c.y + c.h)], [3, 3, 3], 'a 3 px gap');
  assert.deepEqual(new ChatList().layout(s, RECT), [], 'no messages, no bubbles');
});

test('chat: long text is wrapped and cut to four rows (three under a title), the cut marked; a pending tail keeps its end', async (t) => {
  const { s, texts, clear } = await surface(t);
  const list = new ChatList();
  assert.equal(list.cols(s, RECT.w), 54); assert.equal(list.cols(s, RECT.w, { picture: true }), 40);
  const [plain] = list.set([jet('a', LONG)]).render(s, RECT);
  assert.equal(plain.rows.length, 4); assert.ok(plain.rows.every((r) => r.length <= 54));
  assert.equal(plain.rows[0], 'the quick brown fox jumps over the lazy dog and keeps'); assert.ok(plain.rows[3].endsWith('~'), 'more text than rows: the last row says so');
  assert.equal(plain.h, 4 * 12 + 6);
  assert.deepEqual(list.set([jet('a', 'one\ntwo')]).layout(s, RECT)[0].rows, ['one', 'two'], 'a newline starts a row; text that fits is not marked');

  clear();
  const title = 'A title much longer than the bubble could ever hold in one row';
  const [card] = list.set([jet('b', LONG, { title })]).render(s, RECT);
  assert.equal(card.rows.length, 3, 'a title takes one of the rows'); assert.ok(card.rows[2].endsWith('~'));
  assert.equal(card.h, 20 + 3 * 12 + 6); assert.equal(card.w, 336, 'a long title fills the bubble');
  const drawn = texts.find((x) => x.str === title);
  assert.deepEqual([drawn.options.font, drawn.options.colour, drawn.options.maxWidth], [s.fonts.main, C.title, 326], 'the title: one big yellow row, truncated to the bubble');
  assert.equal(texts.find((x) => x.str === card.rows[0]).y, card.y + 3 + 20, 'the text starts under it');
  const [short] = list.set([jet('c', 'ok', { title: 'Fluke 117' })]).layout(s, RECT);
  assert.equal(short.w, 9 * 10 + 10, 'a bubble is as wide as its widest row, the title included');

  const [live] = list.set([jet('d', LONG, { tail: true, pending: true })]).layout(s, RECT);
  assert.equal(live.rows.length, 4); assert.equal(live.rows.at(-1), 'but its own tail', 'tail: the newest words');
  assert.ok(!live.rows.some((r) => r.endsWith('~')));
  assert.deepEqual(list.set([you('e', '')]).layout(s, RECT).map((b) => [b.rows.length, b.h]), [[0, 18]], 'an empty message is still a bubble');
});

test('chat: a picture sits in its bubble with the text beside it', async (t) => {
  const { s, texts, px, clear } = await surface(t);
  const list = new ChatList().set([you('photo', undefined, { image: picture(160, 120, RED) })]);
  const [photo] = list.render(s, RECT);
  assert.deepEqual([photo.w, photo.h, photo.picture], [90, 66, { w: 80, h: 60 }], 'a photo alone: the picture and the padding');
  assert.equal(photo.x + photo.w, EDGE);
  assert.deepEqual([px(photo.x + 5, photo.y + 3), px(photo.x + 84, photo.y + 62)], [to565(RED), to565(RED)], 'drawn at 80x60');
  assert.deepEqual([px(photo.x + 4, photo.y + 30), px(photo.x + 85, photo.y + 30)], [to565(C.you), to565(C.you)], 'framed by the bubble');

  clear();
  const [card] = list.set([jet('card', LONG, { title: 'Fluke 117', image: picture(4, 3, RED) })]).render(s, RECT);
  assert.deepEqual(card.picture, { w: 80, h: 60 }, 'a small picture grows to the box');
  assert.equal(card.h, 66, 'a title and three rows stand beside the picture');
  assert.ok(card.rows.length === 3 && card.rows.every((r) => r.length <= 40), 'the text is narrower beside it');
  assert.equal(px(card.x + 40, card.y + 30), to565(RED));
  assert.deepEqual(texts.filter((x) => x.str === 'Fluke 117' || x.str === card.rows[0]).map((x) => x.x), [card.x + 5 + 80 + 6, card.x + 5 + 80 + 6]);
  const [tall] = list.set([you('tall', 'caption', { image: picture(60, 120, RED) })]).layout(s, RECT);
  assert.deepEqual([tall.picture, tall.w], [{ w: 30, h: 60 }, 30 + 6 + 7 * 6 + 10], 'the aspect is kept');
});

test('chat: the time and the sound mark stand beside the bubble, small and grey', async (t) => {
  const { s, texts, px, clear } = await surface(t);
  const list = new ChatList().set([jet('a', 'Leave it on auto.', { time: '09:44', audio: true }), you('b', 'thanks', { time: '09:45', audio: true }), jet('c', 'Any time.', { time: '09:46' }), you('d', 'no clock')]);
  const [a, b, c, d] = list.render(s, RECT);
  const at = (str) => texts.find((x) => x.str === str), row = (m) => m.y + m.h - 3 - 12;
  assert.deepEqual([at('09:44').x, at('09:44').y, at('09:44').options.align], [a.x + a.w + 6, row(a), 'left'], 'right of a left bubble, level with its last row');
  assert.deepEqual([at('09:45').x, at('09:45').y, at('09:45').options.align], [b.x - 6, row(b), 'right'], 'left of a right bubble');
  assert.ok(['09:44', '09:45', '09:46'].every((x) => at(x).options.font === s.fonts.small && at(x).options.colour === C.dim));
  // the loudspeaker is 7x8, 4 px past the time, centred on the row: its top row is one pixel, in column 3
  const mark = (x, y) => [px(x + 3, y + 2), px(x, y + 4), px(x + 6, y + 4)];
  const lit = [to565(C.dim), to565(C.dim), to565(C.dim)];
  assert.deepEqual(mark(a.x + a.w + 6 + 30 + 4, row(a)), lit, 'the sound mark after the time');
  assert.deepEqual(mark(b.x - 6 - 30 - 4 - 7, row(b)), lit, 'and before it on the other side');
  assert.deepEqual(mark(c.x + c.w + 6 + 30 + 4, row(c)), [0, 0, 0], 'no clip, no mark');
  assert.equal(texts.length, 4 + 3, 'a message without a time draws none');
  assert.equal(px(d.x - 10, row(d) + 6), 0);

  clear(); list.select('a');
  list.render(s, RECT);
  assert.equal(at('09:44').options.colour, C.dim, 'the time is not part of the selected bar');
});

test('chat: the selected bubble is a filled green bar with black text; its picture stays a picture', async (t) => {
  const { s, texts, px, clear } = await surface(t);
  const list = new ChatList().set([jet('card', 'body', { title: 'Fluke 117', image: picture(96, 72, RED) }), you('said', 'thanks')]);
  list.select('card');
  let [card, said] = list.render(s, RECT);
  assert.deepEqual([card.selected, said.selected], [true, false]);
  assert.deepEqual([px(card.x + 1, card.y + 1), px(said.x + 1, said.y + 1)], [to565(C.ok), to565(C.you)]);
  assert.ok(texts.filter((x) => ['Fluke 117', 'body'].includes(x.str)).every((x) => x.options.colour === C.black), 'black on the bar, title included');
  assert.equal(px(card.x + 40, card.y + 30), to565(RED));
  clear(); list.follow();
  [card] = list.render(s, RECT);
  assert.equal(px(card.x + 1, card.y + 1), to565(C.jet));
  assert.equal(texts.find((x) => x.str === 'Fluke 117').options.colour, C.title);
  clear();
  list.set([you('live', 'listening...', { colour: C.ok, pending: true })]).render(s, RECT);
  assert.equal(texts.find((x) => x.str === 'listening...').options.colour, C.ok, 'a message may colour its text');
});

test('chat: follows the newest until the wearer moves; whole bubbles only; a pending bubble is never selected', async (t) => {
  const { s, px, clear } = await surface(t);
  // heights 18, 54, 66, 18, 54, 66, 18 (+ 3 px gaps): the newest four are 165 px, a fifth (54) would not fit in 198
  const seven = () => [you('m1', 'one'), jet('m2', LONG), you('m3', '', { image: picture(160, 120, RED) }), you('m4', 'four'), jet('m5', LONG), you('m6', '', { image: picture(160, 120, RED) }), jet('m7', 'seven')];
  const list = new ChatList().set(seven());
  const shown = () => ids(list.layout(s, RECT));
  assert.equal(list.following, true); assert.equal(list.selected, null);
  assert.deepEqual(shown(), ['m4', 'm5', 'm6', 'm7'], 'the newest that fit whole');
  assert.equal(list.layout(s, RECT).at(-1).y + 18, RECT.y + RECT.h, 'bottom-aligned');
  list.move(1);
  assert.equal(list.following, true, 'already at the newest: a move towards it is nothing');
  list.move(-1);
  assert.equal(list.selected.id, 'm7', 'the first move away selects the newest');
  list.move(-1); list.move(-1); list.move(-1);
  assert.equal(list.selected.id, 'm4'); assert.deepEqual(shown(), ['m4', 'm5', 'm6', 'm7'], 'moving inside the window does not scroll');
  list.move(-1);
  assert.equal(list.selected.id, 'm3'); assert.deepEqual(shown(), ['m3', 'm4', 'm5'], 'past its edge the window comes along, by whole bubbles');
  clear(); list.render(s, RECT);
  assert.equal(px(RECT.x + RECT.w - 2, RECT.y), to565(C.faint), 'more messages than fit: the scroll bar');
  list.set([...list.messages, you('m8', 'eight')]);
  assert.equal(list.selected.id, 'm3'); assert.deepEqual(shown(), ['m3', 'm4', 'm5'], 'a new message does not move a scrolled view');
  list.move(-10);
  assert.equal(list.selected.id, 'm1', 'the oldest clamps');
  list.select('m8'); list.move(1);
  assert.equal(list.following, true, 'moving back past the newest lets go');
  assert.deepEqual(shown(), ['m4', 'm5', 'm6', 'm7', 'm8'], 'and the window is back on it');
  list.select('nope');
  assert.equal(list.following, true, 'an unknown id selects nothing');
  list.select('m2'); list.follow();
  assert.equal(list.selected, null, 'follow() lets go');
  list.select('m2'); list.set(list.messages.filter((m) => m.id !== 'm2'));
  assert.equal(list.following, true, 'a selection whose message is gone lets go');

  // a turn in progress: its bubbles are at the bottom, on show, and not for selecting
  list.set([...seven(), you('live:you', 'and then', { pending: true, tail: true }), jet('live:jet', 'thinking...', { pending: true })]);
  assert.deepEqual(shown().slice(-2), ['live:you', 'live:jet']);
  list.move(-1);
  assert.equal(list.selected.id, 'm7', 'the newest real message');
  assert.ok(shown().includes('live:jet') && shown().includes('m7'));
  list.move(1);
  assert.equal(list.following, true, 'down from the newest real message follows again');
  list.select('live:jet');
  assert.equal(list.following, true, 'select() refuses a pending one too');
  list.set([jet('live:jet', 'thinking...', { pending: true })]); list.move(-1);
  assert.equal(list.selected, null, 'nothing but a pending bubble: nothing to select');
});
