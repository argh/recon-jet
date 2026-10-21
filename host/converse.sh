#!/bin/sh
# converse.sh [seconds] : one voice turn, all local. Jet mics -> qwen3-asr -> qwen-27b -> kokoro -> Jet speaker.
#   prints the transcript and the answer; JET_HOST / LLM_BASE as in listen.sh and say.sh
set -e
cd "$(dirname "$0")/.."
LLM=${LLM_BASE:?set LLM_BASE to an OpenAI-compatible base URL}
Q=$(host/listen.sh "${1:-5}")
echo "heard: $Q"
[ -n "$Q" ] || { host/say.sh "I did not catch that."; exit 0; }
A=$(printf '%s' "$Q" | python3 -c 'import json,sys; print(json.dumps({"model":"qwen-27b","messages":[{"role":"system","content":"You are a voice assistant on a pair of smart glasses. Answer in one or two short spoken sentences."},{"role":"user","content":sys.stdin.read()}],"max_tokens":120,"chat_template_kwargs":{"enable_thinking":False}}))' \
  | curl -sk --max-time 120 "$LLM/chat/completions" -H 'Content-Type: application/json' -d @- \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["choices"][0]["message"]["content"].strip())')
echo "answer: $A"
host/say.sh "$A"
