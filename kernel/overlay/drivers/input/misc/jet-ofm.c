// SPDX-License-Identifier: GPL-2.0
/*
 * Partron MS37C01A optical finger navigation module (ST VD5377 sensor) as used
 * for the Recon Jet "touchpad". Port of the vendor ofm_driver.c (Recon
 * Instruments, android-3.0): the sensor is run in its automatic mode, the
 * MOTION pin raises an interrupt, and after a short settle time the
 * accumulated X/Y movement is read and turned into one of four swipe keys.
 * In addition the raw movement is reported as EV_REL so user space can do
 * its own gesture detection (taps are movements below the swipe threshold;
 * the vendor driver drops them).
 *
 * DT:
 *   ofm@53 {
 *     compatible = "partron,ms37c01a";
 *     reg = <0x53>;
 *     interrupts-extended = <&gpio6 16 IRQ_TYPE_EDGE_RISING>;  // MOTION
 *     standby-gpios = <&gpio2 17 GPIO_ACTIVE_HIGH>;
 *     powerdown-gpios = <&gpio2 5 GPIO_ACTIVE_HIGH>;
 *     vdd-supply = <&ldo2>;      // optional
 *   };
 */
#include <linux/delay.h>
#include <linux/gpio/consumer.h>
#include <linux/i2c.h>
#include <linux/kthread.h>
#include <linux/input.h>
#include <linux/interrupt.h>
#include <linux/module.h>
#include <linux/of.h>
#include <linux/of_irq.h>
#include <linux/regulator/consumer.h>

static int swipe_ms = 400;		/* max swipe window after MOTION */
module_param(swipe_ms, int, 0644);
static int poll_ms = 10;		/* delta read interval inside the window */
module_param(poll_ms, int, 0644);
static int idle_ms = 150;		/* end the window after this much stillness (a pause after touchdown is normal) */
module_param(idle_ms, int, 0644);
static int thr_x = 20;			/* swipe thresholds in summed counts (vendor used 35/45 with its
					 * accumulator read; sampled sums of real swipes here are 25..45) */
module_param(thr_x, int, 0644);
static int thr_y = 20;
module_param(thr_y, int, 0644);
static int tap_key;			/* key code to emit for a touch with less than tap_thr motion (0 = off) */
module_param(tap_key, int, 0644);
static int tap_thr = 6;
module_param(tap_thr, int, 0644);
static int report_rel = 1;		/* also report raw movement as REL_X/REL_Y */
module_param(report_rel, int, 0644);
static int sleep1 = 1, sleep2 = 1, sleep3 = 1;	/* auto-mode sleep check intervals (regs 0x8a..0x8c, higher = sleepier);
					 * stock used 1/5/5 to save power and missed first swipes; 0xff misses everything */
module_param(sleep1, int, 0644);
module_param(sleep2, int, 0644);
module_param(sleep3, int, 0644);
static int debug;
module_param(debug, int, 0644);
static int poll_mode;			/* debug: sample the delta registers every 10 ms from a thread
					 * (ignoring MOTION) and log motion + status */
module_param(poll_mode, int, 0444);

struct jet_ofm {
	struct i2c_client *client;
	struct input_dev *input;
	struct gpio_desc *standby;
	struct gpio_desc *powerdown;
	struct task_struct *poller;
};

static int ofm_wr(struct jet_ofm *o, u8 reg, u8 val)
{
	int r = i2c_smbus_write_byte_data(o->client, reg, val);

	if (r < 0)
		dev_err(&o->client->dev, "write 0x%02x=0x%02x failed (%d)\n", reg, val, r);
	return r;
}

/* vendor "Automatic Movement Filter" patch for VD5377 rev 1.0 */
static void ofm_amf_patch(struct jet_ofm *o)
{
	static const u8 buf1[3] = { 0x02, 0x02, 0x88 };
	static const u8 buf2[42] = {
		0x30, 0x09, 0x1C, 0xE5, 0x18, 0x70, 0x16, 0xC2, 0x09, 0xE5,
		0x1C, 0x54, 0x0F, 0xC4, 0x54, 0xF0, 0xFF, 0x90, 0x00, 0x17,
		0xE0, 0x54, 0x0F, 0x4F, 0xF0, 0xC2, 0x08, 0x80, 0x02, 0x15,
		0x18, 0x90, 0x00, 0x17, 0xE0, 0x44, 0x08, 0xF0, 0x02, 0x05, 0x30, 0x22
	};
	static const u8 buf3[3] = { 0x02, 0x7D, 0x00 };
	static const u8 buf4[3] = { 0x05, 0x29, 0x03 };
	int major = i2c_smbus_read_byte_data(o->client, 0x00);
	int minor = i2c_smbus_read_byte_data(o->client, 0x01);
	int i;

	if (major != 1 || minor != 0)
		return;
	ofm_wr(o, 0x14, 0x0d);
	ofm_wr(o, 0x6f, 0x02);
	for (i = 0; i < 3; i++)
		ofm_wr(o, 0xa0 + i, buf1[i]);
	for (i = 0; i < 42; i++)
		ofm_wr(o, 0xa3 + i, buf2[i]);
	for (i = 0; i < 3; i++)
		ofm_wr(o, 0x70 + i, buf3[i]);
	for (i = 0; i < 3; i++)
		ofm_wr(o, 0x73 + i, buf4[i]);
	ofm_wr(o, 0x6f, 0x0d);
}

static int ofm_init_sensor(struct jet_ofm *o)
{
	static const u8 regs[][2] = {
		{ 0x28, 0x74 },	/* 5x5 high pass filter */
		{ 0x29, 0x19 },	/* min features 25*16 */
		{ 0x0C, 0x5A },	/* MOTION pin: pad output, not pulled down */
		{ 0x2A, 0x04 },	/* 400 CPI X */
		{ 0x2B, 0x04 },	/* 400 CPI Y */
		{ 0x51, 0x01 },	/* sunlight mode automatic */
		{ 0x27, 0x03 },	/* invert X and Y (vendor orientation) */
		{ 0x43, 0x01 },	/* auto exposure */
		{ 0x4b, 0x00 },	/* exposure update every frame */
		{ 0x03, 0xFC },	/* ANALOG_CTRL2 DAC Vref 1.6 V */
		{ 0x8d, 0x7F },	/* auto movement filter, 63 frames */
		{ 0x8e, 0xF3 },	/* 2 ms, 15 sequence */
	};
	int i, r;

	gpiod_set_value_cansleep(o->powerdown, 0);	/* power up */
	msleep(2);
	gpiod_set_value_cansleep(o->standby, 0);	/* leave standby */
	msleep(2);
	r = ofm_wr(o, 0x16, 0x1E);			/* software reset */
	if (r < 0)
		return r;
	msleep(2);
	ofm_amf_patch(o);
	for (i = 0; i < ARRAY_SIZE(regs); i++) {
		r = ofm_wr(o, regs[i][0], regs[i][1]);
		if (r < 0)
			return r;
	}
	/* auto-mode sleep latencies, written before the mode register takes effect */
	ofm_wr(o, 0x8a, sleep1 & 0xff);
	ofm_wr(o, 0x8b, sleep2 & 0xff);
	ofm_wr(o, 0x8c, sleep3 & 0xff);
	r = ofm_wr(o, 0x05, 0x1D);	/* automatic mode, MOTION active high, STANDBY used */
	if (r < 0)
		return r;
	msleep(2);
	return 0;
}

static void ofm_key(struct jet_ofm *o, unsigned int code)
{
	input_report_key(o->input, code, 1);
	input_sync(o->input);
	input_report_key(o->input, code, 0);
	input_sync(o->input);
}

static irqreturn_t ofm_irq(int irq, void *data)
{
	struct jet_ofm *o = data;
	int reg, ax, ay, sx = 0, sy = 0, t, idle = 0, reads = 0;

	/*
	 * Sum the per-read deltas over the swipe window instead of trusting the
	 * chip's accumulator after one delay (a single read 200 ms after MOTION
	 * only ever returned a dozen counts). Stop early once the finger has been
	 * still for idle_ms.
	 */
	for (t = 0; t < swipe_ms; t += poll_ms) {
		reg = i2c_smbus_read_word_data(o->client, 0x21);
		if (reg < 0) {
			dev_err(&o->client->dev, "motion read failed (%d)\n", reg);
			return IRQ_HANDLED;
		}
		reads++;
		if (reg & 0xffff) {
			sx += (s8)(reg & 0xff);
			sy += (s8)((reg >> 8) & 0xff);
			idle = 0;
		} else if ((idle += poll_ms) >= idle_ms && t > 0) {
			break;
		}
		msleep(poll_ms);
	}
	ax = abs(sx);
	ay = abs(sy);
	if (debug)
		dev_info(&o->client->dev, "motion x=%d y=%d (%d reads, %d ms)\n", sx, sy, reads, t);

	if (report_rel && (sx || sy)) {
		input_report_rel(o->input, REL_X, sx);
		input_report_rel(o->input, REL_Y, sy);
		input_sync(o->input);
	}
	if (ax > ay && ax > thr_x)
		ofm_key(o, sx < 0 ? KEY_LEFT : KEY_RIGHT);
	else if (ay > ax && ay > thr_y)
		ofm_key(o, sy < 0 ? KEY_DOWN : KEY_UP);
	else if (tap_key && reads > 1 && ax + ay > 0 && ax + ay < tap_thr)
		ofm_key(o, tap_key);

	/* flush the accumulators unless more motion is pending (bit 3) */
	reg = i2c_smbus_read_byte_data(o->client, 0x23);
	if (reg >= 0 && !(reg & BIT(3)))
		ofm_wr(o, 0x23, reg | 0x20);

	return IRQ_HANDLED;
}

static int ofm_poll_thread(void *data)
{
	struct jet_ofm *o = data;
	int sx = 0, sy = 0, n = 0, st = -1, quiet = 0;

	while (!kthread_should_stop()) {
		int reg = i2c_smbus_read_word_data(o->client, 0x21);

		if (reg >= 0 && (reg & 0xffff)) {
			sx += (s8)(reg & 0xff);
			sy += (s8)((reg >> 8) & 0xff);
			n++;
			st = i2c_smbus_read_byte_data(o->client, 0x23);
			quiet = 0;
		} else if (n && ++quiet >= 10) {
			dev_info(&o->client->dev, "poll: x=%d y=%d over %d samples, last status 0x%02x\n",
				 sx, sy, n, st);
			if (report_rel) {
				input_report_rel(o->input, REL_X, sx);
				input_report_rel(o->input, REL_Y, sy);
				input_sync(o->input);
			}
			sx = sy = n = 0;
		}
		msleep(10);
	}
	return 0;
}

static int jet_ofm_probe(struct i2c_client *client)
{
	struct device *dev = &client->dev;
	struct jet_ofm *o;
	int major, minor, r;

	o = devm_kzalloc(dev, sizeof(*o), GFP_KERNEL);
	if (!o)
		return -ENOMEM;
	o->client = client;
	i2c_set_clientdata(client, o);

	r = devm_regulator_get_enable_optional(dev, "vdd");
	if (r < 0 && r != -ENODEV)
		return dev_err_probe(dev, r, "vdd\n");

	o->standby = devm_gpiod_get(dev, "standby", GPIOD_OUT_LOW);
	if (IS_ERR(o->standby))
		return dev_err_probe(dev, PTR_ERR(o->standby), "standby gpio\n");
	o->powerdown = devm_gpiod_get(dev, "powerdown", GPIOD_OUT_HIGH);
	if (IS_ERR(o->powerdown))
		return dev_err_probe(dev, PTR_ERR(o->powerdown), "powerdown gpio\n");
	msleep(10);					/* minimum powerdown time */
	gpiod_set_value_cansleep(o->powerdown, 0);
	msleep(2);

	major = i2c_smbus_read_byte_data(client, 0x00);
	minor = i2c_smbus_read_byte_data(client, 0x01);
	if (major < 0 || minor < 0)
		return dev_err_probe(dev, -ENODEV, "no response at 0x%02x\n", client->addr);

	o->input = devm_input_allocate_device(dev);
	if (!o->input)
		return -ENOMEM;
	o->input->name = "Recon Jet touchpad (Partron OFM)";
	o->input->phys = "jet-ofm/input0";
	o->input->id.bustype = BUS_I2C;
	input_set_capability(o->input, EV_KEY, KEY_UP);
	input_set_capability(o->input, EV_KEY, KEY_DOWN);
	input_set_capability(o->input, EV_KEY, KEY_LEFT);
	input_set_capability(o->input, EV_KEY, KEY_RIGHT);
	input_set_capability(o->input, EV_KEY, KEY_ENTER);
	input_set_capability(o->input, EV_REL, REL_X);
	input_set_capability(o->input, EV_REL, REL_Y);
	r = input_register_device(o->input);
	if (r)
		return r;

	if (client->irq <= 0)			/* the i2c core drops the irq on re-probe */
		client->irq = of_irq_get(dev->of_node, 0);
	if (client->irq <= 0 && !poll_mode)
		return dev_err_probe(dev, client->irq ?: -EINVAL, "no MOTION interrupt\n");
	/*
	 * MOTION stays high while unread motion is pending, so an edge trigger
	 * loses the rest of a gesture that outlasts one read window. Level-high
	 * with a oneshot thread re-fires until the line drops.
	 */
	if (client->irq > 0) {
		r = devm_request_threaded_irq(dev, client->irq, NULL, ofm_irq,
					      IRQF_ONESHOT | IRQF_TRIGGER_HIGH, "jet-ofm", o);
		if (r)
			return dev_err_probe(dev, r, "irq %d\n", client->irq);
	}

	r = ofm_init_sensor(o);
	if (r < 0)
		return r;

	if (poll_mode) {
		if (client->irq > 0)
			disable_irq(client->irq);
		o->poller = kthread_run(ofm_poll_thread, o, "jet-ofm-poll");
		if (IS_ERR(o->poller))
			return PTR_ERR(o->poller);
	}

	dev_info(dev, "VD5377 rev %d.%d, irq %d, swipe thresholds %d/%d\n",
		 major, minor, client->irq, thr_x, thr_y);
	return 0;
}

static void jet_ofm_remove(struct i2c_client *client)
{
	struct jet_ofm *o = i2c_get_clientdata(client);

	if (o->poller)
		kthread_stop(o->poller);
	gpiod_set_value_cansleep(o->standby, 1);
	gpiod_set_value_cansleep(o->powerdown, 1);
}

static const struct of_device_id jet_ofm_of_match[] = {
	{ .compatible = "partron,ms37c01a" },
	{ }
};
MODULE_DEVICE_TABLE(of, jet_ofm_of_match);

static const struct i2c_device_id jet_ofm_id[] = {
	{ "ms37c01a" },
	{ }
};
MODULE_DEVICE_TABLE(i2c, jet_ofm_id);

static struct i2c_driver jet_ofm_driver = {
	.driver = {
		.name = "jet-ofm",
		.of_match_table = jet_ofm_of_match,
	},
	.probe = jet_ofm_probe,
	.remove = jet_ofm_remove,
	.id_table = jet_ofm_id,
};
module_i2c_driver(jet_ofm_driver);

MODULE_DESCRIPTION("Partron MS37C01A / VD5377 optical finger navigation (Recon Jet touchpad)");
MODULE_LICENSE("GPL");
