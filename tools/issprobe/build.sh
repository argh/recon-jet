#!/bin/sh
# Build issprobe (static ARMv7 musl) with zig, like the other tools/* helpers.
set -e
cd "$(dirname "$0")"
ZIG=${ZIG:-/opt/homebrew/bin/zig}
$ZIG cc -target arm-linux-musleabihf -mcpu=cortex_a9 -static -O2 -Wall -s -o issprobe issprobe.c
ls -la issprobe
