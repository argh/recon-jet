/* reboot2 [reason]: restart with a reboot-reason string (RESTART2), which busybox's reboot
 * cannot pass. The Jet kernel stores it in SAR RAM for the stock u-boot: "bootloader" =>
 * fastboot, "recovery" => recovery partition (both warm resets), anything else => cold
 * reset with "reboot" => a normal (non-charger) boot of the boot partition. */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/reboot.h>
#include <sys/syscall.h>
#include <linux/reboot.h>
int main(int argc, char **argv) {
	const char *cmd = argc > 1 ? argv[1] : "reboot";
	sync();
	if (syscall(SYS_reboot, LINUX_REBOOT_MAGIC1, LINUX_REBOOT_MAGIC2, LINUX_REBOOT_CMD_RESTART2, cmd) < 0) {
		perror("reboot"); return 1;
	}
	return 0;
}
