// The card drawing shared by the two modes, into the real surface: tile sizes and where the
// tiles land, the follow / select / window rules for both anchors, what is cut and how it is
// marked, the pixels that say "selected", and the detail view's flow around the picture and its
// scroll clamp, and the `fill` picture of an opened photo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardList, DetailView } from '../src/modules/ui/cards.js';
import { C } from '../src/modules/ui/style.js';
import { to565 } from '../src/modules/surface/raster.js';
import { stack } from './helpers.js';

const RECT = { x: 2, y: 28, w: 424, h: 198 };   // a list's share of the 428x240 panel
const full = (id) => ({ id, title: `card ${id}`, lines: ['first line', 'second line'] });
const six = () => ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(full);
const ids = (tiles) => tiles.map((t) => t.card.id);

/** The real surface, with every text call recorded and a pixel reader. */
async function surface(t) {
  const st = await stack(); t.after(st.stop);
  const s = st.surface, texts = [], draw = s.text.bind(s);
  s.text = (x, y, str, options) => { const box = draw(x, y, str, options); texts.push({ x, y, str, box, options, shown: s.measureText(str, options).chars.join('') }); return box; };
  const px = (x, y) => s.raster.px[y * s.raster.pitch + x];
  return { s, texts, px, clear: () => { s.clear(); texts.length = 0; } };
}
/** A picture: `top` colour over the upper half, `bottom` over the lower. */
function picture(w, h, top, bottom = top) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...(i < w * (h >> 1) ? top : bottom), 255], i * 4);
  return { width: w, height: h, data };
}
const RED = [255, 0, 0], BLUE = [0, 0, 255];

test('cards: a tile is as tall as what it holds; four full tiles fill the panel exactly', async (t) => {
  const { s } = await surface(t);
  const list = new CardList().set([
    { id: 'line', lines: ['you: one line'], dim: true },
    { id: 'titled', title: 'Title', lines: ['a', 'b'] },
    { id: 'bare', title: 'Title only' },
    { id: 'thumb', title: 'With a picture', thumb: picture(96, 72, RED) },
    { id: 'three', lines: ['a', 'b', 'c', 'd'] },
  ]);
  const tiles = list.layout(s, { ...RECT, h: 400 });
  assert.deepEqual(tiles.map((x) => [x.card.id, x.h]), [['line', 16], ['titled', 48], ['bare', 24], ['thumb', 48], ['three', 40]]);
  assert.deepEqual(tiles.map((x) => [x.x, x.w]), Array(5).fill([2, 420]), 'full width, less the scroll bar edge');
  assert.equal(tiles.at(-1).y + tiles.at(-1).h, RECT.y + 400, 'a following channel is bottom-aligned');
  assert.deepEqual(tiles.slice(1).map((x, i) => x.y - (tiles[i].y + tiles[i].h)), [2, 2, 2, 2], 'a 2 px gap');

  list.set(six());
  const four = list.layout(s, RECT);
  assert.deepEqual(four.map((x) => [x.card.id, x.y, x.h]), [['c3', 28, 48], ['c4', 78, 48], ['c5', 128, 48], ['c6', 178, 48]], 'the newest four, whole tiles only');
  assert.equal(four.at(-1).y + four.at(-1).h, RECT.y + RECT.h);
  assert.deepEqual(new CardList().layout(s, RECT), [], 'no cards, no tiles');
  assert.deepEqual(ids(new CardList().set([full('tall')]).layout(s, { ...RECT, h: 20 })), ['tall'], 'never fewer than one tile');
});

test('cards: a channel follows the newest until the wearer moves; the window holds still around the selection', async (t) => {
  const { s } = await surface(t);
  const list = new CardList({ anchor: 'end' }).set(six());
  const shown = () => ids(list.layout(s, RECT));
  assert.equal(list.following, true); assert.equal(list.selected, null);
  list.move(1);
  assert.equal(list.following, true, 'already at the newest: a move towards it is nothing');
  list.move(-1);
  assert.equal(list.selected.id, 'c6', 'the first move away selects the newest');
  assert.deepEqual(shown(), ['c3', 'c4', 'c5', 'c6']);
  assert.deepEqual(list.layout(s, RECT).map((x) => x.selected), [false, false, false, true]);
  list.move(-1); list.move(-1); list.move(-1);
  assert.equal(list.selected.id, 'c3'); assert.deepEqual(shown(), ['c3', 'c4', 'c5', 'c6'], 'moving inside the window does not scroll');
  list.move(-1);
  assert.equal(list.selected.id, 'c2'); assert.deepEqual(shown(), ['c2', 'c3', 'c4', 'c5'], 'past its edge the window comes along');
  list.move(1);
  assert.equal(list.selected.id, 'c3'); assert.deepEqual(shown(), ['c2', 'c3', 'c4', 'c5'], 'and holds still on the way back');
  list.set([...list.cards, full('c7')]);
  assert.equal(list.selected.id, 'c3'); assert.deepEqual(shown(), ['c2', 'c3', 'c4', 'c5'], 'a new card does not move a scrolled view');
  list.move(-10);
  assert.equal(list.selected.id, 'c1', 'the far end clamps'); assert.deepEqual(shown(), ['c1', 'c2', 'c3', 'c4']);
  list.select('c7');
  assert.deepEqual(shown(), ['c4', 'c5', 'c6', 'c7']);
  list.move(1);
  assert.equal(list.following, true, 'moving back past the newest lets go');
  list.select('nope');
  assert.equal(list.following, true, 'an unknown id selects nothing');
  list.select('c2'); list.follow();
  assert.equal(list.selected, null); assert.deepEqual(shown(), ['c4', 'c5', 'c6', 'c7'], 'follow() re-pins');
  list.select('c2'); list.set(list.cards.filter((c) => c.id !== 'c2'));
  assert.equal(list.following, true, 'a selection whose card is gone lets go');
  list.set([]); list.move(-1);
  assert.equal(list.selected, null, 'nothing to select in an empty list');
});

test('cards: a review list is anchored at the top', async (t) => {
  const { s } = await surface(t);
  const list = new CardList({ anchor: 'start' }).set(six());
  const shown = () => ids(list.layout(s, RECT));
  assert.deepEqual(shown(), ['c1', 'c2', 'c3', 'c4']);
  assert.equal(list.layout(s, { ...RECT, h: 120 })[0].y, RECT.y, 'top-aligned');
  list.move(-1);
  assert.equal(list.following, true);
  list.move(1);
  assert.equal(list.selected.id, 'c1');
  for (let i = 0; i < 4; i++) list.move(1);
  assert.equal(list.selected.id, 'c5'); assert.deepEqual(shown(), ['c2', 'c3', 'c4', 'c5']);
  list.move(5);
  assert.equal(list.selected.id, 'c6'); assert.deepEqual(shown(), ['c3', 'c4', 'c5', 'c6']);
  list.move(-5);
  assert.equal(list.selected.id, 'c1'); assert.deepEqual(shown(), ['c1', 'c2', 'c3', 'c4']);
  list.move(-1);
  assert.equal(list.following, true, 'back past the first lets go');
});

test('cards: what does not fit is cut and marked; the badge keeps its place', async (t) => {
  const { s, texts, clear } = await surface(t);
  const list = new CardList();
  assert.equal(list.cols(s, RECT.w), 68); assert.equal(list.cols(s, RECT.w, { thumb: true }), 58);
  const long = 'the quick brown fox jumps over the lazy dog and keeps on running far past the end of the row';
  list.set([{ id: 'a', title: long, lines: [long, 'third row', 'fourth row'], badge: '12:34' }]);
  const [tile] = list.render(s, RECT);
  assert.equal(tile.rows.length, 2, 'two rows under a title');
  assert.ok(tile.rows.every((r) => r.length <= 68)); assert.equal(tile.rows[0], 'the quick brown fox jumps over the lazy dog and keeps on running far');
  assert.ok(tile.rows[1].endsWith('~'), 'more text than rows: the last row says so');
  const badge = texts.find((x) => x.str === '12:34'), title = texts.find((x) => x.str === long);
  assert.equal(badge.box.x + badge.box.w, tile.x + tile.w - 4, 'right-aligned in the tile');
  assert.ok(title.shown.endsWith('~') && title.shown.length < long.length, 'the title is one truncated row');
  assert.ok(title.box.x + title.shown.length * s.fonts.main.width <= badge.box.x - 6, 'and stops short of the badge');
  assert.equal(title.options.font, s.fonts.main); assert.equal(badge.options.font, s.fonts.small);

  clear();
  list.set([{ id: 'b', lines: [long, long], tail: true }]);
  const [live] = list.render(s, RECT);
  assert.equal(live.rows.length, 3, 'three rows without a title');
  assert.equal(live.rows.at(-1), 'past the end of the row', 'tail: the newest words, uncut');
  assert.ok(!live.rows.some((r) => r.endsWith('~')));

  clear();
  list.set([{ id: 'c', title: 'With a picture', lines: [long], thumb: picture(96, 72, RED) }]);
  const [pic] = list.render(s, RECT);
  assert.ok(pic.rows.every((r) => r.length <= 58), 'the text is narrower beside a thumbnail');
  assert.equal(texts.find((x) => x.str === 'With a picture').x, 2 + 2 + 58 + 6);
});

test('cards: the selected tile is a filled green bar with black text; a quiet tile has no panel', async (t) => {
  const { s, texts, px, clear } = await surface(t);
  const list = new CardList({ anchor: 'start' }).set([
    { id: 'pic', title: 'Picture', lines: ['body'], thumb: picture(96, 72, RED), badge: 'now', colour: C.title },
    { id: 'quiet', lines: ['you: hello'], dim: true },
    { id: 'said', lines: ['Hello yourself.'] },
  ]);
  clear();
  let tiles = list.render(s, RECT);
  const corner = (tile) => px(tile.x + tile.w - 1, tile.y + tile.h - 1);
  assert.deepEqual(tiles.map(corner), [to565(C.panel), 0, to565(C.panel)], 'a card sits on a panel, a quiet line on nothing');
  assert.equal(px(tiles[0].x + 2 + 29, tiles[0].y + 2 + 22), to565(RED), 'the thumbnail is drawn in its box');
  assert.equal(texts.find((x) => x.str === 'Picture').options.colour, C.title, 'the card\'s colour is its title\'s');
  assert.equal(texts.find((x) => x.str === 'you: hello').options.colour, C.dim);
  assert.equal(texts.find((x) => x.str === 'Hello yourself.').options.colour, C.white);
  assert.equal(px(RECT.x + RECT.w - 2, RECT.y), 0, 'everything shows: no scroll bar');

  clear(); list.select('pic');
  tiles = list.render(s, RECT);
  assert.deepEqual(tiles.map(corner), [to565(C.ok), 0, to565(C.panel)]);
  assert.ok(texts.filter((x) => ['Picture', 'body', 'now'].includes(x.str)).every((x) => x.options.colour === C.black), 'black on the bar, badge included');
  assert.equal(px(tiles[0].x + 2 + 29, tiles[0].y + 2 + 22), to565(RED), 'the thumbnail stays a picture');

  clear(); list.set(six()).select('c5');
  tiles = list.render(s, RECT);
  assert.deepEqual(ids(tiles), ['c2', 'c3', 'c4', 'c5']);
  assert.equal(px(RECT.x + RECT.w - 2, RECT.y), to565(C.faint), 'more cards than fit: the scroll bar track');
  assert.equal(px(RECT.x + RECT.w - 2, RECT.y + 100), to565(C.dim), 'and where the window is on it');
});

test('detail: the text flows beside the picture and then under it', async (t) => {
  const { s, texts, px } = await surface(t);
  const view = new DetailView(), words = Array.from({ length: 220 }, (_, i) => `w${i}`).join(' ');
  const at = view.render(s, RECT, { title: 'Fluke 117', badge: '12:34', image: picture(96, 72, RED, BLUE), paragraphs: [{ text: 'pinned', colour: C.title }, '', words] });
  const body = RECT.y + s.fonts.main.height + 6, rows = texts.filter((x) => x.options.font === s.fonts.small && x.str !== '12:34');
  assert.equal(texts.find((x) => x.str === 'Fluke 117').options.colour, C.title);
  assert.deepEqual([px(8 + 80, body + 30), px(8 + 80, body + 90)], [to565(RED), to565(BLUE)], 'the picture fills its 160x120 box');
  assert.equal(px(8 + 165, body + 30), 0, 'and no more');
  assert.equal(at.visible, 14); assert.equal(at.scroll, 0);
  assert.deepEqual([rows[0].str, rows[0].options.colour, rows[1].str], ['pinned', C.title, ''], 'each paragraph starts a row; an empty one is a blank row');
  const beside = rows.filter((r) => r.y < body + 11 * 12), under = rows.filter((r) => r.y >= body + 11 * 12);
  assert.equal(beside.length, 11); assert.ok(beside.every((r) => r.x === 8 + 160 + 8 && r.str.length <= 40), 'eleven short rows right of the picture');
  assert.equal(under.length, 3); assert.ok(under.every((r) => r.x === 8 && r.str.length > 40 && r.str.length <= 68), 'full-width rows under it');
  assert.ok(words.startsWith(rows.slice(2).map((r) => r.str).join(' ')), 'no word lost or reordered across the two widths');
  assert.equal(at.max, at.rows - 14);
});

test('detail: scrolls by pages, clamps at both ends, and a picture scrolled half out stays inside the view', async (t) => {
  const { s, texts, px, clear } = await surface(t);
  const view = new DetailView(), lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const body = RECT.y + s.fonts.main.height + 6, first = () => texts.find((x) => x.y === body && x.options.font === s.fonts.small).str;
  assert.deepEqual(view.render(s, RECT, { title: 'T', paragraphs: lines }), { scroll: 0, max: 26, rows: 40, visible: 14 });
  assert.equal(first(), 'line 0');
  assert.equal(px(RECT.x + RECT.w - 2, body), to565(C.dim), 'the scroll bar, at the top');
  view.scroll(1); clear();
  assert.equal(view.render(s, RECT, { title: 'T', paragraphs: lines }).scroll, 12, 'a page keeps two rows of overlap');
  assert.equal(first(), 'line 12');
  view.scroll(5); clear();
  assert.equal(view.render(s, RECT, { title: 'T', paragraphs: lines }).scroll, 26, 'clamped to the end');
  assert.equal(texts.filter((x) => x.options.font === s.fonts.small).at(-1).str, 'line 39');
  view.scroll(-1); clear();
  assert.equal(view.render(s, RECT, { title: 'T', paragraphs: lines }).scroll, 14, 'the clamp is where the next swipe starts from');
  view.scroll(-99); clear();
  assert.equal(view.render(s, RECT, { title: 'T', paragraphs: lines }).scroll, 0);
  view.scroll(2); view.reset(); clear();
  assert.equal(view.render(s, RECT, { title: 'T', paragraphs: lines }).scroll, 0, 'reset: back to the top');
  assert.deepEqual(view.render(s, RECT, { title: 'T', paragraphs: ['short'] }), { scroll: 0, max: 0, rows: 1, visible: 14 }, 'content that fits does not scroll');

  // a short view: 6 rows, so a page is 4 rows = 48 px of the 120 px picture (red over blue)
  const small = { ...RECT, h: 98 }, pic = picture(96, 72, RED, BLUE);
  clear(); view.render(s, small, { title: 'T', image: pic, paragraphs: lines });
  view.scroll(1); clear();
  assert.equal(view.render(s, small, { title: 'T', image: pic, paragraphs: lines }).scroll, 4);
  assert.deepEqual([px(8 + 80, body + 5), px(8 + 80, body + 30), px(8 + 80, body + 71)], [to565(RED), to565(BLUE), to565(BLUE)], 'the lower part of the picture, from the top of the body');
  assert.equal(px(8 + 80, body + 73), 0, 'ending where the picture ends');
  assert.equal(px(8 + 80, body - 3), 0, 'nothing drawn over the title row');
  assert.equal(first(), 'line 4');
  view.scroll(3); clear();
  view.render(s, small, { title: 'T', image: pic, paragraphs: lines });
  assert.equal(px(8 + 80, body + 5), 0, 'scrolled past: the picture is gone and the text has the width');
  assert.equal(texts.find((x) => x.y === body && x.options.font === s.fonts.small).x, 8);
});

test('detail: with `fill` the picture is as tall as the view and the text keeps the column beside it', async (t) => {
  const { s, texts, px } = await surface(t);
  const view = new DetailView({ fill: true }), words = Array.from({ length: 150 }, (_, i) => `w${i}`).join(' ');
  const at = view.render(s, RECT, { title: 'photo', image: picture(160, 120, RED, BLUE), paragraphs: [words] });
  const body = RECT.y + s.fonts.main.height + 6, rows = texts.filter((x) => x.options.font === s.fonts.small);
  assert.deepEqual([px(8, body), px(8 + 218, body + 163)], [to565(RED), to565(BLUE)], '160x120 grown to 219x164: the fourteen rows under the title');
  assert.deepEqual([px(8 + 219, body + 80), px(8 + 100, body + 164)], [0, 0], 'and no more');
  assert.equal(at.visible, 14);
  assert.ok(rows.slice(0, 14).every((r) => r.x === 8 + 219 + 8 && r.str.length <= 30), 'thirty columns right of it');
  assert.ok(words.startsWith(rows.map((r) => r.str).join(' ')));
  assert.deepEqual(new DetailView({ fill: true }).render(s, RECT, { title: 'photo', image: picture(160, 120, RED), paragraphs: [''] }), { scroll: 0, max: 0, rows: 14, visible: 14 }, 'a picture alone is exactly a page: nothing to scroll');
  const wide = new DetailView({ fill: true }); s.clear();
  wide.render(s, RECT, { title: 'wide', image: picture(300, 60, RED) });
  assert.deepEqual([px(8 + 225, body + 44), px(8 + 226, body + 20), px(8 + 100, body + 45)], [to565(RED), 0, 0], 'a wide picture stops at 55% of the width');
});
