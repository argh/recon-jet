# Doom on the Jet

[doomgeneric](https://github.com/ozkl/doomgeneric) (Chocolate Doom's engine behind a six-function
platform API) with `doomgeneric_jet.c` as the platform: Doom's 320x200 8-bit frame is palette-
mapped straight into `/dev/fb0` and pushed to the Kopin panel with `OMAPFB_UPDATE_WINDOW`; keys
come from jetd's socket (`k <evdev code> <1|0>`), so the pod buttons, the touchpad swipes and a
Bluetooth keyboard all work; sound effects are mixed in software and played through `aplay`. One
static musl binary (~490 KB), no SDL, no music.

## Getting it running

The repo has the port, not the game data: Doom needs an IWAD, and none is checked in (`*.wad` is
gitignored). Two steps on the Mac, with the Jet on the network as `jet.local`:

1. Build: `device/doom/build.sh` (needs `zig` at `/opt/homebrew/bin/zig` and `git`; it clones a
   pinned doomgeneric into `refs/` and leaves `device/doom/doom`).
2. Install: `device/doom/deploy.sh` copies the binary to `/usr/local/bin/doom` and the IWAD to
   `/usr/local/share/doom/` on the Jet. With no argument it uses the free shareware episode,
   `DOOM1.WAD`: from `~/Downloads` or `work/` when one is there, otherwise it fetches Debian's
   `doom-wad-shareware` package, checks the WAD against the shareware 1.9 sha1 and keeps it in
   `work/`. A retail `DOOM.WAD` / `DOOM2.WAD` you own works too: `deploy.sh path/to/DOOM2.WAD`
   and name it in `doomMode.args` (`/android-data/mainline/jet-app.json`).

Until both are in place the switcher lists **Doom** disabled, with `no binary` or `no WAD` after it;
the check runs each time the switcher opens, so nothing needs restarting afterwards. jet-app's
own install (`device/jet-app/deploy/install.sh`) is independent of this. A rootfs reinstall
(`kernel/rootfs/install.sh`) carries the binary along when it is built, never the IWAD: run
`deploy.sh` again.

    device/doom/build.sh                 # fetches doomgeneric (pinned) into refs/, builds ./doom with zig cc
    device/doom/deploy.sh [DOOM1.WAD]    # -> /usr/local/bin/doom + /usr/local/share/doom/ on the Jet's rootfs

Run it from the switcher (**Doom**, a jet-app mode) or over ssh for debugging:
`doom -iwad /usr/local/share/doom/DOOM1.WAD` (stdout has the engine's startup log and `jet:` lines).

## Controls

| Input | Doom |
|---|---|
| front button | Enter (menus) and Fire |
| rear button | Escape (menu / back) |
| touchpad swipes | arrow keys (a swipe is one short press) |
| keyboard | arrows move/turn, Space or Ctrl fire, E use, Shift run, Alt strafe, Esc menu, Enter, 1-7 weapons, F-keys, Tab map |
| front hold | jet-app's switcher: Doom pauses and stops drawing until it closes; picking another mode quits it |

Esc > Quit Game returns to the mode that was showing before.

## Sound

`i_jetsound.c` is the sound module (the slot `i_sdlsound.c` fills in doomgeneric's SDL build): a
mixer thread resamples the playing channels (8-bit mono lumps, mostly 11025 Hz; linear, 16.16 fixed
point) into 10 ms slices of 48 kHz stereo S16, the only format the speaker amp takes (docs/audio.md),
and writes them to an `aplay -D hw:0,0` child through a one-page pipe, so about 60 ms of audio sits
ahead of the speaker (pipe + aplay's 40 ms buffer). Volume/separation arithmetic is i_sdlsound.c's.
`sfx_volume` in Doom's own menu applies as usual; `-nosound` / `-nosfx` turn it off. If `hw:0,0` is
busy (jet-app speaking) aplay dies and Doom is silent until the retry two seconds later; an
`underrun!!!` line in the log means the mixer fell behind. No music: `DG_music_module` is a stub
(Doom's MUS needs an OPL or GUS-patch synth; a job for later).

## Options

- `-stretch`: fill the whole 428x240 glass (16:9) instead of a 320x240 4:3 picture centred;
  `-noscale`: 320x200 as is. Set in `doomMode.args` (`/android-data/mainline/jet-app.json`).
- `-jetd host:port` / `JETD=...`: where jetd listens (default `127.0.0.1:7777`); `-evdev` reads the
  keyboards in `/dev/input` directly instead (what also happens when jetd is unreachable).
- Everything else is Chocolate Doom's: `-warp 1 3`, `-skill 4`, `-nomonsters`, `-file x.wad`, ...
- Signals: `SIGUSR1` freezes (Doom paused, no frames, keys dropped), `SIGUSR2` resumes with every
  key released. jetd leaving remote mode (its shell, `Ctrl+Alt+Enter`) freezes the same way.

Doom writes `default.cfg` and savegames to its current directory; the mode runs it in
`/android-data/mainline/doom` (`doomMode.dataDir`), so they survive a rootfs reinstall.
