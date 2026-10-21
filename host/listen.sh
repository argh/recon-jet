#!/bin/sh
# listen.sh [seconds] : record the Jet's mics (ALSA card Jet, device 1) -> qwen3-asr on llama-swap -> text on stdout
#   JET_HOST (default jet.local), LLM_BASE (required: an OpenAI-compatible base URL, e.g. your llama-swap /v1); keeps the clip in work/audio/
set -e
SECS=${1:-4}
LLM=${LLM_BASE:?set LLM_BASE to an OpenAI-compatible base URL}; HOST=${JET_HOST:-jet.local}
mkdir -p work/audio; OUT=work/audio/listen-$(date +%H%M%S).wav
# the OMAP4 DMIC block only does 96/192 kHz S32; downmix/resample on the Mac for the ASR
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 "root@$HOST" "arecord -q -D hw:0,1 -c 2 -r 96000 -f S32_LE -d $SECS /tmp/listen.wav"
scp -q -O -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "root@$HOST:/tmp/listen.wav" "$OUT.raw.wav"
ffmpeg -loglevel error -y -i "$OUT.raw.wav" -ac 1 -ar 16000 -sample_fmt s16 "$OUT"
curl -sk --max-time 60 "$LLM/audio/transcriptions" -F model=qwen3-asr -F "file=@$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("text",""))'
