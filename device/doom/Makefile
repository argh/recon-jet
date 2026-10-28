# Doom for the Recon Jet: doomgeneric's engine + doomgeneric_jet.c, one static ARMv7 musl binary.
#   make -j8            -> ./doom     (build.sh fetches doomgeneric first)
#   make DG=<dir>       -> another doomgeneric checkout
DG ?= ../../refs/doomgeneric/doomgeneric
CHOC ?= ../../refs/chocolate-doom
ZIG ?= /opt/homebrew/bin/zig
CC = $(ZIG) cc -target arm-linux-musleabihf -mcpu=cortex_a9
# FEATURE_SOUND: i_sound.c dispatches to DG_sound_module (i_jetsound.c) and DG_music_module (Chocolate Doom's OPL player,
# renamed on the command line); compat/ has the SDL headers those files include, over pthreads and builtins
# CMAP256: Doom hands us its 8-bit frame and the gamma-corrected palette; we map to RGB565 ourselves
CFLAGS = -O2 -Wall -Wno-unused-variable -Wno-unused-but-set-variable -Wno-misleading-indentation -Wno-format \
         -DNORMALUNIX -DLINUX -DSNDSERV -D_DEFAULT_SOURCE -DCMAP256 -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 -DFEATURE_SOUND -I$(DG) -I$(CHOC)/opl -Icompat
LDFLAGS = -static -s -Wl,--gc-sections
LIBS = -lm -lpthread

ENGINE = dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main d_mode d_net f_finale f_wipe \
         g_game hu_lib hu_stuff info i_cdmus i_endoom i_joystick i_scale i_sound i_system i_timer memio m_argv m_bbox \
         m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng p_doors p_enemy p_floor p_inter p_lights \
         p_map p_maputl p_mobj p_plats p_pspr p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user r_bsp \
         r_data r_draw r_main r_plane r_segs r_sky r_things sha1 sounds statdump st_lib st_stuff s_sound tables \
         v_video wi_stuff w_checksum w_file w_main w_wad z_zone w_file_stdc i_input i_video doomgeneric mus2mid
MUSIC = opl3 opl_queue opl i_oplmusic midifile
OBJS = $(addprefix build/, $(addsuffix .o, $(ENGINE) $(MUSIC))) build/doomgeneric_jet.o build/i_jetsound.o build/opl_jet.o

doom: $(OBJS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(OBJS) $(LIBS)
	@ls -la $@

build/%.o: $(DG)/%.c | build
	$(CC) $(CFLAGS) -c $< -o $@
build/doomgeneric_jet.o: doomgeneric_jet.c | build
	$(CC) $(CFLAGS) -c $< -o $@
build/i_jetsound.o: i_jetsound.c | build
	$(CC) $(CFLAGS) -c $< -o $@
build/opl_jet.o: opl_jet.c | build
	$(CC) $(CFLAGS) -c $< -o $@
build/opl.o build/opl3.o build/opl_queue.o: build/%.o: $(CHOC)/opl/%.c | build
	$(CC) $(CFLAGS) -c $< -o $@
build/i_oplmusic.o: $(CHOC)/src/i_oplmusic.c | build
	$(CC) $(CFLAGS) -Dmusic_opl_module=DG_music_module -c $< -o $@
build/midifile.o: $(CHOC)/src/midifile.c | build
	$(CC) $(CFLAGS) -c $< -o $@
build:
	mkdir -p build
clean:
	rm -rf build doom
.PHONY: clean
