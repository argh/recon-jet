#!/bin/sh
# jetshot.sh [out.png] [scale]  : a screenshot of the Jet's panel, as shown (jetd, jet-app and the
# viewfinder). Asks jet-app's debug port first (GET /screen.png, instant); when jet-app is not
# running, pulls /dev/fb0 over ssh and converts it here with the app's own PNG code. Default output
# work/shots/jet-<utc time>.png at scale 2 (the panel is 428x240; 2x reads well in a document).
set -e
cd "$(dirname "$0")/.."
HOST=${JET_HOST:-jet.local}; PORT=${JET_VOICE_DEBUG_PORT:-7781}
SCALE=${2:-2}; OUT=${1:-work/shots/jet-$(date -u +%Y%m%dT%H%M%SZ).png}
mkdir -p "$(dirname "$OUT")"
if curl -sf -m 10 "http://$HOST:$PORT/screen.png?scale=$SCALE" -o "$OUT"; then echo "$OUT"; exit 0; fi
echo "jetshot: no answer from jet-app on $HOST:$PORT, reading the framebuffer over ssh" >&2
tools/jsh.sh -t 20 'cd /sys/class/graphics/fb0 && echo $(cat virtual_size) $(cat bits_per_pixel) $(cat stride 2>/dev/null); cat /dev/fb0' | node --input-type=module -e '
  import { rgb565ToRgba, encodePng } from "./device/jet-app/src/lib/png.js";
  import fs from "node:fs";
  const all = fs.readFileSync(0), nl = all.indexOf(10);
  if (nl < 0) { console.error("jetshot: nothing came back from the Jet"); process.exit(1); }
  const head = all.toString("latin1", 0, nl).trim().split(/\s+/), fb = all.subarray(nl + 1);
  const [w, h] = head[0].split(",").map(Number), bpp = Number(head[1]) || 16, stride = Number(head[2]) || w * (bpp >> 3);
  if (bpp !== 16) throw new Error(`${bpp} bpp framebuffer; only 16 is handled here`);
  fs.writeFileSync(process.argv[1], encodePng(rgb565ToRgba(fb, w, h, stride >> 1), w, h, { scale: Number(process.argv[2]) || 1 }));
  console.error(`${w}x${h} x${process.argv[2]}`);
' "$OUT" "$SCALE" && echo "$OUT"
