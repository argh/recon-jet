#!/bin/sh
# Personalise a clone: your WiFi, your ssh key, your inference server, optional VPN.
# Interactive; answers persist in work/setup.json (gitignored) and a re-run defaults to them.
# Everything it writes stays out of git. Then: ./install.sh
set -e
cd "$(dirname "$0")"
. tools/steps.sh
command -v node >/dev/null 2>&1 || die "node not found" "install Node 20+ (brew install node); every build tool here uses it"
exec node tools/setup.js "$@"
