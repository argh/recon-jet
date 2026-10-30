# Augment the synthetic positives (room impulse responses, background noise and music at -5..10 dB
# SNR, EQ, distortion, pitch, gain, jitter) and write their spectrogram features as the ragged
# mmaps the trainer reads: training / validation / testing splits under
# $WORK/generated_augmented_features; `features.py $WORK negatives` does the same for the hard
# negatives in generated_negatives -> generated_negatives_features. The notebook's cells, as a
# script; run with $WORK/venv.
import os
import shutil
import sys

from microwakeword.audio.augmentation import Augmentation
from microwakeword.audio.clips import Clips
from microwakeword.audio.spectrograms import SpectrogramGeneration
from mmap_ninja.ragged import RaggedMmap

work = sys.argv[1] if len(sys.argv) > 1 else "."
which = sys.argv[2] if len(sys.argv) > 2 else None
os.chdir(work)

clips = Clips(input_directory=f"generated_{which}" if which else "generated_samples", file_pattern="**/*.wav", max_clip_duration_s=None,
              remove_silence=False, random_split_seed=10, split_count=0.1)
augmenter = Augmentation(
    augmentation_duration_s=3.2,
    augmentation_probabilities={"SevenBandParametricEQ": 0.1, "TanhDistortion": 0.1, "PitchShift": 0.1, "BandStopFilter": 0.1,
                                "AddColorNoise": 0.1, "AddBackgroundNoise": 0.75, "Gain": 1.0, "RIR": 0.5},
    impulse_paths=["mit_rirs"], background_paths=["fma_16k", "audioset_16k"],
    background_min_snr_db=-5, background_max_snr_db=10, min_jitter_s=0.195, max_jitter_s=0.205)

out = f"generated_{which}_features" if which else "generated_augmented_features"
for split, name, repeat, slide in [("training", "train", 2, 10), ("validation", "validation", 1, 10), ("testing", "test", 1, 1)]:
    d = os.path.join(out, split)
    mm = os.path.join(d, "wakeword_mmap")
    if os.path.isdir(mm) and os.listdir(mm):
        print(f"{split}: exists"); continue
    shutil.rmtree(mm, ignore_errors=True)   # an interrupted run leaves an empty folder the trainer would read as "no positives"
    os.makedirs(d, exist_ok=True)
    gen = SpectrogramGeneration(clips=clips, augmenter=augmenter, slide_frames=slide, step_ms=10)
    RaggedMmap.from_generator(out_dir=os.path.join(d, "wakeword_mmap"),
                              sample_generator=gen.spectrogram_generator(split=name, repeat=repeat),
                              batch_size=100, verbose=True)
    print(f"{split}: done")
