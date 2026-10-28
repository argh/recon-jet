#!/bin/sh
# Build device/doom/doom: fetch doomgeneric and Chocolate Doom (pinned; the OPL music player comes from the
# latter) into refs/ if missing, then make.
set -e
cd "$(dirname "$0")"
DG_REPO=https://github.com/ozkl/doomgeneric.git
DG_REV=e257a09527062bfb986b6e5e0780839b6cbd5b71   # 2026-10-11
DG=../../refs/doomgeneric
if [ ! -d "$DG" ]; then git clone -q "$DG_REPO" "$DG"; fi
if [ "$(git -C "$DG" rev-parse HEAD)" != "$DG_REV" ]; then git -C "$DG" fetch -q --depth 1 origin "$DG_REV" && git -C "$DG" checkout -q "$DG_REV"; fi
CHOC_REPO=https://github.com/chocolate-doom/chocolate-doom.git
CHOC_REV=939cbfeb115338cf7868e516019a4ae832b1ebde   # chocolate-doom-2.3.0
CHOC=../../refs/chocolate-doom
if [ ! -d "$CHOC" ]; then git clone -q --depth 1 --branch chocolate-doom-2.3.0 "$CHOC_REPO" "$CHOC"; fi
if [ "$(git -C "$CHOC" rev-parse HEAD)" != "$CHOC_REV" ]; then git -C "$CHOC" fetch -q --depth 1 origin "$CHOC_REV" && git -C "$CHOC" checkout -q "$CHOC_REV"; fi
make -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" "$@"
