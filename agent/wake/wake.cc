// jetwake: a microWakeWord detector for the Jet. 16 kHz mono S16 PCM on stdin (a WAV header is
// skipped), or with --raw96 the DMIC's own 96 kHz S32 stereo as arecord emits it (downmixed and
// decimated 6:1 exactly as jetd does for ASR); one line per detection on stdout:
//   wake <ms> <avg> <max>        average and peak probability (0..255) over the window
// and with --probs every model step:
//   p <ms> <prob>
// The pipeline is ESPHome's micro_wake_word: the TFLite micro frontend (30 ms windows every
// `step` ms, 40 filterbank channels 125..7500 Hz, noise reduction, PCAN, log scale), features
// scaled to int8 exactly as the models were trained, a streaming model stepped every `stride`
// features (its input shape), and a detection when the last `window` probabilities average above
// the cutoff; a detection is followed by a 1 s cool-off. Models and their manifests:
// github.com/esphome/micro-wake-word-models; training: github.com/kahrendt/microWakeWord.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <unistd.h>

#include "tensorflow/lite/experimental/microfrontend/lib/frontend.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend_util.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/schema/schema_generated.h"

static const int RATE = 16000, FEATURES = 40, WINDOW_MS = 30;
static const int MIN_STEPS_BEFORE_DETECTION = 100;   // cool-off after a detection (and at start)

struct Options { const char *model = nullptr; int step_ms = 10; int window = 5; float cutoff = 0.97f; bool probs = false; bool raw96 = false; };

/** Read 16 kHz mono samples from stdin, either as they are or by decimating the 96 kHz S32 stereo mic stream. */
static ssize_t read_pcm(const Options &o, int16_t *dst, size_t max) {
    static unsigned char inbuf[1 << 16]; static size_t inlen = 0; static int32_t acc[2] = {0, 0}; static int accn = 0;
    if (!o.raw96) { ssize_t r = read(0, dst, max * 2); return r <= 0 ? r : r / 2; }
    ssize_t r = read(0, inbuf + inlen, sizeof inbuf - inlen);
    if (r <= 0) return r;
    inlen += r;
    size_t frames = inlen / 8, i, n = 0; const int32_t *f = (const int32_t *)inbuf;
    for (i = 0; i < frames && n < max; i++) {
        acc[0] += f[2 * i] >> 8; acc[1] += f[2 * i + 1] >> 8;    /* 24-bit samples, headroom for 12 adds */
        if (++accn == 6) { int32_t v = ((acc[0] + acc[1]) / 12) >> 8; dst[n++] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v); acc[0] = acc[1] = 0; accn = 0; }
    }
    size_t used = i * 8; memmove(inbuf, inbuf + used, inlen - used); inlen -= used;
    return n;
}

static long long now_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000; }

static unsigned char *read_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb"); if (!f) return nullptr;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char *buf = (unsigned char *)aligned_alloc(16, (n + 15) & ~15);
    if (!buf || fread(buf, 1, n, f) != (size_t)n) { fclose(f); free(buf); return nullptr; }
    fclose(f); *len = n; return buf;
}

int main(int argc, char **argv) {
    Options o;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--probs")) o.probs = true;
        else if (!strcmp(argv[i], "--raw96")) o.raw96 = true;
        else if (!strcmp(argv[i], "--step") && i + 1 < argc) o.step_ms = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--window") && i + 1 < argc) o.window = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--cutoff") && i + 1 < argc) o.cutoff = atof(argv[++i]);
        else if (argv[i][0] != '-') o.model = argv[i];
        else { fprintf(stderr, "usage: jetwake [--raw96] [--step ms] [--window n] [--cutoff p] [--probs] model.tflite < pcm16k\n"); return 2; }
    }
    if (!o.model) { fprintf(stderr, "jetwake: a model is required\n"); return 2; }
    size_t model_len; unsigned char *model_data = read_file(o.model, &model_len);
    if (!model_data) { fprintf(stderr, "jetwake: cannot read %s\n", o.model); return 1; }

    // ---- frontend (the parameters every microWakeWord model was trained with) ----
    struct FrontendConfig cfg; FrontendFillConfigWithDefaults(&cfg);
    cfg.window.size_ms = WINDOW_MS; cfg.window.step_size_ms = o.step_ms;
    cfg.filterbank.num_channels = FEATURES; cfg.filterbank.lower_band_limit = 125.0f; cfg.filterbank.upper_band_limit = 7500.0f;
    cfg.noise_reduction.smoothing_bits = 10; cfg.noise_reduction.even_smoothing = 0.025f; cfg.noise_reduction.odd_smoothing = 0.06f; cfg.noise_reduction.min_signal_remaining = 0.05f;
    cfg.pcan_gain_control.enable_pcan = 1; cfg.pcan_gain_control.strength = 0.95f; cfg.pcan_gain_control.offset = 80.0f; cfg.pcan_gain_control.gain_bits = 21;
    cfg.log_scale.enable_log = 1; cfg.log_scale.scale_shift = 6;
    struct FrontendState fe;
    if (!FrontendPopulateState(&cfg, &fe, RATE)) { fprintf(stderr, "jetwake: frontend setup failed\n"); return 1; }

    // ---- model ----
    const tflite::Model *model = tflite::GetModel(model_data);
    if (model->version() != TFLITE_SCHEMA_VERSION) { fprintf(stderr, "jetwake: model schema %d, runtime %d\n", (int)model->version(), TFLITE_SCHEMA_VERSION); return 1; }
    static tflite::MicroMutableOpResolver<20> ops;
    ops.AddCallOnce(); ops.AddVarHandle(); ops.AddReshape(); ops.AddReadVariable(); ops.AddStridedSlice(); ops.AddConcatenation();
    ops.AddAssignVariable(); ops.AddConv2D(); ops.AddMul(); ops.AddAdd(); ops.AddMean(); ops.AddFullyConnected(); ops.AddLogistic();
    ops.AddQuantize(); ops.AddDepthwiseConv2D(); ops.AddAveragePool2D(); ops.AddMaxPool2D(); ops.AddPad(); ops.AddPack(); ops.AddSplitV();
    static const size_t ARENA = 256 * 1024, VAR_ARENA = 4096;
    static uint8_t arena[ARENA] __attribute__((aligned(16))), var_arena[VAR_ARENA] __attribute__((aligned(16)));
    tflite::MicroAllocator *va = tflite::MicroAllocator::Create(var_arena, VAR_ARENA);
    tflite::MicroResourceVariables *vars = tflite::MicroResourceVariables::Create(va, 20);
    tflite::MicroInterpreter interp(model, ops, arena, ARENA, vars);
    if (interp.AllocateTensors() != kTfLiteOk) { fprintf(stderr, "jetwake: AllocateTensors failed\n"); return 1; }
    TfLiteTensor *in = interp.input(0), *out = interp.output(0);
    if (in->dims->size != 3 || in->dims->data[0] != 1 || in->dims->data[2] != FEATURES || in->type != kTfLiteInt8) { fprintf(stderr, "jetwake: unexpected input tensor\n"); return 1; }
    if (out->dims->size != 2 || out->dims->data[1] != 1 || out->type != kTfLiteUInt8) { fprintf(stderr, "jetwake: unexpected output tensor\n"); return 1; }
    const int stride = in->dims->data[1];
    fprintf(stderr, "jetwake: %s, stride %d, window %d, cutoff %.2f, arena %zu bytes\n", o.model, stride, o.window, o.cutoff, interp.arena_used_bytes());

    // ---- stream ----
    const int cutoff = (int)(o.cutoff * 255.0f + 0.5f);
    uint8_t *recent = (uint8_t *)calloc(o.window, 1); int recent_i = 0, ignore = -MIN_STEPS_BEFORE_DETECTION, stride_i = 0;
    int16_t pcm[1600]; size_t have = 0; long long samples = 0; bool header_checked = false;
    const long long t0 = now_ms(); long long invokes = 0, busy_ms = 0;
    for (;;) {
        ssize_t r = read_pcm(o, pcm + have, sizeof pcm / 2 - have);
        if (r <= 0) break;
        have += r; size_t pos = 0;
        if (!header_checked && !o.raw96) { header_checked = true; if (have >= 22 && !memcmp(pcm, "RIFF", 4)) pos = 22; }   // 44-byte canonical WAV header
        while (pos < have) {
            size_t used = 0;
            struct FrontendOutput fo = FrontendProcessSamples(&fe, pcm + pos, have - pos, &used);
            pos += used; samples += used;
            if (fo.size == 0) continue;
            int8_t *dst = tflite::GetTensorData<int8_t>(in) + FEATURES * stride_i;
            for (size_t i = 0; i < fo.size; i++) { int32_t v = ((int32_t)fo.values[i] * 256 + 333) / 666 - 128; dst[i] = (int8_t)(v < -128 ? -128 : v > 127 ? 127 : v); }
            if (++stride_i < stride) continue;
            stride_i = 0;
            long long tb = now_ms();
            if (interp.Invoke() != kTfLiteOk) { fprintf(stderr, "jetwake: invoke failed\n"); return 1; }
            busy_ms += now_ms() - tb; invokes++;
            uint8_t p = out->data.uint8[0];
            if (++recent_i == o.window) recent_i = 0;
            recent[recent_i] = p;
            if (p < cutoff && ignore < 0) ignore++;
            long long ms = samples * 1000 / RATE;
            if (o.probs) printf("p %lld %d\n", ms, p);
            if (ignore < 0) continue;
            int sum = 0, mx = 0; for (int i = 0; i < o.window; i++) { sum += recent[i]; if (recent[i] > mx) mx = recent[i]; }
            if (sum > cutoff * o.window) {
                printf("wake %lld %d %d\n", ms, sum / o.window, mx); fflush(stdout);
                memset(recent, 0, o.window); ignore = -MIN_STEPS_BEFORE_DETECTION;
            }
        }
        if (pos < have) memmove(pcm, pcm + pos, (have - pos) * 2);
        have -= pos;
    }
    fflush(stdout);
    long long audio_ms = samples * 1000 / RATE, wall = now_ms() - t0;
    fprintf(stderr, "jetwake: %lld ms of audio, %lld steps, %lld ms in the model (%.1f%% of real time), %lld ms wall\n", audio_ms, invokes, busy_ms, audio_ms ? 100.0 * busy_ms / audio_ms : 0.0, wall);
    FrontendFreeStateContents(&fe);
    return 0;
}
