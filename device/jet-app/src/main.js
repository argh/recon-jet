#!/usr/bin/env node
// Entry point: logger + config layers -> ModuleManager -> run.
//   --help, --dump=-, --device-link-host ..., or JET_DEVICE_LINK_HOST=... (see docs/jet-app.md).
//   JET_LOG_LEVEL and JET_DEVICE_CONFIG are read here, before configuration, and also live in
//   Jet's schema so the environment source accepts them.
import './lib/compat.js';
import { ModuleManager } from '@versionzero/module-manager';
import { Logger } from './lib/logger.js';
import { loadLayers, appRoot } from './lib/config.js';
import { Jet } from './jet.js';
import path from 'node:path';

const logger = new Logger({ level: process.env.JET_LOG_LEVEL ?? 'info' });
const deviceConfig = process.env.JET_DEVICE_CONFIG;

try {
  const { defaults, files } = await loadLayers({ deviceConfig });
  const mm = new ModuleManager().registerInstance(logger, { name: 'logger', lifecycle: false }).register(Jet);
  // personal/index.js may export `modules` (classes with moduleInfo) to add providers without editing core
  const extra = await import(path.join(appRoot, 'personal', 'index.js')).then((m) => m.modules ?? [], () => []);
  for (const ModuleClass of extra) mm.register(ModuleClass);
  logger.info({ files, extraModules: extra.map((m) => m.name) }, 'config layers');
  await mm.run({ defaults });
} catch (error) {
  logger.fatal({ error }, 'jet-app failed');
  process.exit(1);
}
