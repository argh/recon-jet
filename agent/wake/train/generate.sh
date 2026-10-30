#!/bin/sh
# Synthetic positives: piper (904 LibriTTS-R voices, random pairs blended) says the wake phrase.
#   agent/wake/train/generate.sh "heya jet" 1500 ["hey ya jet" 1000 ...]
#   SET=negatives agent/wake/train/generate.sh "hey jeff" 150 "jet lag" 150 ...
# Pairs of phrase and count; spellings are phonetic hints to espeak, several spellings of the same
# phrase make the model tolerant of how it is actually said. Check a spelling before generating
# thousands: run a dozen clips through the ASR (POST /v1/audio/transcriptions) and read what it
# hears. "heya jet" comes out as "hee-ya jet" ("Hairjet", "Heed yet"), which nobody says; "hey ya
# jet", "hey-uh jet", "hey a jet" and "hey yuh jet" come out as the spoken "hey-uh jet" does.
# Clips go to $WORK/generated_samples, or $WORK/generated_<SET> for other sets (hard negatives:
# things that sound like the phrase; `rg`: real recordings of the owner, see realtest.sh).
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
WORK=${WORK:-$ROOT/work/wake-train}; cd "$WORK/piper-sample-generator"
[ $# -ge 2 ] || { echo "usage: generate.sh phrase count [phrase count ...]"; exit 2; }
while [ $# -ge 2 ]; do
  out="../generated_${SET:-samples}/$(echo "$1" | tr ' -' '__')"
  ../venv-piper/bin/python generate_samples.py "$1" --max-samples "$2" --batch-size 50 --output-dir "$out" 2>&1 | grep -v Warning | tail -1
  echo "$1: $(ls "$out" | wc -l | tr -d ' ') clips"
  shift 2
done
