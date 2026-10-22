/* jetd — Recon Jet I/O agent (static, musl, zig cc).
 *
 * Owns the Kopin panel (fb0 + OMAPFB_UPDATE_WINDOW), renders text with an embedded
 * PSF2 font, reads buttons and the optical touchpad from evdev, and talks a trivial
 * line protocol to a host hub over TCP (reconnecting forever).
 *
 *   jetd <host[,host...]> <port> [boot-log-seconds, default 20]
 *   Dials the hosts in turn (2 s apart) while no hub is connected, and accepts inbound hubs on
 *   <port>: up to 4 clients at once (the on-device app, the host hub, debug sessions) all receive
 *   every event and binary payload and may all send commands.
 *
 * Modes (owned by jetd, so they work with the hub gone):
 *   remote   the hub draws the screen and receives every input event (default)
 *   log      kernel log (/dev/kmsg, live) or the previous boot's pstore record
 *   shell    a local shell on a pty rendered as a dumb terminal with scrollback
 *   setup    pad calibration, glance calibration, brightness, power (live PMIC readout)
 * Hold the FRONT button ~1 s to open the mode chooser (swipe up/down, front or
 * tap to pick, rear to cancel). Short presses and swipes belong to the mode.
 * The REAR button's long hold is the PMIC power path: never rely on it.
 *
 * host -> jet (one command per line):
 *   C                 clear the back buffer (black)
 *   T <row> <text>    draw text at text row <row> (0-based), left aligned
 *   A <row> <text>    draw text centred on row <row>
 *   X <x> <y> <text>  draw text at pixel position
 *   R <r> <g> <b>     set text colour (0-255 each); default white
 *   B <x> <y> <w> <h> <r> <g> <b>   filled rectangle
 *   F                 flush back buffer to the panel
 *   L <0-1023>        backlight
 *   P                 ping -> "p"
 *   M <mode>          switch mode (remote|log|shell|setup)
 *   I <text>          shell: write text to the pty (\n \t \\ escapes)
 *   S [w h [skip]]    camera snapshot: one UYVY frame from /dev/video0 (default 640x480, after
 *                     skipping 6 frames for exposure to settle; the media pipeline must already
 *                     be configured for that size), sent back as
 *                     "f <w> <h> UYVY <len>\n" followed by <len> raw bytes, or "e <message>"
 *   (drawing commands are ignored unless the remote mode is showing; the hub
 *    gets a fresh "h" hello whenever remote comes back and should redraw)
 *   V [max_s]         start voice capture (see the voice section), v stops it
 *   W <len> + bytes   queue 48 kHz stereo S16 PCM for the speaker; w = end of clip
 *   Y                 stop playback immediately and drop queued audio (barge-in) -> "w flushed"
 *   K <0|1>           raw keys: the client owns the UI: jetd stays in remote mode, forwards every
 *                     key down/up as it happens and its chooser/setup/log screens are off until
 *                     the last client disconnects (then the recovery chooser returns)
 *   E <0|1>           external surface: the client writes /dev/fb0 itself (reply "E w h bpp
 *                     line_length"); jetd draws nothing in remote mode, F pushes to the panel
 *   F [x y w h]       flush (whole screen, or just a rectangle in external-surface mode)
 *   Z x y w h [fps]   live camera scaled into that rectangle (default 10 fps); z stops it;
 *                     reply "Z srcw srch"; S during a viewfinder returns the next streamed frame
 *   J [n]             resend the last n kernel-log lines (default: the whole ring), then "J n"
 *   U                 re-read the calibration files (glance, view thresholds) -> "U on off deg still"
 *   Q                 power snapshot -> "q vbat vsys vbus mA ctrl1 stat1 linsts cinlimit vichrg udc maxpower"
 * jet -> host:
 *   h <w> <h> <cols> <rows>     hello (also sent when remote mode is re-entered)
 *   k <code> <value>            key event (evdev code, 1=down 0=up)
 *   r <dx> <dy>                 touchpad motion (summed per gesture by the driver)
 *   m <mode>                    mode changed
 *   j <text>                    kernel log line (last 60 on connect, then live)
 *   p                           pong
 *   g <worn> <raw>              glance sensor state change
 *   n <degrees>                 head turned that much and then held still (new view)
 *   a <len> + bytes             16 kHz mono S16 capture chunk; A <end|max|stop|error> ends it
 *   w <done|timeout|error|idle> playback finished
 */
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <math.h>
#define _GNU_SOURCE
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/i2c.h>
#include <linux/i2c-dev.h>
#include <linux/input.h>
#include <linux/videodev2.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "font_psf.h"   /* font_main[] (10x20) and font_small[] (6x12), PSF1 or PSF2 */

struct omapfb_update_window { uint32_t x, y, width, height, format, out_x, out_y, out_width, out_height, reserved[8]; };
#define OMAPFB_UPDATE_WINDOW _IOW('O', 54, struct omapfb_update_window)

#define BTN_FRONT_CODE 86    /* KEY_102ND: front pod button */
#define BTN_REAR_CODE  107   /* KEY_END: rear pod button (PMIC PWRON) */
#define HOLD_MS   1000

static int64_t now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000LL + t.tv_nsec / 1000000; }

/* ---- framebuffer ------------------------------------------------------------ */
static int fbfd = -1;
static struct fb_var_screeninfo vinfo;
static struct fb_fix_screeninfo finfo;
static uint8_t *fbmem;
static uint32_t *back;        /* back buffer, W*H, 0xRRGGBB */
static unsigned W, H;

static int fb_open(void) {
    fbfd = open("/dev/graphics/fb0", O_RDWR);
    if (fbfd < 0) fbfd = open("/dev/fb0", O_RDWR);
    if (fbfd < 0) { perror("fb0"); return -1; }
    ioctl(fbfd, FBIOGET_VSCREENINFO, &vinfo);
    ioctl(fbfd, FBIOGET_FSCREENINFO, &finfo);
    W = vinfo.xres; H = vinfo.yres;
    fbmem = mmap(0, finfo.smem_len, PROT_READ | PROT_WRITE, MAP_SHARED, fbfd, 0);
    if (fbmem == MAP_FAILED) { perror("mmap"); return -1; }
    back = calloc(W * H, 4);
    return 0;
}

static inline uint32_t px(unsigned r, unsigned g, unsigned b) { return (r << 16) | (g << 8) | b; }
static inline uint32_t fbpack(uint32_t c) {
    unsigned r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    return (r << vinfo.red.offset) | (g << vinfo.green.offset) | (b << vinfo.blue.offset);
}

static void fb_flush(void) {
    for (unsigned y = 0; y < H; y++) {
        const uint32_t *src = back + y * W;
        if (vinfo.bits_per_pixel == 16) {
            uint16_t *dst = (uint16_t *)(fbmem + y * finfo.line_length);
            for (unsigned x = 0; x < W; x++) {
                uint32_t c = src[x];
                dst[x] = (uint16_t)(((c >> 8) & 0xf800) | ((c >> 5) & 0x07e0) | ((c >> 3) & 0x001f));
            }
        } else {
            uint32_t *dst = (uint32_t *)(fbmem + y * finfo.line_length);
            for (unsigned x = 0; x < W; x++) dst[x] = fbpack(src[x]);
        }
    }
    struct omapfb_update_window uw = { 0, 0, W, H, 0, 0, 0, W, H, {0} };
    ioctl(fbfd, OMAPFB_UPDATE_WINDOW, &uw);
}
/* External surface: a client owns the framebuffer pixels (writes /dev/fb0 itself) and asks jetd
 * only to push rectangles to the panel. jetd then draws nothing in remote mode except the live
 * viewfinder rectangle (Z). */
static void fb_update(int x, int y, int w, int h) {
    if (x < 0) { w += x; x = 0; } if (y < 0) { h += y; y = 0; }
    if (x + w > (int)W) w = W - x; if (y + h > (int)H) h = H - y;
    if (w <= 0 || h <= 0) return;
    struct omapfb_update_window uw = { x, y, w, h, 0, 0, 0, w, h, {0} };
    ioctl(fbfd, OMAPFB_UPDATE_WINDOW, &uw);
}

/* ---- PSF fonts (two sizes, front button toggles in log/shell) ------------------- */
struct font { const uint8_t *glyphs; unsigned gw, gh, gbytes, nglyph; };
static struct font fonts[2]; static int fsel = 1;   /* 0 small, 1 normal */
static int log_font = 0;                             /* font used by log/shell (front toggles); remote/setup use the normal one */
static const uint8_t *glyphs; static unsigned gw, gh, gbytes, nglyph;
static const unsigned scale = 1;
static uint32_t fg;

static int font_parse(struct font *f, const unsigned char *d) {
    const uint32_t *h = (const uint32_t *)d;
    if (h[0] == 0x864ab572) { f->nglyph = h[4]; f->gbytes = h[5]; f->gh = h[6]; f->gw = h[7]; f->glyphs = d + h[2]; return 0; }
    if (d[0] == 0x36 && d[1] == 0x04) { f->nglyph = (d[2] & 1) ? 512 : 256; f->gbytes = f->gh = d[3]; f->gw = 8; f->glyphs = d + 4; return 0; }
    fprintf(stderr, "unknown font format\n"); return -1;
}
static void font_select(int i) { fsel = i; glyphs = fonts[i].glyphs; gw = fonts[i].gw; gh = fonts[i].gh; gbytes = fonts[i].gbytes; nglyph = fonts[i].nglyph; }
static int font_init(void) {
    if (font_parse(&fonts[0], font_small) || font_parse(&fonts[1], font_main)) return -1;
    font_select(1);
    return 0;
}

static unsigned cols(void) { return W / (gw * scale); }
static unsigned rows(void) { return H / (gh * scale); }

static void draw_glyph(int x0, int y0, unsigned c) {
    if (c >= nglyph) c = '?';
    const uint8_t *g = glyphs + c * gbytes;
    unsigned rowbytes = (gw + 7) / 8;
    for (unsigned gy = 0; gy < gh; gy++)
        for (unsigned gx = 0; gx < gw; gx++)
            if (g[gy * rowbytes + gx / 8] & (0x80 >> (gx % 8)))
                for (unsigned sy = 0; sy < scale; sy++)
                    for (unsigned sx = 0; sx < scale; sx++) {
                        int x = x0 + gx * scale + sx, y = y0 + gy * scale + sy;
                        if (x >= 0 && y >= 0 && (unsigned)x < W && (unsigned)y < H) back[y * W + x] = fg;
                    }
}

static int text_width(const char *s) { return strlen(s) * gw * scale; }
static void draw_text(int x, int y, const char *s) { for (; *s; s++, x += gw * scale) draw_glyph(x, y, (unsigned char)*s); }
static void draw_row(unsigned row, const char *s) { draw_text(0, row * gh * scale, s); }
static void draw_row_centred(unsigned row, const char *s) { draw_text(((int)W - text_width(s)) / 2, row * gh * scale, s); }

static void fill_rect(int x, int y, int w, int h, uint32_t c) {
    for (int yy = y; yy < y + h; yy++) for (int xx = x; xx < x + w; xx++)
        if (xx >= 0 && yy >= 0 && (unsigned)xx < W && (unsigned)yy < H) back[yy * W + xx] = c;
}
static void clear_screen(void) { memset(back, 0, W * H * 4); }

static void set_backlight(int v) {
    FILE *f = fopen("/sys/class/backlight/kopin-a230/brightness", "w");
    if (!f) f = fopen("/sys/class/leds/lcd-backlight/brightness", "w");
    if (f) { fprintf(f, "%d\n", v); fclose(f); }
}
/* persisted backlight level (0..1023, panel default 408): /android-data|/mnt/data/mainline/backlight */
static int backlight_level = 408, backlight_saved = 408;
static const char *backlight_paths[] = { "/android-data/mainline/backlight", "/mnt/data/mainline/backlight" };
static void backlight_load(void) {
    for (int i = 0; i < 2; i++) { FILE *f = fopen(backlight_paths[i], "r"); if (!f) continue; int v; if (fscanf(f, "%d", &v) == 1 && v >= 16 && v <= 1023) backlight_level = backlight_saved = v; fclose(f); break; }
    FILE *f = fopen("/sys/class/backlight/kopin-a230/brightness", "r"); if (f) { int v; if (backlight_saved == 408 && fscanf(f, "%d", &v) == 1) backlight_level = backlight_saved = v; fclose(f); }
    set_backlight(backlight_level);
}
static void backlight_save(void) {
    for (int i = 0; i < 2; i++) { FILE *f = fopen(backlight_paths[i], "w"); if (f) { fprintf(f, "%d\n", backlight_level); fclose(f); break; } }
    backlight_saved = backlight_level;
}

/* ---- input ------------------------------------------------------------------- */
#define MAXIN 8
static int infd[MAXIN]; static int nin;

static void input_open(void) {
    DIR *d = opendir("/dev/input"); struct dirent *e;
    if (!d) return;
    while ((e = readdir(d)) && nin < MAXIN) {
        if (strncmp(e->d_name, "event", 5)) continue;
        char p[64]; snprintf(p, sizeof p, "/dev/input/%s", e->d_name);
        int fd = open(p, O_RDONLY | O_NONBLOCK);
        if (fd >= 0) infd[nin++] = fd;
    }
    closedir(d);
}

/* ---- mode state ------------------------------------------------------------------ */
enum { M_REMOTE, M_LOG, M_CONSOLE, M_SETUP, M_COUNT };
static const char *mode_names[M_COUNT] = { "remote", "log", "shell", "setup" };
static int mode = M_LOG;     /* boot in log mode: if boot stalls the log is what stays on the glass */
static int auto_remote = 1;  /* switch to remote once the hub is up, the backlog replay is done and boot_hold_s passed */
static int boot_hold_s = 20; /* keep the boot log on the glass at least this long after jetd starts */
static int64_t start_ms;
static int reveal = -1;      /* boot log replay: lines shown so far (-1 = replay finished / off) */
static int chooser;          /* chooser overlay open */
static int chooser_sel;
static int dirty;            /* local render needed */

/* ---- hub link ------------------------------------------------------------------ */
static int raw_keys, ext_surface;   /* set by K / E: a client owns keys / pixels (defined here for hub_drop) */
/* Hubs: up to MAXHUB connected clients (the on-device app, the host hub, debug sessions) all
 * receive every event (including binary payloads) and may all send commands. */
#define MAXHUB 4
struct hub { int fd; char inbuf[1024]; size_t inlen; size_t bin_need; int64_t stuck_since; };
static struct hub hubs[MAXHUB]; static int nhubs;
static struct hub *cur_hub;      /* the hub whose line is being handled (W payload accounting) */
static int only_fd = -1;         /* when >= 0, sendf/send_all go to this hub only (hello + log replay) */
static void hub_drop(int i) { close(hubs[i].fd); hubs[i] = hubs[--nhubs]; if (!nhubs) { raw_keys = 0; ext_surface = 0; dirty = 1; } }   /* no client: recovery UI returns */
static int hub_add(int fd) {
    if (nhubs == MAXHUB) hub_drop(0);
    struct hub *h = &hubs[nhubs++]; memset(h, 0, sizeof *h); h->fd = fd; return nhubs - 1;
}
static char hub_hosts[256]; static const char *hub_port;
static int hub_host_idx;
static int64_t next_connect;
static int listen_fd = -1;
static void log_on_connect(void);
static void set_mode(int m);

/* Hub writes never block the UI loop: a line that does not fit the socket buffer is dropped
 * (log mirroring is best effort), and a link that stays full for 5 s is closed so the dialer
 * reconnects. Blocking here was what froze the log/buttons whenever the USB link went bad. */
static void sendf(const char *fmt, ...) {
    if (!nhubs) return;
    char b[512]; va_list ap; va_start(ap, fmt); int n = vsnprintf(b, sizeof b, fmt, ap); va_end(ap);
    if (n <= 0) return;
    for (int i = 0; i < nhubs; i++) {
        struct hub *h = &hubs[i];
        if (only_fd >= 0 && h->fd != only_fd) continue;
        ssize_t w = send(h->fd, b, n, MSG_DONTWAIT | MSG_NOSIGNAL);
        if (w == n) { h->stuck_since = 0; continue; }
        if (w < 0 && errno != EAGAIN) { hub_drop(i--); continue; }
        if (!h->stuck_since) h->stuck_since = now_ms();                 /* partial or EAGAIN: dropped */
        else if (now_ms() - h->stuck_since > 5000) hub_drop(i--);
    }
}

static void send_hello(void) { sendf("h %u %u %u %u\n", W, H, cols(), rows()); }

static int connecting_fd = -1; static int64_t connecting_deadline;
static void hub_connected(int fd) {
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK);   /* reads stay blocking-on-POLLIN as before */
    int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof one);
    hub_add(fd);
    only_fd = fd; send_hello(); log_on_connect(); only_fd = -1;
}
static void try_connect(void) {
    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_STREAM }, *res;
    char hosts[256], *save = NULL, *host = NULL; int i = 0;
    next_connect = now_ms() + 2000;
    snprintf(hosts, sizeof hosts, "%s", hub_hosts);
    for (char *h = strtok_r(hosts, ",", &save); h; h = strtok_r(NULL, ",", &save), i++) if (i == hub_host_idx) host = h;
    if (!host) { hub_host_idx = 0; return; }
    hub_host_idx++;
    if (getaddrinfo(host, hub_port, &hints, &res)) return;
    /* non-blocking connect: a blocking one sat in ARP/SYN timeouts for seconds whenever the
     * USB peer was gone, freezing the UI loop (the log viewer must never depend on the hub) */
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    int r = connect(fd, res->ai_addr, res->ai_addrlen);
    freeaddrinfo(res);
    if (r == 0) { hub_connected(fd); return; }
    if (errno != EINPROGRESS) { close(fd); return; }
    connecting_fd = fd; connecting_deadline = now_ms() + 2000;
}
static void connect_poll(short revents) {          /* called from the main loop for connecting_fd */
    int err = 0; socklen_t el = sizeof err;
    if (revents) {
        if (getsockopt(connecting_fd, SOL_SOCKET, SO_ERROR, &err, &el) == 0 && err == 0) { int fd = connecting_fd; connecting_fd = -1; hub_connected(fd); return; }
        close(connecting_fd); connecting_fd = -1; return;
    }
    if (now_ms() > connecting_deadline) { close(connecting_fd); connecting_fd = -1; }
}

static void listen_open(void) {
    listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1; setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(atoi(hub_port)), .sin_addr.s_addr = INADDR_ANY };
    if (bind(listen_fd, (struct sockaddr *)&a, sizeof a) < 0 || listen(listen_fd, 1) < 0) { close(listen_fd); listen_fd = -1; }
}

static void accept_hub(void) {
    int fd = accept(listen_fd, NULL, NULL);
    if (fd < 0) return;
    int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    hub_add(fd);
    only_fd = fd; send_hello(); log_on_connect(); only_fd = -1;
}

/* ---- modes ---------------------------------------------------------------------- */

static void render(void);

/* ---- log: /dev/kmsg live + previous boot's pstore record -------------------------- */
#define LCOLS 84
#define LROWS 600
static char klog[LROWS][LCOLS + 1]; static int klog_n, klog_head;   /* ring of wrapped lines */
static int kmsg_fd = -1; static int log_scroll, log_prev, hoff;   /* hoff: horizontal column offset (log + shell) */
static char *pstore_text; static int pstore_lines;
static char (*pstore_buf)[LCOLS + 1];

static void klog_add(const char *line) {
    int i = (klog_head + klog_n) % LROWS;
    if (klog_n == LROWS) { i = klog_head; klog_head = (klog_head + 1) % LROWS; } else klog_n++;
    snprintf(klog[i], LCOLS + 1, "%s", line);
    if (nhubs) sendf("j %s\n", line);
    if (mode == M_LOG) dirty = 1;
}

static void kmsg_open(void) {
    kmsg_fd = open("/dev/kmsg", O_RDONLY | O_NONBLOCK);
}

/* /dev/kmsg record: "prio,seq,usec,flags[,...];text\n" with continuation lines starting with ' ' */
static void kmsg_read(void) {
    char buf[1024]; ssize_t r;
    while ((r = read(kmsg_fd, buf, sizeof buf - 1)) > 0) {
        buf[r] = 0;
        char *nl = strchr(buf, '\n'); if (nl) *nl = 0;
        char *semi = strchr(buf, ';'); if (!semi) continue;
        unsigned long long usec = 0; char *c = strchr(buf, ','); if (c) { c = strchr(c + 1, ','); if (c) usec = strtoull(c + 1, NULL, 10); }
        char line[LCOLS + 1]; snprintf(line, sizeof line, "%4llu.%03llu %s", usec / 1000000, (usec / 1000) % 1000, semi + 1);
        klog_add(line);
    }
}

static void pstore_load(void) {
    const char *dirs[] = { "/android-data/mainline/pstore", "/mnt/data/mainline/pstore" };
    for (int d = 0; d < 2 && !pstore_text; d++) {
        char path[128]; const char *names[] = { "console-ramoops-0", "dmesg-ramoops-0" };
        for (int n = 0; n < 2 && !pstore_text; n++) {
            snprintf(path, sizeof path, "%s/%s", dirs[d], names[n]);
            FILE *f = fopen(path, "r"); if (!f) continue;
            fseek(f, 0, SEEK_END); long len = ftell(f); if (len > 200000) { fseek(f, len - 200000, SEEK_SET); len = 200000; } else fseek(f, 0, SEEK_SET);
            pstore_text = malloc(len + 1); len = fread(pstore_text, 1, len, f); pstore_text[len] = 0; fclose(f);
        }
    }
    if (!pstore_text) return;
    pstore_buf = calloc(LROWS, sizeof *pstore_buf);
    char *save = NULL;
    for (char *l = strtok_r(pstore_text, "\n", &save); l; l = strtok_r(NULL, "\n", &save)) {
        snprintf(pstore_buf[pstore_lines % LROWS], LCOLS + 1, "%s", l); pstore_lines++;
    }
}

static void log_on_connect(void) {
    int from = klog_n > 60 ? klog_n - 60 : 0;
    for (int i = from; i < klog_n; i++) sendf("j %s\n", klog[(klog_head + i) % LROWS]);
}

static void render_log(void) {
    clear_screen();
    int nrows = rows(), total = log_prev ? (pstore_lines < LROWS ? pstore_lines : LROWS) : klog_n;
    if (!log_prev && reveal >= 0 && reveal < total) total = reveal;
    if (log_scroll > total - nrows + 1) log_scroll = total - nrows + 1; if (log_scroll < 0) log_scroll = 0;
    fg = px(200, 200, 200);
    for (int i = 0; i < nrows - 1; i++) {
        int idx = total - (nrows - 1) - log_scroll + i; if (idx < 0) continue;
        const char *l = log_prev ? pstore_buf[(pstore_lines - (pstore_lines < LROWS ? pstore_lines : LROWS) + idx) % LROWS] : klog[(klog_head + idx) % LROWS];
        if ((int)strlen(l) <= hoff) continue;
        char line[LCOLS + 1]; snprintf(line, sizeof line, "%.*s", (int)cols(), l + hoff); draw_row(i, line);
    }
    fg = px(255, 200, 0);
    char st[64]; snprintf(st, sizeof st, "%s %d%s%d%s%d rear:%s", log_prev ? "PREV" : "KLOG", total, log_scroll ? " ^" : " ", log_scroll, hoff ? " >" : " ", hoff, log_prev ? "live" : (pstore_lines ? "prev" : "-"));
    draw_row(nrows - 1, st);
}

/* ---- shell: a dumb terminal on a pty ------------------------------------------ */
#define TCOLS 42
#define TROWS 400
static char term[TROWS][TCOLS + 1];
static int term_row, term_col, term_total;   /* cursor row within ring, cursor col, lines ever written */
static int term_scroll;                       /* 0 = follow tail, n = n lines back */
static int term_esc;                          /* escape parser state */
static int pty_fd = -1; static pid_t pty_pid;

static void term_newline(void) {
    term_row = (term_row + 1) % TROWS; term_col = 0; term_total++;
    memset(term[term_row], 0, sizeof term[term_row]);
}

static void term_put(unsigned char c) {
    if (term_esc) {                     /* skip CSI/OSC sequences */
        if (term_esc == 1) { term_esc = (c == '[' || c == ']') ? (c == '[' ? 2 : 3) : 0; return; }
        if (term_esc == 2) { if (c >= 0x40 && c <= 0x7e) term_esc = 0; return; }
        if (term_esc == 3) { if (c == 7) term_esc = 0; return; }
    }
    switch (c) {
    case 27: term_esc = 1; return;
    case '\n': term_newline(); return;
    case '\r': term_col = 0; return;
    case '\b': if (term_col) term_col--; return;
    case '\t': term_col = (term_col + 8) & ~7; if (term_col >= TCOLS) term_newline(); return;
    case 7: return;
    default:
        if (c < 32 || c > 126) return;
        if (term_col >= TCOLS) term_newline();
        term[term_row][term_col++] = c;
    }
}

static void console_spawn(void) {
    if (pty_fd >= 0) return;
    struct winsize ws = { .ws_row = rows(), .ws_col = TCOLS };
    pty_pid = forkpty(&pty_fd, NULL, NULL, &ws);
    if (pty_pid < 0 && errno == ENOENT) {   /* no devpts in this root: mount it and retry once */
        mount("devpts", "/dev/pts", "devpts", 0, "mode=620,ptmxmode=666");
        pty_pid = forkpty(&pty_fd, NULL, NULL, &ws);
    }
    if (pty_pid == 0) {
        setenv("TERM", "dumb", 1); setenv("PS1", "jet$ ", 1); setenv("HOME", "/root", 0);
        chdir("/");
        execl("/bin/sh", "sh", "-i", (char *)0);
        _exit(127);
    }
    if (pty_pid < 0) { pty_fd = -1; return; }
    fcntl(pty_fd, F_SETFL, O_NONBLOCK);
    memset(term, 0, sizeof term); term_row = term_col = term_total = term_scroll = 0;
}

static void console_write(const char *text) {
    if (pty_fd < 0) console_spawn();
    if (pty_fd < 0) return;
    char out[512]; int n = 0;
    for (; *text && n < (int)sizeof out - 1; text++) {
        if (*text == '\\' && text[1]) { text++; out[n++] = *text == 'n' ? '\n' : *text == 't' ? '\t' : *text == 'r' ? '\r' : *text; }
        else out[n++] = *text;
    }
    write(pty_fd, out, n);
}

static void console_read(void) {
    char buf[1024]; ssize_t r;
    while ((r = read(pty_fd, buf, sizeof buf)) > 0) for (ssize_t i = 0; i < r; i++) term_put((unsigned char)buf[i]);
    if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) {    /* shell exited */
        close(pty_fd); pty_fd = -1; waitpid(pty_pid, NULL, WNOHANG);
        term_put('\n'); for (const char *s = "[shell exited]"; *s; s++) term_put(*s);
    }
    dirty = 1;
}

static void render_console(void) {
    clear_screen(); fg = px(220, 220, 220);
    if (pty_fd < 0 && term_total == 0) { fg = px(255, 80, 80); draw_row_centred(3, "no shell: pty unavailable"); draw_row_centred(4, "(is devpts mounted?)"); return; }
    int nrows = rows(), avail = term_total + 1; if (avail > TROWS) avail = TROWS;
    if (term_scroll > avail - nrows) term_scroll = avail - nrows; if (term_scroll < 0) term_scroll = 0;
    int last = term_row - term_scroll;                 /* ring index of the bottom row shown */
    for (int i = nrows - 1; i >= 0; i--, last--) {
        if (nrows - 1 - i >= avail) break;
        const char *l = term[(last % TROWS + TROWS) % TROWS];
        if ((int)strlen(l) <= hoff) continue;
        char line[TCOLS + 1]; snprintf(line, sizeof line, "%.*s", (int)cols(), l + hoff); draw_row(i, line);
    }
    if (term_scroll) { fg = px(255, 200, 0); char s[32]; snprintf(s, sizeof s, "^%d", term_scroll); draw_text(W - text_width(s) - 2, 0, s); }
}

enum { S_MENU, S_CAL, S_CAL_DONE, S_INFO, S_GLANCE, S_GLANCE_DONE, S_BRIGHT, S_POWER };   /* setup screens (used by glance_poll too) */
static int setup_state, setup_sel;

/* ---- glance sensor (APDS9900 via tsl2772 IIO, name tmd2771): polled 4 Hz, hysteresis ------
 * raw 0..1023: ~800-1000 worn, ~500-750 off the head (noisy). Event "g <worn> <raw>" on change;
 * thresholds "on off" overridable in /mnt/data/mainline/glance (e.g. "820 720"). */
static char glance_path[128];
static int glance_on_thr = 820, glance_off_thr = 720, glance_worn = -1, glance_raw = -1, glance_run = 0;
static int64_t glance_next;
static void glance_open(void) {
    for (int i = 0; i < 16; i++) {
        char p[128], name[32] = ""; FILE *f;
        snprintf(p, sizeof p, "/sys/bus/iio/devices/iio:device%d/name", i);
        if (!(f = fopen(p, "r"))) continue;
        if (fgets(name, sizeof name, f) && !strncmp(name, "tmd2771", 7)) { fclose(f); snprintf(glance_path, sizeof glance_path, "/sys/bus/iio/devices/iio:device%d/in_proximity0_raw", i); break; }
        fclose(f);
    }
    const char *paths[] = { "/android-data/mainline/glance", "/mnt/data/mainline/glance" };   /* chroot vs initramfs view */
    for (int i = 0; i < 2; i++) { FILE *f = fopen(paths[i], "r"); if (!f) continue; if (fscanf(f, "%d %d", &glance_on_thr, &glance_off_thr) != 2) { glance_on_thr = 820; glance_off_thr = 720; } fclose(f); break; }
    if (glance_path[0]) fprintf(stderr, "jetd: glance sensor %s (on>=%d off<=%d)\n", glance_path, glance_on_thr, glance_off_thr);
}
static int glance_read_avg(int n) {          /* n quick reads, ~20 ms apart; -1 if no sensor */
    if (!glance_path[0]) return -1;
    int sum = 0, cnt = 0;
    for (int i = 0; i < n; i++) {
        FILE *f = fopen(glance_path, "r"); int raw;
        if (f) { if (fscanf(f, "%d", &raw) == 1) { sum += raw; cnt++; } fclose(f); }
        usleep(20000);
    }
    return cnt ? sum / cnt : -1;
}
static void glance_save(void) {
    const char *paths[] = { "/android-data/mainline/glance", "/mnt/data/mainline/glance" };
    for (int i = 0; i < 2; i++) { FILE *f = fopen(paths[i], "w"); if (f) { fprintf(f, "%d %d\n", glance_on_thr, glance_off_thr); fclose(f); break; } }
}
static void glance_poll(void) {
    if (!glance_path[0] || now_ms() < glance_next) return;
    glance_next = now_ms() + 250;
    FILE *f = fopen(glance_path, "r"); int raw = -1;
    if (!f) return;
    if (fscanf(f, "%d", &raw) != 1) raw = -1;
    fclose(f);
    if (raw < 0) return;
    glance_raw = raw;
    if (mode == M_SETUP && setup_state == S_GLANCE) dirty = 1;   /* live reading on the calibration screen */
    int want;                                                               /* -1: in the dead band */
    if (glance_on_thr >= glance_off_thr) want = raw >= glance_on_thr ? 1 : raw <= glance_off_thr ? 0 : -1;
    else                                 want = raw <= glance_on_thr ? 1 : raw >= glance_off_thr ? 0 : -1;   /* inverted sensor */
    if (want < 0 || want == glance_worn) { glance_run = 0; return; }
    if (++glance_run < 4) return;                                          /* 1 s of agreement */
    glance_run = 0; glance_worn = want;
    sendf("g %d %d\n", glance_worn, glance_raw);
}

/* ---- power (TWL6032 PMIC): battery/charger/USB state for the setup "Power" screen ---------
 * GPADC via IIO (twl6030_gpadc: ch18 VBAT, ch7 VSYS, ch10 VBUS, mV), fuel gauge and charger
 * registers via /dev/i2c-0 (PMIC "charger/FG" address 0x49): FG_REG_10/11 current sample
 * (14-bit signed, mA = raw*3100/8192, negative = discharging; FG enabled once via TOGGLE1),
 * CONTROLLER_CTRL1 0xE1 (EN_CHARGER bit4, EN_LINCH bit5), CONTROLLER_STAT1 0xE3 (VBUS_DET bit2),
 * LINEAR_CHRG_STS 0xDE, CINLIMIT 0xEE (input limit, 50 + 50*code mA for codes < 0x10),
 * VICHRG 0xED (100 + 100*code mA), VOREG 0xEC (3.5 V + 20 mV*code). */
static char gpadc_dir[96]; static int pm_i2c = -1;
struct power_state { int vbat, vsys, vbus, ma, ctrl1, stat1, lin, cin, vichrg, voreg, usb_online; char udc[24]; int maxpower; int temp_mc; int ok; };
static struct power_state pstate; static int64_t power_next;
static int pm_rd(int reg) {
    if (pm_i2c < 0) return -1;
    if (ioctl(pm_i2c, I2C_SLAVE_FORCE, 0x49) < 0) return -1;
    union i2c_smbus_data d; struct i2c_smbus_ioctl_data a = { .read_write = I2C_SMBUS_READ, .command = reg, .size = I2C_SMBUS_BYTE_DATA, .data = &d };
    return ioctl(pm_i2c, I2C_SMBUS, &a) < 0 ? -1 : d.byte;
}
static int pm_wr(int reg, int val) {
    if (pm_i2c < 0 || ioctl(pm_i2c, I2C_SLAVE_FORCE, 0x49) < 0) return -1;
    union i2c_smbus_data d = { .byte = val }; struct i2c_smbus_ioctl_data a = { .read_write = I2C_SMBUS_WRITE, .command = reg, .size = I2C_SMBUS_BYTE_DATA, .data = &d };
    return ioctl(pm_i2c, I2C_SMBUS, &a);
}
static int read_int(const char *path, int dflt) { FILE *f = fopen(path, "r"); if (!f) return dflt; int v = dflt; if (fscanf(f, "%d", &v) != 1) v = dflt; fclose(f); return v; }
static void power_open(void) {
    for (int i = 0; i < 16; i++) {
        char p[128], name[32] = ""; FILE *f;
        snprintf(p, sizeof p, "/sys/bus/iio/devices/iio:device%d/name", i);
        if (!(f = fopen(p, "r"))) continue;
        int hit = fgets(name, sizeof name, f) && strstr(name, "gpadc"); fclose(f);
        if (hit) { snprintf(gpadc_dir, sizeof gpadc_dir, "/sys/bus/iio/devices/iio:device%d", i); break; }
    }
    pm_i2c = open("/dev/i2c-0", O_RDWR);
    if (pm_i2c >= 0) pm_wr(0x90, 0x20);   /* TOGGLE1: FGS, fuel gauge on */
}
static void power_read(void) {
    struct power_state *q = &pstate; char p[160];
    q->ok = gpadc_dir[0] != 0;
    snprintf(p, sizeof p, "%s/in_voltage18_input", gpadc_dir); q->vbat = read_int(p, -1);
    snprintf(p, sizeof p, "%s/in_voltage7_input", gpadc_dir);  q->vsys = read_int(p, -1);
    snprintf(p, sizeof p, "%s/in_voltage10_input", gpadc_dir); q->vbus = read_int(p, -1);
    int lo = pm_rd(0xca), hi = pm_rd(0xcb), ol = pm_rd(0xc8), oh = pm_rd(0xc9);
    if (lo >= 0 && hi >= 0) { int raw = ((hi << 8) | lo) & 0x3fff; if (raw >= 8192) raw -= 16384; int off = ((oh << 8) | ol) & 0x3ff; if (off >= 512) off -= 1024; q->ma = (raw - off) * 3100 / 8192; } else q->ma = -9999;
    q->ctrl1 = pm_rd(0xe1); q->stat1 = pm_rd(0xe3); q->lin = pm_rd(0xde); q->cin = pm_rd(0xee); q->vichrg = pm_rd(0xed); q->voreg = pm_rd(0xec);
    q->usb_online = read_int("/sys/class/power_supply/twl6030_usb/online", -1);
    q->maxpower = read_int("/sys/kernel/config/usb_gadget/g1/configs/c.1/MaxPower", -1);
    q->udc[0] = 0; { DIR *d = opendir("/sys/class/udc"); struct dirent *e; if (d) { while ((e = readdir(d))) if (e->d_name[0] != '.') { snprintf(p, sizeof p, "/sys/class/udc/%s/state", e->d_name); FILE *f = fopen(p, "r"); if (f) { if (fgets(q->udc, sizeof q->udc, f)) q->udc[strcspn(q->udc, "\n")] = 0; fclose(f); } break; } closedir(d); } }
    q->temp_mc = read_int("/sys/class/hwmon/hwmon0/temp1_input", -100000);
}
static void power_poll(void) {       /* 1 Hz refresh while the Power screen is up; also serves 'Q' */
    if (now_ms() < power_next) return;
    power_next = now_ms() + 1000;
    if (mode == M_SETUP && setup_state == S_POWER) { power_read(); dirty = 1; }
}

/* ---- setup -------------------------------------------------------------------- */
static int thr_x = 20, thr_y = 20;
static int gl_step, gl_cal[4], gl_ok;
static const char *gl_prompts[4] = { "look AT the display", "look FORWARD (away)", "look AT the display again", "look AWAY again" };
static const char *setup_items[] = { "Pad calibration", "Glance calibration", "Brightness", "Power", "WiFi via QR code", "Back to remote" };
#define SETUP_N 6
static const char *cal_dirs[4] = { "RIGHT", "LEFT", "DOWN", "UP" };
static int cal_step, cal_n, cal_sum[4][3];
static const char *info_text[4];

static void read_thresholds(void) {
    FILE *f = fopen("/sys/module/jet_ofm/parameters/thr_x", "r"); if (f) { fscanf(f, "%d", &thr_x); fclose(f); }
    f = fopen("/sys/module/jet_ofm/parameters/thr_y", "r"); if (f) { fscanf(f, "%d", &thr_y); fclose(f); }
}

static void write_thresholds(void) {
    FILE *f = fopen("/sys/module/jet_ofm/parameters/thr_x", "w"); if (f) { fprintf(f, "%d\n", thr_x); fclose(f); }
    f = fopen("/sys/module/jet_ofm/parameters/thr_y", "w"); if (f) { fprintf(f, "%d\n", thr_y); fclose(f); }
    const char *paths[] = { "/android-data/mainline/ofm-args", "/mnt/data/mainline/ofm-args" };
    for (int i = 0; i < 2; i++) { f = fopen(paths[i], "w"); if (f) { fprintf(f, "thr_x=%d thr_y=%d\n", thr_x, thr_y); fclose(f); break; } }
}

static int cmp_int(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }

static void cal_finish(void) {
    /* median magnitude per direction; thresholds at half the weakest axis median, clamped */
    int med[4];
    for (int d = 0; d < 4; d++) { int v[3] = { abs(cal_sum[d][0]), abs(cal_sum[d][1]), abs(cal_sum[d][2]) }; qsort(v, 3, sizeof v[0], cmp_int); med[d] = v[1]; }
    int mx = med[0] < med[1] ? med[0] : med[1], my = med[2] < med[3] ? med[2] : med[3];
    thr_x = mx / 2; thr_y = my / 2;
    if (thr_x < 8) thr_x = 8; if (thr_x > 60) thr_x = 60; if (thr_y < 8) thr_y = 8; if (thr_y > 60) thr_y = 60;
    write_thresholds();
    setup_state = S_CAL_DONE;
}

static void glance_cal_finish(void) {
    /* stock flow: at / away / at / away. Thresholds at 60 % and 40 % of the span above the away level. */
    /* Either polarity: on rg's pod "at" reads LOWER than "away" (610/644 vs 1023/720), so the
     * thresholds may come out inverted (on < off) and glance_poll compares accordingly. */
    int on = (gl_cal[0] + gl_cal[2]) / 2, off = (gl_cal[1] + gl_cal[3]) / 2, d = on - off;
    gl_ok = abs(d) >= 40;
    if (gl_ok) { glance_on_thr = off + d * 6 / 10; glance_off_thr = off + d * 4 / 10; glance_worn = -1; glance_save(); }
    setup_state = S_GLANCE_DONE;
}

static void setup_rel(int dx, int dy) {
    if (setup_state != S_CAL || abs(dx) + abs(dy) < 8) return;
    int axis_x = cal_step < 2;
    cal_sum[cal_step][cal_n++] = axis_x ? dx : dy;
    if (cal_n == 3) { cal_n = 0; if (++cal_step == 4) cal_finish(); }
    dirty = 1;
}

static void render_setup(void) {
    clear_screen();
    fg = px(255, 255, 0); draw_row_centred(0, "SETUP");
    if (setup_state == S_MENU) {
        read_thresholds();
        for (int i = 0; i < SETUP_N; i++) {
            char line[48]; snprintf(line, sizeof line, "%s", setup_items[i]);
            fg = i == setup_sel ? px(0, 255, 128) : px(200, 200, 200);
            draw_row(2 + i, i == setup_sel ? "> " : "  "); draw_text(2 * gw * scale, (2 + i) * gh * scale, line);
        }
        fg = px(120, 120, 120); draw_row(rows() - 1, "swipe: move  front: select  rear: back");
    } else if (setup_state == S_CAL) {
        char s[48]; fg = px(255, 255, 255);
        snprintf(s, sizeof s, "swipe %s  (%d of 3)", cal_dirs[cal_step], cal_n + 1); draw_row_centred(3, s);
        fg = px(160, 160, 160);
        for (int i = 0; i < cal_n; i++) { snprintf(s, sizeof s, "got %d", cal_sum[cal_step][i]); draw_row_centred(5 + i, s); }
        draw_row(rows() - 1, "rear: abort");
    } else if (setup_state == S_POWER) {
        struct power_state *q = &pstate; char t[64];
        fg = px(255, 255, 255);
        snprintf(t, sizeof t, "battery %4d mV  %+5d mA  %s", q->vbat, q->ma, q->ma > 15 ? "charging" : q->ma < -15 ? "draining" : "idle"); draw_row(2, t);
        snprintf(t, sizeof t, "system  %4d mV  VBUS %4d mV%s", q->vsys, q->vbus, q->vbus > 4000 ? "" : "  (no USB power)"); draw_row(3, t);
        int en = q->ctrl1 >= 0 && (q->ctrl1 & 0x10), lin = q->ctrl1 >= 0 && (q->ctrl1 & 0x20);
        snprintf(t, sizeof t, "charger %s%s  lin-sts 0x%02x  stat1 0x%02x", en ? "on" : "OFF", lin ? "+cell" : " (no cell path)", q->lin & 0xff, q->stat1 & 0xff); draw_row(4, t);
        int cin_ma = q->cin >= 0 && q->cin < 0x10 ? 50 + 50 * q->cin : -1;
        if (cin_ma > 0) snprintf(t, sizeof t, "limits  in %d mA  charge %d mA  %d.%02d V", cin_ma, q->vichrg >= 0 ? 100 + 100 * (q->vichrg & 0xf) : -1, q->voreg >= 0 ? (3500 + 20 * (q->voreg & 0x3f)) / 1000 : 0, q->voreg >= 0 ? ((3500 + 20 * (q->voreg & 0x3f)) % 1000) / 10 : 0);
        else snprintf(t, sizeof t, "limits  in code 0x%02x (unlimited)  charge %d mA", q->cin & 0xff, q->vichrg >= 0 ? 100 + 100 * (q->vichrg & 0xf) : -1);
        draw_row(5, t);
        snprintf(t, sizeof t, "usb     %s  asks %d mA  online %d", q->udc[0] ? q->udc : "no udc", q->maxpower, q->usb_online); draw_row(6, t);
        if (q->temp_mc > -100000) { snprintf(t, sizeof t, "board   %d.%d C", q->temp_mc / 1000, (q->temp_mc % 1000) / 100); draw_row(7, t); }
        fg = px(120, 120, 120); draw_row(rows() - 1, "live 1 Hz   rear: back");
    } else if (setup_state == S_BRIGHT) {
        char s[48]; fg = px(255, 255, 255);
        snprintf(s, sizeof s, "backlight %d / 1023", backlight_level); draw_row_centred(3, s);
        int w = (W - 40) * backlight_level / 1023; fill_rect(20, 5 * gh * scale, w, gh * scale - 2, px(0, 255, 128));
        fg = px(160, 160, 160); snprintf(s, sizeof s, "saved: %d", backlight_saved); draw_row_centred(7, s);
        fg = px(120, 120, 120); draw_row(rows() - 1, "swipe: adjust  front: save  rear: revert");
    } else if (setup_state == S_GLANCE) {
        char s[48]; fg = px(255, 255, 255);
        snprintf(s, sizeof s, "%d of 4: %s", gl_step + 1, gl_prompts[gl_step]); draw_row_centred(3, s);
        fg = px(0, 255, 128); draw_row_centred(4, "then press FRONT");
        fg = px(160, 160, 160); snprintf(s, sizeof s, "sensor now: %d", glance_raw); draw_row_centred(6, s);
        for (int i = 0; i < gl_step; i++) { snprintf(s, sizeof s, "step %d: %d", i + 1, gl_cal[i]); draw_row_centred(7 + i, s); }
        draw_row(rows() - 1, "rear: abort");
    } else if (setup_state == S_GLANCE_DONE) {
        char s[48];
        if (gl_ok) {
            fg = px(0, 255, 128); draw_row_centred(3, "glance calibrated");
            fg = px(255, 255, 255); snprintf(s, sizeof s, "at %d/%d  away %d/%d", gl_cal[0], gl_cal[2], gl_cal[1], gl_cal[3]); draw_row_centred(5, s);
            snprintf(s, sizeof s, glance_on_thr >= glance_off_thr ? "worn >= %d   off <= %d" : "worn <= %d   off >= %d", glance_on_thr, glance_off_thr); draw_row_centred(6, s);
            fg = px(160, 160, 160); draw_row_centred(7, "saved for next boot");
        } else {
            fg = px(255, 80, 80); draw_row_centred(3, "too little contrast");
            fg = px(255, 255, 255); snprintf(s, sizeof s, "at %d/%d  away %d/%d", gl_cal[0], gl_cal[2], gl_cal[1], gl_cal[3]); draw_row_centred(5, s);
            fg = px(160, 160, 160); draw_row_centred(6, "thresholds unchanged");
        }
        fg = px(120, 120, 120); draw_row(rows() - 1, "any button: menu");
    } else if (setup_state == S_CAL_DONE) {
        char s[48]; fg = px(0, 255, 128); draw_row_centred(3, "calibrated");
        fg = px(255, 255, 255); snprintf(s, sizeof s, "thresholds: x %d  y %d", thr_x, thr_y); draw_row_centred(5, s);
        fg = px(160, 160, 160); draw_row_centred(6, "saved for next boot");
        fg = px(120, 120, 120); draw_row(rows() - 1, "any button: menu");
    } else {
        fg = px(255, 255, 255);
        for (int i = 0; i < 4 && info_text[i]; i++) draw_row_centred(3 + i, info_text[i]);
        fg = px(120, 120, 120); draw_row(rows() - 1, "any button: menu");
    }
}

/* ---- chooser overlay + dispatch ------------------------------------------------ */
static void set_mode(int m) {
    if (m == mode) return;
    mode = m; dirty = 1;
    if (mode == M_CONSOLE) console_spawn();
    if (mode == M_LOG) log_scroll = 0;
    if (mode == M_SETUP) { setup_state = S_MENU; setup_sel = 0; }
    sendf("m %s\n", mode_names[mode]);
    if (mode == M_REMOTE) { clear_screen(); fb_flush(); send_hello(); }
}

static void render_chooser(void) {
    int bw = 22 * gw * scale, bh = (M_COUNT + 2) * gh * scale, bx = (W - bw) / 2, by = (H - bh) / 2;
    fill_rect(bx - 2, by - 2, bw + 4, bh + 4, px(255, 255, 0)); fill_rect(bx, by, bw, bh, px(0, 0, 0));
    fg = px(255, 255, 0); draw_text(bx + gw * scale, by, "MODE");
    for (int i = 0; i < M_COUNT; i++) {
        char s[32]; snprintf(s, sizeof s, "%s%s%s", i == chooser_sel ? "> " : "  ", mode_names[i], i == mode ? " *" : "");
        fg = i == chooser_sel ? px(0, 255, 128) : px(200, 200, 200);
        draw_text(bx + gw * scale, by + (i + 1) * gh * scale, s);
    }
}

static void render(void) {
    if (!dirty) return;
    if (ext_surface && mode == M_REMOTE) { dirty = 0; return; }   /* a client owns the pixels */
    dirty = 0;
    if (chooser || mode != M_REMOTE) {
        font_select((mode == M_LOG || mode == M_CONSOLE) ? log_font : 1);
        if (mode == M_CONSOLE) render_console();
        else if (mode == M_LOG) render_log();
        else if (mode == M_SETUP) render_setup();
        else clear_screen();
        if (chooser) { font_select(1); render_chooser(); }
        fb_flush();
        font_select(1);   /* protocol geometry (hello, hub rows) is always the normal font */
    }
}

/* short press of a pod button, a swipe key from the pad, or raw motion */
static void dispatch_key(unsigned code) {
    if (chooser) {
        if (code == KEY_UP) chooser_sel = (chooser_sel + M_COUNT - 1) % M_COUNT;
        else if (code == KEY_DOWN) chooser_sel = (chooser_sel + 1) % M_COUNT;
        else if (code == BTN_FRONT_CODE || code == KEY_ENTER) { chooser = 0; auto_remote = 0; set_mode(chooser_sel); }
        else if (code == BTN_REAR_CODE) chooser = 0;
        dirty = 1;
        if (!chooser && mode == M_REMOTE) { clear_screen(); fb_flush(); send_hello(); }
        return;
    }
    switch (mode) {
    case M_REMOTE:
        if (code == BTN_FRONT_CODE || code == BTN_REAR_CODE) { sendf("k %u 1\n", code); sendf("k %u 0\n", code); }
        else { sendf("k %u 1\n", code); sendf("k %u 0\n", code); }
        break;
    case M_LOG:
        if (code == KEY_UP) log_scroll += 3;
        else if (code == KEY_DOWN) log_scroll -= 3;
        else if (code == KEY_LEFT) hoff = hoff > 10 ? hoff - 10 : 0;
        else if (code == KEY_RIGHT) { hoff += 10; if (hoff > LCOLS - (int)cols()) hoff = LCOLS - (int)cols(); if (hoff < 0) hoff = 0; }
        else if (code == BTN_FRONT_CODE) log_font = !log_font;
        else if (code == BTN_REAR_CODE) { if (log_prev || pstore_lines) log_prev = !log_prev; log_scroll = 0; }
        dirty = 1;
        break;
    case M_CONSOLE:
        if (code == KEY_UP) term_scroll += 3;
        else if (code == KEY_DOWN) term_scroll -= 3;
        else if (code == KEY_LEFT) hoff = hoff > 10 ? hoff - 10 : 0;
        else if (code == KEY_RIGHT) { hoff += 10; if (hoff > TCOLS - (int)cols()) hoff = TCOLS - (int)cols(); if (hoff < 0) hoff = 0; }
        else if (code == BTN_FRONT_CODE) log_font = !log_font;
        else if (code == BTN_REAR_CODE && pty_fd >= 0) write(pty_fd, "\003", 1);
        dirty = 1;
        break;
    case M_SETUP:
        if (setup_state == S_MENU) {
            if (code == KEY_UP) setup_sel = (setup_sel + SETUP_N - 1) % SETUP_N;
            else if (code == KEY_DOWN) setup_sel = (setup_sel + 1) % SETUP_N;
            else if (code == BTN_REAR_CODE) set_mode(M_REMOTE);
            else if (code == BTN_FRONT_CODE || code == KEY_ENTER) {
                switch (setup_sel) {
                case 0: setup_state = S_CAL; cal_step = cal_n = 0; break;
                case 1:
                    if (glance_path[0]) { setup_state = S_GLANCE; gl_step = 0; }
                    else { setup_state = S_INFO; info_text[0] = "glance calibration"; info_text[1] = "no glance sensor found"; info_text[2] = "(tsl2772 / tmd2771 IIO)"; info_text[3] = NULL; }
                    break;
                case 2: setup_state = S_BRIGHT; break;
                case 3: setup_state = S_POWER; power_read(); power_next = 0; break;
                case 4: setup_state = S_INFO; info_text[0] = "WiFi via QR code"; info_text[1] = "needs the camera port"; info_text[2] = "to mainline first"; info_text[3] = NULL; break;
                case 5: set_mode(M_REMOTE); break;
                }
            }
        } else if (setup_state == S_CAL) {
            if (code == BTN_REAR_CODE) setup_state = S_MENU;
        } else if (setup_state == S_BRIGHT) {
            if (code == KEY_UP || code == KEY_RIGHT) { backlight_level += 48; if (backlight_level > 1023) backlight_level = 1023; set_backlight(backlight_level); }
            else if (code == KEY_DOWN || code == KEY_LEFT) { backlight_level -= 48; if (backlight_level < 16) backlight_level = 16; set_backlight(backlight_level); }
            else if (code == BTN_FRONT_CODE || code == KEY_ENTER) { backlight_save(); setup_state = S_MENU; }
            else if (code == BTN_REAR_CODE) { backlight_level = backlight_saved; set_backlight(backlight_level); setup_state = S_MENU; }
        } else if (setup_state == S_GLANCE) {
            if (code == BTN_REAR_CODE) setup_state = S_MENU;
            else if (code == BTN_FRONT_CODE || code == KEY_ENTER) { gl_cal[gl_step] = glance_read_avg(8); if (++gl_step == 4) glance_cal_finish(); }
        } else if (code == BTN_FRONT_CODE || code == BTN_REAR_CODE || code == KEY_ENTER) {
            setup_state = S_MENU;
        }
        dirty = 1;
        break;
    }
}

static void dispatch_rel(int dx, int dy) {
    if (chooser) return;
    if (mode == M_REMOTE) sendf("r %d %d\n", dx, dy);
    else if (mode == M_SETUP) setup_rel(dx, dy);
}

/* raw evdev: buttons get hold detection, everything else goes straight through */
static struct { int down; int64_t t; int consumed; } btn[2];   /* 0 front, 1 rear */

/* K 1: raw keys. In remote mode every key event (down and up, both pod buttons and the touchpad
 * swipe keys) is forwarded as it happens and jetd's own hold-to-open chooser is off, so the
 * application layer owns the button semantics. Other modes keep jetd's handling. */
static void raw_key(unsigned code, int value) {
    if (raw_keys && nhubs) { if (mode != M_REMOTE) set_mode(M_REMOTE); chooser = 0; sendf("k %u %d\n", code, value); return; }
    int b = code == BTN_FRONT_CODE ? 0 : code == BTN_REAR_CODE ? 1 : -1;
    if (b < 0) { if (value == 1) dispatch_key(code); return; }
    if (value == 1) { btn[b].down = 1; btn[b].t = now_ms(); btn[b].consumed = 0; }
    else if (value == 0 && btn[b].down) { btn[b].down = 0; if (!btn[b].consumed) dispatch_key(code); }
}

static void check_holds(void) {
    if (btn[0].down && !btn[0].consumed && now_ms() - btn[0].t >= HOLD_MS) {
        btn[0].consumed = 1;
        chooser = !chooser; chooser_sel = mode; dirty = 1;
        if (!chooser && mode == M_REMOTE) { clear_screen(); fb_flush(); send_hello(); }
    }
}

/* ---- camera snapshot (V4L2 mmap capture on /dev/video0) --------------------------- */
static int send_fd_all(int fd, const char *p, size_t len) {   /* wait up to 2 s for room, then give up */
    while (len) {
        ssize_t n = send(fd, p, len, MSG_DONTWAIT | MSG_NOSIGNAL);
        if (n < 0) {
            if (errno == EINTR) continue;
            if (errno != EAGAIN) return -1;
            struct pollfd pf = { fd, POLLOUT, 0 };
            if (poll(&pf, 1, 2000) <= 0) return -1;
            continue;
        }
        p += n; len -= n;
    }
    return 0;
}
static int send_all(const void *buf, size_t len) {     /* binary payloads go to every hub (or only_fd) */
    int rc = 0;
    for (int i = 0; i < nhubs; i++) {
        if (only_fd >= 0 && hubs[i].fd != only_fd) continue;
        if (send_fd_all(hubs[i].fd, buf, len) < 0) { hub_drop(i--); rc = -1; }
    }
    return rc;
}

static void cam_snapshot(unsigned w, unsigned h, unsigned skip) {
    struct v4l2_format f = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE };
    struct v4l2_requestbuffers rb = { .count = 3, .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP };
    void *map[3] = { 0 }; size_t maplen[3] = { 0 };
    int fd = open("/dev/video0", O_RDWR | O_NONBLOCK), type = V4L2_BUF_TYPE_VIDEO_CAPTURE, got = -1;
    const char *err = NULL;

    if (fd < 0) { sendf("e camera: open: %s\n", strerror(errno)); return; }
    f.fmt.pix.width = w; f.fmt.pix.height = h; f.fmt.pix.pixelformat = V4L2_PIX_FMT_UYVY; f.fmt.pix.field = V4L2_FIELD_NONE;
    if (ioctl(fd, VIDIOC_S_FMT, &f) < 0) { err = "S_FMT"; goto out; }
    if (ioctl(fd, VIDIOC_REQBUFS, &rb) < 0 || rb.count < 2) { err = "REQBUFS"; goto out; }
    for (unsigned i = 0; i < rb.count; i++) {
        struct v4l2_buffer b = { .type = type, .memory = V4L2_MEMORY_MMAP, .index = i };
        if (ioctl(fd, VIDIOC_QUERYBUF, &b) < 0) { err = "QUERYBUF"; goto out; }
        map[i] = mmap(NULL, b.length, PROT_READ, MAP_SHARED, fd, b.m.offset);
        if (map[i] == MAP_FAILED) { map[i] = NULL; err = "mmap"; goto out; }
        maplen[i] = b.length;
        if (ioctl(fd, VIDIOC_QBUF, &b) < 0) { err = "QBUF"; goto out; }
    }
    if (ioctl(fd, VIDIOC_STREAMON, &type) < 0) { err = "STREAMON"; goto out; }
    /* skip the first frames after power-up: exposure and white balance need a few to settle */
    for (unsigned n = 0; n <= skip; n++) {
        struct pollfd pf = { fd, POLLIN, 0 };
        struct v4l2_buffer b = { .type = type, .memory = V4L2_MEMORY_MMAP };
        if (poll(&pf, 1, 4000) <= 0) { err = "timeout waiting for a frame"; break; }
        if (ioctl(fd, VIDIOC_DQBUF, &b) < 0) { err = "DQBUF"; break; }
        if (n == skip) {
            char hdr[64]; int hl = snprintf(hdr, sizeof hdr, "f %u %u UYVY %u\n", f.fmt.pix.width, f.fmt.pix.height, b.bytesused);
            if (send_all(hdr, hl) == 0 && send_all(map[b.index], b.bytesused) == 0) got = 0;
        } else {
            ioctl(fd, VIDIOC_QBUF, &b);
        }
    }
    ioctl(fd, VIDIOC_STREAMOFF, &type);
out:
    if (err) sendf("e camera: %s: %s\n", err, strerror(errno));
    for (unsigned i = 0; i < 3; i++) if (map[i]) munmap(map[i], maplen[i]);
    close(fd);
    if (got == 0) fprintf(stderr, "jetd: snapshot %ux%u sent\n", f.fmt.pix.width, f.fmt.pix.height);
}

/* ---- viewfinder: live camera scaled into a framebuffer rectangle (Z x y w h [fps], z) --------
 * One V4L2 stream stays open; frames are nearest-neighbour scaled from UYVY straight into the
 * panel rectangle at most `fps` times a second and only that rectangle is pushed. An S snapshot
 * while the viewfinder runs is served from the next streamed frame. Drawn only in remote mode. */
static int vf_fd = -1; static void *vf_map[3]; static size_t vf_len[3]; static unsigned vf_w, vf_h;
static int vf_x, vf_y, vf_rw, vf_rh, vf_interval = 100, vf_snap; static int64_t vf_next;
static void vf_stop(void) {
    if (vf_fd < 0) return;
    int type = V4L2_BUF_TYPE_VIDEO_CAPTURE; ioctl(vf_fd, VIDIOC_STREAMOFF, &type);
    for (int i = 0; i < 3; i++) if (vf_map[i]) { munmap(vf_map[i], vf_len[i]); vf_map[i] = NULL; }
    close(vf_fd); vf_fd = -1;
}
static void vf_start(int x, int y, int w, int h, int fps) {
    vf_stop();
    struct v4l2_format f = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE };
    struct v4l2_requestbuffers rb = { .count = 3, .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP };
    int type = V4L2_BUF_TYPE_VIDEO_CAPTURE; const char *err = NULL;
    vf_fd = open("/dev/video0", O_RDWR | O_NONBLOCK);
    if (vf_fd < 0) { sendf("e viewfinder: open: %s\n", strerror(errno)); return; }
    f.fmt.pix.width = 640; f.fmt.pix.height = 480; f.fmt.pix.pixelformat = V4L2_PIX_FMT_UYVY; f.fmt.pix.field = V4L2_FIELD_NONE;
    if (ioctl(vf_fd, VIDIOC_S_FMT, &f) < 0) { err = "S_FMT"; goto fail; }
    vf_w = f.fmt.pix.width; vf_h = f.fmt.pix.height;
    if (ioctl(vf_fd, VIDIOC_REQBUFS, &rb) < 0 || rb.count < 2) { err = "REQBUFS"; goto fail; }
    for (unsigned i = 0; i < rb.count && i < 3; i++) {
        struct v4l2_buffer b = { .type = type, .memory = V4L2_MEMORY_MMAP, .index = i };
        if (ioctl(vf_fd, VIDIOC_QUERYBUF, &b) < 0) { err = "QUERYBUF"; goto fail; }
        vf_map[i] = mmap(NULL, b.length, PROT_READ, MAP_SHARED, vf_fd, b.m.offset);
        if (vf_map[i] == MAP_FAILED) { vf_map[i] = NULL; err = "mmap"; goto fail; }
        vf_len[i] = b.length;
        if (ioctl(vf_fd, VIDIOC_QBUF, &b) < 0) { err = "QBUF"; goto fail; }
    }
    if (ioctl(vf_fd, VIDIOC_STREAMON, &type) < 0) { err = "STREAMON"; goto fail; }
    vf_x = x; vf_y = y; vf_rw = w; vf_rh = h; vf_interval = fps > 0 ? 1000 / fps : 100; vf_next = 0; vf_snap = 0;
    sendf("Z %u %u\n", vf_w, vf_h);
    return;
fail:
    sendf("e viewfinder: %s: %s\n", err, strerror(errno)); vf_stop();
}
static void vf_draw(const uint8_t *src) {
    int rw = vf_rw, rh = vf_rh;
    if (vf_x + rw > (int)W) rw = W - vf_x; if (vf_y + rh > (int)H) rh = H - vf_y;
    for (int dy = 0; dy < rh; dy++) {
        const uint8_t *row = src + (size_t)(dy * vf_h / vf_rh) * vf_w * 2;
        uint16_t *d16 = (uint16_t *)(fbmem + (vf_y + dy) * finfo.line_length) + vf_x;
        uint32_t *d32 = (uint32_t *)(fbmem + (vf_y + dy) * finfo.line_length) + vf_x;
        for (int dx = 0; dx < rw; dx++) {
            unsigned sx = dx * vf_w / vf_rw, pair = (sx & ~1u) * 2;
            int yv = row[sx * 2 + 1], u = row[pair] - 128, v = row[pair + 2] - 128;
            int c = (yv - 16) * 298;
            int r = (c + 409 * v + 128) >> 8, g = (c - 100 * u - 208 * v + 128) >> 8, b = (c + 516 * u + 128) >> 8;
            r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
            if (vinfo.bits_per_pixel == 16) d16[dx] = (uint16_t)(((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3));
            else d32[dx] = fbpack(px(r, g, b));
        }
    }
    fb_update(vf_x, vf_y, rw, rh);
}
static void vf_frame(void) {
    struct v4l2_buffer b = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP };
    if (ioctl(vf_fd, VIDIOC_DQBUF, &b) < 0) { if (errno != EAGAIN) { sendf("e viewfinder: DQBUF: %s\n", strerror(errno)); vf_stop(); } return; }
    if (vf_snap) { char hdr[64]; int hl = snprintf(hdr, sizeof hdr, "f %u %u UYVY %u\n", vf_w, vf_h, b.bytesused); send_all(hdr, hl); send_all(vf_map[b.index], b.bytesused); vf_snap = 0; }
    if (mode == M_REMOTE && now_ms() >= vf_next) { vf_draw(vf_map[b.index]); vf_next = now_ms() + vf_interval; }
    ioctl(vf_fd, VIDIOC_QBUF, &b);
}

/* ---- hub commands --------------------------------------------------------------- */
/* ---- head motion (LSM9DS0 gyro via IIO): "new view" events ---------------------------
 * 20 Hz sysfs polling. Zero-rate bias (tens of deg/s on this part) is tracked while the head is
 * still (per-axis spread over the last 0.5 s below ~1.5 deg/s). Rotation magnitude above 5 deg/s
 * accumulates degrees; once more than ~20 degrees have been turned and the head has then been
 * still for 1 s, "n <degrees>" is sent (the hub's live look uses it as the trigger). The
 * accumulator decays after 5 s of stillness. Thresholds in /mnt/data/mainline/view ("deg still_ms"). */
static char imu_path[3][128]; static double imu_scale_dps = 0.000153 * 57.29578;
static double imu_bias[3], imu_rot, imu_ring[3][10]; static int imu_ringn, imu_ringfill, imu_still_ms, imu_quiet_ms, imu_biased;
static int view_deg_thr = 20, view_still_ms = 1000; static int64_t imu_next;
static void view_thresholds_load(void) {
    FILE *f = fopen("/mnt/data/mainline/view", "r"); if (!f) f = fopen("/android-data/mainline/view", "r");
    view_deg_thr = 20; view_still_ms = 1000;
    if (f) { if (fscanf(f, "%d %d", &view_deg_thr, &view_still_ms) != 2) { view_deg_thr = 20; view_still_ms = 1000; } fclose(f); }
}
static int imu_fd = -1;    /* IIO buffer (/dev/iio:deviceN, 3 x le:s16 per sample at the sensor ODR) */
static int sysfs_write(const char *path, const char *val) { FILE *f = fopen(path, "w"); if (!f) return -1; int r = fputs(val, f) < 0 ? -1 : 0; fclose(f); return r; }
static void imu_open(void) {
    for (int i = 0; i < 16; i++) {
        char p[128], name[32] = ""; FILE *f;
        snprintf(p, sizeof p, "/sys/bus/iio/devices/iio:device%d/name", i);
        if (!(f = fopen(p, "r"))) continue;
        int hit = fgets(name, sizeof name, f) && !strncmp(name, "lsm9ds0_gyro", 12); fclose(f);
        if (!hit) continue;
        const char *ax = "xyz";
        for (int a = 0; a < 3; a++) snprintf(imu_path[a], sizeof imu_path[a], "/sys/bus/iio/devices/iio:device%d/in_anglvel_%c_raw", i, ax[a]);
        snprintf(p, sizeof p, "/sys/bus/iio/devices/iio:device%d/in_anglvel_scale", i);
        if ((f = fopen(p, "r"))) { double sc; if (fscanf(f, "%lf", &sc) == 1 && sc > 0) imu_scale_dps = sc * 57.29578; fclose(f); }
        /* sysfs raw reads power the sensor up and down with settling delays (~50 ms per axis,
         * which stalled the UI loop); the IIO buffer streams samples at the ODR instead */
        char d[128]; snprintf(d, sizeof d, "/sys/bus/iio/devices/iio:device%d", i);
        int ok = 1;
        for (int a = 0; a < 3 && ok; a++) { snprintf(p, sizeof p, "%s/scan_elements/in_anglvel_%c_en", d, ax[a]); ok = sysfs_write(p, "1") == 0; }
        snprintf(p, sizeof p, "%s/scan_elements/in_timestamp_en", d); sysfs_write(p, "0");
        snprintf(p, sizeof p, "%s/buffer/length", d); if (ok) ok = sysfs_write(p, "64") == 0;
        snprintf(p, sizeof p, "%s/buffer/enable", d); if (ok) ok = sysfs_write(p, "1") == 0;
        snprintf(p, sizeof p, "/dev/iio:device%d", i);
        if (ok) imu_fd = open(p, O_RDONLY | O_NONBLOCK);
        if (imu_fd < 0) fprintf(stderr, "jetd: gyro buffer unavailable, sysfs fallback at 2 Hz\n");
        break;
    }
    view_thresholds_load();
    if (imu_path[0][0]) fprintf(stderr, "jetd: gyro %s (view: %d deg, still %d ms)\n", imu_path[0], view_deg_thr, view_still_ms);
}
static void imu_poll(void) {
    if (!imu_path[0][0] || now_ms() < imu_next) return;
    imu_next = now_ms() + (imu_fd >= 0 ? 50 : 500);
    double w[3];
    if (imu_fd >= 0) {
        int16_t buf[3 * 64]; ssize_t r = read(imu_fd, buf, sizeof buf);
        if (r < 6) return;                                   /* nothing new since the last tick */
        int last = (int)(r / 6) - 1;
        for (int a = 0; a < 3; a++) { w[a] = buf[3 * last + a] * imu_scale_dps; imu_ring[a][imu_ringn] = w[a]; }
    } else {
        for (int a = 0; a < 3; a++) { FILE *f = fopen(imu_path[a], "r"); int raw = 0; if (!f) return; if (fscanf(f, "%d", &raw) != 1) raw = 0; fclose(f); w[a] = raw * imu_scale_dps; imu_ring[a][imu_ringn] = w[a]; }
    }
    imu_ringn = (imu_ringn + 1) % 10; if (imu_ringfill < 10) imu_ringfill++;
    if (imu_ringfill < 10) return;
    int calm = 1;
    for (int a = 0; a < 3 && calm; a++) { double lo = 1e9, hi = -1e9; for (int k = 0; k < 10; k++) { if (imu_ring[a][k] < lo) lo = imu_ring[a][k]; if (imu_ring[a][k] > hi) hi = imu_ring[a][k]; } if (hi - lo > 3.0) calm = 0; }
    if (calm) { for (int a = 0; a < 3; a++) imu_bias[a] = imu_biased ? imu_bias[a] * 0.95 + w[a] * 0.05 : w[a]; imu_biased = 1; }
    if (!imu_biased) return;
    double mag = 0; for (int a = 0; a < 3; a++) { double h = w[a] - imu_bias[a]; mag += h * h; } mag = sqrt(mag);
    double dt = imu_fd >= 0 ? 0.05 : 0.5;
    if (mag > 5.0) { imu_rot += mag * dt; imu_still_ms = 0; imu_quiet_ms = 0; }
    else { imu_still_ms += (int)(dt * 1000); imu_quiet_ms += (int)(dt * 1000); }
    if (imu_rot >= view_deg_thr && imu_still_ms >= view_still_ms) { sendf("n %.0f\n", imu_rot); imu_rot = 0; imu_still_ms = 0; }
    else if (imu_quiet_ms >= 5000) { imu_rot = 0; imu_quiet_ms = 0; }
}

static int send_all(const void *buf, size_t len);

/* ---- voice: capture and playback through ALSA in the Alpine chroot ------------------
 * V [max_s]  start capture: arecord hw:0,1 (96 kHz S32 stereo, the DMIC's only mode) is
 *            downmixed/decimated here to 16 kHz mono S16 and streamed as "a <len>\n"+bytes
 *            (100 ms chunks). Ends on silence (energy VAD: ~0.8 s below the floor after speech),
 *            on max_s (default 8), or on "v"; then "A <end|max|stop|error>".
 * W <len>    + <len> bytes of 48 kHz stereo S16 PCM to play (aplay hw:0,0); chunks are queued
 *            and drained without blocking the UI; "w" marks the end -> "w" back when played. */
#define ALPINE "/mnt/data/rootfs"      /* the userdata rootfs (symlink; see kernel/rootfs) */
static pid_t cap_pid, play_pid;
static int cap_fd = -1, play_fd = -1;
static int64_t cap_t0, cap_max_ms, cap_last_voice, play_last;
static int cap_speech, cap_chunks; static double cap_floor;
static int32_t cap_acc[2]; static int cap_accn;              /* decimation accumulator */
static int16_t cap_out[1600]; static int cap_outn;            /* 100 ms of 16 kHz mono */
static unsigned char cap_in[76800]; static size_t cap_inlen;
static unsigned char *play_buf; static size_t play_len, play_off, play_cap; static int play_end;

static pid_t spawn_pipe(char *const argv[], int *fd, int for_write) {
    /* O_CLOEXEC: a child must not inherit the other child's pipe (an arecord started while aplay
     * still runs kept aplay's stdin open, so aplay never saw EOF and jetd blocked in waitpid) */
    int p[2]; if (pipe2(p, O_CLOEXEC) < 0) return -1;
    pid_t pid = fork();
    if (pid < 0) { close(p[0]); close(p[1]); return -1; }
    if (pid == 0) {
        if (for_write) { dup2(p[0], 0); } else { dup2(p[1], 1); }
        close(p[0]); close(p[1]);
        int nul = open("/dev/null", O_RDWR); if (nul >= 0) { dup2(nul, 2); if (for_write) dup2(nul, 1); else dup2(nul, 0); }
        execv(argv[0], argv); _exit(127);
    }
    if (for_write) { close(p[0]); *fd = p[1]; } else { close(p[1]); *fd = p[0]; }
    return pid;
}
static void cap_send_chunk(void) {
    if (!cap_outn) return;
    double sq = 0; for (int i = 0; i < cap_outn; i++) sq += (double)cap_out[i] * cap_out[i];
    double rms = sqrt(sq / cap_outn);
    cap_chunks++;
    if (cap_chunks <= 3) { if (rms > cap_floor) cap_floor = rms; }
    else {
        double start = cap_floor * 3 > 300 ? cap_floor * 3 : 300, end = cap_floor * 1.5 > 150 ? cap_floor * 1.5 : 150;
        if (rms > start) { cap_speech = 1; cap_last_voice = now_ms(); }
        else if (cap_speech && rms < end && now_ms() - cap_last_voice > 800) cap_speech = 2;   /* trailing silence done */
    }
    if (nhubs) { sendf("a %d\n", cap_outn * 2); send_all(cap_out, cap_outn * 2); }
    cap_outn = 0;
}
static void cap_stop(const char *why) {
    if (cap_pid <= 0) return;
    cap_send_chunk();
    kill(cap_pid, SIGTERM); close(cap_fd); cap_fd = -1; waitpid(cap_pid, NULL, 0); cap_pid = 0;
    sendf("A %s\n", why);
}
static void cap_start(int max_s) {
    if (cap_pid > 0) cap_stop("restart");
    /* from the initramfs the ALSA tools live in the Alpine chroot; when jetd itself runs inside
     * the chroot (live testing over ssh) they are plain /usr/bin paths */
    char *argv_chroot[] = { "/bin/chroot", ALPINE, "/usr/bin/arecord", "-q", "-D", "hw:0,1", "-c", "2", "-r", "96000", "-f", "S32_LE", "-t", "raw", "-", NULL };
    char *argv_direct[] = { "/usr/bin/arecord", "-q", "-D", "hw:0,1", "-c", "2", "-r", "96000", "-f", "S32_LE", "-t", "raw", "-", NULL };
    cap_pid = spawn_pipe(access(ALPINE "/usr/bin/arecord", X_OK) == 0 ? argv_chroot : argv_direct, &cap_fd, 0);
    if (cap_pid <= 0) { sendf("A error\n"); return; }
    cap_t0 = now_ms(); cap_max_ms = (max_s > 0 ? max_s : 8) * 1000LL; cap_last_voice = cap_t0;
    cap_speech = 0; cap_chunks = 0; cap_floor = 0; cap_accn = 0; cap_outn = 0; cap_inlen = 0;
    cap_acc[0] = cap_acc[1] = 0;
}
static void cap_read(void) {
    ssize_t r = read(cap_fd, cap_in + cap_inlen, sizeof cap_in - cap_inlen);
    if (r <= 0) { cap_stop("error"); return; }
    cap_inlen += r;
    size_t frames = cap_inlen / 8, i;
    const int32_t *f = (const int32_t *)cap_in;
    for (i = 0; i < frames; i++) {
        cap_acc[0] += f[2 * i] >> 8; cap_acc[1] += f[2 * i + 1] >> 8;    /* 24-bit samples, headroom for 12 adds */
        if (++cap_accn == 6) {
            int32_t v = (cap_acc[0] + cap_acc[1]) / 12;                   /* average L+R over 6 frames */
            v >>= 8; if (v > 32767) v = 32767; if (v < -32768) v = -32768;
            cap_out[cap_outn++] = (int16_t)v; cap_acc[0] = cap_acc[1] = 0; cap_accn = 0;
            if (cap_outn == 1600) cap_send_chunk();
        }
    }
    size_t used = frames * 8; memmove(cap_in, cap_in + used, cap_inlen - used); cap_inlen -= used;
    if (cap_speech == 2) cap_stop("end");
    else if (now_ms() - cap_t0 > cap_max_ms) cap_stop("max");
}
static void play_close(const char *why) {
    if (play_pid <= 0) return;
    close(play_fd); play_fd = -1; waitpid(play_pid, NULL, 0); play_pid = 0;
    play_len = play_off = 0; play_end = 0;
    sendf("w %s\n", why);
}
static void play_queue(const unsigned char *d, size_t n) {
    if (play_pid <= 0) {
        char *argv_chroot[] = { "/bin/chroot", ALPINE, "/usr/bin/aplay", "-q", "-D", "hw:0,0", "-f", "S16_LE", "-c", "2", "-r", "48000", "-t", "raw", "-", NULL };
        char *argv_direct[] = { "/usr/bin/aplay", "-q", "-D", "hw:0,0", "-f", "S16_LE", "-c", "2", "-r", "48000", "-t", "raw", "-", NULL };
        play_pid = spawn_pipe(access(ALPINE "/usr/bin/aplay", X_OK) == 0 ? argv_chroot : argv_direct, &play_fd, 1);
        if (play_pid <= 0) return;
        fcntl(play_fd, F_SETFL, fcntl(play_fd, F_GETFL) | O_NONBLOCK);
        play_len = play_off = 0; play_end = 0;
    }
    if (play_off == play_len) play_off = play_len = 0;
    if (play_len + n > play_cap) { play_cap = (play_len + n) * 2; play_buf = realloc(play_buf, play_cap); }
    memcpy(play_buf + play_len, d, n); play_len += n; play_last = now_ms();
}
static void play_drain(void) {
    while (play_off < play_len) {
        ssize_t w = write(play_fd, play_buf + play_off, play_len - play_off);
        if (w < 0) { if (errno == EAGAIN) return; play_close("error"); return; }
        play_off += w;
    }
    if (play_end) play_close("done");
}

static void handle_line(char *l) {
    int r, g, b, x, y, w, h;
    int drawing_ok = mode == M_REMOTE && !chooser;
    switch (l[0]) {
    case 'C': if (drawing_ok) clear_screen(); break;
    case 'T': if (drawing_ok && sscanf(l + 1, "%d %n", &r, &x) >= 1) draw_row(r, l + 1 + x); break;
    case 'A': if (drawing_ok && sscanf(l + 1, "%d %n", &r, &x) >= 1) draw_row_centred(r, l + 1 + x); break;
    case 'X': if (drawing_ok && sscanf(l + 1, "%d %d %n", &x, &y, &w) >= 2) draw_text(x, y, l + 1 + w); break;
    case 'R': if (sscanf(l + 1, "%d %d %d", &r, &g, &b) == 3) fg = px(r & 255, g & 255, b & 255); break;
    case 'B': if (drawing_ok && sscanf(l + 1, "%d %d %d %d %d %d %d", &x, &y, &w, &h, &r, &g, &b) == 7) fill_rect(x, y, w, h, px(r & 255, g & 255, b & 255)); break;
    case 'F':
        if (!drawing_ok) break;
        if (ext_surface) { if (sscanf(l + 1, "%d %d %d %d", &x, &y, &w, &h) == 4) fb_update(x, y, w, h); else fb_update(0, 0, W, H); }
        else fb_flush();
        break;
    case 'E': ext_surface = atoi(l + 1) != 0; sendf("E %u %u %u %u\n", W, H, vinfo.bits_per_pixel, finfo.line_length); if (!ext_surface) dirty = 1; break;
    case 'Z': { int fps = 10; if (sscanf(l + 1, "%d %d %d %d %d", &x, &y, &w, &h, &fps) >= 4) vf_start(x, y, w, h, fps); } break;
    case 'z': vf_stop(); break;
    case 'K': raw_keys = atoi(l + 1) != 0; if (raw_keys) { chooser = 0; auto_remote = 0; if (mode != M_REMOTE) set_mode(M_REMOTE); dirty = 1; } break;   /* a client owns the UI */
    case 'J': { int n = atoi(l + 1); if (n <= 0 || n > klog_n) n = klog_n; for (int i = klog_n - n; i < klog_n; i++) sendf("j %s\n", klog[(klog_head + i) % LROWS]); sendf("J %d\n", n); } break;   /* log backlog: last n lines */
    case 'U': { glance_worn = -1; glance_open(); view_thresholds_load(); sendf("U %d %d %d %d\n", glance_on_thr, glance_off_thr, view_deg_thr, view_still_ms); } break;   /* re-read calibration files */
    case 'L': set_backlight(atoi(l + 1)); break;
    case 'P': sendf("p\n"); break;
    case 'G': sendf("g %d %d\n", glance_worn, glance_raw); break;
    case 'V': cap_start(atoi(l + 1)); break;
    case 'Q': power_read(); sendf("q %d %d %d %d 0x%02x 0x%02x 0x%02x 0x%02x 0x%02x %s %d\n", pstate.vbat, pstate.vsys, pstate.vbus, pstate.ma, pstate.ctrl1 & 0xff, pstate.stat1 & 0xff, pstate.lin & 0xff, pstate.cin & 0xff, pstate.vichrg & 0xff, pstate.udc[0] ? pstate.udc : "-", pstate.maxpower); break;
    case 'v': cap_stop("stop"); break;
    case 'W': if (cur_hub) cur_hub->bin_need = strtoul(l + 1, NULL, 10); break;   /* payload bytes follow the line */
    case 'w': if (play_pid > 0) { play_end = 1; play_drain(); } else sendf("w idle\n"); break;
    case 'Y': if (play_pid > 0) { kill(play_pid, SIGKILL); play_close("flushed"); } else sendf("w idle\n"); break;   /* barge-in: drop queued audio now */
    case 'M': { char name[16]; if (sscanf(l + 1, "%15s", name) == 1) for (int i = 0; i < M_COUNT; i++) if (!strcmp(name, mode_names[i])) { chooser = 0; set_mode(i); } } break;
    case 'I': console_write(l + 2); dirty = 1; break;
    case 'S': { unsigned sw = 640, sh = 480, sk = 6; sscanf(l + 1, "%u %u %u", &sw, &sh, &sk); if (sk > 30) sk = 30; if (vf_fd >= 0) vf_snap = 1; else cam_snapshot(sw, sh, sk); } break;
    default: break;
    }
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: jetd <host> <port> [scale]\n"); return 1; }
    snprintf(hub_hosts, sizeof hub_hosts, "%s", argv[1]); hub_port = argv[2];
    if (argc > 3) boot_hold_s = atoi(argv[3]);           /* seconds of boot log before remote takes over */
    if (getenv("JETD_LOG_FONT")) log_font = atoi(getenv("JETD_LOG_FONT"));   /* 0 small (default), 1 normal */
    if (fb_open() || font_init()) return 1;
    signal(SIGPIPE, SIG_IGN); signal(SIGCHLD, SIG_IGN);
    fg = px(255, 255, 255);
    input_open();
    read_thresholds();
    kmsg_open(); pstore_load();
    listen_open(); glance_open(); backlight_load(); imu_open(); power_open();
    start_ms = now_ms();
    if (kmsg_fd >= 0) { kmsg_read(); reveal = 0; }   /* backlog loaded; reveal it progressively */
    fprintf(stderr, "jetd: fb %ux%u, font %ux%u x%u => %u cols x %u rows, %d input devs\n", W, H, gw, gh, scale, cols(), rows(), nin);

    dirty = 1; render();   /* log mode from the start */

    for (;;) {
        if (!nhubs && connecting_fd < 0 && now_ms() >= next_connect) try_connect();
        struct pollfd pf[8 + MAXIN + MAXHUB]; int n = 0, ipty = -1, ikmsg = -1, ilisten = -1;
        int ihub = n; for (int i = 0; i < nhubs; i++) pf[n++] = (struct pollfd){ hubs[i].fd, POLLIN, 0 };
        if (kmsg_fd >= 0) { ikmsg = n; pf[n++] = (struct pollfd){ kmsg_fd, POLLIN, 0 }; }
        if (listen_fd >= 0) { ilisten = n; pf[n++] = (struct pollfd){ listen_fd, POLLIN, 0 }; }
        if (pty_fd >= 0) { ipty = n; pf[n++] = (struct pollfd){ pty_fd, POLLIN, 0 }; }
        int iconn = -1;
        if (connecting_fd >= 0) { iconn = n; pf[n++] = (struct pollfd){ connecting_fd, POLLOUT, 0 }; }
        int ivf = -1;
        if (vf_fd >= 0) { ivf = n; pf[n++] = (struct pollfd){ vf_fd, POLLIN, 0 }; }
        int icap = -1, iplay = -1;
        if (cap_fd >= 0) { icap = n; pf[n++] = (struct pollfd){ cap_fd, POLLIN, 0 }; }
        if (play_fd >= 0 && play_off < play_len) { iplay = n; pf[n++] = (struct pollfd){ play_fd, POLLOUT, 0 }; }
        int iin = n;
        for (int i = 0; i < nin; i++) pf[n++] = (struct pollfd){ infd[i], POLLIN, 0 };
        int timeout = !nhubs ? 500 : 5000;
        if (reveal >= 0 || auto_remote) timeout = reveal >= 0 ? 25 : 500;
        if (btn[0].down && !btn[0].consumed) { int rem = HOLD_MS - (int)(now_ms() - btn[0].t); timeout = rem < 1 ? 1 : rem; }
        if (glance_path[0] && timeout > 250) timeout = 250;
        if (imu_path[0][0] && timeout > 50) timeout = 50;
        if (mode == M_SETUP && setup_state == S_POWER && timeout > 250) timeout = 250;
        if ((cap_pid > 0 || play_pid > 0) && timeout > 100) timeout = 100;
        static int64_t prof_last_report; static int prof_on = -1; static int prof_max[8]; static const char *prof_name[8] = { "sock", "pty", "kmsg", "cap", "play", "input", "holds+glance+imu", "render" };
        if (prof_on < 0) prof_on = getenv("JETD_PROF") != NULL;
        int64_t prof_t0 = now_ms();
        int pr = poll(pf, n, timeout);
        int64_t prof_t = now_ms();
#define PROF(i) do { if (prof_on) { int64_t _n = now_ms(); if (_n - prof_t > prof_max[i]) prof_max[i] = _n - prof_t; prof_t = _n; } } while (0)
        if (pr < 0 && errno != EINTR) break;
        for (int hi = 0; hi < nhubs; hi++) {
            if (!pf[ihub + hi].revents) continue;
            struct hub *h = &hubs[hi];
            ssize_t r = read(h->fd, h->inbuf + h->inlen, sizeof h->inbuf - 1 - h->inlen);
            if (r <= 0) { hub_drop(hi); break; }                      /* table changed: re-poll */
            h->inlen += r; cur_hub = h;
            for (;;) {
                if (h->bin_need) {                                    /* W payload: PCM for the speaker */
                    size_t take = h->inlen < h->bin_need ? h->inlen : h->bin_need;
                    play_queue((unsigned char *)h->inbuf, take);
                    memmove(h->inbuf, h->inbuf + take, h->inlen - take); h->inlen -= take; h->bin_need -= take;
                    if (h->bin_need) break;
                    continue;
                }
                char *nl = memchr(h->inbuf, '\n', h->inlen);
                if (!nl) { if (h->inlen == sizeof h->inbuf - 1) h->inlen = 0; break; }
                *nl = 0; handle_line(h->inbuf);
                size_t used = nl - h->inbuf + 1; memmove(h->inbuf, h->inbuf + used, h->inlen - used); h->inlen -= used;
            }
            h->inbuf[h->inlen] = 0; cur_hub = NULL;
        }
        if (iconn >= 0) connect_poll(pf[iconn].revents);
        PROF(0);
        if (ipty >= 0 && pf[ipty].revents) console_read();
        PROF(1);
        if (ivf >= 0 && pf[ivf].revents) vf_frame();
        if (icap >= 0 && pf[icap].revents) cap_read();
        PROF(3);
        if (iplay >= 0 && pf[iplay].revents) play_drain();
        PROF(4);
        if (play_pid > 0 && !play_end && play_off == play_len && now_ms() - play_last > 3000) play_close("timeout");
        if (cap_pid > 0 && now_ms() - cap_t0 > cap_max_ms) cap_stop("max");
        if (ikmsg >= 0 && pf[ikmsg].revents) kmsg_read();
        PROF(2);
        if (ilisten >= 0 && pf[ilisten].revents) accept_hub();
        for (int i = 0; i < nin; i++) if (pf[iin + i].revents) {
            struct input_event ev[16];
            ssize_t r = read(infd[i], ev, sizeof ev);
            /* keys go through hold detection; the touchpad driver sends one REL_X, REL_Y, SYN group per gesture */
            int dx = 0, dy = 0, any = 0;
            for (ssize_t k = 0; k < (ssize_t)(r / sizeof ev[0]); k++) {
                if (ev[k].type == EV_KEY) raw_key(ev[k].code, ev[k].value);
                else if (ev[k].type == EV_REL) { any = 1; if (ev[k].code == REL_X) dx = ev[k].value; else if (ev[k].code == REL_Y) dy = ev[k].value; }
            }
            if (any) dispatch_rel(dx, dy);
        }
        PROF(5);
        check_holds(); glance_poll(); imu_poll(); power_poll();
        PROF(6);
        if (reveal >= 0) {                        /* ~80 lines/s boot log replay */
            reveal += 2; dirty = 1;
            if (reveal >= klog_n) reveal = -1;
        }
        if (auto_remote && nhubs && reveal < 0 && now_ms() - start_ms >= boot_hold_s * 1000LL) { auto_remote = 0; set_mode(M_REMOTE); }
        render();
        PROF(7);
        if (prof_on && now_ms() - prof_last_report > 5000) {
            prof_last_report = now_ms();
            fprintf(stderr, "prof: poll waited %lld ms (timeout %d);", (long long)(prof_t - prof_t0), timeout);
            for (int i = 0; i < 8; i++) { fprintf(stderr, " %s=%d", prof_name[i], prof_max[i]); prof_max[i] = 0; }
            fprintf(stderr, "\n");
        }
    }
    return 0;
}
