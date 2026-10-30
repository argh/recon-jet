// SPDX-License-Identifier: GPL-2.0-only
/* Linux 6.18 drivers/bluetooth/hci_ll.c plus the Recon Jet GPS channel (search LL_GPS). */
/*
 *  Texas Instruments' Bluetooth HCILL UART protocol
 *
 *  HCILL (HCI Low Level) is a Texas Instruments' power management
 *  protocol extension to H4.
 *
 *  Copyright (C) 2007 Texas Instruments, Inc.
 *
 *  Written by Ohad Ben-Cohen <ohad@bencohen.org>
 *
 *  Acknowledgements:
 *  This file is based on hci_h4.c, which was written
 *  by Maxim Krasnyansky and Marcel Holtmann.
 */

#include <linux/module.h>
#include <linux/kernel.h>

#include <linux/init.h>
#include <linux/sched.h>
#include <linux/types.h>
#include <linux/fcntl.h>
#include <linux/firmware.h>
#include <linux/interrupt.h>
#include <linux/ptrace.h>
#include <linux/poll.h>

#include <linux/slab.h>
#include <linux/errno.h>
#include <linux/string.h>
#include <linux/signal.h>
#include <linux/ioctl.h>
#include <linux/of.h>
#include <linux/serdev.h>
#include <linux/skbuff.h>
#include <linux/ti_wilink_st.h>
#include <linux/clk.h>

#include <net/bluetooth/bluetooth.h>
#include <net/bluetooth/hci_core.h>
#include <linux/gpio/consumer.h>
#include <linux/nvmem-consumer.h>

#include <linux/miscdevice.h>
#include <linux/fs.h>
#include <linux/uaccess.h>
#include <linux/termios.h>
#include <linux/unaligned.h>
#include "hci_uart.h"

/* Vendor-specific HCI commands */
#define HCI_VS_WRITE_BD_ADDR			0xfc06
#define HCI_VS_UPDATE_UART_HCI_BAUDRATE		0xff36

/* HCILL commands */
#define HCILL_GO_TO_SLEEP_IND	0x30
#define HCILL_GO_TO_SLEEP_ACK	0x31
#define HCILL_WAKE_UP_IND	0x32
#define HCILL_WAKE_UP_ACK	0x33

/* HCILL states */
enum hcill_states_e {
	HCILL_ASLEEP,
	HCILL_ASLEEP_TO_AWAKE,
	HCILL_AWAKE,
	HCILL_AWAKE_TO_ASLEEP
};

struct ll_device {
	struct hci_uart hu;
	struct serdev_device *serdev;
	struct gpio_desc *enable_gpio;
	struct clk *ext_clk;
	bdaddr_t bdaddr;
};

struct ll_struct {
	struct sk_buff *rx_skb;
	struct sk_buff_head txq;
	spinlock_t hcill_lock;		/* HCILL state lock	*/
	unsigned long hcill_state;	/* HCILL power state	*/
	struct sk_buff_head tx_wait_q;	/* HCILL wait queue	*/
};

/*
 * GPS over the shared transport (Recon Jet, WL1283). The chip's GPS core speaks TI's AI2
 * protocol on "channel 9" of the same HCILL UART, framed [9][opcode u8][plen le16][payload]:
 * the host sends opcode 1 and waits for the chip's opcode 3 before sending the next, and the
 * chip's opcode 2 carries a report. /dev/tigps hands whole packets to user space, one per
 * read(), and takes one per write(), the contract TI's gps_drv.c had on the stock kernel, so
 * TI's closed navd runs unchanged. The chip is powered and its firmware loaded by hci0 coming
 * up, so the device wants hci0 up; reads return ENODEV once the link is gone.
 */
#define LL_GPS_PKT		0x09
#define LL_GPS_OP_WRITE		0x01
#define LL_GPS_OP_READ		0x02
#define LL_GPS_OP_COMPLETED	0x03
#define LL_GPS_HDR_LEN		3
#define LL_GPS_MAX_FRAME	4096
#define LL_GPS_TXQ_MAX		64
#define LL_GPS_RXQ_MAX		256

static int ll_enqueue(struct hci_uart *hu, struct sk_buff *skb);

static struct ll_gps {
	spinlock_t lock;		/* hu, credit, the queues' use from here */
	struct hci_uart *hu;		/* the open LL link; NULL while it is down */
	bool credit;			/* the chip has acknowledged the last write */
	struct sk_buff_head rx_q;	/* reports (payload only) waiting for read() */
	struct sk_buff_head tx_q;	/* writes (framed, type byte pending) waiting for credit */
	wait_queue_head_t wait;
	atomic_t open;			/* one opener */
} ll_gps;

/* Hand the next queued write to the link if the chip is ready for one. */
static void ll_gps_tx(void)
{
	struct sk_buff *skb;
	unsigned long flags;

	spin_lock_irqsave(&ll_gps.lock, flags);
	if (ll_gps.hu && ll_gps.credit) {
		skb = skb_dequeue(&ll_gps.tx_q);
		if (skb) {
			ll_gps.credit = false;
			bt_dev_info(ll_gps.hu->hdev, "gps: tx %u bytes, hcill state %lu", skb->len, ((struct ll_struct *)ll_gps.hu->priv)->hcill_state);
			ll_enqueue(ll_gps.hu, skb);
			hci_uart_tx_wakeup(ll_gps.hu);
		}
	}
	spin_unlock_irqrestore(&ll_gps.lock, flags);
}

/* A channel-9 frame from the chip: skb->data = [opcode][plen le16][payload]. */
static int ll_recv_gps(struct hci_dev *hdev, struct sk_buff *skb)
{
	u8 op = skb->data[0];
	u16 plen = get_unaligned_le16(skb->data + 1);
	unsigned long flags;

	bt_dev_info(hdev, "gps: rx opcode %u, %u bytes", op, skb->len);
	skb_pull(skb, LL_GPS_HDR_LEN);
	switch (op) {
	case LL_GPS_OP_READ:
		if (skb->len != plen) {
			bt_dev_warn(hdev, "gps: report length %u, header said %u", skb->len, plen);
			break;
		}
		spin_lock_irqsave(&ll_gps.lock, flags);
		if (ll_gps.rx_q.qlen < LL_GPS_RXQ_MAX) {
			skb_queue_tail(&ll_gps.rx_q, skb);
			skb = NULL;
		}
		spin_unlock_irqrestore(&ll_gps.lock, flags);
		wake_up_interruptible(&ll_gps.wait);
		break;
	case LL_GPS_OP_COMPLETED:
		spin_lock_irqsave(&ll_gps.lock, flags);
		ll_gps.credit = true;
		spin_unlock_irqrestore(&ll_gps.lock, flags);
		wake_up_interruptible(&ll_gps.wait);
		ll_gps_tx();
		break;
	default:
		bt_dev_warn(hdev, "gps: unexpected channel-9 opcode %u (%u bytes)", op, skb->len);
	}
	kfree_skb(skb);
	return 0;
}

static void ll_gps_link(struct hci_uart *hu)
{
	unsigned long flags;

	spin_lock_irqsave(&ll_gps.lock, flags);
	ll_gps.hu = hu;
	ll_gps.credit = true;
	spin_unlock_irqrestore(&ll_gps.lock, flags);
}

static void ll_gps_unlink(struct hci_uart *hu)
{
	unsigned long flags;

	spin_lock_irqsave(&ll_gps.lock, flags);
	if (ll_gps.hu == hu) {
		ll_gps.hu = NULL;
		skb_queue_purge(&ll_gps.tx_q);
	}
	spin_unlock_irqrestore(&ll_gps.lock, flags);
	wake_up_interruptible(&ll_gps.wait);
}

static int ll_gps_open(struct inode *inode, struct file *file)
{
	unsigned long flags;
	bool up;

	if (atomic_cmpxchg(&ll_gps.open, 0, 1))
		return -EBUSY;
	spin_lock_irqsave(&ll_gps.lock, flags);
	skb_queue_purge(&ll_gps.rx_q);
	skb_queue_purge(&ll_gps.tx_q);
	ll_gps.credit = true;
	up = ll_gps.hu != NULL;
	spin_unlock_irqrestore(&ll_gps.lock, flags);
	if (!up) {
		atomic_set(&ll_gps.open, 0);
		return -ENODEV;		/* bring hci0 up first: that powers the chip */
	}
	return nonseekable_open(inode, file);
}

static int ll_gps_release(struct inode *inode, struct file *file)
{
	atomic_set(&ll_gps.open, 0);
	return 0;
}

static ssize_t ll_gps_read(struct file *file, char __user *buf, size_t count, loff_t *pos)
{
	struct sk_buff *skb;
	unsigned long flags;
	size_t n;
	int err;

	for (;;) {
		spin_lock_irqsave(&ll_gps.lock, flags);
		skb = skb_dequeue(&ll_gps.rx_q);
		if (!skb && !ll_gps.hu) {
			spin_unlock_irqrestore(&ll_gps.lock, flags);
			return -ENODEV;
		}
		spin_unlock_irqrestore(&ll_gps.lock, flags);
		if (skb)
			break;
		if (file->f_flags & O_NONBLOCK)
			return -EAGAIN;
		err = wait_event_interruptible(ll_gps.wait, !skb_queue_empty(&ll_gps.rx_q) || !ll_gps.hu);
		if (err)
			return err;
	}
	n = min_t(size_t, count, skb->len);
	if (copy_to_user(buf, skb->data, n)) {
		skb_queue_head(&ll_gps.rx_q, skb);
		return -EFAULT;
	}
	skb_pull(skb, n);
	if (skb->len)
		skb_queue_head(&ll_gps.rx_q, skb);	/* the rest of a packet larger than the read */
	else
		kfree_skb(skb);
	return n;
}

static ssize_t ll_gps_write(struct file *file, const char __user *buf, size_t count, loff_t *pos)
{
	struct sk_buff *skb;
	unsigned long flags;
	u8 *hdr;

	if (!count || count > LL_GPS_MAX_FRAME)
		return -EINVAL;
	spin_lock_irqsave(&ll_gps.lock, flags);
	if (!ll_gps.hu) {
		spin_unlock_irqrestore(&ll_gps.lock, flags);
		return -ENODEV;
	}
	if (ll_gps.tx_q.qlen >= LL_GPS_TXQ_MAX) {
		spin_unlock_irqrestore(&ll_gps.lock, flags);
		return -EAGAIN;
	}
	spin_unlock_irqrestore(&ll_gps.lock, flags);
	skb = bt_skb_alloc(LL_GPS_HDR_LEN + count, GFP_KERNEL);
	if (!skb)
		return -ENOMEM;
	hci_skb_pkt_type(skb) = LL_GPS_PKT;	/* ll_enqueue pushes it in front */
	hdr = skb_put(skb, LL_GPS_HDR_LEN);
	hdr[0] = LL_GPS_OP_WRITE;
	put_unaligned_le16(count, hdr + 1);
	if (copy_from_user(skb_put(skb, count), buf, count)) {
		kfree_skb(skb);
		return -EFAULT;
	}
	spin_lock_irqsave(&ll_gps.lock, flags);
	skb_queue_tail(&ll_gps.tx_q, skb);
	spin_unlock_irqrestore(&ll_gps.lock, flags);
	ll_gps_tx();
	return count;
}

static __poll_t ll_gps_poll(struct file *file, poll_table *wait)
{
	__poll_t mask = 0;

	poll_wait(file, &ll_gps.wait, wait);
	if (!skb_queue_empty(&ll_gps.rx_q))
		mask |= EPOLLIN | EPOLLRDNORM;
	if (!ll_gps.hu)
		mask |= EPOLLHUP;
	else if (ll_gps.tx_q.qlen < LL_GPS_TXQ_MAX)
		mask |= EPOLLOUT | EPOLLWRNORM;
	return mask;
}

/* TI's transport library polls FIONREAD for the next packet's size and flushes with TCFLSH. */
static long ll_gps_ioctl(struct file *file, unsigned int cmd, unsigned long arg)
{
	struct sk_buff *skb;
	unsigned long flags;
	int n = 0;

	switch (cmd) {
	case FIONREAD:
		spin_lock_irqsave(&ll_gps.lock, flags);
		skb = skb_peek(&ll_gps.rx_q);
		if (skb)
			n = skb->len;
		spin_unlock_irqrestore(&ll_gps.lock, flags);
		return put_user(n, (int __user *)arg);
	case TCFLSH:
		spin_lock_irqsave(&ll_gps.lock, flags);
		if (arg == TCIFLUSH || arg == TCIOFLUSH)
			skb_queue_purge(&ll_gps.rx_q);
		if (arg == TCOFLUSH || arg == TCIOFLUSH)
			skb_queue_purge(&ll_gps.tx_q);
		spin_unlock_irqrestore(&ll_gps.lock, flags);
		return 0;
	}
	return 0;	/* as the stock driver: unknown ioctls succeed */
}

static const struct file_operations ll_gps_fops = {
	.owner		= THIS_MODULE,
	.open		= ll_gps_open,
	.release	= ll_gps_release,
	.read		= ll_gps_read,
	.write		= ll_gps_write,
	.poll		= ll_gps_poll,
	.unlocked_ioctl	= ll_gps_ioctl,
};

static struct miscdevice ll_gps_dev = {
	.minor	= MISC_DYNAMIC_MINOR,
	.name	= "tigps",
	.fops	= &ll_gps_fops,
	.mode	= 0660,
};

static void ll_gps_init(void)
{
	spin_lock_init(&ll_gps.lock);
	skb_queue_head_init(&ll_gps.rx_q);
	skb_queue_head_init(&ll_gps.tx_q);
	init_waitqueue_head(&ll_gps.wait);
	if (misc_register(&ll_gps_dev))
		pr_warn("hci_ll: no /dev/tigps\n");
}

static void ll_gps_exit(void)
{
	misc_deregister(&ll_gps_dev);
	skb_queue_purge(&ll_gps.rx_q);
	skb_queue_purge(&ll_gps.tx_q);
}

/*
 * Builds and sends an HCILL command packet.
 * These are very simple packets with only 1 cmd byte
 */
static int send_hcill_cmd(u8 cmd, struct hci_uart *hu)
{
	int err = 0;
	struct sk_buff *skb = NULL;
	struct ll_struct *ll = hu->priv;

	BT_DBG("hu %p cmd 0x%x", hu, cmd);

	/* allocate packet */
	skb = bt_skb_alloc(1, GFP_ATOMIC);
	if (!skb) {
		BT_ERR("cannot allocate memory for HCILL packet");
		err = -ENOMEM;
		goto out;
	}

	/* prepare packet */
	skb_put_u8(skb, cmd);

	/* send packet */
	skb_queue_tail(&ll->txq, skb);
out:
	return err;
}

/* Initialize protocol */
static int ll_open(struct hci_uart *hu)
{
	struct ll_struct *ll;

	BT_DBG("hu %p", hu);

	ll = kzalloc(sizeof(*ll), GFP_KERNEL);
	if (!ll)
		return -ENOMEM;

	skb_queue_head_init(&ll->txq);
	skb_queue_head_init(&ll->tx_wait_q);
	spin_lock_init(&ll->hcill_lock);

	ll->hcill_state = HCILL_AWAKE;

	hu->priv = ll;
	ll_gps_link(hu);

	if (hu->serdev) {
		struct ll_device *lldev = serdev_device_get_drvdata(hu->serdev);

		if (!IS_ERR(lldev->ext_clk))
			clk_prepare_enable(lldev->ext_clk);
	}

	return 0;
}

/* Flush protocol data */
static int ll_flush(struct hci_uart *hu)
{
	struct ll_struct *ll = hu->priv;

	BT_DBG("hu %p", hu);

	skb_queue_purge(&ll->tx_wait_q);
	skb_queue_purge(&ll->txq);

	return 0;
}

/* Close protocol */
static int ll_close(struct hci_uart *hu)
{
	struct ll_struct *ll = hu->priv;

	BT_DBG("hu %p", hu);

	ll_gps_unlink(hu);

	skb_queue_purge(&ll->tx_wait_q);
	skb_queue_purge(&ll->txq);

	kfree_skb(ll->rx_skb);

	if (hu->serdev) {
		struct ll_device *lldev = serdev_device_get_drvdata(hu->serdev);

		gpiod_set_value_cansleep(lldev->enable_gpio, 0);

		clk_disable_unprepare(lldev->ext_clk);
	}

	hu->priv = NULL;

	kfree(ll);

	return 0;
}

/*
 * internal function, which does common work of the device wake up process:
 * 1. places all pending packets (waiting in tx_wait_q list) in txq list.
 * 2. changes internal state to HCILL_AWAKE.
 * Note: assumes that hcill_lock spinlock is taken,
 * shouldn't be called otherwise!
 */
static void __ll_do_awake(struct ll_struct *ll)
{
	struct sk_buff *skb = NULL;

	while ((skb = skb_dequeue(&ll->tx_wait_q)))
		skb_queue_tail(&ll->txq, skb);

	ll->hcill_state = HCILL_AWAKE;
}

/*
 * Called upon a wake-up-indication from the device
 */
static void ll_device_want_to_wakeup(struct hci_uart *hu)
{
	unsigned long flags;
	struct ll_struct *ll = hu->priv;

	BT_DBG("hu %p", hu);

	/* lock hcill state */
	spin_lock_irqsave(&ll->hcill_lock, flags);

	switch (ll->hcill_state) {
	case HCILL_ASLEEP_TO_AWAKE:
		/*
		 * This state means that both the host and the BRF chip
		 * have simultaneously sent a wake-up-indication packet.
		 * Traditionally, in this case, receiving a wake-up-indication
		 * was enough and an additional wake-up-ack wasn't needed.
		 * This has changed with the BRF6350, which does require an
		 * explicit wake-up-ack. Other BRF versions, which do not
		 * require an explicit ack here, do accept it, thus it is
		 * perfectly safe to always send one.
		 */
		BT_DBG("dual wake-up-indication");
		fallthrough;
	case HCILL_ASLEEP:
		/* acknowledge device wake up */
		if (send_hcill_cmd(HCILL_WAKE_UP_ACK, hu) < 0) {
			BT_ERR("cannot acknowledge device wake up");
			goto out;
		}
		break;
	default:
		/* any other state is illegal */
		BT_ERR("received HCILL_WAKE_UP_IND in state %ld",
		       ll->hcill_state);
		break;
	}

	/* send pending packets and change state to HCILL_AWAKE */
	__ll_do_awake(ll);

out:
	spin_unlock_irqrestore(&ll->hcill_lock, flags);

	/* actually send the packets */
	hci_uart_tx_wakeup(hu);
}

/*
 * Called upon a sleep-indication from the device
 */
static void ll_device_want_to_sleep(struct hci_uart *hu)
{
	unsigned long flags;
	struct ll_struct *ll = hu->priv;

	BT_DBG("hu %p", hu);

	/* lock hcill state */
	spin_lock_irqsave(&ll->hcill_lock, flags);

	/* sanity check */
	if (ll->hcill_state != HCILL_AWAKE)
		BT_ERR("ERR: HCILL_GO_TO_SLEEP_IND in state %ld",
		       ll->hcill_state);

	/* acknowledge device sleep */
	if (send_hcill_cmd(HCILL_GO_TO_SLEEP_ACK, hu) < 0) {
		BT_ERR("cannot acknowledge device sleep");
		goto out;
	}

	/* update state */
	ll->hcill_state = HCILL_ASLEEP;

out:
	spin_unlock_irqrestore(&ll->hcill_lock, flags);

	/* actually send the sleep ack packet */
	hci_uart_tx_wakeup(hu);
}

/*
 * Called upon wake-up-acknowledgement from the device
 */
static void ll_device_woke_up(struct hci_uart *hu)
{
	unsigned long flags;
	struct ll_struct *ll = hu->priv;

	BT_DBG("hu %p", hu);

	/* lock hcill state */
	spin_lock_irqsave(&ll->hcill_lock, flags);

	/* sanity check */
	if (ll->hcill_state != HCILL_ASLEEP_TO_AWAKE)
		BT_ERR("received HCILL_WAKE_UP_ACK in state %ld",
		       ll->hcill_state);

	/* send pending packets and change state to HCILL_AWAKE */
	__ll_do_awake(ll);

	spin_unlock_irqrestore(&ll->hcill_lock, flags);

	/* actually send the packets */
	hci_uart_tx_wakeup(hu);
}

/* Enqueue frame for transmission (padding, crc, etc) */
/* may be called from two simultaneous tasklets */
static int ll_enqueue(struct hci_uart *hu, struct sk_buff *skb)
{
	unsigned long flags = 0;
	struct ll_struct *ll = hu->priv;

	BT_DBG("hu %p skb %p", hu, skb);

	/* Prepend skb with frame type */
	memcpy(skb_push(skb, 1), &hci_skb_pkt_type(skb), 1);

	/* lock hcill state */
	spin_lock_irqsave(&ll->hcill_lock, flags);

	/* act according to current state */
	switch (ll->hcill_state) {
	case HCILL_AWAKE:
		BT_DBG("device awake, sending normally");
		skb_queue_tail(&ll->txq, skb);
		break;
	case HCILL_ASLEEP:
		BT_DBG("device asleep, waking up and queueing packet");
		/* save packet for later */
		skb_queue_tail(&ll->tx_wait_q, skb);
		/* awake device */
		if (send_hcill_cmd(HCILL_WAKE_UP_IND, hu) < 0) {
			BT_ERR("cannot wake up device");
			break;
		}
		ll->hcill_state = HCILL_ASLEEP_TO_AWAKE;
		break;
	case HCILL_ASLEEP_TO_AWAKE:
		BT_DBG("device waking up, queueing packet");
		/* transient state; just keep packet for later */
		skb_queue_tail(&ll->tx_wait_q, skb);
		break;
	default:
		BT_ERR("illegal hcill state: %ld (losing packet)",
		       ll->hcill_state);
		dev_kfree_skb_irq(skb);
		break;
	}

	spin_unlock_irqrestore(&ll->hcill_lock, flags);

	return 0;
}

static int ll_recv_frame(struct hci_dev *hdev, struct sk_buff *skb)
{
	struct hci_uart *hu = hci_get_drvdata(hdev);
	struct ll_struct *ll = hu->priv;

	switch (hci_skb_pkt_type(skb)) {
	case HCILL_GO_TO_SLEEP_IND:
		BT_DBG("HCILL_GO_TO_SLEEP_IND packet");
		ll_device_want_to_sleep(hu);
		break;
	case HCILL_GO_TO_SLEEP_ACK:
		/* shouldn't happen */
		bt_dev_err(hdev, "received HCILL_GO_TO_SLEEP_ACK in state %ld",
			   ll->hcill_state);
		break;
	case HCILL_WAKE_UP_IND:
		BT_DBG("HCILL_WAKE_UP_IND packet");
		ll_device_want_to_wakeup(hu);
		break;
	case HCILL_WAKE_UP_ACK:
		BT_DBG("HCILL_WAKE_UP_ACK packet");
		ll_device_woke_up(hu);
		break;
	}

	kfree_skb(skb);
	return 0;
}

#define LL_RECV_SLEEP_IND \
	.type = HCILL_GO_TO_SLEEP_IND, \
	.hlen = 0, \
	.loff = 0, \
	.lsize = 0, \
	.maxlen = 0

#define LL_RECV_SLEEP_ACK \
	.type = HCILL_GO_TO_SLEEP_ACK, \
	.hlen = 0, \
	.loff = 0, \
	.lsize = 0, \
	.maxlen = 0

#define LL_RECV_WAKE_IND \
	.type = HCILL_WAKE_UP_IND, \
	.hlen = 0, \
	.loff = 0, \
	.lsize = 0, \
	.maxlen = 0

#define LL_RECV_WAKE_ACK \
	.type = HCILL_WAKE_UP_ACK, \
	.hlen = 0, \
	.loff = 0, \
	.lsize = 0, \
	.maxlen = 0

static const struct h4_recv_pkt ll_recv_pkts[] = {
	{ H4_RECV_ACL,       .recv = hci_recv_frame },
	{ H4_RECV_SCO,       .recv = hci_recv_frame },
	{ H4_RECV_EVENT,     .recv = hci_recv_frame },
	{ LL_RECV_SLEEP_IND, .recv = ll_recv_frame  },
	{ LL_RECV_SLEEP_ACK, .recv = ll_recv_frame  },
	{ LL_RECV_WAKE_IND,  .recv = ll_recv_frame  },
	{ LL_RECV_WAKE_ACK,  .recv = ll_recv_frame  },
	{ .type = LL_GPS_PKT, .hlen = LL_GPS_HDR_LEN, .loff = 1, .lsize = 2, .maxlen = LL_GPS_HDR_LEN + LL_GPS_MAX_FRAME, .recv = ll_recv_gps },
};

/* Recv data */
static int ll_recv(struct hci_uart *hu, const void *data, int count)
{
	struct ll_struct *ll = hu->priv;

	if (!test_bit(HCI_UART_REGISTERED, &hu->flags))
		return -EUNATCH;

	ll->rx_skb = h4_recv_buf(hu, ll->rx_skb, data, count,
				 ll_recv_pkts, ARRAY_SIZE(ll_recv_pkts));
	if (IS_ERR(ll->rx_skb)) {
		int err = PTR_ERR(ll->rx_skb);
		bt_dev_err(hu->hdev, "Frame reassembly failed (%d)", err);
		ll->rx_skb = NULL;
		return err;
	}

	return count;
}

static struct sk_buff *ll_dequeue(struct hci_uart *hu)
{
	struct ll_struct *ll = hu->priv;

	return skb_dequeue(&ll->txq);
}

#if IS_ENABLED(CONFIG_SERIAL_DEV_BUS)
static int read_local_version(struct hci_dev *hdev)
{
	int err = 0;
	unsigned short version = 0;
	struct sk_buff *skb;
	struct hci_rp_read_local_version *ver;

	skb = __hci_cmd_sync(hdev, HCI_OP_READ_LOCAL_VERSION, 0, NULL,
			     HCI_INIT_TIMEOUT);
	if (IS_ERR(skb)) {
		bt_dev_err(hdev, "Reading TI version information failed (%ld)",
			   PTR_ERR(skb));
		return PTR_ERR(skb);
	}
	if (skb->len != sizeof(*ver)) {
		err = -EILSEQ;
		goto out;
	}

	ver = (struct hci_rp_read_local_version *)skb->data;
	if (le16_to_cpu(ver->manufacturer) != 13) {
		err = -ENODEV;
		goto out;
	}

	version = le16_to_cpu(ver->lmp_subver);

out:
	if (err)
		bt_dev_err(hdev, "Failed to read TI version info: %d", err);
	kfree_skb(skb);
	return err ? err : version;
}

static int send_command_from_firmware(struct ll_device *lldev,
				      struct hci_command *cmd)
{
	struct sk_buff *skb;

	if (cmd->opcode == HCI_VS_UPDATE_UART_HCI_BAUDRATE) {
		/* ignore remote change
		 * baud rate HCI VS command
		 */
		bt_dev_warn(lldev->hu.hdev,
			    "change remote baud rate command in firmware");
		return 0;
	}
	if (cmd->prefix != 1)
		bt_dev_dbg(lldev->hu.hdev, "command type %d", cmd->prefix);

	skb = __hci_cmd_sync(lldev->hu.hdev, cmd->opcode, cmd->plen,
			     &cmd->speed, HCI_INIT_TIMEOUT);
	if (IS_ERR(skb)) {
		bt_dev_err(lldev->hu.hdev, "send command failed");
		return PTR_ERR(skb);
	}
	kfree_skb(skb);
	return 0;
}

/*
 * download_firmware -
 *	internal function which parses through the .bts firmware
 *	script file intreprets SEND, DELAY actions only as of now
 */
static int download_firmware(struct ll_device *lldev)
{
	unsigned short chip, min_ver, maj_ver;
	int version, err, len;
	unsigned char *ptr, *action_ptr;
	unsigned char bts_scr_name[40];	/* 40 char long bts scr name? */
	const struct firmware *fw;
	struct hci_command *cmd;

	version = read_local_version(lldev->hu.hdev);
	if (version < 0)
		return version;

	chip = (version & 0x7C00) >> 10;
	min_ver = (version & 0x007F);
	maj_ver = (version & 0x0380) >> 7;
	if (version & 0x8000)
		maj_ver |= 0x0008;

	snprintf(bts_scr_name, sizeof(bts_scr_name),
		 "ti-connectivity/TIInit_%d.%d.%d.bts",
		 chip, maj_ver, min_ver);

	err = request_firmware(&fw, bts_scr_name, &lldev->serdev->dev);
	if (err || !fw->data || !fw->size) {
		bt_dev_err(lldev->hu.hdev, "request_firmware failed(errno %d) for %s",
			   err, bts_scr_name);
		return -EINVAL;
	}
	ptr = (void *)fw->data;
	len = fw->size;
	/* bts_header to remove out magic number and
	 * version
	 */
	ptr += sizeof(struct bts_header);
	len -= sizeof(struct bts_header);

	while (len > 0 && ptr) {
		bt_dev_dbg(lldev->hu.hdev, " action size %d, type %d ",
			   ((struct bts_action *)ptr)->size,
			   ((struct bts_action *)ptr)->type);

		action_ptr = &(((struct bts_action *)ptr)->data[0]);

		switch (((struct bts_action *)ptr)->type) {
		case ACTION_SEND_COMMAND:	/* action send */
			bt_dev_dbg(lldev->hu.hdev, "S");
			cmd = (struct hci_command *)action_ptr;
			err = send_command_from_firmware(lldev, cmd);
			if (err)
				goto out_rel_fw;
			break;
		case ACTION_WAIT_EVENT:  /* wait */
			/* no need to wait as command was synchronous */
			bt_dev_dbg(lldev->hu.hdev, "W");
			break;
		case ACTION_DELAY:	/* sleep */
			bt_dev_info(lldev->hu.hdev, "sleep command in scr");
			msleep(((struct bts_action_delay *)action_ptr)->msec);
			break;
		}
		len -= (sizeof(struct bts_action) +
			((struct bts_action *)ptr)->size);
		ptr += sizeof(struct bts_action) +
			((struct bts_action *)ptr)->size;
	}

out_rel_fw:
	/* fw download complete */
	release_firmware(fw);
	return err;
}

static int ll_set_bdaddr(struct hci_dev *hdev, const bdaddr_t *bdaddr)
{
	bdaddr_t bdaddr_swapped;
	struct sk_buff *skb;

	/* HCI_VS_WRITE_BD_ADDR (at least on a CC2560A chip) expects the BD
	 * address to be MSB first, but bdaddr_t has the convention of being
	 * LSB first.
	 */
	baswap(&bdaddr_swapped, bdaddr);
	skb = __hci_cmd_sync(hdev, HCI_VS_WRITE_BD_ADDR, sizeof(bdaddr_t),
			     &bdaddr_swapped, HCI_INIT_TIMEOUT);
	if (!IS_ERR(skb))
		kfree_skb(skb);

	return PTR_ERR_OR_ZERO(skb);
}

static int ll_setup(struct hci_uart *hu)
{
	int err, retry = 3;
	struct ll_device *lldev;
	struct serdev_device *serdev = hu->serdev;
	u32 speed;

	if (!serdev)
		return 0;

	lldev = serdev_device_get_drvdata(serdev);

	hu->hdev->set_bdaddr = ll_set_bdaddr;

	serdev_device_set_flow_control(serdev, true);

	do {
		/* Reset the Bluetooth device */
		gpiod_set_value_cansleep(lldev->enable_gpio, 0);
		msleep(5);
		gpiod_set_value_cansleep(lldev->enable_gpio, 1);
		mdelay(100);
		err = serdev_device_wait_for_cts(serdev, true, 200);
		if (err) {
			bt_dev_err(hu->hdev, "Failed to get CTS");
			return err;
		}

		err = download_firmware(lldev);
		if (!err)
			break;

		/* Toggle BT_EN and retry */
		bt_dev_err(hu->hdev, "download firmware failed, retrying...");
	} while (retry--);

	if (err)
		return err;

	/* Set BD address if one was specified at probe */
	if (!bacmp(&lldev->bdaddr, BDADDR_NONE)) {
		/* This means that there was an error getting the BD address
		 * during probe, so mark the device as having a bad address.
		 */
		hci_set_quirk(hu->hdev, HCI_QUIRK_INVALID_BDADDR);
	} else if (bacmp(&lldev->bdaddr, BDADDR_ANY)) {
		err = ll_set_bdaddr(hu->hdev, &lldev->bdaddr);
		if (err)
			hci_set_quirk(hu->hdev, HCI_QUIRK_INVALID_BDADDR);
	}

	/* Operational speed if any */
	if (hu->oper_speed)
		speed = hu->oper_speed;
	else if (hu->proto->oper_speed)
		speed = hu->proto->oper_speed;
	else
		speed = 0;

	if (speed) {
		__le32 speed_le = cpu_to_le32(speed);
		struct sk_buff *skb;

		skb = __hci_cmd_sync(hu->hdev, HCI_VS_UPDATE_UART_HCI_BAUDRATE,
				     sizeof(speed_le), &speed_le,
				     HCI_INIT_TIMEOUT);
		if (!IS_ERR(skb)) {
			kfree_skb(skb);
			serdev_device_set_baudrate(serdev, speed);
		}
	}

	return 0;
}

static const struct hci_uart_proto llp;

static int hci_ti_probe(struct serdev_device *serdev)
{
	struct hci_uart *hu;
	struct ll_device *lldev;
	struct nvmem_cell *bdaddr_cell;
	u32 max_speed = 3000000;

	lldev = devm_kzalloc(&serdev->dev, sizeof(struct ll_device), GFP_KERNEL);
	if (!lldev)
		return -ENOMEM;
	hu = &lldev->hu;

	serdev_device_set_drvdata(serdev, lldev);
	lldev->serdev = hu->serdev = serdev;

	lldev->enable_gpio = devm_gpiod_get_optional(&serdev->dev,
						     "enable",
						     GPIOD_OUT_LOW);
	if (IS_ERR(lldev->enable_gpio))
		return PTR_ERR(lldev->enable_gpio);

	lldev->ext_clk = devm_clk_get(&serdev->dev, "ext_clock");
	if (IS_ERR(lldev->ext_clk) && PTR_ERR(lldev->ext_clk) != -ENOENT)
		return PTR_ERR(lldev->ext_clk);

	of_property_read_u32(serdev->dev.of_node, "max-speed", &max_speed);
	hci_uart_set_speeds(hu, 115200, max_speed);

	/* optional BD address from nvram */
	bdaddr_cell = nvmem_cell_get(&serdev->dev, "bd-address");
	if (IS_ERR(bdaddr_cell)) {
		int err = PTR_ERR(bdaddr_cell);

		if (err == -EPROBE_DEFER)
			return err;

		/* ENOENT means there is no matching nvmem cell and ENOSYS
		 * means that nvmem is not enabled in the kernel configuration.
		 */
		if (err != -ENOENT && err != -ENOSYS) {
			/* If there was some other error, give userspace a
			 * chance to fix the problem instead of failing to load
			 * the driver. Using BDADDR_NONE as a flag that is
			 * tested later in the setup function.
			 */
			dev_warn(&serdev->dev,
				 "Failed to get \"bd-address\" nvmem cell (%d)\n",
				 err);
			bacpy(&lldev->bdaddr, BDADDR_NONE);
		}
	} else {
		bdaddr_t *bdaddr;
		size_t len;

		bdaddr = nvmem_cell_read(bdaddr_cell, &len);
		nvmem_cell_put(bdaddr_cell);
		if (IS_ERR(bdaddr)) {
			dev_err(&serdev->dev, "Failed to read nvmem bd-address\n");
			return PTR_ERR(bdaddr);
		}
		if (len != sizeof(bdaddr_t)) {
			dev_err(&serdev->dev, "Invalid nvmem bd-address length\n");
			kfree(bdaddr);
			return -EINVAL;
		}

		/* As per the device tree bindings, the value from nvmem is
		 * expected to be MSB first, but in the kernel it is expected
		 * that bdaddr_t is LSB first.
		 */
		baswap(&lldev->bdaddr, bdaddr);
		kfree(bdaddr);
	}

	return hci_uart_register_device(hu, &llp);
}

static void hci_ti_remove(struct serdev_device *serdev)
{
	struct ll_device *lldev = serdev_device_get_drvdata(serdev);

	hci_uart_unregister_device(&lldev->hu);
}

static const struct of_device_id hci_ti_of_match[] = {
	{ .compatible = "ti,cc2560" },
	{ .compatible = "ti,wl1271-st" },
	{ .compatible = "ti,wl1273-st" },
	{ .compatible = "ti,wl1281-st" },
	{ .compatible = "ti,wl1283-st" },
	{ .compatible = "ti,wl1285-st" },
	{ .compatible = "ti,wl1801-st" },
	{ .compatible = "ti,wl1805-st" },
	{ .compatible = "ti,wl1807-st" },
	{ .compatible = "ti,wl1831-st" },
	{ .compatible = "ti,wl1835-st" },
	{ .compatible = "ti,wl1837-st" },
	{},
};
MODULE_DEVICE_TABLE(of, hci_ti_of_match);

static struct serdev_device_driver hci_ti_drv = {
	.driver		= {
		.name	= "hci-ti",
		.of_match_table = hci_ti_of_match,
	},
	.probe	= hci_ti_probe,
	.remove	= hci_ti_remove,
};
#else
#define ll_setup NULL
#endif

static const struct hci_uart_proto llp = {
	.id		= HCI_UART_LL,
	.name		= "LL",
	.setup		= ll_setup,
	.open		= ll_open,
	.close		= ll_close,
	.recv		= ll_recv,
	.enqueue	= ll_enqueue,
	.dequeue	= ll_dequeue,
	.flush		= ll_flush,
};

int __init ll_init(void)
{
	ll_gps_init();
	serdev_device_driver_register(&hci_ti_drv);

	return hci_uart_register_proto(&llp);
}

int __exit ll_deinit(void)
{
	ll_gps_exit();
	serdev_device_driver_unregister(&hci_ti_drv);

	return hci_uart_unregister_proto(&llp);
}
