# Open questions and untested items

Each entry is something not understood, not verified, or not done. Rules that already exist
for working around a problem are in the other docs; this is the list of what is still unknown.

## Stability

- **Unexplained hard hang.** After a boot-time camera look succeeded, the Jet went dark on USB and
  WiFi; the SoC watchdog did not bring it back and the power button did nothing; only a battery
  pull recovered it (pstore lost). The normal ISS load logs no L3 error, so the camera path
  itself looks clean. Working theory: the watchdog did fire (warm reset) and the bootloader then
  hung (the boot lottery), which is indistinguishable from a dead device. Unproven.
- **Boot lottery.** Why the stock x-loader/u-boot sometimes hangs after a reset (~1 in 5 warm,
  ~1 in 7 cold software resets). Suspected DSS/RFBI or other state left enabled across the reset
  hanging a soft reset; the panel's `.shutdown` hook was not enough. A PMIC (TWL6032) watchdog
  would be the real answer for hard wedges: no mainline driver, register map not studied.
- Two early silent deaths of the stock-kernel bridge (5-8 min, no log) were never explained
  (candidates: USB plug/charger events, wl12xx power save). Not seen on mainline so far.
- ldo2 fails to register at ~26 s on most boots (`twl: Write failed (mod 4, reg 0x56)`,
  -ETIMEDOUT); init re-binds it. Root cause of the early i2c timeout unknown (MSECURE? bus
  contention at boot?).
- Module reload wedges: a panel module reload leaves omapfb unable to bind (-22) and once left a
  shell with irqs disabled; an ISS reload L3-faults. Proper fix (omapfb unbind ordering /
  ti-sysc handling) not attempted; reboot is the workaround.
- The fbcon/VT reboot deadlock with a manual-update panel is avoided by `CONFIG_VT=n`. A real boot
  console on the glass (panel built in + fbcon) would need that fixed (omapfb auto-update plus
  shutdown ordering). Not attempted.

## USB

- **USB link drops on the host side.** The ECM gadget has deactivated with VBUS present and the
  UDC "not attached"; a Jet-side unbind/rebind does not help, a physical replug does. One cause
  was over-current (fixed by the charge policy); drops also coincided with the host display
  sleeping, so host port power management is suspected. After repeated plug cycles the host
  sometimes stops enumerating the Jet at all (try another port/cable). Not fully characterised.
- Earlier "hardware connection lost" flaps on the stock system pointed at the pod's micro-USB
  jack; never confirmed or cleaned.
- `fastboot reboot`/`continue`/post-flash hang in the stock u-boot: cause unknown;
  `fastboot reboot-bootloader` (PRM warm reset path) untested.

## Power

- Whether the original pack's protection board behaves with the 500 mAh replacement cell under
  the 500 mA charge current (charging works; thermal/NTC behaviour not studied).
- The DT `simple-battery` says 400 mA constant charge while the policy programs 500 mA; which the
  cell should get is unresolved.
- The 1008 MHz OPP voltage is out of the TWL6032 SMPS range; capping at 800 MHz is a suggestion,
  not applied in the DT.
- Power cost of the touchpad sleep-interval setting (1/1/1 vs stock 1/5/5) not measured.

## Display

- Why the Kopin needs its init table to land only after DISPC has the LCD config is understood;
  whether `pwm_rearm=1` (re-program the PWM after every frame; stock does it once) is still
  needed is not. A pale "white stripe" was seen once after a partial re-init. The experiment
  knobs and `pio_test` hook could be dropped once stable.
- Register readback over RFBI returns the address word just written (the Kopin does not drive
  the bus on reads, or the OMAP read cycle needs a different sequence); without the A230
  datasheet this stays unexplained. The datasheet on disk (`refs/docs/`) is the A220 sibling.
- Physical location of the A230 ASIC (engine PCB vs display flex) and whether BT.656 input is
  reachable: needs a teardown.
- Stock intended the Kopin clock at 27.43 MHz "to minimise harmonic interference with the GPS
  antenna"; the stock registers actually ran 36.57 MHz, which we copy. Irrelevant until GPS.

## Camera / vision

- Image-diff scene confirmation for "live look" is **not done**: the gyro "new view" event is the
  only trigger. Plan: 32x24 luma diff with brightness normalisation and a running noise floor,
  rate-limited by the ~7 s describe cost. Camera streaming has hang history, so it was deferred.
- Continuous streaming (not single snapshots) to the host, and frame rates over USB, untested.
- Exposure/AWB: frame 2 after stream start is dark and green; 6 skipped frames is empirical.

## Audio / voice

- TFA9895 runs untuned (no NXP DSP config); whether the closed `climax` config can be replayed
  from the stock system dump is unexplored.
- aplay drain latency (~3 s for a 1 s clip) not optimised.
- Wake word on device: not started (needs a small embedded library; mics work now).
- Mic gain/quality with the pod worn, and 192 kHz vs 96 kHz capture, not compared.
- After the Jet's own speaker played the question into the mic, the VAD did not end the capture
  on trailing silence (ran to `max`); whether the floor measured during the earcon tail or the
  speaker's room echo keeps `rms` above `floor * 1.5` is not checked.

## Radios

- **BT/WiFi coexistence**: hci0 up pins WiFi rx at 1 Mbit/s, so the radio is off unless asked
  for. Coex tuning (wlcore/NVS/firmware parameters) not investigated.
- GPS and FM portability: the transport is TI shared transport (`ti-st`, removed from mainline
  but carriable) with `TIInit_*.bts`/`fm*.bts` firmware present. GPS needs a black-box capture of
  the closed "AI2" protocol the stock `navd`/`libgps` speak on `/dev/tigps` (strace on Android
  under open sky) and a replay daemon; FM needs the removed `wl128x` fmdrv carried. Neither started.
- WiFi throughput with the 2.4 GHz antenna placement vs the stock system on the same spot not
  compared; signal is typically -60 to -70 dBm.
- The MFi coprocessor (i2c3 0x11) is only useful with a closed Apple stack: ignored.

## Sensors / input

- Glance threshold and IR-pulse tuning with the pod worn is calibrated per user only; the IIO
  driver exposes `calibrate` but not ppcount/pdrive as the stock pdata did.
- Touchpad thresholds need tuning worn normally (calibration exists; the defaults are a guess).
- Tap detection is implemented in jet-ofm (`tap_key`) but off by default and unverified in use.

## Project

- The navigation (rear ascends to the switcher, front hold jumps to it, jetd's dead-man chooser
  when the app is gone) has been exercised by the author but not by a second person.
- Personalisation vs generic client: device settings live in `mainline/jet-app.json` and flag
  files, host tools read env vars; a documented "bring your own services" path for a second
  person has not been exercised.
- jetd died once, without a log line, at the moment a Bluetooth keyboard reconnected (191 s after
  boot). Not reproduced after the hotplug poll-ordering fix; a fatal-signal logger and the
  unstripped `agent/jetd.dbg` stay in place to catch a repeat. Docker on the device: ruled out.

## Voice turn (2026-10-22)
- First audio arrives ~6 s after the user stops talking with qwen-27b warm (0.6-3 s to the first
  token, then the first sentence), 10 s when llama-swap has to reload it after a vision `look`
  (the chat and vision models evict each other); a smaller chat model (`llm.chatModel`) is the
  obvious lever, keeping both resident the second, splitting long first sentences at commas
  after ~60 characters the third.
- qwen-27b and qwen-vision emit a short `reasoning_content` preamble (~100 characters, about a
  second) whatever the request says (`chat_template_kwargs.enable_thinking`, `reasoning_effort`,
  `/no_think` all tried); the device drops it. A server-side reasoning budget of 0 is untried.
- GNU `tar` on the Debian rootfs fails to load ("unexpected PLT reloc type 0x80"); other binaries
  are fine, busybox tar works. Cause unknown (loader vs this binary's relocations).
- qwen3-asr on a quiet room returned empty partials; hallucination on real background noise is
  untested.

## USB link drops (updated 2026-10-22 afternoon)
- The USB link to the host still drops with the controller in peripheral-only mode (two drops in
  one boot: 5 min and 45 min after boot; gadget logs "reset config / gether_disconnect", VBUS stays
  present, controller then sits in `b_idle` "not attached"). So the OTG/ID theory is not the
  whole story. From the Jet nothing recovers it: gadget UDC rebind, controller `mode` write and a
  driver unbind/bind all leave it in b_idle; the host never re-enumerates until a physical replug.
  The host's own USB log could not be read without privileges. Next: try another host port or a
  powered hub, read the host log right after a drop, and a Jet-side VBUS session restart via the
  PMIC USB PHY if the musb driver exposes one.

## Memory corruption at camera stream start (2026-11-11, open, top reliability issue)

The intermittent jet-app SIGSEGV ("dies entering Describe", two weeks old, taken for a V8/JIT
bug) is **user-memory corruption coincident with a camera stream start**. Evidence from one boot
with `print-fatal-signals` on: four deaths, each within ~1.5 s of a stream start (three
`viewfinder started`, one cold snapshot `S` taken as a voice question arrived); three different
programs (node, busybox `init` loop, busybox `sleep`), all in valid code on corrupted data; the
garbage words are `0x02800280` / `0x03800380` = bytes `80 02 80 02`, i.e. dark UYVY pixels (the
first frame after a start is black). No kernel oops, no ISS error. Heat (86-91 C, no throttle),
audio and WiFi do not fit the timing or the signature.

**Proven the same evening that it is camera data, and that it reaches the page cache**: after a
node death during a scan, `ps` segfaulted on every run; the cached `/usr/bin/ps` differed from
the on-disk file (O_DIRECT read) in exactly bytes 0x8000-0xBFFF - four whole 4 kB pages - and
those pages held `80 02 80 02 ...`: dark UYVY. `echo 1 > /proc/sys/vm/drop_caches` restored it
(hash equal, `ps` runs). So a damaged *clean* file page keeps crashing its program until it is
evicted - the "stays crashy" of earlier episodes - and a damaged *dirty* page would be written
to disk. After any incident: drop caches, and prefer a reboot (anonymous memory of long-lived
processes may be hit too).

**Mechanism proven 2026-11-11 (after a hard reboot), `tools/issprobe`: 20 of 20 stream starts
overflow.** Six mapped 614400-byte buffers filled with 0xA5, only buffer 0 queued, one frame
dequeued: every time the never-queued buffer 1 was completely overwritten with dark UYVY, the
first frame carried the ERROR flag, and its line period was 2560 bytes (1280-wide). The physical
view (`/dev/mem`, CMA at 0xbf000000) shows image data contiguous from buffer 0 for exactly
1,843,200 bytes = 1280x720x2, the sensor's default mode: 1.2 MB past the buffer on every start,
across the gap after it, the next buffer and into the gap after that. Steady-state frames are
640-wide and clean; only the first frame of a stream is oversized. Cause in the code:
`iss_pipeline_enable` arms the CSI-2 context before the sensor's `s_stream(1)`, whose
`mt9m114_initialize()` streams 1280x720 before the 640x480 geometry is programmed; the context
has no frame-size limit.

**Fixed and flashed 2026-11-11** (overlay `omap4iss`): the CSI-2 context is enabled only after
every subdev has started (`defer_ctx`, a module parameter, default on; off restores the old
order for diagnosis); capture buffers are never smaller than 1280x960x2, so a wrong-mode frame
stays inside its plane; and a `0xdeadbeef` sentinel in the slack (4 kB after the expected frame,
4 kB at the plane's end) is checked at each buffer completion - a disturbed one is a ratelimited
kernel warning and an ERROR-flagged buffer. Verified with `tools/issprobe` on the flashed boot:
10 of 10 starts clean and 640-wide, sentinel silent; with `defer_ctx` off the warning fires and
the overrun stays inside the plane. Cost: ~110 ms more per stream start (first frame at ~280 ms),
7.2 MB of the 16 MB CMA while three buffers stream (five fit; nothing else allocates at stream
time; a 1280x960 capture needs the same). Revert: `work/iss-fix/boot-emmc-stock.img` by `dd`, or
the `camera-off` marker. What remains of this section below is the history of the diagnosis.

Still open from it: 1008 MHz without the MPU voltage step; jetd's `play_close` deadlock; jetd's
`vf_frame` serving frame 0 of a stream, which is black (auto-exposure: mean luma 10 at frame 0,
99 at frame 1, settled by frames 6-9, ~0.6 s after STREAMON).

**Exposure** (measured the same day): `/dev/video0` has no controls; the sensor subdevs do -
`auto_exposure` (auto/manual) and AWB on the ifp subdev, `exposure` (1..1012 lines) and
`analogue_gain` (1..511) on the pixel array, readable live while AE runs. On the desk AE sits
at 984 lines and gain 248: near the maximum, averaging the whole frame to luma ~124, which is
what blooms small bright detail on a dark surface. No kernel change is needed to take a metered
manual shot: let AE settle, read the two values, switch to manual, write a reduced gain,
capture, restore auto. AE target, gain caps and the metering window exist in the chip
(`CAM_AET_TARGET_AVERAGE_LUMA`, `CAM_AET_AE_MAX_VIRT_AGAIN`, `CAM_STAT_AE_INITIAL_WINDOW_*`) but
not in the mainline driver: each is a small patch to a built-in driver, i.e. a new zImage.

The hypothesis as first written: the sensor is powered fully off between streams, so
`mt9m114_initialize()` runs at every start and briefly streams at its power-on geometry
(1280-wide) with the CSI-2 receiver already armed and no frame-size limit in the context
(`iss_csi2.c`); a 1.8-2.5 MB frame lands in a 0.6 MB buffer. The ISS buffers come from a 16 MB
CMA area in HighMem that user pages share (`CMA_ALIGNMENT=8`: a 424 kB gap after each buffer),
so the overflow hits whatever process owns the neighbouring pages. Alternatives: stale DMA at
stop / CMA migration race; 1008 MHz without the MPU voltage step (real, but does not explain
the pixel-shaped garbage).

Decisive experiments, cheapest first: (1) a V4L2 test that maps three buffers, fills them with
0xA5, queues only buffer 0, streams one frame and checks whether buffers 1-2 were written
(userspace only, no reboot); (2) core dumps for node/init and a look at the page around the bad
pointer (UYVY run, and its stride: 1280 = oversized frame, 640 = stale address); (3) allocate
`sizeimage` + 2.5 MB slack in `iss_video.c` and log a dirty tail; (4) a dedicated no-map
reserved-memory pool for the ISS; (5) `scaling_max_freq` 800000 regardless.

Related, found on the way: jetd deadlocks in `play_close` (`waitpid` on an `aplay` whose pipe
never sees EOF) when its client dies mid-playback - the glasses stay dead until that aplay is
killed; `vf_frame` serves a snapshot from the very first frame of a stream with no skip, which
is the "image is completely black" scan failures. Mitigations in jet-app meanwhile: the launcher
restarts node after a death by signal; the operator takes a frame ahead of a question only
while the camera is already streaming (`operator.hold`).
