#!/bin/sh
# Pack the mainline kernel + Jet DTB + initramfs into a u-boot `booti` boot image.
#   kernel/mkboot.sh   -> work/mainline/boot-mainline.img   (use: fastboot boot <img>)
set -e
cd "$(dirname "$0")/.."
VER=${VER:-6.18}
OUT=refs/linux/out-$VER
W=work/mainline
rm -rf $W; mkdir -p $W/initramfs/bin $W/initramfs/sbin $W/initramfs/proc $W/initramfs/sys $W/initramfs/dev $W/initramfs/tmp $W/initramfs/mnt $W/initramfs/etc $W/initramfs/var/lib/misc
cp work/alpine/busybox $W/initramfs/bin/busybox && chmod 755 $W/initramfs/bin/busybox
ln -s /bin/busybox $W/initramfs/bin/sh
cp kernel/initramfs/init $W/initramfs/init && chmod 755 $W/initramfs/init
# the Kopin panel driver is a module: init loads it late (after watchdog + ssh) and only if
# userdata has no mainline/panel-off flag, so a display hang resets and stays debuggable
mkdir -p $W/initramfs/lib/modules && cp $OUT/panel-kopin-a230.ko $W/initramfs/lib/modules/
[ -f $OUT/jet-ofm.ko ] && cp $OUT/jet-ofm.ko $W/initramfs/lib/modules/
[ -f $OUT/omap4-iss.ko ] && cp $OUT/omap4-iss.ko $W/initramfs/lib/modules/
[ -f $OUT/tsl2772.ko ] && cp $OUT/tsl2772.ko $W/initramfs/lib/modules/
# display test tool (color bars + moving block via OMAPFB_UPDATE_WINDOW), same binary as the bridge
[ -x agent/jetd ] && cp agent/jetd $W/initramfs/bin/jetd && chmod 755 $W/initramfs/bin/jetd
[ -x agent/wake/jetwake ] && cp agent/wake/jetwake $W/initramfs/bin/jetwake && chmod 755 $W/initramfs/bin/jetwake   # the wake word detector jetd spawns (D 1)
[ -x tools/regdump/regdump ] && cp tools/regdump/regdump $W/initramfs/bin/regdump && chmod 755 $W/initramfs/bin/regdump
[ -x tools/reboot2/reboot2 ] && cp tools/reboot2/reboot2 $W/initramfs/bin/reboot2 && chmod 755 $W/initramfs/bin/reboot2
[ -x tools/fbfill/fbfill ] && cp tools/fbfill/fbfill $W/initramfs/bin/fbfill && chmod 755 $W/initramfs/bin/fbfill
# wlcore on a wl128x asks for ti-connectivity/wl128x-nvs.bin (the stock file is named wl1271-nvs.bin)
mkdir -p $W/initramfs/lib/firmware/ti-connectivity && cp refs/firmware/ti-connectivity/wl128x-fw-5-sr.bin refs/firmware/ti-connectivity/wl128x-fw-5-mr.bin $W/initramfs/lib/firmware/ti-connectivity/
cp refs/firmware/ti-connectivity/wl1271-nvs.bin $W/initramfs/lib/firmware/ti-connectivity/wl128x-nvs.bin
cp refs/firmware/regulatory.db refs/firmware/regulatory.db.p7s $W/initramfs/lib/firmware/
printf 'root::0:0:root:/:/bin/sh\n' > $W/initramfs/etc/passwd
printf 'root:x:0:\n' > $W/initramfs/etc/group
node tools/cpio-newc.js $W/initramfs $W/initramfs.gz
cat $OUT/zImage $OUT/omap4-recon-jet.dtb > $W/zImage-dtb
# header fields from the stock boot image, but ramdisk further up so a big decompressed
# kernel cannot overwrite it (stock: kernel 0x80008000, ramdisk 0x81000000)
python3 - <<EOF
import json
h=json.load(open('work/curboot/info.json'))
h['ramdisk_addr']=0x82000000
h['cmdline']=''
json.dump(h, open('$W/info.json','w'), indent=2)
EOF
cp $W/zImage-dtb $W/kernel
node tools/bootimg.js pack $W $W/boot-mainline.img --kernel $W/zImage-dtb --ramdisk $W/initramfs.gz
# same kernel, initramfs with the eMMC marker (enables init's boot-failure guard): the image to flash to "boot"
# (xz: the boot partition is 8 MB; CONFIG_RD_XZ needs --check=crc32)
touch $W/initramfs/etc/jet-emmc
node tools/cpio-newc.js $W/initramfs $W/initramfs-emmc.cpio && xz -9 --check=crc32 -f $W/initramfs-emmc.cpio
node tools/bootimg.js pack $W $W/boot-emmc.img --kernel $W/zImage-dtb --ramdisk $W/initramfs-emmc.cpio.xz
ls -la $W/boot-mainline.img $W/boot-emmc.img
[ $(stat -f %z $W/boot-emmc.img) -le 8388608 ] && echo "boot-emmc.img fits the 8 MB boot partition" || echo "WARNING: boot-emmc.img exceeds the 8 MB boot partition"
