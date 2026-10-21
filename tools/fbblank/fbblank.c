/* fbblank off|on : FBIOBLANK powerdown / unblank on /dev/fb0 (omapfb -> panel disable/enable) */
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <linux/fb.h>
int main(int argc, char **argv) {
	int fd = open("/dev/fb0", O_RDWR);
	if (fd < 0) { perror("/dev/fb0"); return 1; }
	int mode = (argc > 1 && !strcmp(argv[1], "off")) ? FB_BLANK_POWERDOWN : FB_BLANK_UNBLANK;
	if (ioctl(fd, FBIOBLANK, mode) < 0) { perror("FBIOBLANK"); return 1; }
	printf("fb0 %s\n", mode == FB_BLANK_UNBLANK ? "unblanked" : "powered down");
	return 0;
}
