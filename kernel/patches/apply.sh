#!/bin/sh
# Idempotent in-tree edits for the Jet kernel (run from the kernel source root by build.sh).
# New files come from kernel/overlay/ (copied before this runs); this script only touches
# existing files, each edit guarded by a grep so re-running is a no-op.
set -e
D=drivers/video/fbdev/omap2/omapfb
# 1. omapfb_dss.h: rfbi ops in the output ops union
grep -q "omapdss_rfbi_ops \*rfbi" include/video/omapfb_dss.h || {
  sed -i 's|^struct omapdss_dsi_ops {|struct omapdss_rfbi_ops;\n\nstruct omapdss_dsi_ops {|' include/video/omapfb_dss.h
  sed -i 's|^\t\tconst struct omapdss_dsi_ops \*dsi;|\t\tconst struct omapdss_dsi_ops *dsi;\n\t\tconst struct omapdss_rfbi_ops *rfbi;|' include/video/omapfb_dss.h
}
# 2. dss.c: stop skipping the rfbi child component
grep -q 'strstr(dev_name(dev), "rfbi")' $D/dss/dss.c && sed -i '/strstr(dev_name(dev), "rfbi")/{N;d}' $D/dss/dss.c
# 3. dss.h: prototypes
grep -q rfbi_init_platform_driver $D/dss/dss.h || sed -i 's|^/\* DPI \*/|/* RFBI */\nint rfbi_init_platform_driver(void) __init;\nvoid rfbi_uninit_platform_driver(void);\n\n/* DPI */|' $D/dss/dss.h
grep -q rfbi_init_platform_driver $D/dss/dss.h || { printf '\n/* RFBI */\nint rfbi_init_platform_driver(void) __init;\nvoid rfbi_uninit_platform_driver(void);\n' >> $D/dss/dss.h; }
# 4. core.c: register the platform driver
grep -q rfbi_init_platform_driver $D/dss/core.c || {
  sed -i 's|^\tdispc_init_platform_driver,|\tdispc_init_platform_driver,\n#ifdef CONFIG_FB_OMAP2_DSS_RFBI\n\trfbi_init_platform_driver,\n#endif|' $D/dss/core.c
  sed -i 's|^\tdispc_uninit_platform_driver,|\tdispc_uninit_platform_driver,\n#ifdef CONFIG_FB_OMAP2_DSS_RFBI\n\trfbi_uninit_platform_driver,\n#endif|' $D/dss/core.c
}
# 5. Kconfig / Makefile
grep -q FB_OMAP2_DSS_RFBI $D/dss/Kconfig || printf '\nconfig FB_OMAP2_DSS_RFBI\n\tbool "RFBI support"\n\tdepends on FB_OMAP2_DSS\n\thelp\n\t  MIPI DBI (RFBI, Remote Framebuffer Interface) support, re-added for the Recon Jet.\n' >> $D/dss/Kconfig
grep -q rfbi.o $D/dss/Makefile || echo 'omapdss-$(CONFIG_FB_OMAP2_DSS_RFBI) += rfbi.o' >> $D/dss/Makefile
grep -q FB_OMAP2_PANEL_KOPIN_A230 $D/displays/Kconfig || printf '\nconfig FB_OMAP2_PANEL_KOPIN_A230\n\ttristate "Kopin A230 microdisplay over RFBI (Recon Jet)"\n\tdepends on FB_OMAP2_DSS_RFBI\n' >> $D/displays/Kconfig
grep -q panel-kopin-a230 $D/displays/Makefile || echo 'obj-$(CONFIG_FB_OMAP2_PANEL_KOPIN_A230) += panel-kopin-a230.o' >> $D/displays/Makefile
# 6. init ordering on ti-sysc platforms: the dss@0 platform device is created when the
#    target-module probes (device_initcall), after omapdss_init_of (also device_initcall)
#    looked for it -> "Unable to find DSS platform device" and no omapdss core device, so
#    omap_dss_init's platform_driver_probe never registers the DSS drivers. Run both later.
grep -q "late_initcall(omapdss_init_of)" arch/arm/mach-omap2/display.c || sed -i 's|^omap_device_initcall(omapdss_init_of);|late_initcall(omapdss_init_of);|' arch/arm/mach-omap2/display.c
grep -q "late_initcall_sync(omap_dss_init)" $D/dss/core.c || sed -i 's|^module_init(omap_dss_init);|late_initcall_sync(omap_dss_init);|' $D/dss/core.c
grep -c "late_initcall" arch/arm/mach-omap2/display.c $D/dss/core.c | tr '\n' ' '
# 7. ti-sysc: the dss platform device may not exist yet when omapdss_init_of runs, and the
#    DSS children (dispc, rfbi) are grandchildren behind interconnect target modules.
#    Do what omapdrm's dss.c does: populate the children in dss_probe and recurse through
#    "target-module" devices when collecting components; never fail omapdss_init_of.
grep -q "children will be populated" arch/arm/mach-omap2/display.c || perl -0pi -e 's|\tif \(!pdev\) \{\n\t\tpr_err\("Unable to find DSS platform device\\n"\);\n\t\tof_node_put\(node\);\n\t\treturn -ENODEV;\n\t\}|\tif (!pdev) {\n\t\tpr_info("omapdss: DSS platform device not yet created, children will be populated by the dss driver\\n");\n\t\tof_node_put(node);\n\t\treturn omapdss_init_fbdev();\n\t}|' arch/arm/mach-omap2/display.c
grep -q "linux/of_platform.h" $D/dss/dss.c || sed -i 's|^#include <linux/of_graph.h>|#include <linux/of_graph.h>\n#include <linux/of_platform.h>|' $D/dss/dss.c
grep -q 'strstr(dev_name(dev), "target-module")' $D/dss/dss.c || perl -0pi -e 's|(static int dss_add_child_component\(struct device \*dev, void \*data\)\n\{\n\tstruct component_match \*\*match = data;\n)|$1\n\t/* ti-sysc: DSS blocks sit behind interconnect target modules */\n\tif (strstr(dev_name(dev), "target-module"))\n\t\treturn device_for_each_child(dev, data, dss_add_child_component);\n|' $D/dss/dss.c
grep -q "of_platform_populate(pdev->dev.of_node" $D/dss/dss.c || perl -0pi -e 's|(\t/\* add all the child devices as components \*/\n)|\t/* ti-sysc creates the target modules (and, synchronously, their children) here */\n\tr = of_platform_populate(pdev->dev.of_node, NULL, NULL, &pdev->dev);\n\tif (r)\n\t\treturn r;\n\n$1|' $D/dss/dss.c
grep -c "target-module\|of_platform_populate\|children will be populated" $D/dss/dss.c arch/arm/mach-omap2/display.c | tr '\n' ' '
# 8. runtime PM must be enabled on the dss core BEFORE its children exist (omapdrm does it in
#    probe); omapfb enabled it in dss_bind, after dispc/rfbi were active -> "Enabling runtime
#    PM for inactive device with active children", the core could gate the DSS clock under an
#    active DISPC -> L3 "functional access" errors and hard hangs at probe.
grep -q "pm_runtime_enable(&pdev->dev); /\* before the children \*/" $D/dss/dss.c || perl -0pi -e 's|(\tr = of_platform_populate\(pdev->dev.of_node, NULL, NULL, &pdev->dev\);\n\tif \(r\)\n\t\treturn r;\n)|\tpm_runtime_enable(&pdev->dev); /* before the children */\n$1|' $D/dss/dss.c
grep -q "pm_runtime_enable(&pdev->dev); /\* before the children \*/" $D/dss/dss.c && perl -0pi -e 's|(\tr = dss_init_ports\(pdev\);\n\tif \(r\)\n\t\tgoto err_init_ports;\n\n)\tpm_runtime_enable\(&pdev->dev\);\n|$1|' $D/dss/dss.c
grep -n "pm_runtime_enable" $D/dss/dss.c | tr '\n' ' '
# 9. the stock Jet dispc.c sets DISPC_CONFIG bit 17 (FIFOFILLING) unconditionally at init
#    (regdump on stock Android: DISPC_CONFIG1 0x00030004). Set it with the FIFO handcheck
#    for stall-mode (RFBI) managers.
grep -q "FIFOFILLING" $D/dss/dispc.c || perl -0pi -e 's|(\tdispc_mgr_enable_fifohandcheck\(channel, config->fifohandcheck\);\n)|$1\tif (config->stallmode \&\& channel == OMAP_DSS_CHANNEL_LCD)\n\t\tREG_FLD_MOD(DISPC_CONFIG, 1, 17, 17); /* FIFOFILLING, as the stock Jet kernel */\n|' $D/dss/dispc.c
grep -c "FIFOFILLING" $D/dss/dispc.c | tr '\n' ' '
# 10. Recon Jet touchpad (Partron MS37C01A / VD5377) input driver, kernel/overlay/drivers/input/misc/jet-ofm.c
grep -q INPUT_JET_OFM drivers/input/misc/Kconfig || perl -0pi -e 's|\nendif\n\z|\nconfig INPUT_JET_OFM\n\ttristate "Recon Jet optical finger touchpad (Partron MS37C01A)"\n\tdepends on I2C && GPIOLIB\n\thelp\n\t  Swipe keys and raw motion from the Partron OFM module on the Recon Jet.\n\nendif\n|' drivers/input/misc/Kconfig
grep -q jet-ofm drivers/input/misc/Makefile || echo 'obj-$(CONFIG_INPUT_JET_OFM)		+= jet-ofm.o' >> drivers/input/misc/Makefile
grep -c "JET_OFM\|jet-ofm" drivers/input/misc/Kconfig drivers/input/misc/Makefile | tr '\n' ' '
# 11. OMAP4 ISS camera driver (resurrected from v6.6 staging, overlay drivers/media/platform/ti/omap4iss)
grep -q omap4iss drivers/media/platform/ti/Kconfig || printf '\nsource "drivers/media/platform/ti/omap4iss/Kconfig"\n' >> drivers/media/platform/ti/Kconfig
grep -q omap4iss drivers/media/platform/ti/Makefile || echo 'obj-y += omap4iss/' >> drivers/media/platform/ti/Makefile
grep -c omap4iss drivers/media/platform/ti/Kconfig drivers/media/platform/ti/Makefile | tr '\n' ' '
# 12. reboot = COLD software reset instead of warm: warm restarts from a display/camera-active mainline
#     hang the next boot (bootloader lottery), and the watchdog's warm reset can leave the Jet dead.
#     PRM_RSTCTRL bit 1 = RST_GLOBAL_COLD_SW (like a power-on reset; boots eMMC Android, cycle.sh copes).
grep -q "RST_GLOBAL_COLD_SW (Recon Jet)" arch/arm/mach-omap2/prminst44xx.c || sed -i 's#\tv |= OMAP4430_RST_GLOBAL_WARM_SW_MASK;#\tv |= (1 << 1);\t/* RST_GLOBAL_COLD_SW (Recon Jet): warm resets hang the next boot */#' arch/arm/mach-omap2/prminst44xx.c
grep -c "RST_GLOBAL_COLD_SW (Recon Jet)" arch/arm/mach-omap2/prminst44xx.c | tr '\n' ' '
grep -c "rfbi" $D/dss/core.c $D/dss/dss.h $D/dss/Makefile include/video/omapfb_dss.h | tr '\n' ' '; echo "(apply.sh ok)"
