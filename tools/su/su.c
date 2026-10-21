/* Minimal setuid-root shell for the Jet rooted ramdisk: /sbin/su mode 6755.
 * Static, musl, built with: zig cc -target arm-linux-musleabihf -static -Os su.c -o su */
#include <unistd.h>
#include <stdio.h>
int main(int argc, char **argv) {
    if (setgid(0) || setuid(0)) { perror("setuid"); return 1; }
    if (argc > 2 && argv[1][0] == '-' && argv[1][1] == 'c')
        execl("/system/bin/sh", "sh", "-c", argv[2], (char *)0);
    execl("/system/bin/sh", "sh", (char *)0);
    perror("exec"); return 1;
}
