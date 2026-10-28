# Kernel reference (mainline 6.18)

## Build system

- `kernel/Dockerfile`: Debian bookworm + `crossbuild-essential-armhf`. Image `jet-kbuild`.
- Source lives in the Docker named volume `jet-linux-src` because the Linux tree has
  case-colliding filenames that break on a case-insensitive Mac disk. Output goes to
  `refs/linux/out-6.18/` (zImage, `.config`, dtb, the four overlay `.ko`s, `modules.tar`).
- `kernel/build.sh` steps:

| Step | Does |
|---|---|
| `fetch` | downloads `linux-6.18.tar.xz` into the volume (once) |
| `defconfig` | copies the overlay, runs `patches/apply.sh`, `omap2plus_defconfig` + `kernel/jet.config` fragment, `olddefconfig` |
| `zimage` | copies `omap4-recon-jet.dts`, `patches/twl4030-pwrbutton.c`, the overlay; apply.sh; builds zImage + dtbs + the four modules; strips and exports |
| `module` | rebuilds only the four overlay modules (~20 s) |
| `modules` | whole module tree -> `modules.tar` (stripped, `lib/modules/<ver>`, ~18 MB, no `build` link) |
| `sh` / `clean` | shell in the container / drop the volume |

Full build ~4 min, incremental ~20 s. Then `kernel/mkboot.sh` packs `boot-mainline.img`
(RAM boot) and `boot-emmc.img` (flash) into `work/mainline/`.

## Config fragment `kernel/jet.config` (why the non-obvious lines exist)

- `omap2plus_defconfig` has USB, IIO, EVDEV, CPUFREQ_DT, CLK_TWL, RTC, PWM_TWL as modules;
  `=y` in the fragment is required or the MUSB glue, phy, GPADC, charger silently become modules.
- `CONFIG_USB_G_SERIAL=n`: the legacy gadget grabs the UDC before the configfs gadget.
- `CONFIG_VT=n`, `FRAMEBUFFER_CONSOLE=n`: fbcon's deferred work deadlocks a manual-update panel at
  reboot (fbcon is forced on while VT is set).
- `CONFIG_SERIAL_8250_CONSOLE` unset: with no `console=` the kernel registered ttyS0 (UART2, not
  wired) and spent ~20 s replaying the log into an unclocked UART, pushing the panel to 44 s.
- `HW_RANDOM_OMAP=y`: dropbear otherwise waits minutes for the crng.
- `PSTORE_RAM` + `PANIC_TIMEOUT=5`; `OMAP_WATCHDOG` + `WATCHDOG_NOWAYOUT`.
- `VIDEO_OMAP3=y` only to pull videobuf2/v4l2-fwnode built in; it never probes. `VIDEO_OMAP4=m`
  (ISS), `VIDEO_MT9M114=y`, `TSL2772=m`, `INPUT_JET_OFM=m`, `FB_OMAP2_PANEL_KOPIN_A230=m`.
- Sound and Bluetooth are modules (userdata tree); `CONFIG_DRM=n` for size.

## Modules and firmware on userdata (the boot partition is 8 MB)

- Four modules ride in the initramfs: `panel-kopin-a230.ko`, `jet-ofm.ko`, `omap4-iss.ko`,
  `tsl2772.ko`. Init loads them in the order ISS -> tsl2772 -> jet-ofm -> panel (panel last so a
  display hang is caught by the already-armed watchdog), gated by safe level and flags.
- Everything else: `modules.tar` untarred at `/android-data/mainline/modules`; init symlinks
  `/lib/modules/$(uname -r)` there, in the initramfs and in the rootfs chroot (so `modprobe` works
  over ssh; busybox modprobe has no `-d`).
- Firmware: `firmware_class.path` = `/mnt/data/mainline/firmware` (BT `TIInit_*.bts` under
  `ti-connectivity/`). WiFi firmware (`wl128x-fw-5-sr/mr.bin`, NVS renamed to `wl128x-nvs.bin`,
  `regulatory.db(.p7s)`) is in the initramfs `/lib/firmware` because wlcore is built in.

## Overlay (`kernel/overlay/`, copied over the tree) and `patches/apply.sh` (idempotent sed/perl edits)

| Piece | Why it exists |
|---|---|
| `include/video/omapfb_rfbi.h`, `dss/rfbi.c` | RFBI was removed from omapfb in 5.3 and from omapdrm entirely. 4.19's rfbi.c re-added with: an ops API like `omapdss_dsi_ops`, manual-update kick via `dss_mgr_start_update`, FIFO handcheck on (otherwise SYNC_LOST every frame), stock transfer order (DISPC first, then PIXEL_CNT, then enable, then ITE as a separate write), pck_div 5 from the DSS fclk, and **`rfbi_config_lcd_manager` writing the LCD config straight to DISPC**. The last one was the boot-time root cause: omapfb's apply layer skips stall-mode managers, so the RFBI pad mode/stall/GPOUT bits only reached hardware at the first frame, after the panel init table had been pushed over an unconfigured bus |
| `displays/panel-kopin-a230.c` | Port of the stock panel driver: init table, bus timings, power sequence (power gpio -> clock -> reset held low 50 ms under clock), PWM backlight registers, manual-update display so `/dev/fb0` + `OMAPFB_UPDATE_WINDOW` behave as on stock. Sets the auxclk4 parent mux (cold-boot fix). Keeps experiment knobs as module params and a `pio_test` sysfs hook |
| apply.sh 1-5 | plumbs rfbi into omapfb_dss.h, dss.c, core.c, Kconfig/Makefile (`FB_OMAP2_DSS_RFBI`, `FB_OMAP2_PANEL_KOPIN_A230`) |
| apply.sh 6-7 | ti-sysc ordering: the dss@0 platform device is created when the interconnect target module probes, after `omapdss_init_of` looked for it. Both init calls moved to late_initcall; dss_probe populates its children and component matching recurses through `target-module` devices |
| apply.sh 8 | omapfb enabled runtime PM on the dss core after dispc/rfbi were active -> the DSS fclk could be gated under an active DISPC -> L3 errors and hard hangs at probe. Enable it before the children (as omapdrm does) |
| apply.sh 9 | DISPC_CONFIG bit 17 (FIFOFILLING) for the stall-mode LCD manager, as the stock kernel sets unconditionally |
| `drivers/input/misc/jet-ofm.c` + apply.sh 10 | touchpad: same init sequence as the vendor driver (incl. the AMF patch), threaded irq on MOTION, sums deltas every 10 ms until 150 ms idle or 400 ms; reports REL_X/REL_Y plus swipe keys (thr_x/thr_y, default 20), optional tap key; sleep registers 0x8a..0x8c = 1/1/1 (stock 1/5/5 missed first swipes). Re-reads its irq with `of_irq_get` because the i2c core drops it on re-probe |
| `drivers/media/platform/ti/omap4iss/` + apply.sh 11 | ISS left mainline in 6.7; the v6.6 staging driver refitted to 6.18 V4L2 (fh from `file_to_v4l2_fh`, vb2 `q->lock`, `v4l2_subdev_state_get_format`), platform data replaced by DT/fwnode (child of `target-module@52000000`, syscon CONTROL_CAMERA_RX at padconf offset 0x68, clocks iss_fck/iss_ctrlclk), `iss_reset()` neutralised (ti-sysc owns SYSCONFIG; a SOFTRESET from the driver faults on the L3), pm_runtime held for the driver lifetime, lane positions as runtime knobs |
| `arch/arm/mach-omap2/omap4-restart.c` + apply.sh 12 | reboot reason in SAR RAM; cold reset for plain reboots, warm only for `bootloader`/`recovery` (see boot.md) |
| `drivers/power/supply/twl6030_charger.c` | sets EN_CHARGER\|EN_LINCH (the in-tree driver never enables the linear charge stage) and re-enables in the 10 s watchdog work when VBUS_DET is set but EN_CHARGER is not (unplug/replug can leave the charger off) |
| `sound/soc/ti/omap-mcbsp.c` | simple-audio-card never calls `set_clkdiv`, leaving CLKGDV=0 (bit clock = 24.576 MHz, 512 bits/frame) which the TFA9895 cannot lock to. In master mode with no clkdiv, derive one so a frame is exactly wlen x channels bit clocks |
| `sound/soc/ti/omap-dmic.c` | omap-dmic requires a machine driver to set sysclk/clkdiv ("invalid out frequency: 0Hz"). Defaults derived from the fck: 19.2 MHz -> 2.4 MHz mic clock (3.84 MHz at 192 kHz), 24.576 MHz -> 3.072 MHz |
| `patches/twl4030-pwrbutton.c` (replaces the in-tree file) | TWL6030-class PMICs read STS_HW_CONDITIONS at 0x21 (active low) and the irq must be unmasked by the consumer; `linux,code` from DT |

## ISS rules (hard-won)

- Never `rmmod`/`insmod` the ISS module on a running system (ti-sysc + tainted state -> L3 error
  + wedge). Change, rebuild, reboot.
- Never read ISS (or any idle module's) registers via `/dev/mem` without an active stream: the
  module is idled -> L3 abort -> hang. `work/camera/sweep.sh` only reads while streaming.
- The CSI-2 complex-IO reset only completes while the lanes read LP-11, which a powered idle
  MT9M114 does not provide. Hence pull-ups on the csi21 pads, sensor `autosuspend_delay_ms=0`
  (fully off between streams), and immediate power-off at stream stop. With that, back-to-back
  captures work (1280x960 at ~21.5 fps to memory).
- First register read after insmod logs one benign L3 warning. The sensor's `-ENOIOCTLCMD`
  from `s_stream` is not an error.

## DTS highlights (`kernel/omap4-recon-jet.dts`)

- `recon,jet` + `ti,omap4430`; 1 GiB memory; ramoops at 0xbd000000 (1 MiB); bootargs carry
  `omap_wdt.early_enable=1 panic=5`.
- PMIC `ti,twl6032` at i2c1 0x48 with pwrbutton (`KEY_END`), charger (`ti,twl6032-charger`),
  RTC, ldo1..ldousb/vio, usb comparator, pwm + pwmled, gpadc (`ti,twl6032-gpadc`),
  `#clock-cells = <1>` (CLK32KG via `regulator-fixed-clock` always-on).
- mmc1 disabled (pads in safe mode), mmc2 = eMMC, mmc5 = `ti,wl1283` (ref/tcxo 26 MHz, WLAN_EN
  via `vwl1271` fixed regulator, irq gpio 53). uart2 = `ti,wl1283-st` bluetooth (enable gpio2 14).
  uart3 disabled (its RX pad is the front button).
- `&dss`, `&rfbi` (`ti,omap4-rfbi`, 22 RFBI pads), panel `recon,kopin-a230` with power/reset/
  clk-en/a16 gpios and clocks "pixel" (auxclk4_ck), "pixel_src" (auxclk4_src_ck), "per_m3".
  Clock rates are set by the driver: `assigned-clocks` on the panel node deferred the probe forever.
- i2c2 (400 kHz): lsm9ds0-imu 0x1d, lsm9ds0-gyro 0x6b, `amstaos,tmd2771` 0x39
  (`led-max-microamp = 25000`, the 100 mA default saturated), lps25h 0x5d; all `vdd/vddio = ldo4`.
- i2c3: `nxp,tfa9895` 0x34, `cam_switch` fixed regulator (gpio6 15). i2c4: tmp102 0x49,
  `onnn,mt9m114` 0x48 (auxclk1 = sys_clkin/2 19.2 MHz, 1 data lane, link 307.2 MHz, reset gpio3
  19 active low), `partron,ms37c01a` 0x53 (irq gpio6 16, standby gpio2 17, powerdown gpio2 5).
- `ti,omap4-iss` under `target-module@52000000`; gpio-keys BUTTON_1 (gpio5 15, active low);
  pwm-leds `jet:white:power`; `simple-battery` 500 mAh 4.2 V; `simple-audio-card` with two
  dai-links (McBSP2 -> tfa9895, DMIC -> dmic-codec); dmic pins 0x110/0x112.

## Other pitfalls

- A panel module reload leaves omapfb unable to rebind ("Failed to enable display", -22) and has
  wedged shells with irqs disabled: reboot for panel code changes; use the module-param knobs
  for experiments.
- Reading McBSP2 registers with the module unloaded gives an L3 "TARGET ABE" external abort.
- `dmesg -c` also wipes the 5 s userdata snapshot: do not use it before a test.
- The fw_devlink "dependency cycle" lines for rfbi <-> panel are benign.
