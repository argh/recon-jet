// Tiny 1 bpp icons: an array of equal-length strings, '#' = set. `parseIcon` packs each row
// into an integer (MSB = leftmost pixel, up to 32 wide); `Raster.icon()` draws one.

/** @param {string[]} rows @returns {{w:number, h:number, rows:number[]}} */
export function parseIcon(rows) {
  const w = rows[0].length;
  if (w > 32 || rows.some((r) => r.length !== w)) throw new Error('icon rows must be equal length, at most 32 wide');
  return { w, h: rows.length, rows: rows.map((r) => Array.from(r).reduce((bits, ch) => (bits << 1) | (ch === '#' ? 1 : 0), 0) >>> 0) };
}

export const ICONS = {
  battery: parseIcon([
    '##############..',
    '#............#..',
    '#............###',
    '#............#.#',
    '#............#.#',
    '#............###',
    '#............#..',
    '##############..',
  ]),
  bolt: parseIcon([
    '....##..',
    '...##...',
    '..##....',
    '.#####..',
    '...##...',
    '..##....',
    '.##.....',
    '#.......',
  ]),
  camera: parseIcon([
    '....####........',
    '################',
    '#.....####.....#',
    '#....#....#....#',
    '#....#....#....#',
    '#....#....#....#',
    '#.....####.....#',
    '################',
  ]),
  usb: parseIcon([
    '.....#....',
    '....###...',
    '.....#....',
    '.#...#..#.',
    '.#...#.###',
    '..#..#..#.',
    '...#.#.#..',
    '....###...',
    '.....#....',
    '....###...',
  ]),
};
