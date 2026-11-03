# Recovery: getting back, and why you cannot brick it

The Jet is an abandoned product; treating its eMMC with respect is the difference between a
project and a paperweight. This file is the ladder of ways back, from "mainline is acting up"
to "put the stock software back on", and the invariants that keep every rung reachable.

## The invariants

1. **The bootloader partitions (p1 xloader, p2 u-boot) are never written** — not by
   `install.sh`, not by `recover.sh`, not by any documented procedure in this repo. They are
   what powers on, charges the battery and offers fastboot; while they are intact the device
   always comes up far enough to be rescued, whatever is in the other partitions.
2. **Backups before flashes.** `install.sh` reads GPT + p1–p10 off the device and records
   checksums (`refs/backup/SHA256SUMS.txt`) before its first write. `recover.sh` refuses to
   write anything that does not verify against those checksums. Archive `refs/backup/`
   off-machine; it is your device's birth certificate.
3. **Every flash is verified** by reading the partition back and comparing checksums before any
   reboot, on install and on recovery alike.
4. **Experiments run from RAM.** `fastboot boot` runs an image without flashing it; a bad one
   costs a power cycle. eMMC only ever receives images that already booted from RAM on this
   hardware.
5. **The fallback slot.** p7 (recovery) holds a rooted stock Android. From mainline,
   `reboot2 recovery` boots it and gives adb; `adb reboot` returns to mainline. Mainline and
   the fallback can each rescue the other.

## The ladder (top rung first)

| Situation | Way back |
|---|---|
| jet-app or a mode is misbehaving | `ssh root@jet.local`; restart the app (`docs/jet-app.md`), or hold FRONT at boot for jetd's recovery chooser |
| mainline boots but you want stock behaviour temporarily | `reboot2 recovery` → rooted stock Android with adb; `adb reboot` comes back |
| a new boot image needs testing | `reboot2 bootloader` → `fastboot boot work/mainline/boot-mainline.img` (RAM only) |
| mainline will not boot cleanly | the boot guard (`docs/boot.md`) counts failed boots and degrades: no camera/touchpad → no panel (ssh only) → parks in **fastboot** after 4, by itself |
| black glass, dead USB after any reset | the stock bootloader's hang (~1 in 5 warm, ~1 in 7 cold resets): hold POWER ~10 s (or pull the battery), power on. Nothing was lost |
| back to the stock software | `./recover.sh` (below) |
| backups lost AND p8 broken | the factory OTA fallback (below) |

## recover.sh

```
./recover.sh                     # restore YOUR stock boot backup to p8 -> device boots stock Android
./recover.sh --status            # say what it would do, change nothing
./recover.sh --recovery-slot-too # also restore p7 to stock recovery (drops the rooted fallback)
./recover.sh --clean-userdata    # also delete the mainline files from userdata (full return to stock)
```

Works from mainline (ssh) or the rooted-Android fallback (adb), whichever answers; verifies the
backup's checksum before writing and the partition's content after; skips a partition that
already holds the stock image, so it is as re-runnable as the installer. The default leaves the
rooted fallback in p7 and the mainline files on userdata, so `./install.sh` can bring mainline
straight back; `--recovery-slot-too --clean-userdata` is the full exit.

Stock Android does not mind the extra files on userdata; a factory reset from stock also clears
them.

## The factory OTA fallback (no backups)

Every Jet carries its own signed factory OTA on the efs partition, mounted read-only at
`/factory` on stock Android: `factory.bin`, a zip holding a stock `boot.img` and `/system`.
If `refs/backup/` is ever lost, that boot image is a stock p8:

```
adb pull /factory/factory.bin           # from stock or rooted Android (or LispXML io:cp, docs/setup.md)
unzip factory.bin boot.img
# then write it to p8 exactly as recover.sh does (dd + read-back verify), from rooted Android
# (/dev/block/mmcblk0p8) or mainline (/dev/mmcblk1p8)
```

## What would "bricked" even mean here

Writing garbage over p1/p2 — which nothing in this repo does — or hardware failure. Every state
reachable by these scripts leaves either mainline (ssh), rooted Android (adb), stock recovery,
or fastboot answering; the boot guard even walks a repeatedly-failing device into fastboot on
its own. The scariest-looking state, the black-glass bootloader hang, is the most harmless: it
is a hang on the way into the bootloader, cleared by a power cycle, and it predates this
project — the stock software lived with it too.
