/* Open /dev/watchdog and never feed it: forces a hardware reset after the timeout. */
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
int main(void) { int fd = open("/dev/watchdog", O_WRONLY); if (fd < 0) { perror("open"); return 1; }
  printf("watchdog armed, not feeding\n"); fflush(stdout); for (;;) pause(); }
