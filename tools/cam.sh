#!/bin/sh
# cam.sh [tag] : grab a frame from the camera pointed at the Jet display, auto-locate the
# bright display rectangle, print its bounding box and mean RGB (display + a halo mean).
# CAM_DEV = avfoundation device name (default the FaceTime camera the Jet is mounted at; indices shuffle between runs).
D=${CAM_DIR:-/Users/rg/.claude/jobs/91726e05/tmp/cam}; mkdir -p "$D"
T=${1:-shot}; F="$D/$(date +%H%M%S)-$T.png"
ffmpeg -hide_banner -loglevel error -y -f avfoundation -framerate 30 -video_size 1280x720 -pixel_format uyvy422 -i "${CAM_DEV:-FaceTime HD Camera}" -ss 2 -frames:v 1 "$F" || exit 1
ffmpeg -hide_banner -loglevel error -i "$F" -vf "scale=128:72" -f rawvideo -pix_fmt rgb24 - | python3 -c '
import sys
W,H=128,72; d=sys.stdin.buffer.read(); px=[tuple(d[i:i+3]) for i in range(0,W*H*3,3)]
lum=[(0.3*r+0.59*g+0.11*b) for r,g,b in px]
thr=max(60, max(lum)*0.5)
sel=[(i%W,i//W) for i,l in enumerate(lum) if l>=thr]
if len(sel)<4: print("bbox:none mean_rgb: 0 0 0 halo_rgb: 0 0 0"); sys.exit()
xs=[x for x,y in sel]; ys=[y for x,y in sel]
x0,x1,y0,y1=min(xs),max(xs),min(ys),max(ys)
def mean(cond):
    s=[px[y*W+x] for y in range(H) for x in range(W) if cond(x,y)]
    return tuple(sum(c[k] for c in s)//max(1,len(s)) for k in range(3))
inner=mean(lambda x,y: x0<=x<=x1 and y0<=y<=y1)
halo=mean(lambda x,y: (x0-6<=x<=x1+6 and y0-6<=y<=y1+6) and not (x0<=x<=x1 and y0<=y<=y1))
print(f"bbox:{x0*10},{y0*10}-{x1*10},{y1*10} n={len(sel)} mean_rgb: {inner[0]} {inner[1]} {inner[2]} halo_rgb: {halo[0]} {halo[1]} {halo[2]}")
' | sed "s|^|$F |"
