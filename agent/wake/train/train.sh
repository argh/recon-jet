#!/bin/sh
# Train the streaming model (the notebook's mixednet shape) and export the quantised streaming
# tflite the detector runs: $WORK/trained_models/wakeword/tflite_stream_state_internal_quant/.
# Resumes from checkpoints; TRAIN=0 only converts and tests the best weights.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
WORK=${WORK:-$ROOT/work/wake-train}; cd "$WORK"
cp "${PARAMS:-$HERE/training_parameters.yaml}" training_parameters.yaml   # PARAMS: a variant recipe
venv/bin/python -m microwakeword.model_train_eval \
  --training_config=training_parameters.yaml --train "${TRAIN:-1}" --restore_checkpoint 1 \
  --test_tf_nonstreaming 0 --test_tflite_nonstreaming 0 --test_tflite_nonstreaming_quantized 0 \
  --test_tflite_streaming 0 --test_tflite_streaming_quantized 1 --use_weights best_weights \
  mixednet --pointwise_filters "64,64,64,64" --repeat_in_block "1, 1, 1, 1" \
  --mixconv_kernel_sizes '[5], [7,11], [9,15], [23]' --residual_connection "0,0,0,0" \
  --first_conv_filters 32 --first_conv_kernel_size 5 --stride 3
ls -la trained_models/wakeword/tflite_stream_state_internal_quant/
