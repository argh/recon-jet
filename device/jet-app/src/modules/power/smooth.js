// Smoothing for noisy readouts: a fixed-size window with a median, and rounding to a step.

export class Median {
  /** @param {number} size samples kept (the window) */
  constructor(size = 8) { this.size = Math.max(1, size | 0); this.samples = []; }
  push(v) {
    this.samples.push(v);
    if (this.samples.length > this.size) this.samples.shift();
    return this.value;
  }
  /** Median of the window (mean of the middle pair for an even count), or null when empty. */
  get value() {
    const n = this.samples.length;
    if (!n) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }
  reset() { this.samples.length = 0; }
}

/** Round to the nearest multiple of `step` (e.g. 3987 mV, step 10 -> 3990). */
export const roundTo = (v, step) => Math.round(v / step) * step;
