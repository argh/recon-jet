#!/bin/sh
# One-time setup for training a microWakeWord model on the Mac (Apple Silicon; Python 3.12 for the
# trainer, whose scipy wheel for 3.10 does not load on current macOS, 3.10 for piper): two venvs
# (the trainer wants numpy 2, piper's sample generator wants torch), the piper voice, and the data
# the notebook pulls (negative spectrogram sets ~6 GB, an AudioSet shard and the FMA slice for
# background noise, MIT impulse responses). Everything lands in $WORK (default work/wake-train).
# The microWakeWord notebook (refs/microWakeWord/notebooks/basic_training_notebook.ipynb) is the
# source of these steps; the data has mixed licences, so models trained on it are for personal use.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
WORK=${WORK:-$ROOT/work/wake-train}; PY=${PY:-/opt/homebrew/bin/python3.12}; PY_PIPER=${PY_PIPER:-/opt/homebrew/bin/python3.10}
mkdir -p "$WORK/dl" && cd "$WORK"

[ -d "$ROOT/refs/microWakeWord" ] || git clone -q --depth 1 https://github.com/kahrendt/microWakeWord "$ROOT/refs/microWakeWord"
# datasets 4 decodes audio only through torchcodec; 3.x uses soundfile
[ -x venv/bin/python ] || { $PY -m venv venv && venv/bin/pip install -q --upgrade pip && venv/bin/pip install -q -e "$ROOT/refs/microWakeWord" && venv/bin/pip install -q "datasets<4" soundfile tensorboard; }
[ -x venv-piper/bin/python ] || { $PY_PIPER -m venv venv-piper && venv-piper/bin/pip install -q --upgrade pip && venv-piper/bin/pip install -q torch torchaudio piper-phonemize-cross==1.2.1 audiomentations numpy webrtcvad-wheels; }

if [ ! -d piper-sample-generator ]; then
  git clone -q -b mps-support https://github.com/kahrendt/piper-sample-generator
  # torch >= 2.6 loads weights only by default; the piper checkpoint is a pickled model
  sed -i '' 's/torch\.load(\([^)]*\))/torch.load(\1, weights_only=False)/' piper-sample-generator/generate_samples.py
fi
[ -s piper-sample-generator/models/en_US-libritts_r-medium.pt ] || curl -sL -o piper-sample-generator/models/en_US-libritts_r-medium.pt https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt

fetch() { [ -s "dl/$1" ] || curl -sL -o "dl/$1" "$2"; }
for f in dinner_party.zip dinner_party_eval.zip no_speech.zip speech.zip; do fetch $f https://huggingface.co/datasets/kahrendt/microwakeword/resolve/main/$f; done
fetch audioset_00.parquet https://huggingface.co/datasets/agkphysics/AudioSet/resolve/main/data/bal_train/00.parquet   # 500 ten-second clips, one of 38 shards
fetch fma_xs.zip https://huggingface.co/datasets/mchl914/fma_xsmall/resolve/main/fma_xs.zip

# negatives: pre-computed spectrogram mmaps
mkdir -p negative_datasets
for f in dinner_party dinner_party_eval no_speech speech; do [ -d negative_datasets/$f ] || unzip -q dl/$f.zip -d negative_datasets; done

# background noise and music, as 16 kHz mono wav
[ -d fma ] || { mkdir fma && unzip -q dl/fma_xs.zip -d fma; }
[ -d fma_16k ] || { mkdir fma_16k; find fma -name "*.mp3" | while read -r f; do ffmpeg -loglevel error -y -i "$f" -ar 16000 -ac 1 -sample_fmt s16 "fma_16k/$(basename "${f%.*}").wav"; done; }
[ -d audioset_16k ] || venv/bin/python - <<'EOF'
import os, subprocess, pyarrow.parquet as pq
os.makedirs("audioset_16k", exist_ok=True)
for batch in pq.ParquetFile("dl/audioset_00.parquet").iter_batches(batch_size=64, columns=["audio"]):
    for a in batch.column("audio").to_pylist():
        out = os.path.join("audioset_16k", os.path.splitext(os.path.basename(a["path"]))[0] + ".wav")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", out], input=a["bytes"], check=False)
EOF

# room impulse responses (the repo already holds 16 kHz copies)
[ -d mit_rirs ] || { venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('davidscripka/MIT_environmental_impulse_responses', repo_type='dataset', local_dir='dl/mit_rirs_src')" && mkdir mit_rirs && cp dl/mit_rirs_src/16khz/*.wav mit_rirs/; }

echo "setup complete in $WORK"; du -sh "$WORK" | cut -f1
