#!/bin/sh
# Mainline kernel for the Jet, built in Docker. The source tree lives in a Docker named
# volume (Linux fs): the kernel has case-colliding filenames that break on the Mac's
# case-insensitive disk. Artifacts are copied out to refs/linux/out-$VER.
#   kernel/build.sh fetch            download linux-$VER into the volume (once)
#   kernel/build.sh defconfig        omap2plus_defconfig + kernel/jet.config fragment
#   kernel/build.sh zimage           build zImage, dtbs; export to refs/linux/out-$VER
#   kernel/build.sh sh               shell in the build container
#   kernel/build.sh clean            drop the source volume
set -e
cd "$(dirname "$0")/.."
VER=${VER:-6.18}
VOL=jet-linux-src
IMG=jet-kbuild
OUT=refs/linux/out-$VER
docker image inspect $IMG >/dev/null 2>&1 || docker build -q -t $IMG kernel >/dev/null
docker volume inspect $VOL >/dev/null 2>&1 || docker volume create $VOL >/dev/null
run() { docker run --rm -it -v $VOL:/src -v "$PWD/kernel:/w/kernel:ro" -v "$PWD/refs/linux:/w/out" -w /src/linux-$VER $IMG "$@"; }
runq() { docker run --rm -v $VOL:/src -v "$PWD/kernel:/w/kernel:ro" -v "$PWD/refs/linux:/w/out" -w /src/linux-$VER $IMG "$@"; }
case "$1" in
  fetch)
    mkdir -p refs/linux
    docker run --rm -v $VOL:/src -w /src $IMG sh -c "[ -d linux-$VER ] && echo 'source present' && exit 0; wget -q -O linux.tar.xz https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$VER.tar.xz && tar xf linux.tar.xz && rm linux.tar.xz && ls"
    ;;
  defconfig)
    runq sh -c "cp -r /w/kernel/overlay/. . && sh /w/kernel/patches/apply.sh >/dev/null && make O=out omap2plus_defconfig >/dev/null && scripts/kconfig/merge_config.sh -O out -m out/.config /w/kernel/jet.config | grep -i -E 'redefined|warning' ; make O=out olddefconfig >/dev/null && grep -c '=y' out/.config"
    ;;
  zimage)
    mkdir -p $OUT
    runq sh -c "cp /w/kernel/omap4-recon-jet.dts arch/arm/boot/dts/ti/omap/ && cp /w/kernel/patches/twl4030-pwrbutton.c drivers/input/misc/twl4030-pwrbutton.c && cp -r /w/kernel/overlay/. . && sh /w/kernel/patches/apply.sh && grep -q omap4-recon-jet arch/arm/boot/dts/ti/omap/Makefile || sed -i 's/omap4-panda.dtb \\\\/omap4-panda.dtb omap4-recon-jet.dtb \\\\/' arch/arm/boot/dts/ti/omap/Makefile; grep -n recon-jet arch/arm/boot/dts/ti/omap/Makefile; make O=out -j\$(nproc) zImage dtbs drivers/video/fbdev/omap2/omapfb/displays/panel-kopin-a230.ko drivers/input/misc/jet-ofm.ko drivers/media/platform/ti/omap4iss/omap4-iss.ko drivers/iio/light/tsl2772.ko 2>&1 | grep -E 'error|Error|warning: unmet|recon-jet' | head; ls -la out/arch/arm/boot/zImage && cp out/arch/arm/boot/zImage out/.config /w/out/out-$VER/ && \${CROSS_COMPILE}strip --strip-debug out/drivers/video/fbdev/omap2/omapfb/displays/panel-kopin-a230.ko out/drivers/input/misc/jet-ofm.ko out/drivers/media/platform/ti/omap4iss/omap4-iss.ko out/drivers/iio/light/tsl2772.ko && cp out/drivers/video/fbdev/omap2/omapfb/displays/panel-kopin-a230.ko out/drivers/input/misc/jet-ofm.ko out/drivers/media/platform/ti/omap4iss/omap4-iss.ko out/drivers/iio/light/tsl2772.ko /w/out/out-$VER/ && cp out/arch/arm/boot/dts/ti/omap/omap4-recon-jet.dtb out/arch/arm/boot/dts/ti/omap/omap4-panda.dtb out/arch/arm/boot/dts/ti/omap/omap4-epson-embt2ws.dtb /w/out/out-$VER/ 2>/dev/null; size out/vmlinux | tail -1; ls -la /w/out/out-$VER"
    ;;
  module)
    # rebuild only the Kopin panel module (overlay copied first), ~20 s; reload with kernel/panel-reload.sh
    runq sh -c "cp -r /w/kernel/overlay/. . && make O=out -j\$(nproc) drivers/video/fbdev/omap2/omapfb/displays/panel-kopin-a230.ko drivers/input/misc/jet-ofm.ko drivers/media/platform/ti/omap4iss/omap4-iss.ko drivers/iio/light/tsl2772.ko 2>&1 | grep -E 'error|warning|CC|LD' | head -8; \${CROSS_COMPILE}strip --strip-debug out/drivers/video/fbdev/omap2/omapfb/displays/panel-kopin-a230.ko out/drivers/input/misc/jet-ofm.ko out/drivers/media/platform/ti/omap4iss/omap4-iss.ko out/drivers/iio/light/tsl2772.ko; cp out/drivers/video/fbdev/omap2/omapfb/displays/panel-kopin-a230.ko out/drivers/input/misc/jet-ofm.ko out/drivers/media/platform/ti/omap4iss/omap4-iss.ko out/drivers/iio/light/tsl2772.ko /w/out/out-$VER/ && ls -la /w/out/out-$VER/*.ko"
    ;;
  modules)
    # the whole module tree (BT, ALSA, ...) for userdata: refs/linux/out-$VER/modules.tar (lib/modules/<ver>)
    runq sh -c "cp -r /w/kernel/overlay/. . && sh /w/kernel/patches/apply.sh >/dev/null && make O=out -j\$(nproc) modules 2>&1 | grep -E 'error' | head; rm -rf out/modroot && make O=out INSTALL_MOD_PATH=modroot INSTALL_MOD_STRIP=1 modules_install >/dev/null 2>&1; rm -f out/modroot/lib/modules/*/build; tar -C out/modroot -cf /w/out/out-$VER/modules.tar lib && ls -la /w/out/out-$VER/modules.tar && find out/modroot -name '*.ko' | wc -l"
    ;;
  sh) run bash ;;
  clean) docker volume rm $VOL ;;
  *) echo "usage: $0 fetch|defconfig|zimage|module|sh|clean"; exit 1 ;;
esac
