// Text helpers for a fixed-width grid.

/** Word-wrap `text` into lines of at most `cols` characters (long words are split). */
export function wrap(text, cols) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    const start = lines.length;
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (word.length > cols) { if (cur) lines.push(cur); for (let i = 0; i < word.length; i += cols) lines.push(word.slice(i, i + cols)); cur = ''; continue; }
      if (cur && cur.length + 1 + word.length > cols) { lines.push(cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur || lines.length === start) lines.push(cur);
  }
  return lines;
}

/** `left` and `right` on one row, padded apart to `cols`. */
export function spread(left, right, cols) {
  const gap = cols - left.length - right.length;
  return gap > 0 ? left + ' '.repeat(gap) + right : (left + ' ' + right).slice(0, cols);
}

export function truncate(text, cols) { return text.length > cols ? text.slice(0, cols - 1) + '~' : text; }
