#!/bin/sh
# One "look" on mainline: snapshot through the hub (jetd camera), ask the local vision model,
# show the answer on the glass through the hub.
#   host/look.sh ["question"] [--claude]      (hub must be running: node host/jet-hub.js jet.local)
set -e
cd "$(dirname "$0")/.."
Q=${1:-"Describe what you see in one short sentence. If there is readable text, quote it."}
shift 2>/dev/null || true
mkdir -p work/capture
img=work/capture/look-$(date +%H%M%S).jpg
t0=$(date +%s)
code=$(curl -s -o "$img" -w '%{http_code}' -X POST localhost:7778/snapshot -H 'content-type: application/json' -d '{"w":640,"h":480}')
[ "$code" = 200 ] || { echo "snapshot failed: HTTP $code $(cat "$img")"; exit 1; }
echo "captured: $img ($(( $(date +%s) - t0 ))s)"
t1=$(date +%s)
ans=$(node host/vision.js "$img" "$Q" "$@" 2>/tmp/claude-501/vision.err || true)
echo "answer ($(( $(date +%s) - t1 ))s): $ans"
node -e '
const [ans] = process.argv.slice(1);
const body = JSON.stringify({ lines: ans.split(/\n+/).filter(Boolean), center: false, color: [255, 255, 255], clear: true });
require("http").request({ host: "localhost", port: 7778, path: "/screen", method: "POST", headers: { "content-type": "application/json" } }, (r) => r.resume()).end(body);
' "$ans"
