#!/bin/sh
# Build work/jet-app.tgz (pure JS, so node_modules from the Mac run on the Jet's armv7 Node 20).
set -e
cd "$(dirname "$0")/.."
npm ci --omit=dev --silent
mkdir -p ../../work
tar czf ../../work/jet-app.tgz package.json package-lock.json README.md src config deploy test node_modules
ls -la ../../work/jet-app.tgz
