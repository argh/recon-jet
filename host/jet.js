#!/usr/bin/env node
// jet — one-shot developer CLI for the on-device daemon (agent/jetd.c, docs/jetd.md). Replaces
// the retired jet-hub server: connect, do the one thing asked, exit; no listeners, no HTTP.
// `jet --help` for the surface; JET_HOST overrides the default device address.
import { ModuleManager, Configurator } from '@versionzero/module-manager';
import { JetApp } from './modules/app.js';

try {
  // configEnabled: false — the CLI's only configuration is flags and JET_* (no config files)
  const configurator = new Configurator({ configEnabled: false });
  await new ModuleManager({ configurator }).register(JetApp).run({ appName: 'jet' });
} catch (error) {
  const message = error.cause?.message ? `${error.message} (${error.cause.message})` : error.message;
  console.error(`${error.name}: ${message}`);
  process.exit(1);
}
