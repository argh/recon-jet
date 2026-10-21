#!/bin/sh
# say.sh "text" [voice]  : text -> kokoro TTS on llama-swap -> the Jet's speaker (ALSA card Jet via ssh)
#   JET_HOST (default jet.local), LLM_BASE (required: an OpenAI-compatible base URL, e.g. your llama-swap /v1)
set -e
TEXT=${1:?text}; VOICE=${2:-af_heart}
LLM=${LLM_BASE:?set LLM_BASE to an OpenAI-compatible base URL}; HOST=${JET_HOST:-jet.local}
T=$(mktemp -t jetsay).wav
printf '%s' "$TEXT" | python3 -c 'import json,sys; print(json.dumps({"model":"kokoro","input":sys.stdin.read(),"voice":sys.argv[1],"response_format":"wav"}))' "$VOICE" \
  | curl -sk --max-time 60 "$LLM/audio/speech" -H 'Content-Type: application/json' -d @- -o "$T"
# the amp path is verified at 48 kHz stereo S16 (what speaker-test used); kokoro returns 24 kHz mono
ffmpeg -loglevel error -y -i "$T" -ac 2 -ar 48000 -sample_fmt s16 "$T.48k.wav"
scp -q -O -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$T.48k.wav" "root@$HOST:/tmp/say.wav"
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 "root@$HOST" 'aplay -q -D hw:0,0 /tmp/say.wav'
rm -f "$T" "$T.48k.wav"
