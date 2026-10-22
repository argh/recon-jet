// Calibration arithmetic, pure, matching what jetd's setup mode did (agent/jetd.c) so both
// produce the same files.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median3 = (a, b, c) => [a, b, c].sort((x, y) => x - y)[1];

/** Pad calibration steps, in order: the axis sampled and the prompt. x < 0 is left, y < 0 is down (jet-ofm). */
export const PAD_STEPS = [
  { dir: 'RIGHT', axis: 'x' }, { dir: 'LEFT', axis: 'x' }, { dir: 'DOWN', axis: 'y' }, { dir: 'UP', axis: 'y' },
];
export const PAD_SWIPES = 3;   // per direction
export const PAD_MIN_MOTION = 8;   // |dx| + |dy| below this is not a swipe

/**
 * Swipe thresholds from three motion sums per direction: the median magnitude per direction,
 * half the weaker direction of each axis, clamped to 8..60.
 * @param {number[][]} samples 4 x 3 signed sums, in PAD_STEPS order
 * @returns {{thrX: number, thrY: number}}
 */
export function padThresholds(samples) {
  const med = samples.map(([a, b, c]) => median3(Math.abs(a), Math.abs(b), Math.abs(c)));
  return { thrX: clamp(Math.trunc(Math.min(med[0], med[1]) / 2), 8, 60), thrY: clamp(Math.trunc(Math.min(med[2], med[3]) / 2), 8, 60) };
}

/** The `mainline/ofm-args` line jet-ofm's module parameters are loaded from at boot. */
export const ofmArgs = ({ thrX, thrY }) => `thr_x=${thrX} thr_y=${thrY}\n`;

/** Glance calibration prompts, in order (the stock flow). */
export const GLANCE_STEPS = ['look AT the display', 'look FORWARD (away)', 'look AT the display again', 'look AWAY again'];
export const GLANCE_READS = 8;   // sensor reads averaged per step
export const GLANCE_MIN_SPAN = 40;   // less contrast than this between at and away is a flat run

/**
 * Glance thresholds from the four averaged readings (at, away, at, away): the "on" threshold
 * 60 % and the "off" threshold 40 % of the way from the away level to the at level. Either
 * polarity: on < off means the sensor reads lower when worn, and jetd compares accordingly.
 * @param {number[]} reads 4 averaged readings
 * @returns {{ok: boolean, on: number, off: number, at: number, away: number, span: number}}
 */
export function glanceThresholds(reads) {
  const at = Math.trunc((reads[0] + reads[2]) / 2), away = Math.trunc((reads[1] + reads[3]) / 2), span = at - away;
  return { ok: Math.abs(span) >= GLANCE_MIN_SPAN, on: away + Math.trunc(span * 6 / 10), off: away + Math.trunc(span * 4 / 10), at, away, span };
}

/** The `mainline/glance` file jetd reads: "on off". */
export const glanceFile = ({ on, off }) => `${on} ${off}\n`;

/** Backlight steps: 16..1023 by 48 (the kopin-a230 range jetd used). */
export const BACKLIGHT = { min: 16, max: 1023, step: 48, fallback: 208 };
export const backlightStep = (level, d) => clamp(level + d * BACKLIGHT.step, BACKLIGHT.min, BACKLIGHT.max);
