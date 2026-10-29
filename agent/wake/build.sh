#!/bin/sh
# Build jetwake (static ARMv7 musl, or native with TARGET=native for testing on the Mac) from the
# flattened tflite-micro tree (refs/esp-tflite-micro, generic kernels, no ESP-NN) and the TFLite
# micro frontend (refs/pymicro-features, with its fixed-point kissfft).
set -e
cd "$(dirname "$0")"
REFS=../../refs; TFLM=$REFS/esp-tflite-micro; PMF=$REFS/pymicro-features
ZIG=${ZIG:-/opt/homebrew/bin/zig}
TARGET=${TARGET:-arm}
case $TARGET in
  arm)    OUT=jetwake; TFLAGS="-target arm-linux-musleabihf -mcpu=cortex_a9 -static -Wl,--gc-sections -s" ;;
  native) OUT=jetwake-native; TFLAGS="" ;;
esac
M=$TFLM/tensorflow/lite/micro
SRCS="$(for f in debug_log flatbuffer_utils memory_helpers micro_allocation_info micro_allocator micro_context micro_interpreter_context micro_interpreter_graph micro_interpreter micro_log micro_op_resolver micro_profiler micro_resource_variable micro_time micro_utils recording_micro_allocator system_setup; do echo $M/$f.cc; done)
$(ls $M/kernels/*.cc | grep -v test)
$(ls $M/tflite_bridge/*.cc)
$M/memory_planner/greedy_memory_planner.cc $M/memory_planner/linear_memory_planner.cc
$(ls $M/arena_allocator/*.cc | grep -v test)
$TFLM/tensorflow/lite/kernels/kernel_util.cc
$TFLM/tensorflow/lite/core/c/common.cc
$TFLM/tensorflow/lite/core/api/flatbuffer_conversions.cc $TFLM/tensorflow/lite/core/api/tensor_utils.cc
$(for f in common quantization_util portable_tensor_utils tensor_utils tensor_ctypes reference/portable_tensor_utils; do echo $TFLM/tensorflow/lite/kernels/internal/$f.cc; done)
$TFLM/tensorflow/compiler/mlir/lite/core/api/error_reporter.cc
$TFLM/tensorflow/compiler/mlir/lite/schema/schema_utils.cc
$(for f in fft fft_util filterbank filterbank_util frontend frontend_util log_lut log_scale log_scale_util noise_reduction noise_reduction_util pcan_gain_control pcan_gain_control_util window window_util kiss_fft_int16; do echo $PMF/tensorflow/lite/experimental/microfrontend/lib/$f.cc; done)"
$ZIG c++ $TFLAGS -std=gnu++17 -O2 -fno-rtti -fno-exceptions -fno-threadsafe-statics -ffunction-sections -fdata-sections \
  -DTF_LITE_STATIC_MEMORY -DTF_LITE_DISABLE_X86_NEON -DTF_LITE_USE_CTIME -w \
  -I$TFLM -I$TFLM/third_party/flatbuffers/include -I$TFLM/third_party/gemmlowp -I$TFLM/third_party/ruy -I$PMF -I$PMF/kissfft \
  -o $OUT wake.cc $SRCS
ls -la $OUT
