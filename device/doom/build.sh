#!/bin/sh
# Build device/doom/doom: fetch doomgeneric (pinned) into refs/doomgeneric if missing, then make.
set -e
cd "$(dirname "$0")"
DG_REPO=https://github.com/ozkl/doomgeneric.git
DG_REV=e257a09527062bfb986b6e5e0780839b6cbd5b71   # 2026-10-11
DG=../../refs/doomgeneric
if [ ! -d "$DG" ]; then git clone -q "$DG_REPO" "$DG"; fi
if [ "$(git -C "$DG" rev-parse HEAD)" != "$DG_REV" ]; then git -C "$DG" fetch -q --depth 1 origin "$DG_REV" && git -C "$DG" checkout -q "$DG_REV"; fi
make -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" "$@"
