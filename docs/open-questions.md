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

- The mode chooser (front hold) has been exercised by the author but not by a second person; the
  WiFi-via-QR setup item is a placeholder.
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
