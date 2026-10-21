/* SPDX-License-Identifier: GPL-2.0-only */
/*
 * omapfb RFBI (MIPI DBI type B) output API for panel drivers.
 *
 * RFBI support was dropped from omapfb in Linux 5.3 ("no users"). This header,
 * dss/rfbi.c and displays/panel-kopin-a230.c bring it back for the Recon Jet
 * (Kopin A230 microdisplay on OMAP4 RFBI). Timing structures follow the 4.19
 * omapfb_dss.h definitions; the ops struct mirrors omapdss_dsi_ops.
 */
#ifndef __OMAPFB_RFBI_H
#define __OMAPFB_RFBI_H

#include <linux/types.h>

struct omap_dss_device;

enum omap_rfbi_te_mode {
	OMAP_DSS_RFBI_TE_MODE_1 = 1,
	OMAP_DSS_RFBI_TE_MODE_2 = 2,
};

/* All times in picoseconds, converted by the driver into L4 clock ticks. */
struct rfbi_timings {
	int cs_on_time;
	int cs_off_time;
	int we_on_time;
	int we_off_time;
	int re_on_time;
	int re_off_time;
	int we_cycle_time;
	int re_cycle_time;
	int cs_pulse_width;
	int access_time;

	int clk_div;

	u32 tim[5];		/* set by rfbi_convert_timings() */
	int converted;
};

struct omapdss_rfbi_ops {
	int (*connect)(struct omap_dss_device *dssdev,
			struct omap_dss_device *dst);
	void (*disconnect)(struct omap_dss_device *dssdev,
			struct omap_dss_device *dst);

	int (*enable)(struct omap_dss_device *dssdev);
	void (*disable)(struct omap_dss_device *dssdev);

	/* bus geometry: pixel bpp and parallel data lines, e.g. (16, 8) or (16, 16) */
	int (*configure)(struct omap_dss_device *dssdev, int pixel_size,
			int data_lines);
	void (*set_size)(struct omap_dss_device *dssdev, u16 w, u16 h);
	void (*set_interface_timings)(struct omap_dss_device *dssdev,
			const struct rfbi_timings *timings);
	int (*enable_te)(struct omap_dss_device *dssdev, bool enable,
			unsigned int line);

	/* programmed I/O on the bus (caller holds bus_lock) */
	void (*write_command)(struct omap_dss_device *dssdev, const void *buf,
			u32 len);
	void (*write_data)(struct omap_dss_device *dssdev, const void *buf,
			u32 len);
	void (*read_data)(struct omap_dss_device *dssdev, void *buf, u32 len);

	/* push the whole LCD manager frame through DISPC; callback on FRAMEDONE */
	int (*update)(struct omap_dss_device *dssdev,
			void (*callback)(void *), void *data);

	void (*bus_lock)(struct omap_dss_device *dssdev);
	void (*bus_unlock)(struct omap_dss_device *dssdev);
};

#endif
