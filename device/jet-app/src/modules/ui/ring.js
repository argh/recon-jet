// Ring: part of a rectangle's border, as the rectangles to fill. The border is walked clockwise
// from the top left corner (top edge left to right, right edge down, bottom edge back, left
// edge up) and `from`..`to` are fractions of that walk: `ring(r, 2, 0, p)` is a progress border
// filled to `p`, `ring(r, 2, phase, phase + 0.25)` a segment circling it (a span past 1 wraps).
// Pure geometry: what the fraction means (time, an angle) and the colour are the caller's.

/**
 * @param {{x: number, y: number, w: number, h: number}} rect  the border's outer edge
 * @param {number} thick  its thickness, inwards
 * @param {number} from  0..1 along the walk (taken modulo 1)
 * @param {number} to  from..from+1; clamped to one lap
 * @returns {{x: number, y: number, w: number, h: number}[]} at most five, none empty
 */
export function ring(rect, thick, from, to) {
  const span = Math.max(0, Math.min(1, to - from));
  from -= Math.floor(from);
  if (from + span > 1) return [...ring(rect, thick, from, 1), ...ring(rect, thick, 0, from + span - 1)];
  const { x, y, w, h } = rect, lap = 2 * (w + h), a = Math.round(from * lap), b = Math.round((from + span) * lap), out = [];
  // each edge's share of a..b, as the distance along that edge
  const edge = (start, length, box) => { const s0 = Math.max(a - start, 0), s1 = Math.min(b - start, length); if (s1 > s0) out.push(box(s0, s1 - s0, s1)); };
  edge(0, w, (s0, n) => ({ x: x + s0, y, w: n, h: thick }));
  edge(w, h, (s0, n) => ({ x: x + w - thick, y: y + s0, w: thick, h: n }));
  edge(w + h, w, (s0, n, s1) => ({ x: x + w - s1, y: y + h - thick, w: n, h: thick }));
  edge(2 * w + h, h, (s0, n, s1) => ({ x, y: y + h - s1, w: thick, h: n }));
  return out;
}
