#!/bin/sh
# Build jetd (static ARMv7 musl) with an embedded Terminus PSF2 font.
#   agent/build.sh [font] [small-font]   defaults: ter-u20b (10x20, 42x12 cells) + Lat2-Terminus12x6 (6x12, 71x20 cells)
#   main font: ter-u20b (PSF2, 20x10 glyphs => 42x12 cells; ter-u16b is PSF1 and is rejected)
set -e
cd "$(dirname "$0")"
FONT=${1:-ter-u20b}; SMALL=${2:-Lat2-Terminus12x6}
{ echo "/* generated from font/$FONT.psf (main) and font/$SMALL.psf (small) */";
  xxd -i -n font_main "font/$FONT.psf" | sed 's/^unsigned char/const unsigned char/; s/^unsigned int/const unsigned/';
  xxd -i -n font_small "font/$SMALL.psf" | sed 's/^unsigned char/const unsigned char/; s/^unsigned int/const unsigned/'; } > font_psf.h
ZIG=${ZIG:-/opt/homebrew/bin/zig}
$ZIG cc -target arm-linux-musleabihf -mcpu=cortex_a9 -static -O2 -Wall -s -o jetd jetd.c
ls -la jetd
