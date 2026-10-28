/* Chocolate Doom's i_swap.h (used by i_oplmusic.c and midifile.c) takes its swaps from SDL. */
#ifndef JET_SDL_ENDIAN_H
#define JET_SDL_ENDIAN_H
#include <stdint.h>
#define SDL_SwapBE16(x) __builtin_bswap16((uint16_t)(x))
#define SDL_SwapBE32(x) __builtin_bswap32((uint32_t)(x))
#define SDL_SwapLE16(x) ((uint16_t)(x))
#define SDL_SwapLE32(x) ((uint32_t)(x))
#endif
