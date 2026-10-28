// Small sysfs / flag-file helpers: absent files are normal (tests, a Mac, a module not loaded).
import fs from 'node:fs/promises';

/** Write `text` to `file` if it exists; a missing file is left missing. */
export async function writeIfPresent(file, text) { if (await fs.access(file).then(() => true, () => false)) await fs.writeFile(file, text); }

/** The integer in `file`, or null when it is missing or not a number. */
export async function readInt(file) { const n = parseInt(await fs.readFile(file, 'utf8').catch(() => ''), 10); return Number.isNaN(n) ? null : n; }
