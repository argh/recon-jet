/* issprobe: does the OMAP4 ISS write outside the buffer it was given at stream start?
 *
 * Per run: open the capture node, S_FMT 640x480 UYVY, REQBUFS N (MMAP), map every buffer
 * read-write and fill it with 0xA5, queue only the first Q buffers (default 1), STREAMON,
 * dequeue F frames (default 1; with Q > 1 each is re-queued), STREAMOFF, then scan every
 * buffer that was never queued for bytes that are no longer 0xA5. One summary line per run,
 * details for dirty buffers. The physical placement of each buffer (first/last PFN from
 * /proc/self/pagemap, root only) is printed so adjacency is visible: an overflow out of
 * buffer 0 only shows in a neighbour if the neighbour really is the next thing in memory.
 *
 *   issprobe [-d /dev/video0] [-n runs=20] [-b bufs=6] [-q queued=1] [-f frames=1]
 *            [-s sleep_s=3] [-t timeout_ms=4000] [-w WxH=640x480] [-x stop_after_dirty_runs=0]
 *            [-m hexaddr[:MiB]]  read-only /dev/mem view of the CMA area (e.g. bf000000:16): gives each
 *                          buffer's physical address (pagemap cannot see a VM_PFNMAP mapping) and, with
 *                          -o, dumps physical memory from buffer 0 onward (prefix.phys, 4 MiB) so the
 *                          whole extent of the frame is visible, gaps between buffers included
 *            [-L]          per dequeued frame: ms since STREAMON, mean luma, share of luma >= 235 and <= 20
 *                          (auto-exposure convergence after a cold start; use with -q 3 -f 30)
 *            [-o prefix]   write buffer 0 and every dirty buffer of the last run to prefix.bN
 *
 * Static ARMv7 (zig cc -target arm-linux-musleabihf), see build.sh. Uses the media pipeline
 * as init configured it (sensor -> CSI2a -> memory); it does not touch links or subdev formats.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <time.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <linux/videodev2.h>

#define MAXB 16
#define FILL 0xA5

static uint64_t pfn_of(int pm, const void *va) {
	uint64_t e = 0;
	if (pm < 0) return 0;
	if (pread(pm, &e, 8, (off_t)((uintptr_t)va / 4096) * 8) != 8) return 0;
	if (!(e >> 63)) return 0;                       /* not present */
	return e & ((1ULL << 55) - 1);
}

static void hexdump(const uint8_t *p, size_t n) {
	for (size_t i = 0; i < n; i++) printf("%02x%s", p[i], (i & 31) == 31 ? "\n      " : " ");
	printf("\n");
}

/* mean absolute difference between bytes one candidate line period apart; the lower one is the
 * real line length. Flat (black) data scores ~0 for both: reported as such via the luma spread. */
static double sad(const uint8_t *p, size_t len, size_t period) {
	uint64_t s = 0; size_t n = 0;
	if (len <= period) return -1;
	for (size_t i = 1; i + period < len; i += 2, n++) s += (unsigned)abs((int)p[i] - (int)p[i + period]);
	return n ? (double)s / n : -1;
}

struct scan { size_t changed, first, last; };
static struct scan scan_buf(const uint8_t *p, size_t len) {
	struct scan s = { 0, 0, 0 };
	for (size_t i = 0; i < len; i++) if (p[i] != FILL) { if (!s.changed) s.first = i; s.last = i; s.changed++; }
	return s;
}

int main(int argc, char **argv) {
	const char *dev = "/dev/video0", *dump = NULL;
	int runs = 20, nb = 6, nq = 1, frames = 1, slp = 3, tmo = 4000, stop_dirty = 0, luma = 0, c;
	unsigned W = 640, H = 480; unsigned long cma_base = 0, cma_len = 16 << 20; const uint8_t *cma = NULL;
	while ((c = getopt(argc, argv, "d:n:b:q:f:s:t:w:x:o:m:L")) != -1) switch (c) {
		case 'd': dev = optarg; break;
		case 'n': runs = atoi(optarg); break;
		case 'b': nb = atoi(optarg); break;
		case 'q': nq = atoi(optarg); break;
		case 'f': frames = atoi(optarg); break;
		case 's': slp = atoi(optarg); break;
		case 't': tmo = atoi(optarg); break;
		case 'm': cma_base = strtoul(optarg, NULL, 16); if (strchr(optarg, ':')) cma_len = strtoul(strchr(optarg, ':') + 1, NULL, 0) << 20; break;
		case 'L': luma = 1; break;
		case 'o': dump = optarg; break;
		case 'x': stop_dirty = atoi(optarg); break;
		case 'w': sscanf(optarg, "%ux%u", &W, &H); break;
		default: fprintf(stderr, "usage: see the header of issprobe.c\n"); return 2;
	}
	if (nb > MAXB) nb = MAXB;
	if (nq < 1) nq = 1;
	setvbuf(stdout, NULL, _IOLBF, 0);
	int pm = open("/proc/self/pagemap", O_RDONLY);
	int dirty_runs = 0, ok_runs = 0;
	if (cma_base) {
		int mfd = open("/dev/mem", O_RDONLY | O_SYNC);
		cma = mfd < 0 ? MAP_FAILED : mmap(NULL, cma_len, PROT_READ, MAP_SHARED, mfd, cma_base);
		if (cma == MAP_FAILED) { printf("/dev/mem view of %lx: %s\n", cma_base, strerror(errno)); cma = NULL; }
	}

	for (int run = 1; run <= runs; run++) {
		void *map[MAXB] = { 0 }; size_t len[MAXB] = { 0 }; uint64_t p0[MAXB] = { 0 }, p1[MAXB] = { 0 };
		int type = V4L2_BUF_TYPE_VIDEO_CAPTURE, fd, streaming = 0;
		const char *err = NULL; int e = 0;
		unsigned bytesused = 0, flags = 0, seq = 0, got = 0; int didx = -1;
		struct timespec t0, t1; long ms = -1;

		fd = open(dev, O_RDWR | O_NONBLOCK);
		if (fd < 0) { printf("run %d: open %s: %s\n", run, dev, strerror(errno)); return 1; }
		struct v4l2_format f = { .type = type };
		f.fmt.pix.width = W; f.fmt.pix.height = H; f.fmt.pix.pixelformat = V4L2_PIX_FMT_UYVY; f.fmt.pix.field = V4L2_FIELD_NONE;
		if (ioctl(fd, VIDIOC_S_FMT, &f) < 0) { err = "S_FMT"; e = errno; goto out; }
		struct v4l2_requestbuffers rb = { .count = nb, .type = type, .memory = V4L2_MEMORY_MMAP };
		long req_ms; clock_gettime(CLOCK_MONOTONIC, &t0);
		if (ioctl(fd, VIDIOC_REQBUFS, &rb) < 0) { err = "REQBUFS"; e = errno; goto out; }
		clock_gettime(CLOCK_MONOTONIC, &t1); req_ms = (t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_nsec - t0.tv_nsec) / 1000000;
		if ((int)rb.count < nq + 1) { err = "REQBUFS gave too few buffers"; e = 0; goto out; }
		for (unsigned i = 0; i < rb.count; i++) {
			struct v4l2_buffer b = { .type = type, .memory = V4L2_MEMORY_MMAP, .index = i };
			if (ioctl(fd, VIDIOC_QUERYBUF, &b) < 0) { err = "QUERYBUF"; e = errno; goto out; }
			map[i] = mmap(NULL, b.length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, b.m.offset);
			if (map[i] == MAP_FAILED) { map[i] = NULL; err = "mmap"; e = errno; goto out; }
			len[i] = b.length;
			memset(map[i], FILL, len[i]);
			p0[i] = pfn_of(pm, map[i]);
			p1[i] = pfn_of(pm, (uint8_t *)map[i] + ((len[i] - 1) & ~4095UL));
			if (cma) {
				uint8_t sig[16]; int hits = 0; unsigned long at = 0;
				memcpy(sig, "ISSPROBE", 8); sig[8] = (uint8_t)i; sig[9] = (uint8_t)run; memset(sig + 10, 0x5a, 6);
				memcpy(map[i], sig, 16); memcpy((uint8_t *)map[i] + len[i] - 16, sig, 16);
				for (unsigned long o = 0; o + len[i] <= cma_len; o += 4096)
					if (!memcmp(cma + o, sig, 16) && !memcmp(cma + o + len[i] - 16, sig, 16)) { hits++; at = o; }
				memset(map[i], FILL, 16); memset((uint8_t *)map[i] + len[i] - 16, FILL, 16);
				if (hits == 1) { p0[i] = (cma_base + at) >> 12; p1[i] = (cma_base + at + len[i] - 1) >> 12; }
				else printf("run %d: b%u not located in the /dev/mem view (%d hits)\n", run, i, hits);
			}
		}
		if (run == 1) printf("format %ux%u sizeimage %u bytesperline %u, %u buffers, %d queued, %d frame(s)\n",
			f.fmt.pix.width, f.fmt.pix.height, f.fmt.pix.sizeimage, f.fmt.pix.bytesperline, rb.count, nq, frames);
		printf("run %d placement (%u x %zu bytes, REQBUFS %ld ms):", run, rb.count, len[0], req_ms);
		for (unsigned i = 0; i < rb.count; i++) {
			printf(" b%u=pfn %llx-%llx", i, (unsigned long long)p0[i], (unsigned long long)p1[i]);
			if (i && p0[i] && p0[0]) printf("(%+lldk)", ((long long)p0[i] - (long long)p0[0]) * 4);
		}
		printf("\n");
		for (int i = 0; i < nq; i++) {
			struct v4l2_buffer b = { .type = type, .memory = V4L2_MEMORY_MMAP, .index = i };
			if (ioctl(fd, VIDIOC_QBUF, &b) < 0) { err = "QBUF"; e = errno; goto out; }
		}
		clock_gettime(CLOCK_MONOTONIC, &t0);
		if (ioctl(fd, VIDIOC_STREAMON, &type) < 0) { err = "STREAMON"; e = errno; goto out; }
		streaming = 1;
		for (int n = 0; n < frames; n++) {
			struct pollfd pf = { fd, POLLIN, 0 };
			struct v4l2_buffer b = { .type = type, .memory = V4L2_MEMORY_MMAP };
			if (poll(&pf, 1, tmo) <= 0) { err = "timeout waiting for a frame"; e = 0; break; }
			if (ioctl(fd, VIDIOC_DQBUF, &b) < 0) { err = "DQBUF"; e = errno; break; }
			if (!got) { clock_gettime(CLOCK_MONOTONIC, &t1); ms = (t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_nsec - t0.tv_nsec) / 1000000; }
			if (luma) {
				const uint8_t *p = map[b.index]; uint64_t sum = 0; unsigned hi = 0, lo = 0, n = 0;
				struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
				for (size_t i = 1; i < b.bytesused; i += 2 * 7, n++) { sum += p[i]; if (p[i] >= 235) hi++; if (p[i] <= 20) lo++; }
				printf("  frame %d seq %u t=%ld ms luma mean %.1f, >=235: %.1f%%, <=20: %.1f%%%s\n", got, b.sequence,
					(long)((t.tv_sec - t0.tv_sec) * 1000 + (t.tv_nsec - t0.tv_nsec) / 1000000), n ? (double)sum / n : 0,
					n ? 100.0 * hi / n : 0, n ? 100.0 * lo / n : 0, b.flags & V4L2_BUF_FLAG_ERROR ? " ERROR" : "");
			}
			got++; bytesused = b.bytesused; flags = b.flags; seq = b.sequence; didx = b.index;
			if (n + 1 < frames && nq > 1) ioctl(fd, VIDIOC_QBUF, &b);
		}
		usleep(100000);                                 /* let anything still in flight land before the stop */
out:
		if (streaming) ioctl(fd, VIDIOC_STREAMOFF, &type);
		if (err) printf("run %d: ERROR %s: %s\n", run, err, e ? strerror(e) : "-");

		/* scan the buffers that were never queued */
		size_t total = 0; int ndirty = 0; uint64_t hi = 0;
		struct scan sc[MAXB];
		for (unsigned i = nq; i < rb.count && map[i]; i++) {
			sc[i] = scan_buf(map[i], len[i]);
			total += sc[i].changed;
			if (sc[i].changed) { ndirty++; if (p0[i] && p0[0]) { uint64_t end = (p0[i] - p0[0]) * 4096ULL + sc[i].last + 1; if (p0[i] > p0[0] && end > hi) hi = end; } }
		}
		/* buffer 0: how much of it was written, and the line period of what is there */
		struct scan s0 = { 0, 0, 0 }; double a1 = -1, a2 = -1; unsigned ymin = 255, ymax = 0;
		size_t tail_canary = 0, tail_other = 0, tail_first = 0, tail_last = 0;
		if (map[0]) {
			size_t fl = f.fmt.pix.sizeimage < len[0] ? f.fmt.pix.sizeimage : len[0];
			const uint8_t *p = map[0];
			s0 = scan_buf(p, fl);
			a1 = sad(p, fl, 1280); a2 = sad(p, fl, 2560);
			/* the plane behind the frame (a kernel with larger buffers): 0xdeadbeef words are the driver's
			 * sentinel, anything else that is not our fill was written by the receiver */
			for (size_t i = fl; i + 4 <= len[0]; i += 4) {
				if (p[i] == FILL && p[i + 1] == FILL && p[i + 2] == FILL && p[i + 3] == FILL) continue;
				if (p[i] == 0xef && p[i + 1] == 0xbe && p[i + 2] == 0xad && p[i + 3] == 0xde) { tail_canary += 4; continue; }
				if (!tail_other) tail_first = i;
				tail_other += 4; tail_last = i + 3;
			}
			for (size_t i = 1; i < fl; i += 2) { uint8_t y = ((uint8_t *)map[0])[i]; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
		}
		printf("run %d: frames=%u idx=%d bytesused=%u flags=0x%x seq=%u first_frame_ms=%ld | b0 written=%zu/%u luma=%u..%u sad1280=%.2f sad2560=%.2f (%s) | unqueued dirty=%d bufs %zu bytes%s",
			run, got, didx, bytesused, flags, seq, ms, s0.changed, f.fmt.pix.sizeimage, ymin, ymax, a1, a2,
			ymax - ymin < 8 ? "flat: no stride information" : a1 < a2 * 0.7 ? "period 1280 = 640-wide lines" : a2 < a1 * 0.7 ? "period 2560 = 1280-wide lines" : "ambiguous",
			ndirty, total, ndirty ? " => OVERFLOW" : " => clean");
		if (hi) printf(" | written extent from b0 start >= %llu bytes", (unsigned long long)hi);
		if (len[0] > f.fmt.pix.sizeimage) {
			printf(" | b0 tail: sentinel %zu bytes, overrun %zu bytes", tail_canary, tail_other);
			if (tail_other) printf(" (0x%zx..0x%zx) => OVERRUN INSIDE THE PLANE", tail_first, tail_last);
		}
		printf("\n");
		for (unsigned i = nq; i < rb.count && map[i]; i++) {
			if (!sc[i].changed) continue;
			const uint8_t *p = map[i];
			size_t n = sc[i].last + 1 - sc[i].first; if (n > 64) n = 64;
			printf("   b%u: %zu bytes changed, offsets 0x%zx..0x%zx of 0x%zx; sad1280=%.2f sad2560=%.2f\n      ",
				i, sc[i].changed, sc[i].first, sc[i].last, len[i],
				sad(p + sc[i].first, sc[i].last + 1 - sc[i].first, 1280), sad(p + sc[i].first, sc[i].last + 1 - sc[i].first, 2560));
			hexdump(p + sc[i].first, n);
		}
		if (dump) for (unsigned i = 0; i < rb.count && map[i]; i++) {
			char fn[256]; int o;
			if (i >= (unsigned)nq && !sc[i].changed) continue;
			snprintf(fn, sizeof fn, "%s.b%u", dump, i);
			if ((o = open(fn, O_WRONLY | O_CREAT | O_TRUNC, 0644)) >= 0) { if (write(o, map[i], len[i]) != (ssize_t)len[i]) perror(fn); close(o); }
		}
		if (dump && cma && p0[0]) {
			char fn[256]; int o; unsigned long off = (unsigned long)(p0[0] << 12) - cma_base, n = cma_len - off;
			if (n > (4UL << 20)) n = 4UL << 20;
			snprintf(fn, sizeof fn, "%s.phys", dump);
			if ((o = open(fn, O_WRONLY | O_CREAT | O_TRUNC, 0644)) >= 0) { if (write(o, cma + off, n) != (ssize_t)n) perror(fn); close(o); }
			printf("run %d: physical memory %lx..%lx written to %s\n", run, cma_base + off, cma_base + off + n, fn);
		}
		if (ndirty) dirty_runs++; else if (!err) ok_runs++;
		for (unsigned i = 0; i < MAXB; i++) if (map[i]) munmap(map[i], len[i]);
		close(fd);
		if (err && e == EBUSY) { printf("device busy (someone else is streaming): stopping\n"); break; }
		if (stop_dirty && dirty_runs >= stop_dirty) { printf("stopping after %d dirty run(s)\n", dirty_runs); break; }
		if (run < runs) sleep(slp);
	}
	printf("summary: %d dirty, %d clean\n", dirty_runs, ok_runs);
	return 0;
}
