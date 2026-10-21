// SPDX-License-Identifier: GPL-2.0-only
/*
 * omap4-restart.c - Common to OMAP4 and OMAP5
 *
 * Recon Jet: the stock u-boot reads a reboot-reason string from public SAR RAM
 * (0x4a326000 + 0xA0C, "bootloader" / "recovery" / "reboot" / "off") but only
 * honours "bootloader"/"recovery" after a WARM reset (PRM_RSTST bit 1); "reboot"
 * works after any reset and selects a normal Android boot instead of the
 * charger-mode boot a cold reset otherwise lands in.  Warm resets hang the next
 * boot now and then, so plain reboots stay cold (see patches/apply.sh step 12)
 * and only the two bootloader-targeted commands use a warm reset.
 */

#include <linux/types.h>
#include <linux/reboot.h>
#include <linux/io.h>
#include <linux/string.h>
#include "common.h"
#include "prm.h"
#include "prm44xx.h"
#include "prcm44xx.h"
#include "prminst44xx.h"
#include "prm-regbits-44xx.h"

#define JET_REBOOT_REASON_OFFSET	0xA0C
#define JET_REBOOT_REASON_SIZE		0xF

static void jet_warm_reset(void)
{
	s32 inst = omap4_prmst_get_prm_dev_inst();
	u32 v;

	if (inst == PRM_INSTANCE_UNKNOWN)
		return;
	v = omap4_prminst_read_inst_reg(OMAP4430_PRM_PARTITION, inst,
					OMAP4_PRM_RSTCTRL_OFFSET);
	v |= OMAP4430_RST_GLOBAL_WARM_SW_MASK;
	omap4_prminst_write_inst_reg(v, OMAP4430_PRM_PARTITION, inst,
				     OMAP4_PRM_RSTCTRL_OFFSET);
	/* OCP barrier */
	omap4_prminst_read_inst_reg(OMAP4430_PRM_PARTITION, inst,
				    OMAP4_PRM_RSTCTRL_OFFSET);
}

/**
 * omap44xx_restart - trigger a software restart of the SoC
 * @mode: the "reboot mode", see arch/arm/kernel/{setup,process}.c
 * @cmd: passed from the userspace program rebooting the system (if provided)
 *
 * Resets the SoC.  For @cmd, see the 'reboot' syscall in
 * kernel/sys.c.  No return value.
 */
void omap44xx_restart(enum reboot_mode mode, const char *cmd)
{
	void __iomem *sar = omap4_get_sar_ram_base();
	const char *reason = (cmd && *cmd) ? cmd : "reboot";
	bool warm = !strcmp(reason, "bootloader") || !strcmp(reason, "recovery");
	char buf[JET_REBOOT_REASON_SIZE + 1];

	if (sar) {
		memset(buf, 0, sizeof(buf));
		strscpy(buf, reason, sizeof(buf));
		memcpy_toio(sar + JET_REBOOT_REASON_OFFSET, buf, sizeof(buf));
	}
	pr_emerg("restart: reason \"%s\" (%s reset)\n", reason, warm ? "warm" : "cold");

	if (warm)
		jet_warm_reset();
	else
		omap_prm_reset_system();
}
