// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * twl4030-pwrbutton with TWL6030/TWL6032 support (Recon Jet). Copied over
 * drivers/input/misc/twl4030-pwrbutton.c by kernel/build.sh.
 *
 * Differences from mainline: on a TWL6030-class PMIC the PWRON state lives in
 * STS_HW_CONDITIONS at PM_MASTER+0x02 (absolute 0x21) and is active low, and the
 * reported key code can be set from DT with linux,code (the Jet's rear button is a
 * nav key on a short press; only a long press is "power").
 */
#include <linux/module.h>
#include <linux/init.h>
#include <linux/kernel.h>
#include <linux/errno.h>
#include <linux/input.h>
#include <linux/interrupt.h>
#include <linux/of.h>
#include <linux/platform_device.h>
#include <linux/mfd/twl.h>

#define PWR_PWRON_IRQ (1 << 0)

#define TWL4030_STS_HW_CONDITIONS 0x0f
#define TWL6030_STS_HW_CONDITIONS 0x02	/* relative to TWL6030 PM_MASTER base 0x1f */

struct twl_pwrbutton {
	struct input_dev *input;
	unsigned int code;
	bool is_6030;
};

static irqreturn_t powerbutton_irq(int irq, void *_pb)
{
	struct twl_pwrbutton *pb = _pb;
	struct input_dev *pwr = pb->input;
	int err;
	u8 value;

	err = twl_i2c_read_u8(TWL_MODULE_PM_MASTER, &value,
			      pb->is_6030 ? TWL6030_STS_HW_CONDITIONS : TWL4030_STS_HW_CONDITIONS);
	if (!err) {
		bool pressed = pb->is_6030 ? !(value & PWR_PWRON_IRQ) : !!(value & PWR_PWRON_IRQ);

		pm_wakeup_event(pwr->dev.parent, 0);
		input_report_key(pwr, pb->code, pressed);
		input_sync(pwr);
	} else {
		dev_err(pwr->dev.parent, "twl: i2c error %d while reading STS_HW_CONDITIONS\n", err);
	}

	return IRQ_HANDLED;
}

static int twl4030_pwrbutton_probe(struct platform_device *pdev)
{
	struct twl_pwrbutton *pb;
	struct input_dev *pwr;
	int irq = platform_get_irq(pdev, 0);
	int err;

	if (irq < 0)
		return irq;

	pb = devm_kzalloc(&pdev->dev, sizeof(*pb), GFP_KERNEL);
	if (!pb)
		return -ENOMEM;

	pwr = devm_input_allocate_device(&pdev->dev);
	if (!pwr) {
		dev_err(&pdev->dev, "Can't allocate power button\n");
		return -ENOMEM;
	}

	pb->input = pwr;
	pb->is_6030 = twl_class_is_6030();
	pb->code = KEY_POWER;
	of_property_read_u32(pdev->dev.of_node, "linux,code", &pb->code);

	input_set_capability(pwr, EV_KEY, pb->code);
	pwr->name = pb->is_6030 ? "twl6030_pwrbutton" : "twl4030_pwrbutton";
	pwr->phys = "twl4030_pwrbutton/input0";
	pwr->dev.parent = &pdev->dev;

	err = devm_request_threaded_irq(&pdev->dev, irq, NULL, powerbutton_irq,
			IRQF_TRIGGER_FALLING | IRQF_TRIGGER_RISING |
			IRQF_ONESHOT,
			"twl4030_pwrbutton", pb);
	if (err < 0) {
		dev_err(&pdev->dev, "Can't get IRQ for pwrbutton: %d\n", err);
		return err;
	}

	err = input_register_device(pwr);
	if (err) {
		dev_err(&pdev->dev, "Can't register power button: %d\n", err);
		return err;
	}

	/*
	 * The twl6030 irq chip does not touch the PMIC mask registers per interrupt;
	 * every consumer unmasks its own bit (see twl6030_usb, twl6030-gpadc, twl-rtc).
	 */
	if (pb->is_6030) {
		twl6030_interrupt_unmask(PWR_PWRON_IRQ, REG_INT_MSK_LINE_A);
		twl6030_interrupt_unmask(PWR_PWRON_IRQ, REG_INT_MSK_STS_A);
	}

	device_init_wakeup(&pdev->dev, true);

	return 0;
}

#ifdef CONFIG_OF
static const struct of_device_id twl4030_pwrbutton_dt_match_table[] = {
       { .compatible = "ti,twl4030-pwrbutton" },
       {},
};
MODULE_DEVICE_TABLE(of, twl4030_pwrbutton_dt_match_table);
#endif

static struct platform_driver twl4030_pwrbutton_driver = {
	.probe		= twl4030_pwrbutton_probe,
	.driver		= {
		.name	= "twl4030_pwrbutton",
		.of_match_table = of_match_ptr(twl4030_pwrbutton_dt_match_table),
	},
};
module_platform_driver(twl4030_pwrbutton_driver);

MODULE_ALIAS("platform:twl4030_pwrbutton");
MODULE_DESCRIPTION("Triton2 / Phoenix Power Button");
MODULE_LICENSE("GPL");
MODULE_AUTHOR("Peter De Schrijver <peter.de-schrijver@nokia.com>");
MODULE_AUTHOR("Felipe Balbi <felipe.balbi@nokia.com>");
