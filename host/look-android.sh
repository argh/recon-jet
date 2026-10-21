#!/bin/sh
# One "look": capture a photo on the Jet (stock Android), ask the local vision model,
# and show the answer on the Jet's display via the stock HTML viewer.
#   host/look.sh ["question"] [--claude]
set -e
cd "$(dirname "$0")/.."
Q=${1:-"Describe what you see in one short sentence. If there is readable text, quote it."}
shift 2>/dev/null || true
img=$(tools/android-capture.sh photo)
echo "captured: $img"
t0=$(date +%s)
ans=$(node host/vision.js "$img" "$Q" "$@" 2>/tmp/claude-501/vision.err || true)
echo "answer ($(( $(date +%s) - t0 ))s): $ans"
# render on the Jet: black page, large white text, wraps naturally
esc=$(printf '%s' "$ans" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')
cat > work/capture/look.html <<EOF
<html><body style="margin:0;background:#000;color:#fff;font-family:sans-serif">
<div style="padding:6px 8px;font-size:22px;line-height:1.15">$esc</div></body></html>
EOF
adb push work/capture/look.html /sdcard/look.html >/dev/null
adb shell am start -a android.intent.action.VIEW -d file:///sdcard/look.html -t text/html >/dev/null
