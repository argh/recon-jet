#!/bin/sh
# Score a model on real recordings from the Jet's own mics: every $WORK/real/*.raw (16 kHz mono
# S16, as jetd feeds the detector) is run through the native detector and the hits are listed, so a
# retrain is judged on the voice that has to work, not on piper's. A recording's expected hits go in
# a sidecar `<name>.txt` as free text (what was said, when); the script only prints.
#   agent/wake/train/realtest.sh [model.tflite] [cutoff]
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
WORK=${WORK:-$ROOT/work/wake-train}
MODEL=${1:-$ROOT/agent/wake/models/heya_jet.tflite}; CUTOFF=${2:-0.5}
BIN=$ROOT/agent/wake/jetwake-native
[ -x "$BIN" ] || { echo "build the native detector first: TARGET=native agent/wake/build.sh"; exit 2; }
for raw in "$WORK"/real/*.raw; do
  name=$(basename "$raw" .raw)
  hits=$("$BIN" --probs --cutoff "$CUTOFF" "$MODEL" < "$raw" 2>/dev/null |
    awk '$1=="wake"{printf "%ds(%d) ", $2/1000, $3} $1=="p"&&$3>=128{n++} END{printf "| %d steps >= 128\n", n+0}')
  printf "%-18s %s\n" "$name" "$hits"
  [ -f "${raw%.raw}.txt" ] && sed 's/^/                   /' "${raw%.raw}.txt"
done
