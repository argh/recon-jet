// The visual grammar (docs/interaction-design.md): palette, layout constants and text helpers
// shared by the system layer and every mode. Colour carries meaning: green = selected/active/ok,
// yellow = title/attention, red = problem, grey = hint.

export const C = { white: 0xffffff, dim: 0xa0a0a0, faint: 0x404040, title: 0xffff00, ok: 0x00ff80, warn: 0xffa000, bad: 0xff4040, panel: 0x101820, black: 0x000000 };
export const MARGIN = 6;
export const STRIP_H = 10;   // the system status strip along the top (ui.setStrip)
export const TOP = STRIP_H + 4;   // first free row under the strip

/**
 * Greedy word wrap for a monospace font: `cols` characters per line; words longer than a line
 * are broken; newlines in the text start a new line.
 * @returns {string[]}
 */
export function wrapWords(text, cols) {
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    let cur = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > cols) { if (cur) { lines.push(cur); cur = ''; } lines.push(word.slice(0, cols)); word = word.slice(cols); }
      if (!cur) cur = word;
      else if (cur.length + 1 + word.length <= cols) cur += ' ' + word;
      else { lines.push(cur); cur = word; }
    }
    lines.push(cur);
  }
  while (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** The hint line along the bottom of the panel, in the small font (its row is cleared first, so an overlay's hint replaces the mode's). */
export function hint(s, text, colour = C.dim) {
  const { small } = s.fonts, y = s.height - small.height - 2;
  s.fillRect(0, y, s.width, small.height + 2, C.black);
  s.text(s.width / 2, y, text, { font: small, colour, align: 'center', maxWidth: s.width - 2 * MARGIN });
}

/** A heading in the big font at the top left, with an optional right-aligned value (the clock). */
export function heading(s, title, right) {
  const { main } = s.fonts;
  s.text(MARGIN, TOP, title, { font: main, colour: C.title });
  if (right) s.text(s.width - MARGIN, TOP, right, { font: main, colour: C.white, align: 'right' });
  s.line(0, TOP + main.height + 2, s.width, TOP + main.height + 2, C.faint);
}

/** A "label ......... value" row in the small font; returns the next row's y. */
export function row(s, y, label, value, colour = C.white) {
  const { small } = s.fonts;
  s.text(MARGIN, y, label, { font: small, colour: C.dim });
  s.text(s.width - MARGIN, y, value, { font: small, colour, align: 'right', maxWidth: s.width - 2 * MARGIN - 80 });
  return y + small.height + 1;
}

/** Wrapped paragraph: big font when it fits in `h` pixels, small otherwise; returns rows drawn. */
export function paragraph(s, x, y, w, h, text, { colour = C.white } = {}) {
  const { main, small } = s.fonts;
  let font = main, rows = wrapWords(text, Math.floor(w / main.width));
  if (rows.length * main.height > h) { font = small; rows = wrapWords(text, Math.floor(w / small.width)); }
  const max = Math.max(0, Math.floor(h / font.height));
  rows.slice(0, max).forEach((r, i) => s.text(x, y + i * font.height, r, { font, colour }));
  return Math.min(rows.length, max);
}

/** A screen title with the wizard progress ("pad calibration  2 of 3") while the wizard runs. */
export const stepTitle = (title, wizard) => (wizard ? `${title}  ${wizard.n} of ${wizard.of}` : title);
