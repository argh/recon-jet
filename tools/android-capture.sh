#!/bin/sh
# Remote camera + mic sampling on the rooted stock Android (not the bridge).
#   tools/android-capture.sh photo [out.jpg]   launch ReconCamera, press ENTER, pull newest JPEG
#   tools/android-capture.sh mic [secs] [out.wav]   tinycap from the on-board DMIC, pull
# Requires adb to the Jet running Android with /sbin/su (rooted boot partition).
set -e
cd "$(dirname "$0")/.."
SU='adb shell /sbin/su -c'
mkdir -p work/capture
case "$1" in
  photo)
    out=${2:-work/capture/photo-$(date +%H%M%S).jpg}
    before=$(adb shell ls /sdcard/DCIM/Camera/ | tr -d '\r' | grep -c jpg || true)
    adb shell am start -n com.reconinstruments.camera/.app.CameraActivity >/dev/null
    sleep 4
    adb shell input keyevent 66            # ENTER = shutter in CameraActivity
    for i in 1 2 3 4 5 6 7 8; do sleep 1; after=$(adb shell ls /sdcard/DCIM/Camera/ | tr -d '\r' | grep -c jpg || true); [ "$after" -gt "$before" ] && break; done
    sleep 2
    f=$(adb shell ls -t /sdcard/DCIM/Camera/ 2>/dev/null | tr -d '\r' | grep jpg | head -1)
    [ -z "$f" ] && f=$(adb shell ls /sdcard/DCIM/Camera/ | tr -d '\r' | grep jpg | tail -1)
    adb pull "/sdcard/DCIM/Camera/$f" "$out" >/dev/null
    adb shell input keyevent 4 >/dev/null   # BACK out of the camera app
    echo "$out"
    ;;
  mic)
    secs=${2:-4}; out=${3:-work/capture/mic-$(date +%H%M%S).wav}
    # ABE route used by the stock HAL ("mm_ul2_dmic0_jet"): DMIC0 -> MUX_UL10/11 -> MM_UL2 (pcm device 1).
    # Period must be ABE-aligned (960 frames x2); 1024x4 opens but never delivers data.
    # This tinycap has no -T: run it in the background and SIGINT it so it writes the RIFF header.
    BB=/data/local/tmp/busybox
    $SU "'tinymix MUX_UL10 DMic0L; tinymix MUX_UL11 DMic0R; tinymix \"DMIC1 UL Volume\" 149 149; $BB rm -f /sdcard/mic.wav; tinycap /sdcard/mic.wav -D 0 -d 1 -c 2 -r 48000 -b 16 -p 960 -n 2 >/dev/null 2>&1 & $BB sleep $secs; $BB pkill -INT tinycap; $BB sleep 1'" 2>&1 | tr -d '\r' | tail -1
    adb pull /sdcard/mic.wav "$out" >/dev/null
    echo "$out"
    ;;
  *) echo "usage: $0 photo [out.jpg] | mic [secs] [out.wav]"; exit 1;;
esac
