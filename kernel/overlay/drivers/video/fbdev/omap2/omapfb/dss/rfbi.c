// SPDX-License-Identifier: GPL-2.0-only
/*
 * RFBI (MIPI DBI type B / Remote Framebuffer Interface) output for omapfb.
 *
 * Re-added for the Recon Jet (OMAP4430 + Kopin A230). Based on the 4.19 omapfb
 * rfbi.c (removed in 5.3 for lack of users) and on the register sequences of the
 * Recon 3.0 kernel driver that drives this exact panel. The output exposes a
 * small ops API (include/video/omapfb_rfbi.h) that the panel driver uses, in the
 * same way DSI command-mode panels use omapdss_dsi_ops.
 *
 * Copyright (C) 2009 Nokia Corporation (original)
 */

#define DSS_SUBSYS_NAME "RFBI"

#include <linux/kernel.h>
#include <linux/export.h>
#include <linux/clk.h>
#include <linux/io.h>
#include <linux/delay.h>
#include <linux/seq_file.h>
#include <linux/semaphore.h>
#include <linux/platform_device.h>
#include <linux/pm_runtime.h>
#include <linux/component.h>
#include <linux/of.h>
#include <linux/string.h>

#include <video/omapfb_dss.h>
#include <video/omapfb_rfbi.h>
#include "dss.h"

struct rfbi_reg { u16 idx; };

#define RFBI_REG(idx)		((const struct rfbi_reg) { idx })

#define RFBI_REVISION		RFBI_REG(0x0000)
#define RFBI_SYSCONFIG		RFBI_REG(0x0010)
#define RFBI_SYSSTATUS		RFBI_REG(0x0014)
#define RFBI_CONTROL		RFBI_REG(0x0040)
#define RFBI_PIXEL_CNT		RFBI_REG(0x0044)
#define RFBI_LINE_NUMBER	RFBI_REG(0x0048)
#define RFBI_CMD		RFBI_REG(0x004c)
#define RFBI_PARAM		RFBI_REG(0x0050)
#define RFBI_DATA		RFBI_REG(0x0054)
#define RFBI_READ		RFBI_REG(0x0058)
#define RFBI_STATUS		RFBI_REG(0x005c)

#define RFBI_CONFIG(n)		RFBI_REG(0x0060 + (n)*0x18)
#define RFBI_ONOFF_TIME(n)	RFBI_REG(0x0064 + (n)*0x18)
#define RFBI_CYCLE_TIME(n)	RFBI_REG(0x0068 + (n)*0x18)
#define RFBI_DATA_CYCLE1(n)	RFBI_REG(0x006c + (n)*0x18)
#define RFBI_DATA_CYCLE2(n)	RFBI_REG(0x0070 + (n)*0x18)
#define RFBI_DATA_CYCLE3(n)	RFBI_REG(0x0074 + (n)*0x18)

#define RFBI_VSYNC_WIDTH	RFBI_REG(0x0090)
#define RFBI_HSYNC_WIDTH	RFBI_REG(0x0094)

#define REG_FLD_MOD(idx, val, start, end) \
	rfbi_write_reg(idx, FLD_MOD(rfbi_read_reg(idx), val, start, end))

enum omap_rfbi_cycleformat {
	OMAP_DSS_RFBI_CYCLEFORMAT_1_1 = 0,
	OMAP_DSS_RFBI_CYCLEFORMAT_2_1 = 1,
	OMAP_DSS_RFBI_CYCLEFORMAT_3_1 = 2,
	OMAP_DSS_RFBI_CYCLEFORMAT_3_2 = 3,
};

enum omap_rfbi_datatype {
	OMAP_DSS_RFBI_DATATYPE_12 = 0,
	OMAP_DSS_RFBI_DATATYPE_16 = 1,
	OMAP_DSS_RFBI_DATATYPE_18 = 2,
	OMAP_DSS_RFBI_DATATYPE_24 = 3,
};

enum omap_rfbi_parallelmode {
	OMAP_DSS_RFBI_PARALLELMODE_8 = 0,
	OMAP_DSS_RFBI_PARALLELMODE_9 = 1,
	OMAP_DSS_RFBI_PARALLELMODE_12 = 2,
	OMAP_DSS_RFBI_PARALLELMODE_16 = 3,
};

static int rfbi_convert_timings(struct rfbi_timings *t);

/* settle time between starting a read cycle and sampling RFBI_READ (/sys/module/omapdss/parameters) */
static int rfbi_read_delay_us = 10;
module_param(rfbi_read_delay_us, int, 0644);

static struct {
	struct platform_device *pdev;
	void __iomem	*base;

	unsigned long	l4_khz;

	enum omap_rfbi_datatype datatype;
	enum omap_rfbi_parallelmode parallelmode;
	enum omap_rfbi_te_mode te_mode;
	int te_enabled;

	void (*framedone_callback)(void *data);
	void *framedone_callback_data;

	struct semaphore bus_lock;

	struct omap_video_timings timings;
	int pixel_size;
	int data_lines;
	struct rfbi_timings intf_timings;

	bool enabled;
	struct omap_dss_device output;
} rfbi;

static inline void rfbi_write_reg(const struct rfbi_reg idx, u32 val)
{
	__raw_writel(val, rfbi.base + idx.idx);
}

static inline u32 rfbi_read_reg(const struct rfbi_reg idx)
{
	return __raw_readl(rfbi.base + idx.idx);
}

static int rfbi_runtime_get(void)
{
	int r;

	r = pm_runtime_get_sync(&rfbi.pdev->dev);
	WARN_ON(r < 0);
	return r < 0 ? r : 0;
}

static void rfbi_runtime_put(void)
{
	int r;

	r = pm_runtime_put_sync(&rfbi.pdev->dev);
	WARN_ON(r < 0 && r != -ENOSYS);
}

static void rfbi_bus_lock(struct omap_dss_device *dssdev)
{
	down(&rfbi.bus_lock);
}

static void rfbi_bus_unlock(struct omap_dss_device *dssdev)
{
	up(&rfbi.bus_lock);
}

static void rfbi_write_command(struct omap_dss_device *dssdev,
		const void *buf, u32 len)
{
	switch (rfbi.parallelmode) {
	case OMAP_DSS_RFBI_PARALLELMODE_8:
	{
		const u8 *b = buf;
		for (; len; len--)
			rfbi_write_reg(RFBI_CMD, *b++);
		break;
	}

	case OMAP_DSS_RFBI_PARALLELMODE_16:
	{
		const u16 *w = buf;
		BUG_ON(len & 1);
		for (; len; len -= 2)
			rfbi_write_reg(RFBI_CMD, *w++);
		break;
	}

	default:
		BUG();
	}
}

static void rfbi_read_data(struct omap_dss_device *dssdev, void *buf, u32 len)
{
	switch (rfbi.parallelmode) {
	case OMAP_DSS_RFBI_PARALLELMODE_8:
	{
		u8 *b = buf;
		for (; len; len--) {
			rfbi_write_reg(RFBI_READ, 0);
			udelay(rfbi_read_delay_us);
			*b++ = rfbi_read_reg(RFBI_READ);
		}
		break;
	}

	case OMAP_DSS_RFBI_PARALLELMODE_16:
	{
		u16 *w = buf;
		BUG_ON(len & 1);
		for (; len; len -= 2) {
			rfbi_write_reg(RFBI_READ, 0);
			udelay(rfbi_read_delay_us);
			*w++ = rfbi_read_reg(RFBI_READ);
		}
		break;
	}

	default:
		BUG();
	}
}

static void rfbi_write_data(struct omap_dss_device *dssdev,
		const void *buf, u32 len)
{
	switch (rfbi.parallelmode) {
	case OMAP_DSS_RFBI_PARALLELMODE_8:
	{
		const u8 *b = buf;
		for (; len; len--)
			rfbi_write_reg(RFBI_PARAM, *b++);
		break;
	}

	case OMAP_DSS_RFBI_PARALLELMODE_16:
	{
		const u16 *w = buf;
		BUG_ON(len & 1);
		for (; len; len -= 2)
			rfbi_write_reg(RFBI_PARAM, *w++);
		break;
	}

	default:
		BUG();
	}
}

/*
 * Push one full frame from DISPC (LCD manager) through RFBI. The panel driver
 * has already sent the "start of frame" command. The callback runs from the
 * DISPC FRAMEDONE handler.
 */
static int rfbi_transfer_area(struct omap_dss_device *dssdev,
		void (*callback)(void *data), void *data)
{
	u32 l;
	struct omap_overlay_manager *mgr = rfbi.output.manager;
	u16 width = rfbi.timings.x_res;
	u16 height = rfbi.timings.y_res;

	if (!mgr)
		return -ENODEV;

	BUG_ON(rfbi.framedone_callback != NULL);

	DSSDBG("rfbi_transfer_area %dx%d\n", width, height);

	dss_mgr_set_timings(mgr, &rfbi.timings);

	/*
	 * Same order as the stock Jet rfbi_transfer_area: start DISPC (LCDENABLE,
	 * it stalls on the RFBI FIFO handshake) first, then program the pixel
	 * count, enable the RFBI, and trigger with a separate ITE write.
	 */
	dss_mgr_start_update(mgr);

	rfbi.framedone_callback = callback;
	rfbi.framedone_callback_data = data;

	rfbi_write_reg(RFBI_PIXEL_CNT, width * height);

	l = rfbi_read_reg(RFBI_CONTROL);
	l = FLD_MOD(l, 1, 0, 0); /* enable */
	l = FLD_MOD(l, 0, 4, 4); /* ITE */
	rfbi_write_reg(RFBI_CONTROL, l);
	l = rfbi_read_reg(RFBI_CONTROL);
	if (!rfbi.te_enabled)
		l = FLD_MOD(l, 1, 4, 4); /* ITE: internal trigger, start now */
	rfbi_write_reg(RFBI_CONTROL, l);

	return 0;
}

static void framedone_callback(void *data)
{
	void (*callback)(void *data);

	DSSDBG("FRAMEDONE\n");

	REG_FLD_MOD(RFBI_CONTROL, 0, 0, 0);

	callback = rfbi.framedone_callback;
	rfbi.framedone_callback = NULL;

	if (callback != NULL)
		callback(rfbi.framedone_callback_data);
}

static int ps_to_rfbi_ticks(int time, int div)
{
	unsigned long tick_ps;
	int ret;

	/* Calculate in picosecs to yield more exact results */
	tick_ps = 1000000000 / (rfbi.l4_khz) * div;

	ret = (time + tick_ps - 1) / tick_ps;

	return ret;
}

static int rfbi_convert_timings(struct rfbi_timings *t)
{
	u32 l;
	int reon, reoff, weon, weoff, cson, csoff, cs_pulse;
	int actim, recyc, wecyc;
	int div = t->clk_div;

	if (div <= 0 || div > 2)
		return -1;

	/* Make sure that after conversion it still holds that:
	 * weoff > weon, reoff > reon, recyc >= reoff, wecyc >= weoff,
	 * csoff > cson, csoff >= max(weoff, reoff), actim > reon
	 */
	weon = ps_to_rfbi_ticks(t->we_on_time, div);
	weoff = ps_to_rfbi_ticks(t->we_off_time, div);
	if (weoff <= weon)
		weoff = weon + 1;
	if (weon > 0x0f)
		return -1;
	if (weoff > 0x3f)
		return -1;

	reon = ps_to_rfbi_ticks(t->re_on_time, div);
	reoff = ps_to_rfbi_ticks(t->re_off_time, div);
	if (reoff <= reon)
		reoff = reon + 1;
	if (reon > 0x0f)
		return -1;
	if (reoff > 0x3f)
		return -1;

	cson = ps_to_rfbi_ticks(t->cs_on_time, div);
	csoff = ps_to_rfbi_ticks(t->cs_off_time, div);
	if (csoff <= cson)
		csoff = cson + 1;
	if (csoff < max(weoff, reoff))
		csoff = max(weoff, reoff);
	if (cson > 0x0f)
		return -1;
	if (csoff > 0x3f)
		return -1;

	l =  cson;
	l |= csoff << 4;
	l |= weon  << 10;
	l |= weoff << 14;
	l |= reon  << 20;
	l |= reoff << 24;

	t->tim[0] = l;

	actim = ps_to_rfbi_ticks(t->access_time, div);
	if (actim <= reon)
		actim = reon + 1;
	if (actim > 0x3f)
		return -1;

	wecyc = ps_to_rfbi_ticks(t->we_cycle_time, div);
	if (wecyc < weoff)
		wecyc = weoff;
	if (wecyc > 0x3f)
		return -1;

	recyc = ps_to_rfbi_ticks(t->re_cycle_time, div);
	if (recyc < reoff)
		recyc = reoff;
	if (recyc > 0x3f)
		return -1;

	cs_pulse = ps_to_rfbi_ticks(t->cs_pulse_width, div);
	if (cs_pulse > 0x3f)
		return -1;

	l =  wecyc;
	l |= recyc    << 6;
	l |= cs_pulse << 12;
	l |= actim    << 22;

	t->tim[1] = l;

	t->tim[2] = div - 1;

	t->converted = 1;

	return 0;
}

static int calc_extif_timings(struct rfbi_timings *t)
{
	int div;

	for (div = 1; div <= 2; div++) {
		t->clk_div = div;
		if (rfbi_convert_timings(t) == 0)
			return 0;
	}

	DSSERR("can't setup timings\n");
	return -1;
}

static void rfbi_set_timings(int rfbi_module, struct rfbi_timings *t)
{
	int r;

	if (!t->converted) {
		r = calc_extif_timings(t);
		if (r < 0)
			DSSERR("Failed to calc timings\n");
	}

	BUG_ON(!t->converted);

	rfbi_write_reg(RFBI_ONOFF_TIME(rfbi_module), t->tim[0]);
	rfbi_write_reg(RFBI_CYCLE_TIME(rfbi_module), t->tim[1]);

	/* TIMEGRANULARITY */
	REG_FLD_MOD(RFBI_CONFIG(rfbi_module),
		    (t->tim[2] ? 1 : 0), 4, 4);

	DSSDBG("RFBI timings: onoff %08x cycle %08x div %d\n",
	       t->tim[0], t->tim[1], t->clk_div);
}

static int rfbi_enable_te(struct omap_dss_device *dssdev, bool enable,
		unsigned int line)
{
	u32 l;

	if (line > (1 << 11) - 1)
		return -EINVAL;

	l = rfbi_read_reg(RFBI_CONFIG(0));
	l &= ~(0x3 << 2);
	if (enable) {
		rfbi.te_enabled = 1;
		l |= rfbi.te_mode << 2;
	} else
		rfbi.te_enabled = 0;
	rfbi_write_reg(RFBI_CONFIG(0), l);
	rfbi_write_reg(RFBI_LINE_NUMBER, line);

	return 0;
}

static int rfbi_configure_bus(int rfbi_module, int bpp, int lines)
{
	u32 l;
	int cycle1 = 0, cycle2 = 0, cycle3 = 0;
	enum omap_rfbi_cycleformat cycleformat;
	enum omap_rfbi_datatype datatype;
	enum omap_rfbi_parallelmode parallelmode;

	switch (bpp) {
	case 12:
		datatype = OMAP_DSS_RFBI_DATATYPE_12;
		break;
	case 16:
		datatype = OMAP_DSS_RFBI_DATATYPE_16;
		break;
	case 18:
		datatype = OMAP_DSS_RFBI_DATATYPE_18;
		break;
	case 24:
		datatype = OMAP_DSS_RFBI_DATATYPE_24;
		break;
	default:
		return -EINVAL;
	}
	rfbi.datatype = datatype;

	switch (lines) {
	case 8:
		parallelmode = OMAP_DSS_RFBI_PARALLELMODE_8;
		break;
	case 9:
		parallelmode = OMAP_DSS_RFBI_PARALLELMODE_9;
		break;
	case 12:
		parallelmode = OMAP_DSS_RFBI_PARALLELMODE_12;
		break;
	case 16:
		parallelmode = OMAP_DSS_RFBI_PARALLELMODE_16;
		break;
	default:
		return -EINVAL;
	}
	rfbi.parallelmode = parallelmode;

	if ((bpp % lines) == 0) {
		switch (bpp / lines) {
		case 1:
			cycleformat = OMAP_DSS_RFBI_CYCLEFORMAT_1_1;
			break;
		case 2:
			cycleformat = OMAP_DSS_RFBI_CYCLEFORMAT_2_1;
			break;
		case 3:
			cycleformat = OMAP_DSS_RFBI_CYCLEFORMAT_3_1;
			break;
		default:
			return -EINVAL;
		}
	} else if ((2 * bpp % lines) == 0) {
		if ((2 * bpp / lines) == 3)
			cycleformat = OMAP_DSS_RFBI_CYCLEFORMAT_3_2;
		else
			return -EINVAL;
	} else {
		return -EINVAL;
	}

	switch (cycleformat) {
	case OMAP_DSS_RFBI_CYCLEFORMAT_1_1:
		cycle1 = lines;
		break;

	case OMAP_DSS_RFBI_CYCLEFORMAT_2_1:
		cycle1 = lines;
		cycle2 = lines;
		break;

	case OMAP_DSS_RFBI_CYCLEFORMAT_3_1:
		cycle1 = lines;
		cycle2 = lines;
		cycle3 = lines;
		break;

	case OMAP_DSS_RFBI_CYCLEFORMAT_3_2:
		cycle1 = lines;
		cycle2 = (lines / 2) | ((lines / 2) << 16);
		cycle3 = (lines << 16);
		break;
	}

	REG_FLD_MOD(RFBI_CONTROL, 0, 3, 2); /* clear CS */

	l = 0;
	l |= FLD_VAL(parallelmode, 1, 0);
	l |= FLD_VAL(0, 3, 2);		/* TRIGGERMODE: ITE */
	l |= FLD_VAL(0, 4, 4);		/* TIMEGRANULARITY */
	l |= FLD_VAL(datatype, 6, 5);
	l |= FLD_VAL(0, 8, 7);	/* L4FORMAT, 1pix/L4 */
	l |= FLD_VAL(cycleformat, 10, 9);
	l |= FLD_VAL(0, 12, 11);	/* UNUSEDBITS */
	l |= FLD_VAL(0, 16, 16);	/* A0POLARITY */
	l |= FLD_VAL(0, 17, 17);	/* REPOLARITY */
	l |= FLD_VAL(0, 18, 18);	/* WEPOLARITY */
	l |= FLD_VAL(0, 19, 19);	/* CSPOLARITY */
	l |= FLD_VAL(1, 20, 20);	/* TE_VSYNC_POLARITY */
	l |= FLD_VAL(1, 21, 21);	/* HSYNCPOLARITY */
	rfbi_write_reg(RFBI_CONFIG(rfbi_module), l);

	rfbi_write_reg(RFBI_DATA_CYCLE1(rfbi_module), cycle1);
	rfbi_write_reg(RFBI_DATA_CYCLE2(rfbi_module), cycle2);
	rfbi_write_reg(RFBI_DATA_CYCLE3(rfbi_module), cycle3);

	l = rfbi_read_reg(RFBI_CONTROL);
	l = FLD_MOD(l, rfbi_module+1, 3, 2); /* Select CSx */
	l = FLD_MOD(l, 0, 1, 1); /* clear bypass */
	rfbi_write_reg(RFBI_CONTROL, l);

	DSSDBG("RFBI config: bpp %d, lines %d, cycles: 0x%x 0x%x 0x%x\n",
	       bpp, lines, cycle1, cycle2, cycle3);

	return 0;
}

static int rfbi_configure(struct omap_dss_device *dssdev, int pixel_size,
		int data_lines)
{
	rfbi.pixel_size = pixel_size;
	rfbi.data_lines = data_lines;

	/* only re-program the hardware while the output is powered */
	if (!rfbi.enabled)
		return 0;

	return rfbi_configure_bus(0, pixel_size, data_lines);
}

static int rfbi_update(struct omap_dss_device *dssdev, void (*callback)(void *),
		void *data)
{
	return rfbi_transfer_area(dssdev, callback, data);
}

static void rfbi_set_size(struct omap_dss_device *dssdev, u16 w, u16 h)
{
	rfbi.timings.x_res = w;
	rfbi.timings.y_res = h;
}

static void rfbi_set_interface_timings(struct omap_dss_device *dssdev,
		const struct rfbi_timings *timings)
{
	rfbi.intf_timings = *timings;
	rfbi.intf_timings.converted = 0;
}

static void rfbi_dump_regs(struct seq_file *s)
{
#define DUMPREG(r) seq_printf(s, "%-35s %08x\n", #r, rfbi_read_reg(r))

	if (rfbi_runtime_get())
		return;

	DUMPREG(RFBI_REVISION);
	DUMPREG(RFBI_SYSCONFIG);
	DUMPREG(RFBI_SYSSTATUS);
	DUMPREG(RFBI_CONTROL);
	DUMPREG(RFBI_PIXEL_CNT);
	DUMPREG(RFBI_LINE_NUMBER);
	DUMPREG(RFBI_CMD);
	DUMPREG(RFBI_PARAM);
	DUMPREG(RFBI_DATA);
	DUMPREG(RFBI_READ);
	DUMPREG(RFBI_STATUS);

	DUMPREG(RFBI_CONFIG(0));
	DUMPREG(RFBI_ONOFF_TIME(0));
	DUMPREG(RFBI_CYCLE_TIME(0));
	DUMPREG(RFBI_DATA_CYCLE1(0));
	DUMPREG(RFBI_DATA_CYCLE2(0));
	DUMPREG(RFBI_DATA_CYCLE3(0));

	DUMPREG(RFBI_CONFIG(1));
	DUMPREG(RFBI_ONOFF_TIME(1));
	DUMPREG(RFBI_CYCLE_TIME(1));
	DUMPREG(RFBI_DATA_CYCLE1(1));
	DUMPREG(RFBI_DATA_CYCLE2(1));
	DUMPREG(RFBI_DATA_CYCLE3(1));

	DUMPREG(RFBI_VSYNC_WIDTH);
	DUMPREG(RFBI_HSYNC_WIDTH);

	rfbi_runtime_put();
#undef DUMPREG
}

static void rfbi_config_lcd_manager(struct omap_dss_device *dssdev)
{
	struct omap_overlay_manager *mgr = rfbi.output.manager;
	struct dss_lcd_mgr_config mgr_config;

	memset(&mgr_config, 0, sizeof(mgr_config));

	/*
	 * In stall mode the pixel clock only paces DISPC handing pixels to the
	 * RFBI FIFO; any valid divider pair will do (the stock driver left this
	 * uninitialised). Use the DSS fclk with small dividers.
	 */
	dss_select_lcd_clk_source(mgr->id, OMAP_DSS_CLK_SRC_FCK);
	mgr_config.clock_info.lck_div = 1;
	/*
	 * The stock Jet dispc.c hard-codes lck 1 / pck 5 (DISPC_DIVISOR1 0x00010005) on
	 * the same 170.67 MHz DSS fclk mainline uses (dpll_per M5 = 9 on both kernels).
	 */
	mgr_config.clock_info.pck_div = 5;
	pr_info("rfbi: dispc fclk %lu Hz, pck_div %u\n", dss_get_dispc_clk_rate(),
		mgr_config.clock_info.pck_div);

	mgr_config.io_pad_mode = DSS_IO_PAD_MODE_RFBI;

	mgr_config.stallmode = true;
	/*
	 * The stock Jet driver enables the FIFO handcheck (DISPC stalls while the
	 * RFBI FIFO is full); without it every frame ends in SYNC_LOST.
	 */
	mgr_config.fifohandcheck = true;

	mgr_config.video_port_width = rfbi.pixel_size;
	mgr_config.lcden_sig_polarity = 0;

	dss_mgr_set_lcd_config(mgr, &mgr_config);
	/*
	 * The apply layer only writes a manual-update manager's LCD config to the
	 * hardware at the first update (dss_write_regs skips stall-mode managers),
	 * i.e. after the panel driver has already sent its init table over the bus.
	 * Until then DISPC_CONTROL still has reset values (no RFBI pad mode, no
	 * stall mode, GPOUT bits clear) and register writes to the panel are
	 * partly lost. The stock DSS programmed DISPC directly in display enable:
	 * do the same now (DISPC is powered while the RFBI is active).
	 */
	dispc_mgr_set_lcd_config(mgr->id, &mgr_config);

	/*
	 * Set rfbi.timings with default values, the x_res and y_res fields
	 * are expected to be already configured by the panel driver via
	 * set_size().
	 */
	rfbi.timings.hsw = 1;
	rfbi.timings.hfp = 1;
	rfbi.timings.hbp = 1;
	rfbi.timings.vsw = 1;
	rfbi.timings.vfp = 0;
	rfbi.timings.vbp = 0;

	rfbi.timings.interlace = false;
	rfbi.timings.hsync_level = OMAPDSS_SIG_ACTIVE_HIGH;
	rfbi.timings.vsync_level = OMAPDSS_SIG_ACTIVE_HIGH;
	rfbi.timings.data_pclk_edge = OMAPDSS_DRIVE_SIG_RISING_EDGE;
	rfbi.timings.de_level = OMAPDSS_SIG_ACTIVE_HIGH;
	rfbi.timings.sync_pclk_edge = OMAPDSS_DRIVE_SIG_FALLING_EDGE;

	dss_mgr_set_timings(mgr, &rfbi.timings);
}

static int rfbi_display_enable(struct omap_dss_device *dssdev)
{
	struct omap_dss_device *out = &rfbi.output;
	int r;

	if (out->manager == NULL) {
		DSSERR("failed to enable display: no output/manager\n");
		return -ENODEV;
	}

	r = rfbi_runtime_get();
	if (r)
		return r;

	r = dss_mgr_register_framedone_handler(out->manager,
			framedone_callback, NULL);
	if (r) {
		DSSERR("can't get FRAMEDONE irq\n");
		goto err1;
	}

	rfbi_config_lcd_manager(dssdev);

	r = dss_mgr_enable(out->manager);
	if (r) {
		DSSERR("can't enable manager\n");
		goto err2;
	}

	rfbi_configure_bus(0, rfbi.pixel_size, rfbi.data_lines);

	rfbi_set_timings(0, &rfbi.intf_timings);

	rfbi.enabled = true;

	return 0;
err2:
	dss_mgr_unregister_framedone_handler(out->manager,
			framedone_callback, NULL);
err1:
	rfbi_runtime_put();
	return r;
}

static void rfbi_display_disable(struct omap_dss_device *dssdev)
{
	struct omap_dss_device *out = &rfbi.output;

	if (!rfbi.enabled)
		return;

	rfbi.enabled = false;

	dss_mgr_disable(out->manager);

	dss_mgr_unregister_framedone_handler(out->manager,
			framedone_callback, NULL);

	rfbi_runtime_put();
}

static int rfbi_connect(struct omap_dss_device *dssdev,
		struct omap_dss_device *dst)
{
	struct omap_overlay_manager *mgr;
	int r;

	mgr = omap_dss_get_overlay_manager(dssdev->dispc_channel);
	if (!mgr)
		return -ENODEV;

	r = dss_mgr_connect(mgr, dssdev);
	if (r)
		return r;

	r = omapdss_output_set_device(dssdev, dst);
	if (r) {
		DSSERR("failed to connect output to new device: %s\n",
				dst->name);
		dss_mgr_disconnect(mgr, dssdev);
		return r;
	}

	return 0;
}

static void rfbi_disconnect(struct omap_dss_device *dssdev,
		struct omap_dss_device *dst)
{
	WARN_ON(dst != dssdev->dst);

	if (dst != dssdev->dst)
		return;

	omapdss_output_unset_device(dssdev);

	if (dssdev->manager)
		dss_mgr_disconnect(dssdev->manager, dssdev);
}

static const struct omapdss_rfbi_ops rfbi_ops = {
	.connect = rfbi_connect,
	.disconnect = rfbi_disconnect,

	.enable = rfbi_display_enable,
	.disable = rfbi_display_disable,

	.configure = rfbi_configure,
	.set_size = rfbi_set_size,
	.set_interface_timings = rfbi_set_interface_timings,
	.enable_te = rfbi_enable_te,

	.write_command = rfbi_write_command,
	.write_data = rfbi_write_data,
	.read_data = rfbi_read_data,

	.update = rfbi_update,

	.bus_lock = rfbi_bus_lock,
	.bus_unlock = rfbi_bus_unlock,
};

static void rfbi_init_output(struct platform_device *pdev)
{
	struct omap_dss_device *out = &rfbi.output;

	out->dev = &pdev->dev;
	out->id = OMAP_DSS_OUTPUT_DBI;
	out->output_type = OMAP_DISPLAY_TYPE_DBI;
	out->name = "rfbi.0";
	out->dispc_channel = OMAP_DSS_CHANNEL_LCD;
	out->ops.rfbi = &rfbi_ops;
	out->owner = THIS_MODULE;
	out->port_num = 0;

	omapdss_register_output(out);
}

static void rfbi_uninit_output(struct platform_device *pdev)
{
	struct omap_dss_device *out = &rfbi.output;

	omapdss_unregister_output(out);
}

/* RFBI HW IP initialisation */
static int rfbi_bind(struct device *dev, struct device *master, void *data)
{
	struct platform_device *pdev = to_platform_device(dev);
	u32 rev;
	struct resource *rfbi_mem;
	struct clk *clk;
	int r;

	rfbi.pdev = pdev;

	sema_init(&rfbi.bus_lock, 1);

	rfbi_mem = platform_get_resource(rfbi.pdev, IORESOURCE_MEM, 0);
	if (!rfbi_mem) {
		DSSERR("can't get IORESOURCE_MEM RFBI\n");
		return -EINVAL;
	}

	rfbi.base = devm_ioremap(&pdev->dev, rfbi_mem->start,
				 resource_size(rfbi_mem));
	if (!rfbi.base) {
		DSSERR("can't ioremap RFBI\n");
		return -ENOMEM;
	}

	clk = clk_get(&pdev->dev, "ick");
	if (IS_ERR(clk)) {
		DSSERR("can't get ick\n");
		return PTR_ERR(clk);
	}

	rfbi.l4_khz = clk_get_rate(clk) / 1000;

	clk_put(clk);

	/* sane defaults until the panel configures us */
	rfbi.pixel_size = 16;
	rfbi.data_lines = 16;
	rfbi.te_mode = OMAP_DSS_RFBI_TE_MODE_1;

	pm_runtime_enable(&pdev->dev);

	r = rfbi_runtime_get();
	if (r)
		goto err_runtime_get;

	msleep(10);

	rev = rfbi_read_reg(RFBI_REVISION);
	dev_info(&pdev->dev, "OMAP RFBI rev %d.%d, L4 %lu kHz\n",
	       FLD_GET(rev, 7, 4), FLD_GET(rev, 3, 0), rfbi.l4_khz);

	rfbi_runtime_put();

	dss_debugfs_create_file("rfbi", rfbi_dump_regs);

	rfbi_init_output(pdev);

	return 0;

err_runtime_get:
	pm_runtime_disable(&pdev->dev);
	return r;
}

static void rfbi_unbind(struct device *dev, struct device *master, void *data)
{
	struct platform_device *pdev = to_platform_device(dev);

	rfbi_uninit_output(pdev);

	pm_runtime_disable(&pdev->dev);
}

static const struct component_ops rfbi_component_ops = {
	.bind	= rfbi_bind,
	.unbind	= rfbi_unbind,
};

static int rfbi_probe(struct platform_device *pdev)
{
	return component_add(&pdev->dev, &rfbi_component_ops);
}

static void rfbi_remove(struct platform_device *pdev)
{
	component_del(&pdev->dev, &rfbi_component_ops);
}

static int rfbi_runtime_suspend(struct device *dev)
{
	dispc_runtime_put();

	return 0;
}

static int rfbi_runtime_resume(struct device *dev)
{
	int r;

	r = dispc_runtime_get();
	if (r < 0)
		return r;

	return 0;
}

static const struct dev_pm_ops rfbi_pm_ops = {
	.runtime_suspend = rfbi_runtime_suspend,
	.runtime_resume = rfbi_runtime_resume,
};

static const struct of_device_id rfbi_of_match[] = {
	{ .compatible = "ti,omap2-rfbi", },
	{ .compatible = "ti,omap3-rfbi", },
	{ .compatible = "ti,omap4-rfbi", },
	{},
};

static struct platform_driver omap_rfbihw_driver = {
	.probe		= rfbi_probe,
	.remove		= rfbi_remove,
	.driver         = {
		.name   = "omapdss_rfbi",
		.pm	= &rfbi_pm_ops,
		.of_match_table = rfbi_of_match,
		.suppress_bind_attrs = true,
	},
};

int __init rfbi_init_platform_driver(void)
{
	return platform_driver_register(&omap_rfbihw_driver);
}

void rfbi_uninit_platform_driver(void)
{
	platform_driver_unregister(&omap_rfbihw_driver);
}
