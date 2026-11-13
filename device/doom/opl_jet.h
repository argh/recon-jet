// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef OPL_JET_H
#define OPL_JET_H
#include <stdint.h>
/* Render the emulated OPL chip's next `frames` stereo S16 frames at 48 kHz, running the music
 * player's timed callbacks on the way. Returns 0 (buffer untouched) when music is not up. */
int OPL_Jet_Render(int16_t *stereo, unsigned frames);
#endif
