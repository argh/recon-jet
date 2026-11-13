// SPDX-License-Identifier: GPL-2.0-or-later
/* Chocolate Doom's OPL layer on the Jet: the driver slot opl_sdl.c fills in the SDL build. The
 * emulated chip (opl3.c, Nuked OPL3) is clocked by the sfx mixer: i_jetsound.c asks for each 10 ms
 * slice through OPL_Jet_Render, which generates samples up to the next due callback, runs it (the
 * MUS player's tick, which writes registers for the next notes) and carries on. The callback queue,
 * the two chip timers that OPL_Detect looks for and the pause offset are opl_sdl.c's, with the
 * mutexes on pthreads. opl.c's driver table names opl_sdl_driver, so that is this driver's name. */
#include <pthread.h>
#include <stdio.h>
#include <string.h>

#include "opl3.h"
#include "opl.h"
#include "opl_internal.h"
#include "opl_queue.h"
#include "opl_jet.h"

#define RATE 48000      /* the speaker's rate, whatever snd_samplerate says */

typedef struct { unsigned rate, enabled, value; uint64_t expire_time; } opl_timer_t;

static pthread_mutex_t callback_mutex = PTHREAD_MUTEX_INITIALIZER;        /* held while a callback runs, and by OPL_Lock */
static pthread_mutex_t queue_mutex = PTHREAD_MUTEX_INITIALIZER;
static opl_callback_queue_t *queue;
static uint64_t current_time, pause_offset;                                /* us */
static int paused, initialised;
static opl3_chip chip;
static int register_num;
static opl_timer_t timer1 = { 12500, 0, 0, 0 }, timer2 = { 3125, 0, 0, 0 };

static void advance(unsigned nsamples) {
    opl_callback_t cb; void *data;
    pthread_mutex_lock(&queue_mutex);
    uint64_t us = ((uint64_t)nsamples * OPL_SECOND) / RATE;
    current_time += us;
    if (paused) pause_offset += us;
    while (!OPL_Queue_IsEmpty(queue) && current_time >= OPL_Queue_Peek(queue) + pause_offset) {
        if (!OPL_Queue_Pop(queue, &cb, &data)) break;
        pthread_mutex_unlock(&queue_mutex);
        pthread_mutex_lock(&callback_mutex); cb(data); pthread_mutex_unlock(&callback_mutex);
        pthread_mutex_lock(&queue_mutex);
    }
    pthread_mutex_unlock(&queue_mutex);
}

int OPL_Jet_Render(int16_t *out, unsigned frames) {
    if (!initialised) return 0;
    unsigned filled = 0;
    while (filled < frames) {
        uint64_t n;
        pthread_mutex_lock(&queue_mutex);
        if (paused || OPL_Queue_IsEmpty(queue)) n = frames - filled;
        else {
            uint64_t next = OPL_Queue_Peek(queue) + pause_offset;
            n = next > current_time ? ((next - current_time) * RATE + OPL_SECOND - 1) / OPL_SECOND : 0;
            if (n > frames - filled) n = frames - filled;
        }
        pthread_mutex_unlock(&queue_mutex);
        if (n) OPL3_GenerateStream(&chip, out + filled * 2, n);
        filled += n;
        advance(n);
    }
    return 1;
}

/* ---- the driver -------------------------------------------------------------------------- */
static int jet_init(unsigned port_base) {
    queue = OPL_Queue_Create();
    current_time = pause_offset = 0; paused = 0; register_num = 0;
    memset(&timer1.enabled, 0, sizeof timer1 - sizeof timer1.rate); memset(&timer2.enabled, 0, sizeof timer2 - sizeof timer2.rate);
    OPL3_Reset(&chip, RATE);
    initialised = 1;
    return 1;
}

static void jet_shutdown(void) {
    initialised = 0;
    if (queue) { OPL_Queue_Destroy(queue); queue = NULL; }
}

static unsigned jet_read(opl_port_t port) {
    unsigned r = 0;
    if (port == OPL_REGISTER_PORT_OPL3) return 0xff;
    if (timer1.enabled && current_time > timer1.expire_time) r |= 0x80 | 0x40;
    if (timer2.enabled && current_time > timer2.expire_time) r |= 0x80 | 0x20;
    return r;
}

static void timer_end(opl_timer_t *t) { if (t->enabled) t->expire_time = current_time + ((uint64_t)(0x100 - t->value) * OPL_SECOND) / t->rate; }

static void write_reg(unsigned reg, unsigned value) {
    switch (reg) {
    case OPL_REG_TIMER1: timer1.value = value; timer_end(&timer1); break;
    case OPL_REG_TIMER2: timer2.value = value; timer_end(&timer2); break;
    case OPL_REG_TIMER_CTRL:
        if (value & 0x80) { timer1.enabled = timer2.enabled = 0; }
        else {
            if (!(value & 0x40)) { timer1.enabled = (value & 0x01) != 0; timer_end(&timer1); }
            if (!(value & 0x20)) { timer2.enabled = (value & 0x02) != 0; timer_end(&timer2); }
        }
        break;
    default: OPL3_WriteRegBuffered(&chip, reg, value); break;
    }
}

static void jet_write(opl_port_t port, unsigned value) {
    if (port == OPL_REGISTER_PORT) register_num = value;
    else if (port == OPL_REGISTER_PORT_OPL3) register_num = value | 0x100;
    else if (port == OPL_DATA_PORT) write_reg(register_num, value);
}

static void jet_set_callback(uint64_t us, opl_callback_t cb, void *data) {
    pthread_mutex_lock(&queue_mutex); OPL_Queue_Push(queue, cb, data, current_time - pause_offset + us); pthread_mutex_unlock(&queue_mutex);
}
static void jet_clear_callbacks(void) { pthread_mutex_lock(&queue_mutex); OPL_Queue_Clear(queue); pthread_mutex_unlock(&queue_mutex); }
static void jet_lock(void) { pthread_mutex_lock(&callback_mutex); }
static void jet_unlock(void) { pthread_mutex_unlock(&callback_mutex); }
static void jet_set_paused(int p) { paused = p; }
static void jet_adjust_callbacks(float f) { pthread_mutex_lock(&queue_mutex); OPL_Queue_AdjustCallbacks(queue, current_time, f); pthread_mutex_unlock(&queue_mutex); }

opl_driver_t opl_sdl_driver = {
    "Jet", jet_init, jet_shutdown, jet_read, jet_write, jet_set_callback, jet_clear_callbacks, jet_lock, jet_unlock, jet_set_paused, jet_adjust_callbacks,
};

/* i_oplmusic.c reaches Chocolate's own deh_str.h, whose doomfeatures.h turns FEATURE_DEHACKED on
 * and so declares this as a function; doomgeneric's tree has it as a no-op macro. */
char *DEH_String(char *s) { return s; }
