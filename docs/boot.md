# Boot reference

## eMMC layout (what boots from where)

| Partition | Holds | Reached by |
|---|---|---|
| p8 `boot` (8 MB) | mainline: `work/mainline/boot-emmc.img` (zImage + appended DTB + xz initramfs with the `/etc/jet-emmc` marker) | default boot, `reboot2`, `adb reboot` from Android |
| p7 `recovery` (8 MB) | rooted stock Android boot image (stock kernel, `ro.secure=0`, `/sbin/su`, adb) | `reboot2 recovery` from mainline |
| p1/p2 | stock x-loader + u-boot, untouched | |

The stock recovery is backed up in `refs/backup/`. Both images were written with `dd` and
read back for a sha256 match; never use `fastboot flash` (see below).

## u-boot facts (board/omap4430jet/jet.c in `refs/reconos/u-boot`)

- The reboot reason is a C string at public SAR RAM `0x4a326000 + 0xA0C` (15 bytes):
  `bootloader`, `recovery`, `reboot`, `normal`, `off`, `ChargeShutdown`.
- `bootloader` (fastboot) and `recovery` are honoured **only after a warm reset**
  (PRM_RSTST bit 1 set). `reboot` works after any reset and selects a normal Android-style boot.
- After a cold reset with no reason string, u-boot treats USB power as a charger insert: Android
  boots in charger mode (`bootmode=1`, screen off, adb late or absent). Without USB and without
  the power button held it powers off again, which is why a short press "does nothing".
- SAR RAM survives both warm resets and the cold *software* reset; only a battery pull clears it.
- There is **no key combo** for fastboot (the power-hold hack is compiled out). Fastboot is
  reached only via the reason string.
- u-boot fastboot: `fastboot boot <img>` RAM-boots an image (up to ~496 MB) without flashing.
  After `fastboot flash`, `fastboot reboot` or `fastboot continue` the loop stops answering
  and needs a power cycle. Rule: one `fastboot boot` per session; flash with `dd` from Linux.
  A `fastboot boot` issued < 5 s after fastboot enumerates can hang: kill and reissue.

## Reset types and `reboot2`

The mainline kernel's restart (`kernel/overlay/arch/arm/mach-omap2/omap4-restart.c`) writes
the reboot command to SAR RAM, then:

| Command | Reset | Lands in |
|---|---|---|
| `reboot2` (= `reboot`) | **cold** software reset (PRM_RSTCTRL bit 1, apply.sh step 12) | normal boot of `boot` = mainline |
| `reboot2 bootloader` | warm | fastboot |
| `reboot2 recovery` | warm | `recovery` = rooted Android with adb |

`tools/reboot2` exists because busybox `reboot` cannot pass a RESTART2 string. From the
chroot use `/usr/local/bin/reboot2` (the initramfs `/bin` is not visible there). From Android,
`adb reboot` (warm + "normal") returns to mainline. Plain reboots are cold on purpose: warm
restarts from a display/camera-active mainline hung the next boot about 1 in 5 times.

## The boot lottery (rule)

A reset that lands in the stock x-loader/u-boot sometimes hangs before the kernel: black glass,
nothing on USB, no watchdog recovery. Seen on ~1 in 5 warm resets and about 1 in 7 cold
software resets. The hardware watchdog uses a warm reset, so a wedge can look like "watchdog
useless" when it is really the bootloader hanging on the way back. Only a power cycle (battery
pull or `ChargeShutdown`-style power-off) recovers it. Plan test loops around this.

## Boot guard (eMMC image only; RAM boots never count)

`/android-data/mainline/bootfail` (the initramfs sees userdata at `/mnt/data`) counts boots that
did not become healthy, i.e. jetd still alive 60 s after init (or a panel-less safe boot reaching
the end of init).

| Count | Safe level | Effect |
|---|---|---|
| 1 | 0 | normal |
| 2 | 2 | no camera (ISS) and no touchpad modules |
| 3 | 3 | no panel either (ssh only) |
| 4 | | `reboot2 bootloader` (fastboot) and the count resets to 0 |

Front button held during init forces level 2. `mainline/safe=N` forces a level and skips
counting. Killing jetd and rebooting before the 60 s mark counts as a failed boot.

## Userdata flags (`/android-data/mainline/` in the chroot, `/mnt/data/mainline/` in the initramfs)

| File | Meaning |
|---|---|
| `bootfail`, `safe` | boot guard (above) |
| `panel-off` | do not load the panel module |
| `camera-off` | do not load the ISS module |
| `charge-off` | disable init's charge policy loop |
| `bt` | power the Bluetooth radio at boot (the stack always starts; jet-app's System > Bluetooth keeps this in step) |
| `hub` | comma-separated hub host list jetd dials (default: the USB peer pool) |
| `usbnet` | first three octets of the USB subnet (default in init) |
| `ofm-args` | insmod args for jet-ofm (written by pad calibration, e.g. `thr_x=14 thr_y=16`) |
| `glance` | glance thresholds "on off" (written by glance calibration) |
| `backlight` | saved backlight level (0..1023) |
| `view` | "new view" thresholds "deg still_ms" |
| `panel-args`, `panel-delay`, `panel-post` | panel module args, seconds to wait before loading it, shell snippet run after |
| `modules/`, `firmware/` | module tree and firmware (see kernel.md) |
| `pstore/`, `dmesg.txt`, `init.log` | previous-boot crash record and 5 s log snapshots |

## Flashing procedure (from mainline)

```
scp -O work/mainline/boot-emmc.img root@jet.local:/tmp/
ssh root@jet.local 'dd if=/tmp/boot-emmc.img of=/dev/mmcblk1p8 bs=1M conv=fsync && sha256sum /tmp/boot-emmc.img && dd if=/dev/mmcblk1p8 bs=1M count=8 | head -c $(stat -c %s /tmp/boot-emmc.img) | sha256sum'
ssh root@jet.local reboot2
```
The two hashes must match. `mkboot.sh` warns if the image exceeds 8,388,608 bytes. Current
images are ~7.45 MB with stripped tools and an xz initramfs (`--check=crc32`, required by
CONFIG_RD_XZ). The chroot has no sftp server, so a default `scp` fails with "sftp-server: No such file": use `scp -O` (legacy protocol) or `ssh 'cat > f' < f`.

## RAM boots (new drivers are developed this way)

```
reboot2 bootloader              # or: adb reboot bootloader from Android
fastboot boot work/mainline/boot-mainline.img
```
`kernel/boot.sh` wraps the fastboot/watch part; `kernel/cycle.sh` does reboot -> fastboot ->
boot -> dmesg grep in one go. A hung RAM boot never touches eMMC. Image format: Android boot
image v0, kernel at 0x80008000, ramdisk moved to 0x82000000 (the stock 0x81000000 sits inside
the decompressed ~17 MB kernel), empty cmdline (u-boot supplies bootargs; ATAG compat merges
them with the DT bootargs). `CONFIG_PANIC_TIMEOUT=5` so a panic falls back to eMMC.

## Boot timeline (eMMC, healthy)

Watchdog armed 1.3 s, ISS probed ~2.9 s, panel ~3.8 s, jetd started right after, boot log
visible on the glass from ~4 s (replayed at 80 lines/s), wlcore associated ~6 s, ssh ~21 s.
`omap_wdt` is NOWAYOUT and fed by busybox `watchdog -t 10 -T 60`; `omap_wdt.early_enable=1`
and `panic=5` are in the DT bootargs. ramoops at 0xbd000000 (1 MiB) survives warm resets only.

## Cold-boot pitfalls (rule: test every bring-up step after a real power cycle)

Anything that only ever ran after Android or u-boot had configured the hardware is suspect.
RAM boots inherit PMIC and SCRM state; eMMC boots after a power cycle do not. Known cases:

| Hardware state | Who set it on stock | Mainline fix |
|---|---|---|
| SCRM AUXCLK4 source mux (display clock). Reset default is sys_clk 19.2 MHz -> noise on the glass | Android/u-boot | panel driver `clk_set_parent(auxclk4_src_ck, dpll_per_m3x2_ck)` before `clk_set_rate` (DT clock "pixel_src") |
| PMIC CLK32KG 32 kHz output (WL1283 slow clock). Off -> "mmc4: Failed to initialize a non-removable card", wlcore init timeout | Android | DT `regulator-fixed-clock` "clk32kg" always-on (clk-twl) |
| Charger EN_LINCH (linear charge stage). Off -> cell discharges while on USB | Android driver | overlay twl6030_charger sets EN_CHARGER\|EN_LINCH and re-enables while VBUS is present |
| u-boot's charger limits (VICHRG 1.5 A code, CINLIMIT unlimited) stay if the kernel driver's enable path does not run | u-boot (every cold boot) | init charge policy loop rewrites CINLIMIT/VICHRG (see power.md) |
| PMIC PWRON interrupt masked (mainline twl6030 irq has no per-irq unmask) | | pwrbutton overlay unmasks INT_MSK_LINE_A / MSK_STS_A in probe |
| ldo2 (touchpad rail) fails to register at ~26 s ("twl: Write failed (mod 4, reg 0x56)") on most boots | | init re-binds the regulator; cause open |

CCF caches clock hardware state at init, so a `/dev/mem` poke plus module reload cannot
validate a clock fix: only a real power cycle proves it.
