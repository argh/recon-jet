/* What Chocolate Doom's OPL layer and MIDI parser take from SDL, over pthreads and builtins:
 * opl.c uses a mutex + condition for OPL_Delay (and strcmp without including string.h); the
 * big-endian swaps Chocolate's i_swap.h wants are in SDL_endian.h. */
#ifndef JET_SDL_COMPAT_H
#define JET_SDL_COMPAT_H
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include "SDL_endian.h"

typedef pthread_mutex_t SDL_mutex;
typedef pthread_cond_t SDL_cond;
static inline SDL_mutex *SDL_CreateMutex(void) { SDL_mutex *m = malloc(sizeof *m); pthread_mutex_init(m, NULL); return m; }
static inline void SDL_DestroyMutex(SDL_mutex *m) { pthread_mutex_destroy(m); free(m); }
static inline int SDL_LockMutex(SDL_mutex *m) { return pthread_mutex_lock(m); }
static inline int SDL_UnlockMutex(SDL_mutex *m) { return pthread_mutex_unlock(m); }
static inline SDL_cond *SDL_CreateCond(void) { SDL_cond *c = malloc(sizeof *c); pthread_cond_init(c, NULL); return c; }
static inline void SDL_DestroyCond(SDL_cond *c) { pthread_cond_destroy(c); free(c); }
static inline int SDL_CondSignal(SDL_cond *c) { return pthread_cond_signal(c); }
static inline int SDL_CondWait(SDL_cond *c, SDL_mutex *m) { return pthread_cond_wait(c, m); }
#endif
