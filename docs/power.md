# Power, charging and the fuel gauge (TWL6032)

All registers are on PMIC i2c address 0x49 (bus `i2c-0` on mainline). Read/write from the
Alpine chroot with `i2cget/i2cset -f -y 0 0x49 <reg>`; jetd uses `/dev/i2c-0` directly.

## Charger registers used

| Register | Addr | Meaning / values used |
|---|---|---|
| CONTROLLER_CTRL1 | 0xE1 | bit4 EN_CHARGER (VBUS -> VSYS), bit5 EN_LINCH (linear stage VSYS -> VBAT). Must be **0x30** to charge the cell. The in-tree driver only set 0x10, and writes 0x00 on VBUS loss |
| CONTROLLER_STAT1 | 0xE3 | bit2 VBUS_DET, bit6 LINCH_GATED; 0x84 = VBUS present |
| LINEAR_CHRG_STS | 0xDE | 0x44 while actually charging (0x40 idle) |
| CHARGERUSB_VICHRG | 0xED | charge current code: 0x03 = 400 mA, 0x04 = 500 mA, 0x0e = 1.5 A (u-boot leaves this) |
| CHARGERUSB_CINLIMIT | 0xEE | input limit: 50 + 50 x code mA for codes < 0x10 (0x01 = 100 mA, 0x08 = 450 mA, 0x09 = 500 mA, 0x0d = 700 mA); >= 800 mA uses extended codes, 0x29 = 1000 mA; 0x2e = no limit (u-boot leaves this) |
| CHARGERUSB_CTRLLIMIT2 | 0xF0 | charge current ceiling, set to 0x03 (400 mA, the DT battery limit) |
| VOREG | | 4.2 V |
| Charger WDG | | 0x7f as left by the driver |
| TOGGLE1 | 0x90 | 0x20 enables the fuel gauge |

Facts: toggling EN_CHARGER off while the cell is low reboots the device (the system runs from
the charger path). PMIC registers survive SoC resets, which is why RAM boots after Android
charged fine and the eMMC-default system did not.

## Fuel gauge current

`FG_REG_10/11` (0xCA low, 0xCB high): 14-bit signed sample; offset in 0xC8/0xC9 (10-bit signed).

```
raw = ((hi << 8) | lo) & 0x3fff;  if (raw >= 8192) raw -= 16384;
off = ((oh << 8) | ol) & 0x3ff;   if (off >= 512)  off -= 1024;
mA  = (raw - off) * 3100 / 8192;      // negative = discharging
```
Typical: -80 mA idle on a dead charge path, +280 mA charging from a wall adapter, +130 mA on a
PC port after enumeration.

## GPADC channels (IIO `twl6030_gpadc`, needs the `ti,twl6032-gpadc` compatible)

| Channel | Meaning |
|---|---|
| `in_voltage18_input` | VBAT (what u-boot reports as `androidboot.voltage`) |
| `in_voltage7_input` | system rail (~0.5 V above VBAT) |
| `in_voltage10_input` | VBUS |
| temp1 / temp4 | PMIC temperature channels (NTC via VBAT_TEMP in u-boot) |

u-boot's low-battery cutoff is ~3.4-3.6 V (temperature dependent): three 100 ms blinks on the
power button means "alive but too low".

## Charge policy (init loop every 3 s, `tools/charge-policy.sh` for live use, `mainline/charge-off` disables)

| Condition | CINLIMIT | Reason |
|---|---|---|
| VBUS present, UDC not "configured", < 15 s | 0x01 = 100 mA | USB allows no more before enumeration; macOS cuts the port otherwise |
| UDC "configured" (a PC host) | 0x08 = 450 mA | 500 mA allocation (gadget MaxPower 500) minus margin |
| unenumerated for 15 s (wall adapter) | 0x29 = 1000 mA | DCP |

Always: VICHRG 0x04 and CTRLLIMIT2 0x04 (500 mA for the 500 mAh cell), CTRL1 0x30. The kernel
overlay driver also re-asserts EN_CHARGER|EN_LINCH in its 10 s watchdog work whenever VBUS_DET
is set. On a PC port only ~50-130 mA reaches the cell while the system runs: charge from a wall
adapter.

## macOS over-current behaviour

With u-boot's limits left in place (1.5 A / unlimited) and EN_LINCH forced, the Jet drew system
(~375 mA) + charge (~280 mA) > 500 mA; macOS reports over-current, cuts VBUS and the device
"disappears within 30 s". Even 450 mA before enumeration tripped it after ~6 s; the 100 mA
pre-enumeration step fixed that. Symptom on the Jet: UDC "not attached" with VBUS still 4.9 V.

## Power screen (jetd setup -> Power; hub `Q` -> `q ...`)

1 Hz: battery mV (ch18) / mA (fuel gauge), system mV (ch7), VBUS mV (ch10), CTRL1 bits
(EN_CHARGER/EN_LINCH), LINEAR_CHRG_STS, STAT1, CINLIMIT, VICHRG, VOREG, UDC state, gadget
MaxPower (visible only when jetd runs from the initramfs, where configfs is mounted), board
temperature if `hwmon0` exists.

## LED and power button

- Red charge LED is driven by the PMIC charger (u-boot forces it on in charger mode).
- White power LED: TWL6032 PWM2 as `jet:white:power` (pwm-twl lacks `get_state`, so
  `default-state = keep` logs a warning and the LED starts off; init sets 16).
- Power button long holds are handled in the PMIC: 5 s off, 9 s forced shutdown.
