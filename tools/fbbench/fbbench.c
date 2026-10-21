/* fbbench [frames] : max OMAPFB_UPDATE_WINDOW rate with a changing full frame (RGB565) */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <linux/fb.h>
struct uw { uint32_t x, y, width, height, format, out_x, out_y, out_width, out_height, reserved[8]; };
#define OMAPFB_UPDATE_WINDOW _IOW('O', 54, struct uw)
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
int main(int argc, char **argv) {
	int n = argc > 1 ? atoi(argv[1]) : 200, fd = open("/dev/fb0", O_RDWR);
	struct fb_var_screeninfo v; struct fb_fix_screeninfo f; ioctl(fd, FBIOGET_VSCREENINFO, &v); ioctl(fd, FBIOGET_FSCREENINFO, &f);
	uint8_t *m = mmap(0, f.smem_len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	struct uw u = { 0, 0, v.xres, v.yres, 0, 0, 0, v.xres, v.yres, {0} };
	double t0 = now(), tfill = 0;
	for (int i = 0; i < n; i++) {
		double a = now();
		uint16_t c = (i & 1) ? 0xf800 : 0x001f;
		for (unsigned y = 0; y < v.yres; y++) { uint16_t *row = (uint16_t *)(m + y * f.line_length); for (unsigned x = 0; x < v.xres; x++) row[x] = (x / 32 + i) & 1 ? c : 0; }
		tfill += now() - a;
		if (ioctl(fd, OMAPFB_UPDATE_WINDOW, &u) < 0) { perror("update"); return 1; }
	}
	double dt = now() - t0;
	printf("%d frames in %.2f s = %.1f fps (fill %.1f ms/frame, update %.1f ms/frame)\n", n, dt, n / dt, tfill / n * 1e3, (dt - tfill) / n * 1e3);
	return 0;
}
