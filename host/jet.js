#!/usr/bin/env node
// jet — one-shot developer CLI for the on-device daemon (agent/jetd.c, docs/jetd.md). Replaces
// the retired jet-hub server: connect, do the one thing asked, exit; no listeners, no HTTP.
// `jet --help` for the surface; JET_HOST overrides the default device address.
import { ModuleManager, Configurator, ConfiguratorError, SchemaError } from '@versionzero/module-manager';
import { JetApp } from './modules/app.js';

try {
  // configEnabled: false — the CLI's only configuration is flags and JET_* (no config files)
  const configurator = new Configurator({ configEnabled: false });
  await new ModuleManager({ configurator }).register(JetApp).run({ appName: 'jet' });
} catch (error) {
  // the split from configurator's examples/commands.js: a mistyped command line (selector,
  // flag, value) gets one friendly line and a --help nudge; anything else is unexpected and
  // prints in full so there is something to debug with
  if (error instanceof ConfiguratorError || error instanceof SchemaError) {
    const message = error.cause?.message ? `${error.message} (${error.cause.message})` : error.message;
    console.error(`${error.name}: ${message}`);
    console.error('Specify --help to list commands and options (jet <command> --help for one command)');
  } else {
    console.error(error);
  }
  process.exit(1);
}
