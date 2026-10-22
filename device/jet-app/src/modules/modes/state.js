// The app's persisted state on userdata (the last used mode): a small JSON file, written
// atomically (temp file + rename) so a power cut mid-write never leaves garbage behind.
import fs from 'node:fs/promises';
import path from 'node:path';

/** @returns {Promise<object>} `{}` when the file is missing or unreadable */
export async function readState(file) {
  try { const o = JSON.parse(await fs.readFile(file, 'utf8')); return o && typeof o === 'object' ? o : {}; }
  catch { return {}; }
}

/** Merge `patch` into the file's current contents and write it back. */
export async function writeState(file, patch) {
  const state = { ...(await readState(file)), ...patch };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state) + '\n');
  await fs.rename(tmp, file);
  return state;
}
