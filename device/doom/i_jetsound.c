// SPDX-License-Identifier: GPL-2.0-or-later
/* Sound for Doom on the Recon Jet: doomgeneric's sound module (the slot i_sdlsound.c fills in the
 * SDL build) as a small software mixer. Doom's SFX lumps are 8-bit unsigned mono, mostly 11025 Hz;
 * a mixer thread resamples the playing channels (linear, 16.16 fixed point) into 10 ms slices of
 * 48 kHz stereo S16, the one format the speaker amp accepts (docs/audio.md), and streams them to
 * jetd's `W` over loopback (docs/jetd.md) — jetd is the one owner of the speaker, so doom audio
 * gets the same path as every other sound, including the live mirror's tee. TCP buffers unlike
 * the old one-page aplay pipe, so the mixer paces itself on an absolute slice clock. Volume and
 * separation follow i_sdlsound.c's arithmetic. jetd dying (or dropping us)
 * silences Doom until the next retry, two seconds later. Music is Chocolate Doom's OPL player
 * (i_oplmusic.c on the emulated chip in opl3.c, opl_jet.c as its driver), rendered into the same
 * slices here, so the mixer thread is the music clock: it keeps mixing even with aplay gone. */
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <time.h>
#include <unistd.h>

#include "doomtype.h"
#include "deh_str.h"
#include "i_sound.h"
#include "m_misc.h"
#include "w_wad.h"
#include "z_zone.h"
#include "opl_jet.h"

#define RATE 48000
#define SLICE 480                       /* frames per mix: 10 ms */
#define CHANNELS 16                     /* more than s_sound's snd_channels ever asks for */
#define RETRY_MS 2000

typedef struct { const byte *pcm; unsigned len, rate; } sfx_t;         /* sfxinfo->driver_data */
typedef struct { const sfx_t *s; uint32_t pos, step; int lvol, rvol; } chan_t;

static chan_t chans[CHANNELS];
static pthread_mutex_t mx = PTHREAD_MUTEX_INITIALIZER;
static pthread_t mixer;
static volatile int running;
static int play_fd = -1;
volatile int jet_sound_paused;                 /* freeze (doomgeneric_jet.c): the music clock halts too */
static boolean use_sfx_prefix;
static int16_t out[SLICE * 2], music[SLICE * 2];
static int32_t acc[SLICE * 2];

/* config.cfg knobs i_sound.c binds for the SDL module; unused here */
int use_libsamplerate = 0;
float libsamplerate_scale = 0.65f;

static int64_t now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000; }

/* ---- jetd as the speaker --------------------------------------------------------------- */
static void player_close(void) {
    if (play_fd >= 0) { close(play_fd); play_fd = -1; }
}

static int player_open(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(7777) };
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (fd < 0 || connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { if (fd >= 0) close(fd); return -1; }
    int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    play_fd = fd;
    return 0;
}

/* ---- mixing --------------------------------------------------------------------------- */
static void mix_slice(void) {
    memset(acc, 0, sizeof acc);
    pthread_mutex_lock(&mx);
    for (int c = 0; c < CHANNELS; c++) {
        chan_t *ch = &chans[c];
        const sfx_t *s = ch->s;
        if (!s) continue;
        for (int i = 0; i < SLICE; i++) {
            uint32_t idx = ch->pos >> 16;
            if (idx + 1 >= s->len) { ch->s = NULL; break; }
            int32_t frac = ch->pos & 0xffff, a = (int)s->pcm[idx] - 128, b = (int)s->pcm[idx + 1] - 128;
            int32_t v = (a * (65536 - frac) + b * frac) >> 16;         /* -128..127 */
            acc[2 * i] += v * ch->lvol; acc[2 * i + 1] += v * ch->rvol;   /* (v << 8) * vol / 256 */
            ch->pos += ch->step;
        }
    }
    pthread_mutex_unlock(&mx);
    if (OPL_Jet_Render(music, SLICE)) for (int i = 0; i < SLICE * 2; i++) acc[i] += music[i];
    for (int i = 0; i < SLICE * 2; i++) { int32_t v = acc[i]; out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
}

static void *mixer_main(void *arg) {
    int64_t next_try = 0, next_slice = now_ms();
    char hdr[24], trash[4096];
    const int slice_ms = SLICE * 1000 / RATE;
    while (running) {
        if (play_fd < 0 && now_ms() >= next_try) {
            next_try = now_ms() + RETRY_MS;
            if (player_open() < 0) perror("jet: jetd");
            else fprintf(stderr, "jet: sound to jetd (W over loopback)\n");
        }
        if (jet_sound_paused) {                /* frozen: no mixing (the OPL clock halts, so music
                                                  resumes where it stopped), but keep the socket
                                                  drained so jetd does not drop us */
            if (play_fd >= 0) while (recv(play_fd, trash, sizeof trash, MSG_DONTWAIT) > 0) {}
            next_slice = now_ms() + slice_ms;
            usleep((useconds_t)(slice_ms * 1000));
            continue;
        }
        mix_slice();
        if (play_fd >= 0) {
            /* jetd talks back (hello, log lines): drain or its stuck-writer rule drops us */
            while (recv(play_fd, trash, sizeof trash, MSG_DONTWAIT) > 0) {}
            int hl = snprintf(hdr, sizeof hdr, "W %zu\n", sizeof out);
            struct iovec iov[2] = { { hdr, (size_t)hl }, { out, sizeof out } };
            ssize_t want = hl + (ssize_t)sizeof out, n;
            do n = writev(play_fd, iov, 2); while (n < 0 && errno == EINTR);
            if (n != want) { fprintf(stderr, "jet: jetd gone (%s), retrying in %d s\n", n < 0 ? strerror(errno) : "short write", RETRY_MS / 1000); player_close(); }
        }
        /* the mixer is its own clock: TCP buffers, so unlike the old one-page pipe nothing paces us */
        next_slice += slice_ms;
        int64_t wait = next_slice - now_ms();
        if (wait > 0) usleep((useconds_t)(wait * 1000));
        else if (wait < -10 * slice_ms) next_slice = now_ms();   /* fell far behind (suspend): resync, do not sprint */
    }
    return arg;
}

/* ---- the sound module ----------------------------------------------------------------- */
static void lump_name(sfxinfo_t *sfx, char *buf, size_t n) {
    if (sfx->link) sfx = sfx->link;
    if (use_sfx_prefix) M_snprintf(buf, n, "ds%s", DEH_String(sfx->name)); else M_StringCopy(buf, DEH_String(sfx->name), n);
}

/* Load a lump as a DMX sound: 0x03 0x00, rate (16), length (32), then samples, of which DMX skips
 * the first and last 16 (padding). Kept for good in the zone; all of DOOM1's are ~1 MB. */
static sfx_t *load(sfxinfo_t *sfxinfo) {
    if (sfxinfo->driver_data) return sfxinfo->driver_data;
    int lumpnum = sfxinfo->lumpnum;
    if (lumpnum < 0) return NULL;
    byte *data = W_CacheLumpNum(lumpnum, PU_STATIC);
    unsigned lumplen = W_LumpLength(lumpnum);
    if (lumplen < 8 || data[0] != 0x03 || data[1] != 0x00) { W_ReleaseLumpNum(lumpnum); return NULL; }
    unsigned rate = data[2] | (data[3] << 8), length = data[4] | (data[5] << 8) | (data[6] << 16) | ((unsigned)data[7] << 24);
    if (length > lumplen - 8 || length <= 48 || rate == 0) { W_ReleaseLumpNum(lumpnum); return NULL; }
    sfx_t *s = Z_Malloc(sizeof *s, PU_STATIC, NULL);
    s->pcm = data + 8 + 16; s->len = length - 32; s->rate = rate;
    sfxinfo->driver_data = s;
    return s;
}

static boolean I_Jet_InitSound(boolean prefix) {
    use_sfx_prefix = prefix;
    running = 1;
    if (pthread_create(&mixer, NULL, mixer_main, NULL)) { running = 0; perror("jet: mixer thread"); return false; }
    return true;
}

static void I_Jet_ShutdownSound(void) {
    if (!running) return;
    running = 0;
    pthread_join(mixer, NULL);
    player_close();
}

static int I_Jet_GetSfxLumpNum(sfxinfo_t *sfx) { char name[9]; lump_name(sfx, name, sizeof name); return W_GetNumForName(name); }

static void I_Jet_UpdateSound(void) {}

static void I_Jet_UpdateSoundParams(int channel, int vol, int sep) {
    if (channel < 0 || channel >= CHANNELS) return;
    int left = ((254 - sep) * vol) / 127, right = (sep * vol) / 127;
    pthread_mutex_lock(&mx);
    chans[channel].lvol = left < 0 ? 0 : left > 255 ? 255 : left;
    chans[channel].rvol = right < 0 ? 0 : right > 255 ? 255 : right;
    pthread_mutex_unlock(&mx);
}

static int I_Jet_StartSound(sfxinfo_t *sfxinfo, int channel, int vol, int sep) {
    if (!running || channel < 0 || channel >= CHANNELS) return -1;
    const sfx_t *s = load(sfxinfo);
    if (!s) return -1;
    pthread_mutex_lock(&mx);
    chans[channel].s = s; chans[channel].pos = 0; chans[channel].step = ((uint64_t)s->rate << 16) / RATE;
    pthread_mutex_unlock(&mx);
    I_Jet_UpdateSoundParams(channel, vol, sep);
    return channel;
}

static void I_Jet_StopSound(int channel) {
    if (channel < 0 || channel >= CHANNELS) return;
    pthread_mutex_lock(&mx); chans[channel].s = NULL; pthread_mutex_unlock(&mx);
}

static boolean I_Jet_SoundIsPlaying(int channel) { return channel >= 0 && channel < CHANNELS && chans[channel].s != NULL; }

/* S_Init runs this before the lump numbers are known; read every sound in now so the first shot
 * does not wait on the WAD. */
static void I_Jet_PrecacheSounds(sfxinfo_t *sounds, int num) {
    int loaded = 0;
    for (int i = 0; i < num; i++) {
        char name[9]; lump_name(&sounds[i], name, sizeof name);
        sounds[i].lumpnum = W_CheckNumForName(name);
        if (sounds[i].lumpnum >= 0 && load(&sounds[i])) loaded++;
    }
    fprintf(stderr, "jet: %d sounds cached\n", loaded);
}

static snddevice_t jet_devices[] = { SNDDEVICE_SB, SNDDEVICE_PAS, SNDDEVICE_GUS, SNDDEVICE_WAVEBLASTER, SNDDEVICE_SOUNDCANVAS, SNDDEVICE_AWE32 };

sound_module_t DG_sound_module = {
    jet_devices, sizeof jet_devices / sizeof *jet_devices,
    I_Jet_InitSound, I_Jet_ShutdownSound, I_Jet_GetSfxLumpNum, I_Jet_UpdateSound, I_Jet_UpdateSoundParams,
    I_Jet_StartSound, I_Jet_StopSound, I_Jet_SoundIsPlaying, I_Jet_PrecacheSounds,
};

