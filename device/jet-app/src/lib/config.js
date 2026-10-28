// Configuration layering below the schema-driven sources (env JET_*, argv):
//   config/jet-app.default.json  (generic, committed)
//   <deviceConfig>               (per-device, default /android-data/mainline/jet-app.json)
//   personal/jet-app.json        (gitignored: hosts, models, prompts)
// Later layers deep-merge over earlier ones; the result is passed as the configurator's
// `defaults` context, so environment and command line still win.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

async function readJson(file, { required = false } = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && !required) return {};
    throw new Error(`${file}: ${error.message}`, { cause: error });
  }
}

/**
 * @param {{deviceConfig?: string}} [options]
 * @returns {Promise<{defaults: object, files: string[]}>}
 */
export async function loadLayers({ deviceConfig = '/android-data/mainline/jet-app.json' } = {}) {
  const files = [path.join(appRoot, 'config', 'jet-app.default.json'), deviceConfig, path.join(appRoot, 'personal', 'jet-app.json')];
  let defaults = {};
  for (const [i, file] of files.entries()) defaults = deepMerge(defaults, await readJson(file, { required: i === 0 }));
  return { defaults, files };
}

/**
 * Deep-merge `patch` into one JSON layer on disk (created when missing): how a System screen
 * persists a setting into the per-device layer.
 */
export async function patchLayer(file, patch) {
  const merged = deepMerge(await readJson(file), patch);
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
