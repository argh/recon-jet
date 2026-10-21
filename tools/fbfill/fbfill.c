/* Fill /dev/graphics/fb0 with color bars + a moving block, report fb geometry.
 * usage: fbfill [seconds]   (static, zig cc -target arm-linux-musleabihf) */
#include <fcntl.h>
#include <linux/fb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <time.h>
/* omapfb manual-update panel: OMAPFB_UPDATE_WINDOW = _IOW('O', 54, struct omapfb_update_window) */
struct omapfb_update_window { unsigned x, y, width, height, format, out_x, out_y, out_width, out_height, reserved[8]; };
#define OMAPFB_UPDATE_WINDOW _IOW('O', 54, struct omapfb_update_window)
int main(int argc, char **argv) {
    int secs = argc > 1 ? atoi(argv[1]) : 5;
    int fd = open("/dev/graphics/fb0", O_RDWR);
    if (fd < 0) { perror("open fb0"); return 1; }
    struct fb_var_screeninfo v; struct fb_fix_screeninfo f;
    ioctl(fd, FBIOGET_VSCREENINFO, &v); ioctl(fd, FBIOGET_FSCREENINFO, &f);
    printf("fb: %ux%u (virt %ux%u) bpp %u stride %u smem %u r%u/%u g%u/%u b%u/%u\n",
        v.xres, v.yres, v.xres_virtual, v.yres_virtual, v.bits_per_pixel, f.line_length, f.smem_len,
        v.red.offset, v.red.length, v.green.offset, v.green.length, v.blue.offset, v.blue.length);
    unsigned char *fb = mmap(0, f.smem_len, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
    if (fb == MAP_FAILED) { perror("mmap"); return 1; }
    unsigned colors[8] = {0xffffff,0xffff00,0x00ffff,0x00ff00,0xff00ff,0xff0000,0x0000ff,0x000000};
    struct timespec ts = {0, 33000000};
    for (int frame = 0; frame < secs * 30; frame++) {
        for (unsigned y = 0; y < v.yres; y++) {
            unsigned char *row = fb + y * f.line_length;
            for (unsigned x = 0; x < v.xres; x++) {
                unsigned c = colors[x * 8 / v.xres];
                unsigned bx = (frame * 4) % (v.xres - 40);
                if (x >= bx && x < bx + 40 && y >= v.yres/2 - 20 && y < v.yres/2 + 20) c = 0x808080;
                unsigned r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
                /* honour the fb's bit layout: 32 bpp XRGB (stock kernel) or 16 bpp RGB565 (mainline omapfb) */
                unsigned px = ((r >> (8 - v.red.length)) << v.red.offset) |
                              ((g >> (8 - v.green.length)) << v.green.offset) |
                              ((b >> (8 - v.blue.length)) << v.blue.offset);
                if (v.bits_per_pixel == 16) ((unsigned short *)row)[x] = (unsigned short)px;
                else ((unsigned *)row)[x] = px;
            }
        }
        struct omapfb_update_window uw = {0, 0, v.xres, v.yres, 0, 0, 0, v.xres, v.yres, {0}};
        if (ioctl(fd, OMAPFB_UPDATE_WINDOW, &uw) < 0 && frame == 0) perror("OMAPFB_UPDATE_WINDOW");
        nanosleep(&ts, 0);
    }
    return 0;
}
