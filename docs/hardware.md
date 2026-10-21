# Hardware reference

Established facts about the Recon Jet (board revision "JET_V2", codename "sun"). Sources: the
stock 3.0 kernel board files (`refs/reconos/`), register dumps taken on the stock kernel, and
mainline bring-up. GPIO numbers are Linux global numbers; "gpioN line M" is the mainline bank.

## Core

| Item | Fact |
|---|---|
| SoC | TI OMAP4430 ES2.3, dual Cortex-A9, GP (non-secure) part; OPPs 300/600/800/1008 MHz |
| RAM | 1 GiB (1,018,180 kB usable on mainline; stock showed 627 MB after carveouts) |
| Storage | 8 GB eMMC on mmc2 host (8-bit, gpmc_ad0-7 mode 1, vmmc = ldo5). Mainline names it `mmcblk1`, stock `mmcblk0` |
| Machine | `recon,jet` / mach-types OMAP4_JET 4413. No SD slot, no vibrator on V2 |
| USB | MUSB peripheral (UTMI) + TWL6030 USB phy. Stock VID 0x2523 (PIDs D208 mtp, D209 mtp+adb, D100 fastboot). OMAP ROM USB boot = 0451:d00f |
| UARTs | UART3 (`ttyO2`) is the bootloader/stock console but its RX pad is the front button on the Jet; UART2 is the BT/GPS/FM transport. No serial console is wired out |
| 1008 MHz OPP | asks for more MPU voltage than the TWL6032 SMPS table allows ("OUT OF RANGE" warning); 800 MHz is the practical ceiling |

## PMIC: TWL6032 (i2c1, IRQ sys_nirq1)

| i2c address | Block |
|---|---|
| 0x48 | ID0: STS_HW_CONDITIONS 0x21 (PWRON bit), CLK32KG_CFG at 0xBC/0xBD/0xBE (0xBE=1 keeps the 32 kHz output on) |
| 0x49 | ID1: PIH interrupt regs INT_STS_A..C 0xD0-0xD2, MSK_LINE 0xD3-0xD5, MSK_STS 0xD6-0xD8; charger 0xE0..; fuel gauge 0xC8..0xCB; TOGGLE1 0x90 |
| 0x4a | ID2 |

LDO map (from the stock board-44xx-power.c): ldo1=vpp, ldo2=vaux1 (touchpad 2.9 V), ldo3=vaux3,
ldo4=vaux2 (sensors/audio switch), ldo5=vmmc (eMMC), ldo6=vcxio, ldo7=vusim, ldoln=vdac,
ldousb=vusb. ldo2/3/4 must be always-on or the sensors go -EREMOTEIO 30 s after boot.
Other PMIC functions in use: GPADC, RTC, PWM2 (power LED), USB comparator, power button, charger.
CLK32KG is the WL1283 slow clock: WiFi does not come up without it (see boot.md).

## Display: Kopin A230 over RFBI

| Item | Fact |
|---|---|
| Panel | Kopin WQVGA 0.2" AMLCD, 428x240 (436x246 incl. orbit), driven by the Kopin A230 ASIC |
| Bus | OMAP RFBI (MIPI DBI type B / Intel-80), 16 data lines. Pads dpm_emu3-19 mode 4 and usbb2_ulpitll_dat3-7 mode 6, all input-enabled (0x104/0x106) |
| GPIOs | 52 (gpio2 20) panel power, 42 (gpio2 10) reset, 41 (gpio2 9) clock enable, 163 (gpio6 3) A16 |
| Clock | auxclk4 on pad fref_clk4_out (WKUP domain, 0x4a31e05c) = dpll_per_m3x2 (256 MHz) / 7 = **36.57 MHz**. SCRM AUXCLK4 = 0x00060104 |
| DSS | fclk = dpll_per_m5x2 170.67 MHz, pck_div 5; DISPC_CONTROL 0x8908 (RFBI/stall, TFT, 16 lines); RFBI_CONFIG0 0x00300023; bus timings from MCLK_PS 40000 |
| Protocol | 16-bit register writes with A16 high only during the command cycle; frame = command 0x0000 then a DISPC transfer; 0xB3=3 acts as commit of the init table |
| Backlight | A Kopin ASIC PWM register (regs 0x12/0x13/0x1D/0x1E/0x1F), **not** a PMIC PWM. Backlight class `kopin-a230`, 0..1023; 16 is the only level that truly dims, 208 is the lowest readable indoors, 408 is the driver default |
| Update | manual-update only: pixels reach the glass via `OMAPFB_UPDATE_WINDOW` (ioctl 'O'/54). Plain fb writes and pan do nothing |
| Framebuffer | mainline exposes `/dev/fb0` 428x240 RGB565 (stride 856); stock used 32-bit XRGB |
| Rate | 54.7 fps full-frame ceiling (17.3 ms RFBI transfer + 0.9 ms fill) |

The A230 also accepts BT.656 digital video (unused). Its physical location (engine PCB vs display flex) is unconfirmed.

## Touchpad

Partron MS37C01A optical finger module (ST VD5377 sensor), i2c4 0x53 (mainline bus `i2c-3`,
device `3-0053`). MOTION gpio 176 (gpio6 16, kpd_row4 pad 0x18a), STANDBY gpio 49 (gpio2 17),
POWERDOWN gpio 37 (gpio2 5), supply ldo2 2.9 V. Registers: 0x00 rev, 0x21 motion, 0x31 feature
count, 0x47 exposure, 0x8a..0x8c sleep check intervals. The stock driver emitted only four
swipe keys; it never detected taps.

## Camera

MT9M114 (1280x960, fixed focus) on i2c4 0x48, chip id 0x2481, CSI-2 to the OMAP4 ISS.
MCLK = auxclk1 on pad fref_clk1_out, forced to sys_clkin/2 = 19.2 MHz with the sensor PLL on
(link 307.2 MHz). Reset gpio 83 (gpio3 19, active low), power switch gpio 175 (gpio6 15,
`cam_switch` 2.8 V). Lanes: clock on csi21 dx0/dy0 (position 1), data on dx1/dy1 (position 2),
continuous clock; the dx2/dy2 pads are also muxed with pull-ups. Optics: sharp from ~0.5 m to
infinity; a label is readable at 30 cm; small objects at 15-25 cm need a clip-on macro lens.
The stock camera path ran on the Ducati M3 (OMX); mainline drives the ISS directly.

## Sensors

| Device | Bus / address | Notes |
|---|---|---|
| LSM9DS0 accel/mag | i2c2 0x1d (mainline `i2c-1`) | 0x1d identifies the V2 board; INT1/INT2 gpio 59/60 |
| LSM9DS0 gyro | i2c2 0x6b | scale 0.000153 rad/s/LSB; used for the "new view" detector |
| LPS25H pressure | i2c2 0x5d | raw x 2.4414e-5 kPa |
| APDS9900 prox/ALS ("glance") | i2c2 0x39, ID 0x29 | INT on gpio 56 (unused, polled). ALS reads 0 inside the pod |
| TMP102 board temp | i2c4 0x49 | hwmon |
| MFi coprocessor | i2c3 0x11 | Apple iAP; unused |

## Audio

No twl6040 and no ABE codec. Speaker: NXP TFA9895 DSP amp on i2c3 0x34 (revision reg 0x03 =
0x12) fed by McBSP2 I2S (mcbsp2 pads, McBSP master). Mics: OMAP4 DMIC block, clock out on
abe_dmic_clk1 (pad 0x110), data on abe_dmic_din1 (pad 0x112). See audio.md.

## WL1283 (WiFi / BT / FM / GPS)

WiFi over SDIO on mmc5 (sdmmc5 pads mode 0), WLAN_EN gpio 43 (gpio2 11), WLAN_IRQ gpio 53,
ref/tcxo clock 26 MHz, slow clock = PMIC CLK32KG. BT, FM and GPS share UART2 behind TI's
shared transport; BT_EN gpio 46 (gpio2 14). Firmware: `wl128x-fw-5-sr/mr.bin`, NVS
(`wl1271-nvs.bin` on the stock system, carries the MAC), `TIInit_*.bts` for BT. GPS fixes are
computed on the chip and spoken over a closed "AI2" protocol by stock user space (not ported).

## Buttons and LEDs

| Control | Fact |
|---|---|
| FRONT button | BUTTON_1, gpio 143 (gpio5 15, pad uart3_rx_irrx mode 3), active low, 50 ms debounce. KEY_102ND (86). Forward in the stock UI |
| REAR button | PMIC PWRON. Short press = KEY_END (107), the stock BACK key. Long hold is the hardware power path (5 s off, 9 s forced) |
| White power LED | TWL6032 PWM2 (pwm-twl channel 1), leds `jet:white:power`; 127 bright, 10 dim, 16 is the running level |
| Red LED | PMIC charger LED. Stock meaning: red = off+charging, white = on, pink = on+charging, off = full |

## eMMC partitions (8 GB, GPT by name)

| # | Name | Size | Use |
|---|---|---|---|
| p1 | xloader | 128 KB | unsigned GP x-loader |
| p2 | bootloader | 2 MB | U-Boot 1.1.4-4.1.1 (Apr 2015), fastboot |
| p3 | ubootenv | 128 KB | |
| p4 | misc | 384 KB | |
| p5 | efs | 320 MB | `/factory`: signed factory OTA restored on reset |
| p6 | crypto | 16 KB | |
| p7 | recovery | 8 MB | **rooted stock Android boot image** (our fallback) |
| p8 | boot | 8 MB | **mainline** (`boot-emmc.img`, must stay <= 8 MB) |
| p9 | system | 512 MB | stock /system (ext4, used read-only by the chroot) |
| p10 | cache | 256 MB | |
| p11 | userdata | 6.2 GB | ext4: Alpine chroot, `mainline/` flags, modules, firmware |

Backups of GPT + p1..p10 and the factory OTA live in `refs/` (gitignored).

## Battery and charger

- Pack connector is 3-pin: VBAT, GND, NTC thermistor (~10 k). The battery ID resistor is on
  the main board, so "no battery" is never detected by software.
- The PMIC will not start the OMAP without VBAT: a dead cell looks like a brick (steady red
  LED, nothing on USB, no button response). The original 10-year-old cell was dead; a 3.7 V
  500 mAh cell wired to the pack's protection board works.
- Boot-on-plug is enabled: VBUS alone boots u-boot into Android charger mode, which never
  enables the USB gadget. An off-and-charging Jet is invisible on USB by design.
- The battery is charged by the TWL6032 **linear** stage (VSYS -> VBAT), which needs EN_LINCH;
  EN_CHARGER alone only powers VSYS from VBUS. See power.md.
