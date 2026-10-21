// SPDX-License-Identifier: GPL-2.0-only
/*
 * Kopin A230 microdisplay (Recon Jet) on the OMAP4 RFBI, for omapfb.
 *
 * Port of the Recon Instruments 3.0 kernel driver (panel-kopin-a230.c,
 * Gil Zhaiek, 2012) to the omapfb display driver model: the panel is a
 * manual-update DBI display behind the rfbi.0 output. The Kopin init table,
 * the bus timings and the register-write protocol are taken verbatim from
 * the stock driver; the backlight is a register in the Kopin ASIC.
 *
 * Device tree:
 *   panel { compatible = "recon,kopin-a230"; power-gpios, reset-gpios,
 *           clk-en-gpios, a16-gpios; clocks = <&auxclk4_ck> (27.43 MHz);
 *           port { endpoint { remote-endpoint = <&rfbi_out>; }; }; }
 */

#include <linux/backlight.h>
#include <linux/clk.h>
#include <linux/delay.h>
#include <linux/gpio/consumer.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/of.h>
#include <linux/platform_device.h>
#include <linux/slab.h>

#include <video/omapfb_dss.h>
#include <video/omapfb_rfbi.h>

#define KOPIN_WIDTH		428
#define KOPIN_HEIGHT		240

/* RFBI bus cycle: 10% slower than the 27 MHz (37037 ps) the stock comment calls "the real clock" */
#define MCLK_PS			40000

#define A230_DEFAULT_BRIGHTNESS	0x198	/* 0x66 * 4 */
#define A230_MAX_BRIGHTNESS	1023
#define A230_PWM0_H_ADDR	0x1D
#define A230_PWM1_H_ADDR	0x1E
#define A230_PWM0_1_L_ADDR	0x1F
#define A230_PWR_REG		0x12
#define A230_PWR_PAD_DWN_BIT	BIT(0)
#define A230_PWR_DIG_DWN_BIT	BIT(1)
#define A230_PWR_REG_2		0x13
#define A230_PWM_DISABLE_BIT	BIT(1)
#define A230_DAC_DWN_BIT	BIT(5)

#define KOPIN_REG_BASE_ADDR	0x1ff00

/* experiment knobs (module params + sysfs, see kernel/panel-reload.sh) */
static int a16_frame;			/* A16 level while a frame (command + pixels) is on the bus */
module_param(a16_frame, int, 0644);
static int frame_cmd;			/* start-of-frame command word */
module_param(frame_cmd, int, 0644);
static int frame_cmd_bytes = 2;		/* 1 = 8-bit command cycle, 2 = 16-bit */
module_param(frame_cmd_bytes, int, 0644);
static int pwm_rearm = 1;		/* re-program the PWM after every DISPC frame */
module_param(pwm_rearm, int, 0644);
static int reg_mode;			/* 0 = 16-bit direct (A16 high for the command cycle only, stock),
					 * 1 = 8-bit indirect via 0xB9..0xBD (no A16), 2 = direct with A16 held
					 * high through the data cycle too */
module_param(reg_mode, int, 0644);
static int a16_hold_us;			/* delay before dropping A16 after a posted RFBI command write */
module_param(a16_hold_us, int, 0644);
static int b3_unlock;			/* write 0xB3=3 through the 8-bit indirect window before the init
					 * table (stock does; the panel takes direct writes without it) */
module_param(b3_unlock, int, 0644);
static int b3_read;			/* read 0xB3 back after the unlock write, as the stock driver does */
module_param(b3_read, int, 0644);
static int b3_direct;			/* write 0xB3=3 as a direct 16-bit register write before the table */
module_param(b3_direct, int, 0644);
static int table_passes = 1;		/* send the init table this many times (each pass ends with 0xB3=3) */
module_param(table_passes, int, 0644);
static int pass_delay_ms;		/* wait between init table passes */
module_param(pass_delay_ms, int, 0644);
static int post_enable_ms = 50;		/* wait between RFBI enable and the first register write */
module_param(post_enable_ms, int, 0644);
static int reset_low_ms = 50;		/* hold ResetB low with the panel clock running before releasing it */
module_param(reset_low_ms, int, 0644);
static int post_reset_ms = 250;		/* wait after releasing reset before the first register write */
module_param(post_reset_ms, int, 0644);
static int drop_power;			/* power_off also drops the panel power rail (cold restart on unblank) */
module_param(drop_power, int, 0644);

struct kopin_reg {
	u8 addr;
	u8 data;
};

static const struct kopin_reg kopin_init_data[] = {
	{0x00,0xC2},{0x01,0x00},{0x02,0x04},{0x03,0x01},{0x04,0x01},{0x05,0x00},{0x06,0x1E},{0x07,0x0B},{0x08,0x0B},{0x09,0x80},{0x0F,0x00},
	{0x10,0x09}, /* flip display in software */
	{0x10,0x01},
	{0x11,0x04},{0x12,0x00},{0x13,0x00},{0x14,0x80},{0x15,0x00},{0x16,0x00},{0x17,0xFF},{0x18,0x80},{0x19,0x00},{0x1A,0x00},{0x1B,0x80},{0x1C,0x80},
	{A230_PWM0_H_ADDR,0},{A230_PWM1_H_ADDR,0},{A230_PWM0_1_L_ADDR,0},
	{0x20,0x01},{0x22,0x10},{0x23,0xEB},{0x24,0x10},{0x25,0xF0},{0x26,0x2A},{0x27,0x01},{0x28,0x98},{0x29,0x01},{0x2A,0xD0},{0x2B,0x00},{0x2C,0x64},{0x2D,0x00},{0x2E,0x04},{0x2F,0x02},
	{0x30,0x40},{0x31,0x00},{0x32,0x80},{0x33,0x00},{0x34,0x80},{0x36,0xAB},{0x37,0x01},{0x38,0x54},{0x39,0x00},{0x3F,0x11},
	{0x40,0x0B},{0x41,0x2A},{0x42,0x30},{0x44,0xB7},{0x45,0x01},{0x46,0x06},{0x47,0x00},{0x48,0xB5},{0x49,0x01},{0x4A,0x00},{0x4C,0x01},{0x4D,0xF1},{0x4F,0x00},
	{0x50,0xFF},{0x51,0xEF},{0x52,0xDF},{0x53,0xCF},{0x54,0xBF},{0x55,0xAF},{0x56,0x9F},{0x57,0x8F},{0x58,0x7F},{0x59,0x6F},{0x5A,0x5F},{0x5B,0x4F},{0x5C,0x3F},{0x5D,0x2F},{0x5E,0x1F},{0x5F,0x0F},
	{0x60,0x00},{0x62,0x00},{0x63,0x0F},{0x64,0x1F},{0x65,0x2F},{0x66,0x3F},{0x67,0x4F},{0x68,0x5F},{0x69,0x6F},{0x6A,0x7F},{0x6B,0x8F},{0x6C,0x9F},{0x6D,0xAF},{0x6E,0xBF},{0x6F,0xCF},
	{0x70,0xDF},{0x71,0xEF},{0x72,0xFF},
	{0x80,0x8F},{0x81,0x00},{0x82,0x00},{0x83,0x00},{0x84,0xAC},{0x85,0x01},{0x86,0xF0},{0x88,0x0F},{0x89,0x00},{0x8A,0x00},{0x8B,0x00},{0x8C,0x00},{0x8D,0x00},{0x8E,0x00},
	{0x90,0x0F},{0x91,0x00},{0x92,0x00},{0x93,0x00},{0x94,0x00},{0x95,0x00},{0x96,0x00},{0x98,0x0F},{0x99,0x00},{0x9A,0x00},{0x9B,0x00},{0x9C,0x00},{0x9D,0x00},{0x9E,0x00},
	{0xA0,0x00},{0xA1,0x00},{0xA2,0x00},{0xA4,0xFF},{0xA5,0xFE},{0xA6,0x01},{0xA8,0xFF},{0xA9,0xFE},{0xAA,0x01},{0xAC,0xFF},{0xAD,0xFE},{0xAE,0x01},
	{0xB0,0x00},{0xB1,0x00},{0xB2,0x00},{0xB3,0x03},{0x00,0x00},
};

struct panel_drv_data {
	struct omap_dss_device dssdev;
	struct omap_dss_device *in;

	struct device *dev;
	struct mutex lock;

	struct gpio_desc *power_gpio;	/* A230_POWER_ENABLE (gpio 52) */
	struct gpio_desc *reset_gpio;	/* A230_DISP_RES (gpio 42), active high = run */
	struct gpio_desc *clk_en_gpio;	/* A230_CLK_TV_EN (gpio 41) */
	struct gpio_desc *a16_gpio;	/* RFBI_A16 (gpio 163): 17th address bit */
	struct clk *clk;		/* auxclk4, 36.57 MHz to the Kopin (dpll_per m3x2 256 MHz / 7) */

	struct omap_video_timings timings;
	struct backlight_device *bldev;

	bool direct_mode;		/* 16-bit register access after the 0xB3 unlock */
	bool init_done;
	bool clk_on;
	u16 brightness;
	struct completion frame_done;
};

#define to_panel_data(p) container_of(p, struct panel_drv_data, dssdev)

static void kopin_sleep(void)
{
	usleep_range(1000, 10000);
}

/* --- bus primitives (caller holds the rfbi bus lock) --- */

static void kopin_cmd_mode(struct panel_drv_data *ddata);
static void kopin_raw_mode(struct panel_drv_data *ddata);

static void kopin_write_addr(struct panel_drv_data *ddata, u16 address)
{
	/* the bus is in 16-line raw mode here: an 8-bit command cycle would need a switch to
	 * command mode (rfbi_write_command BUG_ONs on odd lengths in 16-line mode) */
	gpiod_set_value(ddata->a16_gpio, !!a16_frame);
	if (frame_cmd_bytes == 1) {
		u8 a8 = address;

		kopin_cmd_mode(ddata);
		ddata->in->ops.rfbi->write_command(ddata->in, &a8, 1);
		kopin_raw_mode(ddata);
	} else {
		ddata->in->ops.rfbi->write_command(ddata->in, &address, 2);
	}
}

static void kopin_frame_done_bus(struct panel_drv_data *ddata)
{
	/* leave A16 low for register traffic */
	gpiod_set_value(ddata->a16_gpio, 0);
}

static void kopin_write_reg_8bit(struct panel_drv_data *ddata, u8 addr, u8 val)
{
	ddata->in->ops.rfbi->write_command(ddata->in, &addr, 1);
	ddata->in->ops.rfbi->write_data(ddata->in, &val, 1);
}

static void kopin_a16_drop(struct panel_drv_data *ddata)
{
	/* the RFBI executes posted command/data writes asynchronously: give the bus
	 * cycle time to go out with A16 still high */
	if (a16_hold_us)
		udelay(a16_hold_us);
	gpiod_set_value(ddata->a16_gpio, 0);
}

static void kopin_write_reg_16bit(struct panel_drv_data *ddata, u32 addr, u16 val)
{
	u16 tmp_addr = addr & 0xffff;
	bool a16 = addr & BIT(16);

	if (a16)
		gpiod_set_value(ddata->a16_gpio, 1);
	ddata->in->ops.rfbi->write_command(ddata->in, &tmp_addr, 2);
	if (a16 && reg_mode != 2)
		kopin_a16_drop(ddata);
	ddata->in->ops.rfbi->write_data(ddata->in, &val, 2);
	if (a16 && reg_mode == 2)
		kopin_a16_drop(ddata);
}

static u8 kopin_read_reg_8bit(struct panel_drv_data *ddata, u8 addr)
{
	u8 ret = 0;

	ddata->in->ops.rfbi->write_command(ddata->in, &addr, 1);
	ddata->in->ops.rfbi->read_data(ddata->in, &ret, 1);
	return ret;
}

static u16 kopin_read_reg_16bit(struct panel_drv_data *ddata, u32 addr)
{
	u16 tmp_addr = addr & 0xffff;
	u16 ret = 0;

	if (addr & BIT(16))
		gpiod_set_value(ddata->a16_gpio, 1);
	ddata->in->ops.rfbi->write_command(ddata->in, &tmp_addr, 2);
	if (addr & BIT(16))
		kopin_a16_drop(ddata);
	ddata->in->ops.rfbi->read_data(ddata->in, &ret, 2);
	return ret;
}

/*
 * Kopin registers are reached either through the 8-bit indirect window
 * (0xB9..0xBD) or, once 0xB3 has been written, directly with 16-bit cycles at
 * KOPIN_REG_BASE_ADDR | reg.
 */
static void kopin_write_reg(struct panel_drv_data *ddata, u32 addr, u16 val)
{
	if (ddata->direct_mode && reg_mode != 1) {
		kopin_write_reg_16bit(ddata, addr | KOPIN_REG_BASE_ADDR, val);
	} else {
		/* the indirect window is an 8-line protocol: switch the bus for it */
		bool switch_bus = ddata->direct_mode;

		if (switch_bus)
			kopin_cmd_mode(ddata);
		kopin_write_reg_8bit(ddata, 0xB9, 0x0);
		kopin_write_reg_8bit(ddata, 0xBA, (addr >> 8) & 0xff);
		kopin_write_reg_8bit(ddata, 0xBB, addr & 0xff);
		kopin_write_reg_8bit(ddata, 0xBC, val & 0xff);
		kopin_write_reg_8bit(ddata, 0xBD, (val >> 8) & 0xff);
		if (switch_bus)
			kopin_raw_mode(ddata);
	}
}

static u16 kopin_read_reg(struct panel_drv_data *ddata, u8 addr)
{
	u16 ret;

	if (ddata->direct_mode) {
		ret = kopin_read_reg_16bit(ddata, addr | KOPIN_REG_BASE_ADDR);
	} else {
		kopin_write_reg_8bit(ddata, 0xB9, 0x0);
		kopin_write_reg_8bit(ddata, 0xBA, (addr >> 8) & 0xff);
		kopin_write_reg_8bit(ddata, 0xBB, addr & 0xff);
		ret = kopin_read_reg_8bit(ddata, 0xBC);
		ret |= kopin_read_reg_8bit(ddata, 0xBD) << 8;
	}
	return ret;
}

/* command mode = 8 data lines, raw (pixel) mode = 16 data lines, both 16 bpp */
static void kopin_cmd_mode(struct panel_drv_data *ddata)
{
	ddata->in->ops.rfbi->configure(ddata->in, 16, 8);
}

static void kopin_raw_mode(struct panel_drv_data *ddata)
{
	ddata->in->ops.rfbi->configure(ddata->in, 16, 16);
}

/* --- backlight (a PWM inside the Kopin ASIC, 0..1023) --- */

static void kopin_set_pwm_locked(struct panel_drv_data *ddata, u16 val)
{
	if (val == 0) {
		kopin_write_reg(ddata, A230_PWR_REG_2, A230_PWM_DISABLE_BIT);
	} else {
		kopin_write_reg(ddata, A230_PWR_REG_2, 0);
		kopin_write_reg(ddata, A230_PWM0_H_ADDR, val >> 4);
		kopin_write_reg(ddata, A230_PWM0_1_L_ADDR, val & 0xf);
	}
}

static int kopin_bl_update_status(struct backlight_device *bl)
{
	struct panel_drv_data *ddata = bl_get_data(bl);
	struct omap_dss_device *in = ddata->in;
	int level = backlight_get_brightness(bl);

	mutex_lock(&ddata->lock);
	ddata->brightness = level;
	if (omapdss_device_is_enabled(&ddata->dssdev)) {
		in->ops.rfbi->bus_lock(in);
		kopin_set_pwm_locked(ddata, level);
		in->ops.rfbi->bus_unlock(in);
	}
	mutex_unlock(&ddata->lock);
	return 0;
}

static const struct backlight_ops kopin_bl_ops = {
	.update_status = kopin_bl_update_status,
};

/* --- power sequencing (Kopin datasheet figures 42/44) --- */

static void kopin_clock_on(struct panel_drv_data *ddata)
{
	if (ddata->clk_on)
		return;
	if (ddata->clk)
		clk_prepare_enable(ddata->clk);
	gpiod_set_value_cansleep(ddata->clk_en_gpio, 1);
	ddata->clk_on = true;
}

static void kopin_clock_off(struct panel_drv_data *ddata)
{
	if (!ddata->clk_on)
		return;
	if (ddata->clk)
		clk_disable_unprepare(ddata->clk);
	gpiod_set_value_cansleep(ddata->clk_en_gpio, 0);
	ddata->clk_on = false;
}

/* the register side of power-on (bus lock held): unlock, init table, power regs, TE off */
static void kopin_init_regs(struct panel_drv_data *ddata)
{
	struct omap_dss_device *in = ddata->in;
	int i;

	/* unlock direct (16-bit) register access */
	if (!ddata->direct_mode) {
		if (b3_unlock) {
			kopin_cmd_mode(ddata);
			kopin_write_reg(ddata, 0xB3, 0x3);
			if (b3_read)
				kopin_read_reg(ddata, 0xB3);
			kopin_raw_mode(ddata);
		}
		ddata->direct_mode = true;
		if (b3_direct)
			kopin_write_reg(ddata, 0xB3, 0x3);
	}

	if (!ddata->init_done) {
		int pass;

		for (pass = 0; pass < max(table_passes, 1); pass++) {
			if (pass && pass_delay_ms)
				msleep(pass_delay_ms);
			for (i = 0; i < ARRAY_SIZE(kopin_init_data); i++)
				kopin_write_reg(ddata, kopin_init_data[i].addr,
						kopin_init_data[i].data);
		}
		ddata->init_done = true;
	}

	/* resume sequence: pads/digital up, PWM off until the first frame */
	kopin_write_reg(ddata, A230_PWR_REG, 0);
	kopin_write_reg(ddata, A230_PWR_REG_2, A230_PWM_DISABLE_BIT);

	in->ops.rfbi->enable_te(in, false, 0);
}

static int kopin_power_on(struct panel_drv_data *ddata)
{
	struct omap_dss_device *in = ddata->in;
	int r, i;

	/*
	 * Panel power, then the pixel clock, then release reset (ResetB high).
	 * The reset is synchronous: at boot the clock has only just started when
	 * probe's reset-low state would be released, so hold reset low with the
	 * clock running first (stock had the clock running for seconds with
	 * ResetB low from board init).
	 */
	gpiod_set_value_cansleep(ddata->power_gpio, 1);
	kopin_sleep();
	gpiod_set_value_cansleep(ddata->reset_gpio, 0);
	kopin_clock_on(ddata);
	msleep(reset_low_ms);
	gpiod_set_value_cansleep(ddata->reset_gpio, 1);
	gpiod_set_value_cansleep(ddata->a16_gpio, 0);
	/* the stock driver released reset at probe and wrote the first register ~3 s later */
	msleep(post_reset_ms);

	in->ops.rfbi->set_size(in, ddata->timings.x_res, ddata->timings.y_res);
	in->ops.rfbi->configure(in, 16, 16);

	r = in->ops.rfbi->enable(in);
	if (r) {
		dev_err(ddata->dev, "failed to enable RFBI\n");
		return r;
	}

	msleep(post_enable_ms);

	in->ops.rfbi->bus_lock(in);
	kopin_init_regs(ddata);
	in->ops.rfbi->bus_unlock(in);

	return 0;
}

static void kopin_power_off(struct panel_drv_data *ddata)
{
	struct omap_dss_device *in = ddata->in;

	in->ops.rfbi->bus_lock(in);
	kopin_set_pwm_locked(ddata, 0);
	kopin_write_reg(ddata, A230_PWR_REG, A230_PWR_DIG_DWN_BIT | A230_PWR_PAD_DWN_BIT);
	kopin_write_reg(ddata, A230_PWR_REG_2, A230_DAC_DWN_BIT | A230_PWM_DISABLE_BIT);
	kopin_sleep();
	gpiod_set_value_cansleep(ddata->reset_gpio, 0);
	/* wait at least 5 vsyncs after disabling the LCD */
	msleep(10);
	in->ops.rfbi->disable(in);
	in->ops.rfbi->bus_unlock(in);

	kopin_clock_off(ddata);
	if (drop_power) {
		gpiod_set_value_cansleep(ddata->power_gpio, 0);
		msleep(100);
	}
	/* keep panel power on: the stock driver never drops it after boot, and
	 * the init table only runs once (direct_mode/init_done stay set) */
}

/* --- omapdss display driver --- */

static int kopin_connect(struct omap_dss_device *dssdev)
{
	struct panel_drv_data *ddata = to_panel_data(dssdev);
	struct omap_dss_device *in = ddata->in;

	if (omapdss_device_is_connected(dssdev))
		return 0;

	return in->ops.rfbi->connect(in, dssdev);
}

static void kopin_disconnect(struct omap_dss_device *dssdev)
{
	struct panel_drv_data *ddata = to_panel_data(dssdev);
	struct omap_dss_device *in = ddata->in;

	if (!omapdss_device_is_connected(dssdev))
		return;

	in->ops.rfbi->disconnect(in, dssdev);
}

static int kopin_enable(struct omap_dss_device *dssdev)
{
	struct panel_drv_data *ddata = to_panel_data(dssdev);
	int r;

	if (!omapdss_device_is_connected(dssdev))
		return -ENODEV;

	if (omapdss_device_is_enabled(dssdev))
		return 0;

	mutex_lock(&ddata->lock);
	r = kopin_power_on(ddata);
	if (r == 0)
		dssdev->state = OMAP_DSS_DISPLAY_ACTIVE;
	mutex_unlock(&ddata->lock);

	return r;
}

static void kopin_disable(struct omap_dss_device *dssdev)
{
	struct panel_drv_data *ddata = to_panel_data(dssdev);

	if (!omapdss_device_is_enabled(dssdev))
		return;

	mutex_lock(&ddata->lock);
	kopin_power_off(ddata);
	dssdev->state = OMAP_DSS_DISPLAY_DISABLED;
	mutex_unlock(&ddata->lock);
}

static void kopin_framedone_cb(void *data)
{
	struct panel_drv_data *ddata = data;

	/* the update holds the bus lock from the start-of-frame command until here */
	ddata->in->ops.rfbi->bus_unlock(ddata->in);
	complete(&ddata->frame_done);
}

static int kopin_update(struct omap_dss_device *dssdev,
		u16 x, u16 y, u16 w, u16 h)
{
	struct panel_drv_data *ddata = to_panel_data(dssdev);
	struct omap_dss_device *in = ddata->in;
	int r;

	if (!omapdss_device_is_enabled(dssdev))
		return 0;

	mutex_lock(&ddata->lock);
	in->ops.rfbi->bus_lock(in);

	reinit_completion(&ddata->frame_done);

	/* the Kopin takes whole frames only: command 0x0000 = start of frame */
	kopin_write_addr(ddata, (u16)frame_cmd);

	r = in->ops.rfbi->update(in, kopin_framedone_cb, ddata);
	if (r) {
		in->ops.rfbi->bus_unlock(in);
		mutex_unlock(&ddata->lock);
		return r;
	}

	/* keep the ioctl synchronous like the stock driver: wait for FRAMEDONE */
	if (!wait_for_completion_timeout(&ddata->frame_done, msecs_to_jiffies(200))) {
		dev_warn(ddata->dev, "frame done timeout\n");
		in->ops.rfbi->bus_unlock(in);
	}

	kopin_frame_done_bus(ddata);

	/* backlight may only be set after the first frame has been pushed */
	if (pwm_rearm && ddata->brightness) {
		in->ops.rfbi->bus_lock(in);
		kopin_set_pwm_locked(ddata, ddata->brightness);
		in->ops.rfbi->bus_unlock(in);
	}

	mutex_unlock(&ddata->lock);
	return 0;
}

/*
 * Debug: push a frame by programmed I/O through the RFBI (like the stock driver's
 * boot image) instead of via DISPC. echo bars|white|black|0xRRGGBB|reinit|bootinit|table [lo hi]|read|wr 0xRR 0xVVVV > pio_test
 */
static ssize_t pio_test_store(struct device *dev, struct device_attribute *attr,
		const char *buf, size_t count)
{
	struct panel_drv_data *ddata = dev_get_drvdata(dev);
	struct omap_dss_device *in = ddata->in;
	static const u16 bars[8] = { 0xffff, 0xffe0, 0x07ff, 0x07e0, 0xf81f, 0xf800, 0x001f, 0x0000 };
	u16 solid = 0;
	int mode = 0, x, y;
	unsigned long v;

	if (!omapdss_device_is_enabled(&ddata->dssdev))
		return -ENODEV;
	if (!strncmp(buf, "read", 4)) {
		/* read back Kopin registers 0x00..0x2f and the PWM/power regs, direct 16-bit mode */
		static const u8 regs[] = { 0x00, 0x01, 0x02, 0x06, 0x10, 0x12, 0x13, 0x1d, 0x1f,
					   0x20, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0xb3 };
		int i;

		mutex_lock(&ddata->lock);
		in->ops.rfbi->bus_lock(in);
		for (i = 0; i < ARRAY_SIZE(regs); i++)
			dev_info(dev, "reg 0x%02x = 0x%04x\n", regs[i], kopin_read_reg(ddata, regs[i]));
		in->ops.rfbi->bus_unlock(in);
		mutex_unlock(&ddata->lock);
		return count;
	}
	if (!strncmp(buf, "wr ", 3)) {
		/* wr 0xREG 0xVAL : one register write in the current reg_mode */
		unsigned int reg, val;

		if (sscanf(buf + 3, "%i %i", &reg, &val) != 2)
			return -EINVAL;
		mutex_lock(&ddata->lock);
		in->ops.rfbi->bus_lock(in);
		kopin_write_reg(ddata, reg, val);
		in->ops.rfbi->bus_unlock(in);
		mutex_unlock(&ddata->lock);
		dev_info(dev, "pio_test: wrote 0x%02x = 0x%04x (reg_mode=%d)\n", reg, val, reg_mode);
		return count;
	}
	if (!strncmp(buf, "table", 5)) {
		/* table [lo hi] : re-send init table entries [lo, hi) only */
		int lo = 0, hi = ARRAY_SIZE(kopin_init_data), i;

		sscanf(buf + 5, "%d %d", &lo, &hi);
		if (lo < 0 || hi > ARRAY_SIZE(kopin_init_data) || lo >= hi)
			return -EINVAL;
		mutex_lock(&ddata->lock);
		in->ops.rfbi->bus_lock(in);
		for (i = lo; i < hi; i++)
			kopin_write_reg(ddata, kopin_init_data[i].addr, kopin_init_data[i].data);
		in->ops.rfbi->bus_unlock(in);
		mutex_unlock(&ddata->lock);
		dev_info(dev, "pio_test: table entries %d..%d re-sent (0x%02x..0x%02x)\n", lo, hi - 1,
			 kopin_init_data[lo].addr, kopin_init_data[hi - 1].addr);
		return count;
	}
	if (sysfs_streq(buf, "bootinit")) {
		/* replay the boot-time register sequence (unlock + table + power regs) */
		mutex_lock(&ddata->lock);
		in->ops.rfbi->bus_lock(in);
		ddata->direct_mode = false;
		ddata->init_done = false;
		kopin_init_regs(ddata);
		in->ops.rfbi->bus_unlock(in);
		mutex_unlock(&ddata->lock);
		dev_info(dev, "pio_test: boot init sequence replayed (b3_unlock=%d b3_read=%d reg_mode=%d)\n",
			 b3_unlock, b3_read, reg_mode);
		return count;
	}
	if (sysfs_streq(buf, "reinit")) {
		int i;

		mutex_lock(&ddata->lock);
		in->ops.rfbi->bus_lock(in);
		for (i = 0; i < ARRAY_SIZE(kopin_init_data); i++)
			kopin_write_reg(ddata, kopin_init_data[i].addr, kopin_init_data[i].data);
		kopin_write_reg(ddata, A230_PWR_REG, 0);
		kopin_set_pwm_locked(ddata, ddata->brightness);
		in->ops.rfbi->bus_unlock(in);
		mutex_unlock(&ddata->lock);
		dev_info(dev, "pio_test: init table re-sent\n");
		return count;
	}
	if (sysfs_streq(buf, "bars"))
		mode = 1;
	else if (sysfs_streq(buf, "white"))
		solid = 0xffff;
	else if (sysfs_streq(buf, "black"))
		solid = 0;
	else if (!kstrtoul(buf, 0, &v))
		solid = (u16)(((v >> 8) & 0xf800) | ((v >> 5) & 0x07e0) | ((v >> 3) & 0x001f));
	else
		return -EINVAL;

	mutex_lock(&ddata->lock);
	in->ops.rfbi->bus_lock(in);
	kopin_write_addr(ddata, (u16)frame_cmd);
	for (y = 0; y < KOPIN_HEIGHT; y++) {
		for (x = 0; x < KOPIN_WIDTH; x++) {
			u16 px = mode ? bars[x * 8 / KOPIN_WIDTH] : solid;

			if (mode && y > KOPIN_HEIGHT / 2 - 10 && y < KOPIN_HEIGHT / 2 + 10)
				px = 0x8410; /* grey band */
			in->ops.rfbi->write_data(in, &px, 2);
		}
	}
	kopin_frame_done_bus(ddata);
	if (pwm_rearm && ddata->brightness)
		kopin_set_pwm_locked(ddata, ddata->brightness);
	in->ops.rfbi->bus_unlock(in);
	mutex_unlock(&ddata->lock);
	dev_info(dev, "pio_test: pushed %s frame (a16_frame=%d frame_cmd=0x%x/%dB)\n",
		 mode ? "bars" : "solid", a16_frame, frame_cmd, frame_cmd_bytes);
	return count;
}
static DEVICE_ATTR_WO(pio_test);

static int kopin_sync(struct omap_dss_device *dssdev)
{
	struct panel_drv_data *ddata = to_panel_data(dssdev);
	struct omap_dss_device *in = ddata->in;

	mutex_lock(&ddata->lock);
	in->ops.rfbi->bus_lock(in);
	in->ops.rfbi->bus_unlock(in);
	mutex_unlock(&ddata->lock);
	return 0;
}

static void kopin_get_resolution(struct omap_dss_device *dssdev,
		u16 *xres, u16 *yres)
{
	*xres = dssdev->panel.timings.x_res;
	*yres = dssdev->panel.timings.y_res;
}

static void kopin_get_timings(struct omap_dss_device *dssdev,
		struct omap_video_timings *timings)
{
	struct panel_drv_data *ddata = to_panel_data(dssdev);

	*timings = ddata->timings;
}

static int kopin_check_timings(struct omap_dss_device *dssdev,
		struct omap_video_timings *timings)
{
	if (timings->x_res != KOPIN_WIDTH || timings->y_res != KOPIN_HEIGHT)
		return -EINVAL;
	return 0;
}

static int kopin_get_recommended_bpp(struct omap_dss_device *dssdev)
{
	/* RGB565: the RFBI output is 16-bit anyway, the 24 (= 32-bit XRGB) path
	 * hung the SoC at omapfb probe, and the Jet tools handle 16 bpp */
	return 16;
}

static struct omap_dss_driver kopin_ops = {
	.connect	= kopin_connect,
	.disconnect	= kopin_disconnect,

	.enable		= kopin_enable,
	.disable	= kopin_disable,

	.update		= kopin_update,
	.sync		= kopin_sync,

	.get_resolution	= kopin_get_resolution,
	.get_recommended_bpp = kopin_get_recommended_bpp,
	.get_timings	= kopin_get_timings,
	.check_timings	= kopin_check_timings,
};

static int kopin_probe(struct platform_device *pdev)
{
	struct clk *per, *src;
	struct backlight_properties props;
	struct panel_drv_data *ddata;
	struct omap_dss_device *dssdev, *in;
	struct rfbi_timings rt;
	int r;

	if (!pdev->dev.of_node)
		return -ENODEV;

	ddata = devm_kzalloc(&pdev->dev, sizeof(*ddata), GFP_KERNEL);
	if (!ddata)
		return -ENOMEM;

	platform_set_drvdata(pdev, ddata);
	ddata->dev = &pdev->dev;
	mutex_init(&ddata->lock);
	init_completion(&ddata->frame_done);

	in = omapdss_of_find_source_for_first_ep(pdev->dev.of_node);
	if (IS_ERR(in))
		return dev_err_probe(&pdev->dev, PTR_ERR(in), "failed to find video source\n");
	if (!in->ops.rfbi) {
		omap_dss_put_device(in);
		return dev_err_probe(&pdev->dev, -EINVAL, "video source is not RFBI\n");
	}
	ddata->in = in;

	ddata->power_gpio = devm_gpiod_get(&pdev->dev, "power", GPIOD_OUT_HIGH);
	if (IS_ERR(ddata->power_gpio)) {
		r = dev_err_probe(&pdev->dev, PTR_ERR(ddata->power_gpio), "power gpio\n");
		goto err;
	}
	ddata->reset_gpio = devm_gpiod_get(&pdev->dev, "reset", GPIOD_OUT_LOW);
	if (IS_ERR(ddata->reset_gpio)) {
		r = dev_err_probe(&pdev->dev, PTR_ERR(ddata->reset_gpio), "reset gpio\n");
		goto err;
	}
	ddata->clk_en_gpio = devm_gpiod_get_optional(&pdev->dev, "clk-en", GPIOD_OUT_LOW);
	if (IS_ERR(ddata->clk_en_gpio)) {
		r = dev_err_probe(&pdev->dev, PTR_ERR(ddata->clk_en_gpio), "clk-en gpio\n");
		goto err;
	}
	ddata->a16_gpio = devm_gpiod_get(&pdev->dev, "a16", GPIOD_OUT_LOW);
	if (IS_ERR(ddata->a16_gpio)) {
		r = dev_err_probe(&pdev->dev, PTR_ERR(ddata->a16_gpio), "a16 gpio\n");
		goto err;
	}
	ddata->clk = devm_clk_get_optional(&pdev->dev, "pixel");
	if (IS_ERR(ddata->clk)) {
		r = dev_err_probe(&pdev->dev, PTR_ERR(ddata->clk), "pixel clock\n");
		goto err;
	}
	if (ddata->clk) {
		/*
		 * Stock (regdump on Android): dpll_per M3 = 6 -> m3x2 256 MHz, SCRM
		 * AUXCLK4 divider 7 -> 36.57 MHz to the Kopin. (An earlier 27.43 MHz
		 * figure came from a mislabelled PRCM register.)
		 */
		/*
		 * On a cold boot auxclk4 still sources sys_clk (19.2 MHz) and
		 * clk_set_rate() cannot reach 36.57 MHz from there (garbage on the
		 * glass); Android/u-boot had reparented it on the RAM boots. Select
		 * dpll_per m3x2 explicitly first.
		 */
		per = devm_clk_get_optional(&pdev->dev, "per_m3");
		src = devm_clk_get_optional(&pdev->dev, "pixel_src");	/* auxclk4_src_ck: the mux */
		if (!IS_ERR_OR_NULL(per) && !IS_ERR_OR_NULL(src)) {
			r = clk_set_parent(src, per);
			if (r)
				dev_warn(&pdev->dev, "pixel clock set_parent: %d\n", r);
		}
		r = clk_set_rate(ddata->clk, 36571429);
		dev_info(&pdev->dev, "pixel clock %lu Hz (set_rate %d)\n", clk_get_rate(ddata->clk), r);
	}

	ddata->timings.x_res = KOPIN_WIDTH;
	ddata->timings.y_res = KOPIN_HEIGHT;
	ddata->timings.pixelclock = 10000000;
	ddata->timings.hsw = 1;
	ddata->timings.hfp = 1;
	ddata->timings.hbp = 1;
	ddata->timings.vsw = 1;
	ddata->timings.vfp = 0;
	ddata->timings.vbp = 0;
	ddata->brightness = A230_DEFAULT_BRIGHTNESS;

	/* bus timings from the stock driver (picoseconds) */
	memset(&rt, 0, sizeof(rt));
	rt.cs_on_time	= 0;
	rt.we_on_time	= rt.cs_on_time + MCLK_PS;
	rt.re_on_time	= rt.cs_on_time + 75000;
	rt.we_off_time	= rt.we_on_time + 2 * MCLK_PS;
	rt.re_off_time	= rt.re_on_time + 150000;
	rt.access_time	= 0;
	rt.cs_off_time	= rt.we_off_time;
	rt.we_cycle_time = rt.cs_off_time + MCLK_PS;
	rt.re_cycle_time = rt.re_off_time + 40000;
	rt.cs_pulse_width = 80000;
	rt.clk_div	= 1;
	in->ops.rfbi->set_interface_timings(in, &rt);

	dssdev = &ddata->dssdev;
	dssdev->dev = &pdev->dev;
	dssdev->driver = &kopin_ops;
	dssdev->panel.timings = ddata->timings;
	dssdev->type = OMAP_DISPLAY_TYPE_DBI;
	dssdev->owner = THIS_MODULE;
	dssdev->caps = OMAP_DSS_DISPLAY_CAP_MANUAL_UPDATE;
	dssdev->ctrl.pixel_size = 16;

	r = omapdss_register_display(dssdev);
	if (r) {
		dev_err(&pdev->dev, "Failed to register panel\n");
		goto err;
	}

	memset(&props, 0, sizeof(props));
	props.type = BACKLIGHT_RAW;
	props.max_brightness = A230_MAX_BRIGHTNESS;
	props.brightness = ddata->brightness;
	ddata->bldev = devm_backlight_device_register(&pdev->dev, "kopin-a230",
			&pdev->dev, ddata, &kopin_bl_ops, &props);
	if (IS_ERR(ddata->bldev))
		dev_warn(&pdev->dev, "no backlight device: %ld\n", PTR_ERR(ddata->bldev));

	if (device_create_file(&pdev->dev, &dev_attr_pio_test))
		dev_warn(&pdev->dev, "no pio_test attribute\n");

	dev_info(&pdev->dev, "Kopin A230 %dx%d on %s\n", KOPIN_WIDTH, KOPIN_HEIGHT, in->name);
	return 0;

err:
	omap_dss_put_device(in);
	return r;
}

static void kopin_remove(struct platform_device *pdev)
{
	struct panel_drv_data *ddata = platform_get_drvdata(pdev);
	struct omap_dss_device *dssdev = &ddata->dssdev;

	device_remove_file(&pdev->dev, &dev_attr_pio_test);
	omapdss_unregister_display(dssdev);

	kopin_disable(dssdev);
	kopin_disconnect(dssdev);

	omap_dss_put_device(ddata->in);
}

/* an emergency restart with the DSS/RFBI active wedges the SoC: power the panel and the
 * RFBI down on an orderly reboot so the restart path finds the DSS idle */
static void kopin_shutdown(struct platform_device *pdev)
{
	struct panel_drv_data *ddata = platform_get_drvdata(pdev);

	kopin_disable(&ddata->dssdev);
}

static const struct of_device_id kopin_of_match[] = {
	{ .compatible = "recon,kopin-a230", },
	{},
};
MODULE_DEVICE_TABLE(of, kopin_of_match);

static struct platform_driver kopin_driver = {
	.probe = kopin_probe,
	.remove = kopin_remove,
	.shutdown = kopin_shutdown,
	.driver = {
		.name = "panel-kopin-a230",
		.of_match_table = kopin_of_match,
		.suppress_bind_attrs = true,
	},
};

module_platform_driver(kopin_driver);

MODULE_AUTHOR("Recon Instruments / port for mainline");
MODULE_DESCRIPTION("Kopin A230 RFBI panel driver (Recon Jet)");
MODULE_LICENSE("GPL");
