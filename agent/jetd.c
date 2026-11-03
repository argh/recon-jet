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
 *   shell    bash in the Debian rootfs on a pty, a small terminal emulator (Linux-console subset,
 *            TERM=linux: colours, scroll regions, insert/delete: vi, emacs/mg, less work) with
 *            scrollback; a Bluetooth (or USB) keyboard types into it, Ctrl+Alt+Enter toggles it from
 *            any mode, even while a client owns the UI (K 1); input devices appearing after boot are
 *            picked up live
 * Hold the FRONT button ~1 s: with a client owning the UI it returns to remote (the app's
 * menu takes over); with no client it opens the dead-man chooser (log / shell / bluetooth /
 * reboot) - the field escape hatch, not a menu system (the app owns every real menu).
 * Short presses and swipes belong to the mode.
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
 *   M <mode>          switch mode (remote|log|shell)
 *   I <text>          shell: write text to the pty (\n \t \\ escapes)
 *   S [w h [skip]]    camera snapshot: one UYVY frame from /dev/video0 (default 640x480, after
 *                     skipping 6 frames for exposure to settle; the media pipeline must already
 *                     be configured for that size), sent back as
 *                     "f <w> <h> UYVY <len>\n" followed by <len> raw bytes, or "e <message>"
 *   (drawing commands are ignored unless the remote mode is showing; the hub
 *    gets a fresh "h" hello whenever remote comes back and should redraw)
 *   V [max_s]         start voice capture (see the voice section), v stops it
 *   D <0|1> [cutoff [window]]   listen for the wake word (jetwake over the mic, see the voice
 *                     section); a hit is "d <avg> <max>" and starts a capture as V would
 *   W <len> + bytes   queue 48 kHz stereo S16 PCM for the speaker; w = end of clip
 *   Y                 stop playback immediately and drop queued audio (barge-in) -> "w flushed"
 *   K <0|1>           raw keys: the client owns the UI: jetd stays in remote mode, forwards every
 *                     key down/up as it happens and its chooser/log screens are off until
 *                     the last client disconnects (then the recovery chooser returns)
 *   E <0|1>           external surface: the client writes /dev/fb0 itself (reply "E w h bpp
 *                     line_length"); jetd draws nothing in remote mode, F pushes to the panel
 *   F [x y w h]       flush (whole screen, or just a rectangle in external-surface mode)
 *   Z x y w h [fps]   live camera scaled into that rectangle (default 10 fps); z stops it;
 *                     reply "Z srcw srch"; S during a viewfinder returns the next streamed frame
 *   J [n]             resend the last n kernel-log lines (default: the whole ring), then "J n"
 *   U                 re-read the calibration files (glance, wear, view thresholds) -> "U on off deg still"
 *   G / O             current glance / wear state -> "g <at> <raw>" / "o <worn> <raw>"
 *   Q                 power snapshot -> "q vbat vsys vbus mA ctrl1 stat1 linsts cinlimit vichrg udc maxpower"
 *   N <0|1>           mirror the panel to this client (docs/live.md): reply "N w h bpp line_length",
 *                     then a full refresh and a "b" rect for every panel push (post-composition,
 *                     so the viewfinder and external-surface drawing are included). Also tees
 *                     speaker audio to this client as "u" chunks. Never blocks the UI: a rect is
 *                     sent only when it wholly fits the socket's free space; an overflowed client
 *                     self-heals with a banded full refresh from the live framebuffer.
 *   H k <code> <val> / H r <dx> <dy> / H t <code> <val>   inject input: a pod button / a pad
 *                     gesture / a keyboard key (the kbd path, like the BT keyboard: shell typing,
 *                     modifiers, Ctrl+Alt+Enter) — same dispatch as evdev, so holds, the chooser
 *                     and k/r forwarding all behave
 * jet -> host:
 *   h <w> <h> <cols> <rows>     hello (also sent when remote mode is re-entered)
 *   k <code> <value>            key event (evdev code, 1=down 0=up)
 *   r <dx> <dy>                 touchpad motion (summed per gesture by the driver)
 *   m <mode>                    mode changed
 *   j <text>                    kernel log line (last 60 on connect, then live)
 *   p                           pong
 *   g <at> <raw>                glance changed: the eye is at the glass (1) or looking ahead (0)
 *   o <worn> <raw>              wear changed: the glasses are on a head (1) or off (0)
 *   n <degrees>                 head turned that much and then held still (new view)
 *   a <len> + bytes             16 kHz mono S16 capture chunk; A <end|max|stop|error> ends it
 *   d <avg> <max>               wake word heard (probabilities 0..255); a capture follows
 *   x <on|off|error ...>        listening state
 *   w <done|timeout|error|idle> playback finished
 *   b <x> <y> <w> <h> <len> + bytes   mirror rect (packed rows, fb pixel format per the N reply)
 *   u <len> + bytes             mirror tee of queued speaker audio (48 kHz stereo S16)
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
#include <ucontext.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/uio.h>
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

static void mirror_tee(int x, int y, int w, int h);   /* defined with the hub machinery below */

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
    mirror_tee(0, 0, W, H);
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
    mirror_tee(x, y, w, h);
}

/* ---- PSF fonts (two sizes, front button toggles in log/shell) ------------------- */
struct font { const uint8_t *glyphs; unsigned gw, gh, gbytes, nglyph; };
static struct font fonts[2]; static int fsel = 1;   /* 0 small, 1 normal */
static int log_font = 0;                             /* font used by log/shell (front toggles); remote uses the normal one */
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

/* ---- input ------------------------------------------------------------------- */
#define MAXIN 12
static int infd[MAXIN]; static char inkbd[MAXIN]; static int nin;   /* inkbd: the device has letter keys */
static int inotify_fd = -1;

/* A device with letter keys is a keyboard (its keys type into the shell). A pointer without them
 * (a BT keyboard's trackpad: BTN_LEFT + REL_X/Y) is ignored so it cannot pose as the Jet's touchpad. */
static int input_add(const char *name) {
    if (nin >= MAXIN) return -1;
    char p[64]; snprintf(p, sizeof p, "/dev/input/%s", name);
    int fd = open(p, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    unsigned long keys[(KEY_MAX + 8 * sizeof(long)) / (8 * sizeof(long))] = { 0 };
    ioctl(fd, EVIOCGBIT(EV_KEY, sizeof keys), keys);
#define HASKEY(k) ((keys[(k) / (8 * sizeof(long))] >> ((k) % (8 * sizeof(long)))) & 1)
    int kbd = HASKEY(KEY_A) && HASKEY(KEY_Z);
    if (!kbd && HASKEY(BTN_LEFT)) { close(fd); return -1; }
#undef HASKEY
    if (kbd) { unsigned rep[2] = { 600, 60 }; ioctl(fd, EVIOCSREP, rep); }   /* autorepeat after 600 ms at ~16/s (kernel default 250/33 doubles slow presses) */
    infd[nin] = fd; inkbd[nin] = kbd; nin++;
    return 0;
}
static void input_remove(int i) { close(infd[i]); nin--; infd[i] = infd[nin]; inkbd[i] = inkbd[nin]; }

static void input_open(void) {
    DIR *d = opendir("/dev/input"); struct dirent *e;
    if (d) { while ((e = readdir(d))) if (!strncmp(e->d_name, "event", 5)) input_add(e->d_name); closedir(d); }
    inotify_fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (inotify_fd >= 0 && inotify_add_watch(inotify_fd, "/dev/input", IN_CREATE) < 0) { close(inotify_fd); inotify_fd = -1; }
}

/* a device node appeared (a Bluetooth keyboard connected): open it, retrying once if it is not ready */
static void input_hotplug(void) {
    char buf[512]; ssize_t r;
    while ((r = read(inotify_fd, buf, sizeof buf)) > 0)
        for (char *p = buf; p < buf + r; ) {
            struct inotify_event *ev = (struct inotify_event *)p;
            if (ev->len && !strncmp(ev->name, "event", 5) && input_add(ev->name) < 0) { usleep(100000); input_add(ev->name); }
            p += sizeof *ev + ev->len;
        }
}

/* ---- mode state ------------------------------------------------------------------ */
enum { M_REMOTE, M_LOG, M_CONSOLE, M_COUNT };
static const char *mode_names[M_COUNT] = { "remote", "log", "shell" };
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
struct hub { int fd; char inbuf[1024]; size_t inlen; size_t bin_need; int64_t stuck_since;
             int mirror; unsigned mirror_y;      /* N 1: tee panel pushes; mirror_y < H = full refresh in progress */
             int owns_keys, owns_surface; };     /* this client's K / E grants (raw_keys / ext_surface are ORs of these) */
static struct hub hubs[MAXHUB]; static int nhubs;
static struct hub *cur_hub;      /* the hub whose line is being handled (W payload accounting) */
static int only_fd = -1;         /* when >= 0, sendf/send_all go to this hub only (hello + log replay) */
static int turn_on, listen_on; static void turn_end(const char *why); static void listen_stop(const char *why);   /* voice section, below */
/* K/E are per-client grants: when their owner drops (the app crashed) they must clear even while
 * other clients (the live mirror, a debug session) stay connected, or the dead-man chooser is
 * unreachable and the panel stays suppressed. */
static void recompute_owners(void) {
    int k = 0, e = 0;
    for (int i = 0; i < nhubs; i++) { k |= hubs[i].owns_keys; e |= hubs[i].owns_surface; }
    if (raw_keys != k || ext_surface != e) dirty = 1;
    raw_keys = k; ext_surface = e;
}
/* no client: the recovery UI returns, the mic is released (a turn or the wake word has no one to serve) */
static void hub_drop(int i) { close(hubs[i].fd); hubs[i] = hubs[--nhubs]; recompute_owners(); if (!nhubs) { dirty = 1; if (turn_on) turn_end("stop"); if (listen_on) listen_stop("off"); } }
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

/* ---- shell: a terminal emulator on a pty (Linux-console subset, TERM=linux) -------------------
 * A grid of cells (glyph, colours, attributes) sized to the current font (71x20 small, 42x12
 * normal; the front button toggles and the pty is resized). Lines pushed off the top of a
 * full-screen scroll go to a scrollback ring (pad swipes or Shift+PgUp/PgDn view it). Covered:
 * cursor motion, ED/EL/ECH, IL/DL/ICH/DCH, scroll regions (DECSTBM), SU/SD, save/restore cursor,
 * SGR (bold/dim/underline/reverse, 16/256/true colour), autowrap, insert mode, the alternate
 * screen (1047/1049) as save+clear/restore, DSR/DA replies, tabs, UTF-8 decoded to one cell
 * (non-ASCII drawn as '?'), DEC line drawing approximated. Enough for bash, vi/vim, mg/emacs,
 * less and nano. The shell runs in the Debian rootfs (chroot) when jetd runs from the initramfs. */
#define VT_COLS 71
#define VT_ROWS 20
#define SB_ROWS 400
#define A_BOLD 1
#define A_DIM 2
#define A_UL 4
#define A_REV 8
#define DEF_FG 0xdcdcdc
#define DEF_BG 0x000000
struct cell { uint32_t fg, bg; unsigned char ch, attr; };
static struct cell vt[VT_ROWS][VT_COLS];
static struct cell vt_alt[VT_ROWS][VT_COLS];                 /* the main screen, kept while the alternate screen shows */
static struct cell sb[SB_ROWS][VT_COLS]; static int sb_head, sb_n;   /* scrollback ring (head = next slot) */
static int vt_cols = 71, vt_rows = 20;
static int cx, cy, wrap_pending, cur_vis = 1, autowrap = 1, insert_mode, alt_screen, origin_mode, dec_gfx;
static uint32_t cur_fg = DEF_FG, cur_bg = DEF_BG; static int cur_attr;
static int st_top, st_bot = 19;                              /* scroll region (inclusive rows) */
static int s_cx, s_cy, s_attr, alt_cx, alt_cy; static uint32_t s_fg = DEF_FG, s_bg = DEF_BG;
static int term_scroll;                                      /* 0 = live screen, n = scrollback lines back */
static int pty_fd = -1; static pid_t pty_pid;
static int esc_state;                                        /* 0 ground, 1 ESC, 2 CSI, 3 OSC/DCS (skip to ST/BEL), 4 ESC + intermediate */
static int csi_par[16], csi_n, csi_priv, csi_has;
static unsigned utf_cp; static int utf_rem;

static const uint32_t ansi_pal[16] = { 0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x2040ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5,
                                       0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff };
static uint32_t pal256(int n) {
    if (n < 16) return ansi_pal[n & 15];
    if (n < 232) { n -= 16; int r = n / 36, g = (n / 6) % 6, b = n % 6; return px(r ? 55 + r * 40 : 0, g ? 55 + g * 40 : 0, b ? 55 + b * 40 : 0); }
    int v = 8 + (n - 232) * 10; return px(v, v, v);
}

static struct cell vt_blank(void) { return (struct cell){ cur_fg, cur_bg, ' ', 0 }; }
static void vt_fill(int row, int c0, int c1) { struct cell b = vt_blank(); for (int c = c0; c <= c1 && c < vt_cols; c++) if (c >= 0) vt[row][c] = b; }
static void vt_clear_all(void) { for (int r = 0; r < vt_rows; r++) vt_fill(r, 0, vt_cols - 1); }

/* lines leaving the top of a full-height scroll by a line feed are history (not on the alternate
 * screen, and not for delete-line / scroll-up commands, which editors use for redraws) */
static void vt_scroll_up(int top, int bot, int n, int hist) {
    for (int k = 0; k < n && top <= bot; k++) {
        if (hist && top == 0 && bot == vt_rows - 1 && !alt_screen) { memcpy(sb[sb_head], vt[0], sizeof vt[0]); sb_head = (sb_head + 1) % SB_ROWS; if (sb_n < SB_ROWS) sb_n++; }
        memmove(vt[top], vt[top + 1], (bot - top) * sizeof vt[0]);
        vt_fill(bot, 0, vt_cols - 1);
    }
}
static void vt_scroll_down(int top, int bot, int n) {
    for (int k = 0; k < n && top <= bot; k++) { memmove(vt[top + 1], vt[top], (bot - top) * sizeof vt[0]); vt_fill(top, 0, vt_cols - 1); }
}
static void vt_linefeed(void) { if (cy == st_bot) vt_scroll_up(st_top, st_bot, 1, 1); else if (cy < vt_rows - 1) cy++; }
static void vt_reverse_lf(void) { if (cy == st_top) vt_scroll_down(st_top, st_bot, 1); else if (cy > 0) cy--; }

static void vt_reset(void) {
    cx = cy = wrap_pending = insert_mode = alt_screen = origin_mode = dec_gfx = 0; cur_vis = autowrap = 1;
    cur_fg = DEF_FG; cur_bg = DEF_BG; cur_attr = 0; st_top = 0; st_bot = vt_rows - 1; esc_state = 0; utf_rem = 0;
    vt_clear_all();
}
/* a new grid size (font toggle): keep the top-left, clamp the cursor, tell the shell */
static void vt_resize(int c, int r) {
    if (c > VT_COLS) c = VT_COLS; if (r > VT_ROWS) r = VT_ROWS; if (c < 1 || r < 1) return;
    if (c == vt_cols && r == vt_rows) return;
    struct cell b = { DEF_FG, DEF_BG, ' ', 0 };
    for (int y = 0; y < VT_ROWS; y++) for (int x = 0; x < VT_COLS; x++) if (y >= vt_rows || x >= vt_cols) vt[y][x] = b;
    vt_cols = c; vt_rows = r; st_top = 0; st_bot = r - 1;
    if (cx >= c) cx = c - 1; if (cy >= r) cy = r - 1; wrap_pending = 0; term_scroll = 0;
    if (pty_fd >= 0) { struct winsize ws = { .ws_row = r, .ws_col = c }; ioctl(pty_fd, TIOCSWINSZ, &ws); }
}
static void vt_geometry_for_font(int f) { vt_resize(W / fonts[f].gw, H / fonts[f].gh); }

static void vt_putc(unsigned c) {
    if (c >= 0x80) c = '?';
    if (dec_gfx) {               /* DEC special graphics: box drawing as ASCII */
        if (c == 'q') c = '-'; else if (c == 'x') c = '|'; else if (c >= 'j' && c <= 'n') c = '+'; else if (c >= 't' && c <= 'w') c = '+'; else if (c == '`' || c == 'a' || c == 'f' || c == 'g' || c == '~') c = '#';
    }
    if (wrap_pending) { wrap_pending = 0; if (autowrap) { cx = 0; vt_linefeed(); } }
    if (insert_mode && cx < vt_cols - 1) memmove(&vt[cy][cx + 1], &vt[cy][cx], (vt_cols - 1 - cx) * sizeof vt[0][0]);
    vt[cy][cx] = (struct cell){ cur_fg, cur_bg, (unsigned char)c, (unsigned char)cur_attr };
    if (cx == vt_cols - 1) wrap_pending = 1; else cx++;
}

static FILE *ptylog;   /* JETD_PTYLOG=<file>: every byte the shell writes (>) and receives (<), for terminal debugging */
static void ptylog_write(char dir, const char *b, size_t n) {
    if (!ptylog) return;
    fprintf(ptylog, "%c ", dir); for (size_t i = 0; i < n; i++) { unsigned char c = b[i]; if (c >= 32 && c < 127) fputc(c, ptylog); else fprintf(ptylog, "\\x%02x", c); } fputc('\n', ptylog); fflush(ptylog);
}
static void vt_reply(const char *s) { fprintf(stderr, "jetd: terminal reply %s\n", s + 1); if (pty_fd >= 0) { write(pty_fd, s, strlen(s)); ptylog_write('<', s, strlen(s)); } }

static void vt_sgr(void) {
    if (csi_n == 0) { csi_par[0] = 0; csi_n = 1; }
    for (int i = 0; i < csi_n; i++) {
        int p = csi_par[i];
        if (p == 0) { cur_attr = 0; cur_fg = DEF_FG; cur_bg = DEF_BG; }
        else if (p == 1) cur_attr |= A_BOLD; else if (p == 2) cur_attr |= A_DIM; else if (p == 4) cur_attr |= A_UL; else if (p == 7) cur_attr |= A_REV;
        else if (p == 5) cur_attr |= A_BOLD;
        else if (p == 22) cur_attr &= ~(A_BOLD | A_DIM); else if (p == 24) cur_attr &= ~A_UL; else if (p == 25) ; else if (p == 27) cur_attr &= ~A_REV;
        else if (p >= 30 && p <= 37) cur_fg = ansi_pal[p - 30]; else if (p >= 90 && p <= 97) cur_fg = ansi_pal[p - 90 + 8];
        else if (p >= 40 && p <= 47) cur_bg = ansi_pal[p - 40]; else if (p >= 100 && p <= 107) cur_bg = ansi_pal[p - 100 + 8];
        else if (p == 39) cur_fg = DEF_FG; else if (p == 49) cur_bg = DEF_BG;
        else if ((p == 38 || p == 48) && i + 1 < csi_n) {
            uint32_t col = p == 38 ? cur_fg : cur_bg;
            if (csi_par[i + 1] == 5 && i + 2 < csi_n) { col = pal256(csi_par[i + 2]); i += 2; }
            else if (csi_par[i + 1] == 2 && i + 4 < csi_n) { col = px(csi_par[i + 2] & 255, csi_par[i + 3] & 255, csi_par[i + 4] & 255); i += 4; }
            else break;
            if (p == 38) cur_fg = col; else cur_bg = col;
        }
    }
}

static void vt_mode(int set) {
    for (int i = 0; i < csi_n; i++) {
        int p = csi_par[i];
        if (csi_priv) {
            if (p == 7) autowrap = set;
            else if (p == 25) cur_vis = set;
            else if (p == 6) { origin_mode = set; cx = 0; cy = set ? st_top : 0; }
            else if (p == 47 || p == 1047 || p == 1049) {
                if (set && !alt_screen) { memcpy(vt_alt, vt, sizeof vt); alt_cx = cx; alt_cy = cy; alt_screen = 1; if (p == 1049) { s_cx = cx; s_cy = cy; s_fg = cur_fg; s_bg = cur_bg; s_attr = cur_attr; } vt_clear_all(); }
                else if (!set && alt_screen) { memcpy(vt, vt_alt, sizeof vt); cx = alt_cx; cy = alt_cy; alt_screen = 0; if (p == 1049) { cur_fg = s_fg; cur_bg = s_bg; cur_attr = s_attr; } }
            }
            /* 1 (cursor keys), 12 (blink), 1000+ (mouse), 2004 (bracketed paste): ignored */
        } else if (p == 4) insert_mode = set;
    }
}

static void vt_csi(unsigned char f) {
    int p0 = csi_n > 0 && csi_par[0] > 0 ? csi_par[0] : 1, p1 = csi_n > 1 && csi_par[1] > 0 ? csi_par[1] : 1;
    int top = origin_mode ? st_top : 0, bot = origin_mode ? st_bot : vt_rows - 1;
    wrap_pending = 0;
    switch (f) {
    case 'A': cy -= p0; if (cy < top) cy = top; break;
    case 'B': cy += p0; if (cy > bot) cy = bot; break;
    case 'C': case 'a': cx += p0; if (cx > vt_cols - 1) cx = vt_cols - 1; break;
    case 'D': cx -= p0; if (cx < 0) cx = 0; break;
    case 'E': cx = 0; cy += p0; if (cy > bot) cy = bot; break;
    case 'F': cx = 0; cy -= p0; if (cy < top) cy = top; break;
    case 'G': case '`': cx = p0 - 1; if (cx > vt_cols - 1) cx = vt_cols - 1; if (cx < 0) cx = 0; break;
    case 'd': cy = top + p0 - 1; if (cy > bot) cy = bot; if (cy < top) cy = top; break;
    case 'H': case 'f': cy = top + p0 - 1; cx = p1 - 1; if (cy > bot) cy = bot; if (cy < top) cy = top; if (cx > vt_cols - 1) cx = vt_cols - 1; break;
    case 'J': {
        int m = csi_n ? csi_par[0] : 0;
        if (m == 0) { vt_fill(cy, cx, vt_cols - 1); for (int r = cy + 1; r < vt_rows; r++) vt_fill(r, 0, vt_cols - 1); }
        else if (m == 1) { for (int r = 0; r < cy; r++) vt_fill(r, 0, vt_cols - 1); vt_fill(cy, 0, cx); }
        else if (m == 2 || m == 3) { vt_clear_all(); if (m == 3) sb_n = 0; }
        break; }
    case 'K': { int m = csi_n ? csi_par[0] : 0; if (m == 0) vt_fill(cy, cx, vt_cols - 1); else if (m == 1) vt_fill(cy, 0, cx); else vt_fill(cy, 0, vt_cols - 1); break; }
    case 'L': if (cy >= st_top && cy <= st_bot) vt_scroll_down(cy, st_bot, p0); break;
    case 'M': if (cy >= st_top && cy <= st_bot) vt_scroll_up(cy, st_bot, p0, 0); break;
    case 'P': { int n = p0 > vt_cols - cx ? vt_cols - cx : p0; memmove(&vt[cy][cx], &vt[cy][cx + n], (vt_cols - cx - n) * sizeof vt[0][0]); vt_fill(cy, vt_cols - n, vt_cols - 1); break; }
    case '@': { int n = p0 > vt_cols - cx ? vt_cols - cx : p0; memmove(&vt[cy][cx + n], &vt[cy][cx], (vt_cols - cx - n) * sizeof vt[0][0]); vt_fill(cy, cx, cx + n - 1); break; }
    case 'X': vt_fill(cy, cx, cx + p0 - 1); break;
    case 'S': vt_scroll_up(st_top, st_bot, p0, 0); break;
    case 'T': vt_scroll_down(st_top, st_bot, p0); break;
    case 'Z': cx = ((cx - 1) / 8) * 8; if (cx < 0) cx = 0; break;
    case 'r': { int t = csi_n > 0 && csi_par[0] > 0 ? csi_par[0] : 1, b = csi_n > 1 && csi_par[1] > 0 ? csi_par[1] : vt_rows;
        if (b > vt_rows) b = vt_rows; if (t < b) { st_top = t - 1; st_bot = b - 1; cx = 0; cy = origin_mode ? st_top : 0; } break; }
    case 's': s_cx = cx; s_cy = cy; s_fg = cur_fg; s_bg = cur_bg; s_attr = cur_attr; break;
    case 'u': cx = s_cx; cy = s_cy; cur_fg = s_fg; cur_bg = s_bg; cur_attr = s_attr; break;
    case 'm': vt_sgr(); break;
    case 'h': vt_mode(1); break;
    case 'l': vt_mode(0); break;
    case 'n': if (csi_priv) break; if (csi_n && csi_par[0] == 6) { char r[32]; snprintf(r, sizeof r, "\033[%d;%dR", cy + 1, cx + 1); vt_reply(r); } else if (csi_n && csi_par[0] == 5) vt_reply("\033[0n"); break;
    case 'c': if (!csi_priv && (!csi_n || csi_par[0] == 0)) vt_reply("\033[?6c"); break;   /* DA: "VT102" (linux u8); CSI ? n c is the console cursor shape, not a request */
    default: break;                             /* g (tabs), q, t, > ... ignored */
    }
}

static void vt_feed(unsigned char c) {
    if (esc_state == 3) { if (c == 7 || c == 0x9c) esc_state = 0; else if (c == 27) esc_state = 5; return; }
    if (esc_state == 5) { esc_state = c == '\\' ? 0 : 3; return; }   /* ESC \ ends an OSC/DCS */
    if (c < 0x20 || c == 0x7f) {                                     /* controls act in every state */
        switch (c) {
        case 27: esc_state = 1; return;
        case '\n': case 11: case 12: vt_linefeed(); wrap_pending = 0; return;
        case '\r': cx = 0; wrap_pending = 0; return;
        case '\b': if (cx) cx--; wrap_pending = 0; return;
        case '\t': { int n = (cx + 8) & ~7; cx = n < vt_cols ? n : vt_cols - 1; return; }
        case 14: dec_gfx = 1; return;    /* SO: G1 (line drawing) */
        case 15: dec_gfx = 0; return;    /* SI: G0 */
        case 24: case 26: esc_state = 0; return;
        default: return;                 /* BEL, NUL, DEL ... */
        }
    }
    switch (esc_state) {
    case 1:
        esc_state = 0;
        switch (c) {
        case '[': esc_state = 2; csi_n = 0; csi_priv = 0; csi_has = 0; memset(csi_par, 0, sizeof csi_par); break;
        case ']': case 'P': case '^': case '_': esc_state = 3; break;
        case '(': case ')': case '#': case '%': esc_state = 4; break;
        case '7': s_cx = cx; s_cy = cy; s_fg = cur_fg; s_bg = cur_bg; s_attr = cur_attr; break;
        case '8': cx = s_cx; cy = s_cy; cur_fg = s_fg; cur_bg = s_bg; cur_attr = s_attr; wrap_pending = 0; break;
        case 'D': vt_linefeed(); break;
        case 'E': cx = 0; vt_linefeed(); break;
        case 'M': vt_reverse_lf(); break;
        case 'c': vt_reset(); break;
        case 'Z': vt_reply("\033[?6c"); break;
        default: break;                  /* = > H N O ... ignored */
        }
        return;
    case 4: esc_state = 0; return;       /* charset designation: the final byte */
    case 2:
        if (c >= '0' && c <= '9') { if (csi_n < 16) { csi_par[csi_n] = csi_par[csi_n] * 10 + (c - '0'); csi_has = 1; } return; }
        if (c == ';') { if (csi_n < 15) csi_n++; csi_has = 1; return; }
        if (c == '?') { csi_priv = 1; return; }
        if (c >= 0x20 && c <= 0x3f) return;                        /* other parameter/intermediate bytes */
        if (csi_has) csi_n++;
        esc_state = 0; vt_csi(c); return;
    default: break;
    }
    /* ground: UTF-8 -> one cell */
    if (utf_rem) { if ((c & 0xc0) == 0x80) { utf_cp = (utf_cp << 6) | (c & 0x3f); if (--utf_rem == 0) vt_putc(utf_cp); return; } utf_rem = 0; }
    if (c < 0x80) vt_putc(c);
    else if ((c & 0xe0) == 0xc0) { utf_cp = c & 0x1f; utf_rem = 1; }
    else if ((c & 0xf0) == 0xe0) { utf_cp = c & 0x0f; utf_rem = 2; }
    else if ((c & 0xf8) == 0xf0) { utf_cp = c & 0x07; utf_rem = 3; }
}

/* the shell: bash (or sh) inside the Debian rootfs when jetd runs from the initramfs, TERM=linux */
static void console_spawn(void) {
    if (pty_fd >= 0) return;
    vt_geometry_for_font(log_font);
    struct winsize ws = { .ws_row = vt_rows, .ws_col = vt_cols };
    pty_pid = forkpty(&pty_fd, NULL, NULL, &ws);
    if (pty_pid < 0 && errno == ENOENT) {   /* no devpts in this root: mount it and retry once */
        mount("devpts", "/dev/pts", "devpts", 0, "mode=620,ptmxmode=666");
        pty_pid = forkpty(&pty_fd, NULL, NULL, &ws);
    }
    if (pty_pid == 0) {
        const char *root = access("/mnt/data/rootfs/bin/sh", X_OK) == 0 ? "/mnt/data/rootfs" : NULL;
        if (root && chroot(root) == 0) chdir("/");
        setenv("TERM", "linux", 1); setenv("HOME", "/root", 1); setenv("LANG", "C.UTF-8", 1); setenv("PS1", "jet$ ", 0);
        setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", 1);
        chdir("/root");
        execl("/bin/bash", "bash", "-l", (char *)0);
        execl("/bin/sh", "sh", "-i", (char *)0);
        _exit(127);
    }
    if (pty_pid < 0) { pty_fd = -1; return; }
    fcntl(pty_fd, F_SETFL, O_NONBLOCK);
    if (!ptylog && getenv("JETD_PTYLOG")) ptylog = fopen(getenv("JETD_PTYLOG"), "a");
    vt_reset(); sb_n = 0; sb_head = 0; term_scroll = 0;
}

static void console_write(const char *text) {
    if (pty_fd < 0) console_spawn();
    if (pty_fd < 0) return;
    char out[512]; int n = 0;
    for (; *text && n < (int)sizeof out - 1; text++) {
        if (*text == '\\' && text[1]) { text++; out[n++] = *text == 'n' || *text == 'r' ? '\r' : *text == 't' ? '\t' : *text == 'e' ? 27 : *text; }   /* Enter is CR on a terminal */
        else out[n++] = *text == '\n' ? '\r' : *text;
    }
    write(pty_fd, out, n); ptylog_write('<', out, n);
}

static void console_read(void) {
    char buf[2048]; ssize_t r;
    while ((r = read(pty_fd, buf, sizeof buf)) > 0) { ptylog_write('>', buf, r); for (ssize_t i = 0; i < r; i++) vt_feed((unsigned char)buf[i]); }
    if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) {    /* shell exited */
        close(pty_fd); pty_fd = -1; waitpid(pty_pid, NULL, WNOHANG);
        const char *m = "\r\n[shell exited: front hold > remote, or any key restarts]"; while (*m) vt_feed((unsigned char)*m++);
    }
    dirty = 1;
}

static uint32_t shade(uint32_t c, int attr) {
    if (attr & A_BOLD) { unsigned r = (c >> 16) + 60, g = ((c >> 8) & 255) + 60, b = (c & 255) + 60; return px(r > 255 ? 255 : r, g > 255 ? 255 : g, b > 255 ? 255 : b); }
    if (attr & A_DIM) return px((c >> 16) * 2 / 3, ((c >> 8) & 255) * 2 / 3, (c & 255) * 2 / 3);
    return c;
}
static void draw_cell(int x, int y, const struct cell *c, int cursor) {
    uint32_t f = shade(c->fg, c->attr), b = c->bg;
    if ((c->attr & A_REV) ^ cursor) { uint32_t t = f; f = b; b = t; if (cursor && f == b) f = DEF_FG; }
    if (b != DEF_BG) fill_rect(x, y, gw, gh, b);
    if (c->ch != ' ') { fg = f; draw_glyph(x, y, c->ch); }
    if (c->attr & A_UL) fill_rect(x, y + gh - 1, gw, 1, f);
}

static void render_console(void) {
    clear_screen();
    vt_geometry_for_font(fsel);                       /* the font the render selected */
    if (pty_fd < 0 && sb_n == 0 && cx == 0 && cy == 0) { fg = px(255, 80, 80); draw_row_centred(3, "no shell: pty unavailable"); draw_row_centred(4, "(is devpts mounted?)"); return; }
    if (term_scroll > sb_n) term_scroll = sb_n; if (term_scroll < 0) term_scroll = 0;
    for (int r = 0; r < vt_rows; r++) {
        int src = r - term_scroll;                      /* < 0: a scrollback line */
        const struct cell *line = src >= 0 ? vt[src] : sb[((sb_head + src) % SB_ROWS + SB_ROWS) % SB_ROWS];
        for (int c = 0; c < vt_cols; c++) draw_cell(c * gw, r * gh, &line[c], src >= 0 && cur_vis && pty_fd >= 0 && src == cy && c == (wrap_pending ? cx : cx));
    }
    if (term_scroll) { fg = px(255, 200, 0); char s[32]; snprintf(s, sizeof s, "^%d", term_scroll); fill_rect(W - text_width(s) - 4, 0, text_width(s) + 4, gh, DEF_BG); draw_text(W - text_width(s) - 2, 0, s); }
}


/* ---- glance sensor (APDS9900 via tsl2772 IIO, name tmd2771): polled 4 Hz, hysteresis ------
 * One reading, two classifications, each with 1 s of agreement before it changes:
 * - glance "g <at> <raw>": the eye is at the glass (lower) vs looking ahead (higher), thresholds
 *   "on off" from the user's calibration in /mnt/data/mainline/glance (either polarity).
 * - wear "o <worn> <raw>": the glasses are on a head at all. Off the head the sensor sees nothing
 *   (raw ~0, spikes to ~60); worn it reads 130-320 whichever way the eye looks, so fixed
 *   thresholds (>= 100 worn, <= 60 off) hold without calibration; "on off" in mainline/wear
 *   overrides them. */
static char glance_path[128];
static int glance_on_thr = 820, glance_off_thr = 720, glance_worn = -1, glance_raw = -1, glance_run = 0;
static int wear_on_thr = 100, wear_off_thr = 60, wear_worn = -1, wear_run = 0;
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
    const char *wpaths[] = { "/android-data/mainline/wear", "/mnt/data/mainline/wear" };
    for (int i = 0; i < 2; i++) { FILE *f = fopen(wpaths[i], "r"); if (!f) continue; if (fscanf(f, "%d %d", &wear_on_thr, &wear_off_thr) != 2 || wear_on_thr <= wear_off_thr) { wear_on_thr = 100; wear_off_thr = 60; } fclose(f); break; }
    if (glance_path[0]) fprintf(stderr, "jetd: glance sensor %s (glance on>=%d off<=%d, wear on>=%d off<=%d)\n", glance_path, glance_on_thr, glance_off_thr, wear_on_thr, wear_off_thr);
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
    int wear = raw >= wear_on_thr ? 1 : raw <= wear_off_thr ? 0 : -1;
    if (wear < 0 || wear == wear_worn) wear_run = 0;
    else if (++wear_run >= 4) { wear_run = 0; wear_worn = wear; sendf("o %d %d\n", wear_worn, raw); }
    int want;                                                               /* -1: in the dead band */
    if (glance_on_thr >= glance_off_thr) want = raw >= glance_on_thr ? 1 : raw <= glance_off_thr ? 0 : -1;
    else                                 want = raw <= glance_on_thr ? 1 : raw >= glance_off_thr ? 0 : -1;   /* inverted sensor */
    if (want < 0 || want == glance_worn) { glance_run = 0; return; }
    if (++glance_run < 4) return;                                          /* 1 s of agreement */
    glance_run = 0; glance_worn = want;
    sendf("g %d %d\n", glance_worn, glance_raw);
}

/* ---- power (TWL6032 PMIC): battery/charger/USB state for the Q snapshot ---------
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
}

/* ---- chooser overlay + dispatch ------------------------------------------------ */
static void set_mode(int m) {
    if (m == mode) return;
    mode = m; dirty = 1;
    if (mode == M_CONSOLE) console_spawn();
    if (mode == M_LOG) log_scroll = 0;
    sendf("m %s\n", mode_names[mode]);
    if (mode == M_REMOTE) { clear_screen(); fb_flush(); send_hello(); }
}

/* The dead-man chooser: shown only when no client owns the UI (the app is gone). Deliberately
 * not a menu system - the app owns every real menu (docs/interaction-design.md); this is the
 * field escape hatch: read the log, get a shell, power the Bluetooth radio for a keyboard,
 * or reboot (which brings the app back). */
#define CHOOSER_N 4
/* userdata is /mnt/data in the initramfs (the flashed jetd) but /android-data when a dev build
 * runs from an ssh session (dropbear lives in the chroot); same for reaching bluetoothctl */
static const char *bt_marker_path(void) {
    return access("/mnt/data/mainline", F_OK) == 0 ? "/mnt/data/mainline/bt" : "/android-data/mainline/bt";
}
static int bt_marker(void) { return access(bt_marker_path(), F_OK) == 0; }
static void bt_toggle(void) {
    int on = !bt_marker();
    if (on) { FILE *f = fopen(bt_marker_path(), "w"); if (f) fclose(f); }
    else unlink(bt_marker_path());
    if (fork() == 0) {
        if (access("/mnt/data/rootfs", F_OK) == 0)
            execl("/bin/chroot", "chroot", "/mnt/data/rootfs", "/usr/bin/bluetoothctl", "power", on ? "on" : "off", (char *)0);
        execl("/usr/bin/bluetoothctl", "bluetoothctl", "power", on ? "on" : "off", (char *)0);
        _exit(127);
    }
}
static void render_chooser(void) {
    int bw = 22 * gw * scale, bh = (CHOOSER_N + 2) * gh * scale, bx = (W - bw) / 2, by = (H - bh) / 2;
    fill_rect(bx - 2, by - 2, bw + 4, bh + 4, px(255, 255, 0)); fill_rect(bx, by, bw, bh, px(0, 0, 0));
    fg = px(255, 255, 0); draw_text(bx + gw * scale, by, "RECOVERY");
    const char *labels[CHOOSER_N] = { "log", "shell", bt_marker() ? "bluetooth: on" : "bluetooth: off", "reboot" };
    int current = mode == M_LOG ? 0 : mode == M_CONSOLE ? 1 : -1;
    for (int i = 0; i < CHOOSER_N; i++) {
        char s[40]; snprintf(s, sizeof s, "%s%s%s", i == chooser_sel ? "> " : "  ", labels[i], i == current ? " *" : "");
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
        else clear_screen();
        if (chooser) { font_select(1); render_chooser(); }
        fb_flush();
        font_select(1);   /* protocol geometry (hello, hub rows) is always the normal font */
    }
}

/* short press of a pod button, a swipe key from the pad, or raw motion */
static void dispatch_key(unsigned code) {
    if (chooser) {
        if (code == KEY_UP) chooser_sel = (chooser_sel + CHOOSER_N - 1) % CHOOSER_N;
        else if (code == KEY_DOWN) chooser_sel = (chooser_sel + 1) % CHOOSER_N;
        else if (code == BTN_FRONT_CODE || code == KEY_ENTER) {
            if (chooser_sel == 2) bt_toggle();                 /* toggles in place so the state shows */
            else if (chooser_sel == 3) { if (fork() == 0) { execl("/bin/reboot2", "reboot2", (char *)0); _exit(127); } }
            else { chooser = 0; auto_remote = 0; set_mode(chooser_sel == 0 ? M_LOG : M_CONSOLE); }
        }
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
    case M_CONSOLE:                        /* pad swipes page the scrollback; the keyboard talks to the shell */
        if (code == KEY_UP) term_scroll += 3;
        else if (code == KEY_DOWN) term_scroll -= 3;
        else if (code == BTN_FRONT_CODE) { log_font = !log_font; vt_geometry_for_font(log_font); }
        else if (code == BTN_REAR_CODE) {   /* rear exits (ascend); a keyboard's Ctrl+C interrupts */
            if (raw_keys && nhubs) set_mode(M_REMOTE);
            else { chooser = 1; chooser_sel = 1; }
        }
        dirty = 1;
        break;
    }
}

static void dispatch_rel(int dx, int dy) {
    if (chooser) return;
    if (mode == M_REMOTE) sendf("r %d %d\n", dx, dy);
}

/* ---- keyboard (BT/USB HID): types into the shell -------------------------------- */
static int kbd_mods;   /* 1 shift, 2 ctrl, 4 alt */
static const char *kmap[128] = {   /* US layout: [code] = "plain shifted" */
    [KEY_1] = "1!", [KEY_2] = "2@", [KEY_3] = "3#", [KEY_4] = "4$", [KEY_5] = "5%", [KEY_6] = "6^", [KEY_7] = "7&", [KEY_8] = "8*", [KEY_9] = "9(", [KEY_0] = "0)",
    [KEY_MINUS] = "-_", [KEY_EQUAL] = "=+", [KEY_LEFTBRACE] = "[{", [KEY_RIGHTBRACE] = "]}", [KEY_SEMICOLON] = ";:", [KEY_APOSTROPHE] = "'\"", [KEY_GRAVE] = "`~",
    [KEY_BACKSLASH] = "\\|", [KEY_COMMA] = ",<", [KEY_DOT] = ".>", [KEY_SLASH] = "/?", [KEY_SPACE] = "  ",
    [KEY_Q] = "qQ", [KEY_W] = "wW", [KEY_E] = "eE", [KEY_R] = "rR", [KEY_T] = "tT", [KEY_Y] = "yY", [KEY_U] = "uU", [KEY_I] = "iI", [KEY_O] = "oO", [KEY_P] = "pP",
    [KEY_A] = "aA", [KEY_S] = "sS", [KEY_D] = "dD", [KEY_F] = "fF", [KEY_G] = "gG", [KEY_H] = "hH", [KEY_J] = "jJ", [KEY_K] = "kK", [KEY_L] = "lL",
    [KEY_Z] = "zZ", [KEY_X] = "xX", [KEY_C] = "cC", [KEY_V] = "vV", [KEY_B] = "bB", [KEY_N] = "nN", [KEY_M] = "mM",
    [KEY_KPASTERISK] = "**", [KEY_KPMINUS] = "--", [KEY_KPPLUS] = "++", [KEY_KPDOT] = "..", [KEY_KPSLASH] = "//",
    [KEY_KP0] = "00", [KEY_KP1] = "11", [KEY_KP2] = "22", [KEY_KP3] = "33", [KEY_KP4] = "44", [KEY_KP5] = "55", [KEY_KP6] = "66", [KEY_KP7] = "77", [KEY_KP8] = "88", [KEY_KP9] = "99",
};
/* keys that are escape sequences (what the Linux console sends: TERM=linux's terminfo) */
static const char *kseq(unsigned code) {
    switch (code) {
    case KEY_UP: return "\033[A"; case KEY_DOWN: return "\033[B"; case KEY_RIGHT: return "\033[C"; case KEY_LEFT: return "\033[D";
    case KEY_HOME: return "\033[1~"; case KEY_INSERT: return "\033[2~"; case KEY_DELETE: return "\033[3~"; case KEY_END: return "\033[4~";
    case KEY_PAGEUP: return "\033[5~"; case KEY_PAGEDOWN: return "\033[6~";
    case KEY_F1: return "\033[[A"; case KEY_F2: return "\033[[B"; case KEY_F3: return "\033[[C"; case KEY_F4: return "\033[[D"; case KEY_F5: return "\033[[E";
    case KEY_F6: return "\033[17~"; case KEY_F7: return "\033[18~"; case KEY_F8: return "\033[19~"; case KEY_F9: return "\033[20~"; case KEY_F10: return "\033[21~";
    case KEY_F11: return "\033[23~"; case KEY_F12: return "\033[24~";
    default: return NULL;
    }
}

/* A key from a keyboard-class device. Returns 1 when consumed here (the shell toggle, every key
 * while the shell is showing, and the modifiers unless a raw-keys client owns the keyboard); 0 hands
 * it to the ordinary key path, so in remote mode a client that asked for raw keys sees keyboard keys
 * as `k <code> <value>` like any other, Shift/Ctrl/Alt included (Doom fires with Ctrl). The
 * modifier state is tracked either way, so Ctrl+Alt+Enter keeps working.
 * In the shell: Alt prefixes ESC (Meta), Ctrl makes control codes (Ctrl+Space = NUL, Ctrl+/ = ^_),
 * Shift+PgUp/PgDn page the scrollback, Enter is CR, Backspace is DEL. */
static int kbd_key(unsigned code, int value) {
    int mbit = code == KEY_LEFTSHIFT || code == KEY_RIGHTSHIFT ? 1 : code == KEY_LEFTCTRL || code == KEY_RIGHTCTRL ? 2 : code == KEY_LEFTALT || code == KEY_RIGHTALT ? 4 : 0;
    if (mbit) { if (value) kbd_mods |= mbit; else kbd_mods &= ~mbit; return !(raw_keys && nhubs && mode != M_CONSOLE); }
    if (code == KEY_ENTER && (kbd_mods & 6) == 6) {                  /* Ctrl+Alt+Enter: shell on/off */
        if (value == 1) { chooser = 0; auto_remote = 0; set_mode(mode == M_CONSOLE ? M_REMOTE : M_CONSOLE); }
        return 1;
    }
    if (mode != M_CONSOLE) return 0;
    if (value == 0) return 1;                                          /* presses and repeats type; releases do not */
    if ((kbd_mods & 1) && (code == KEY_PAGEUP || code == KEY_PAGEDOWN)) {   /* scrollback paging */
        term_scroll += code == KEY_PAGEUP ? vt_rows - 1 : -(vt_rows - 1); if (term_scroll < 0) term_scroll = 0; dirty = 1; return 1;
    }
    char out[12]; int n = 0;
    if (kbd_mods & 4) out[n++] = 27;                                   /* Alt = Meta: ESC prefix */
    const char *seq = kseq(code);
    if (seq) { while (*seq) out[n++] = *seq++; }
    else {
        char c;
        switch (code) {
        case KEY_ENTER: case KEY_KPENTER: c = '\r'; break;
        case KEY_BACKSPACE: c = 0x7f; break;
        case KEY_TAB: if (kbd_mods & 1) { out[n++] = 27; out[n++] = '['; c = 'Z'; } else c = '\t'; break;
        case KEY_ESC: c = 27; break;
        default:
            if (code >= 128 || !kmap[code]) return 1;
            c = kmap[code][kbd_mods & 1];
            if (kbd_mods & 2) {                                        /* control codes */
                if ((c | 0x20) >= 'a' && (c | 0x20) <= 'z') c = (c | 0x20) - 'a' + 1;
                else if (c == ' ' || c == '2' || c == '@') c = 0;
                else if (c == '[' || c == '3') c = 27; else if (c == '\\' || c == '4') c = 28; else if (c == ']' || c == '5') c = 29;
                else if (c == '^' || c == '6') c = 30; else if (c == '_' || c == '-' || c == '/' || c == '7') c = 31; else if (c == '?' || c == '8') c = 0x7f;
            }
        }
        out[n++] = c;
    }
    if (pty_fd < 0) console_spawn();
    if (pty_fd >= 0) { write(pty_fd, out, n); ptylog_write('<', out, n); }
    term_scroll = 0; dirty = 1;
    return 1;
}

/* raw evdev: buttons get hold detection, everything else goes straight through */
static struct { int down; int64_t t; int consumed; } btn[2];   /* 0 front, 1 rear */

/* K 1: raw keys. In remote mode every key event (down and up, both pod buttons and the touchpad
 * swipe keys) is forwarded as it happens and jetd's own hold-to-open chooser is off, so the
 * application layer owns the button semantics. Other modes keep jetd's handling. */
static void raw_key(unsigned code, int value) {
    if (raw_keys && nhubs && mode != M_CONSOLE) { if (mode != M_REMOTE) set_mode(M_REMOTE); chooser = 0; sendf("k %u %d\n", code, value); return; }
    int b = code == BTN_FRONT_CODE ? 0 : code == BTN_REAR_CODE ? 1 : -1;
    if (b < 0) { if (value == 1) dispatch_key(code); return; }
    if (value == 1) { btn[b].down = 1; btn[b].t = now_ms(); btn[b].consumed = 0; }
    else if (value == 0 && btn[b].down) { btn[b].down = 0; if (!btn[b].consumed) dispatch_key(code); }
}

static void check_holds(void) {
    if (btn[0].down && !btn[0].consumed && now_ms() - btn[0].t >= HOLD_MS) {
        btn[0].consumed = 1;
        if (raw_keys && nhubs) {               /* the app owns the UI: its menu, never ours */
            if (mode != M_REMOTE) set_mode(M_REMOTE);   /* shell/log hand back (remote holds were forwarded) */
            return;
        }
        chooser = !chooser; chooser_sel = mode == M_CONSOLE ? 1 : 0; dirty = 1;
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

/* ---- mirror (N): tee panel pushes and speaker audio to subscribed clients -------------------
 * The panel is manual-update, so every change already names its rectangle: mirroring is a tee of
 * fbmem bytes at the two push sites above, no encoding (428x240 is small enough raw). Unlike
 * send_fd_all this must never block the UI loop, so a rect is written only when it wholly fits
 * the socket's free space (SO_SNDBUF - TIOCOUTQ); otherwise the client is marked for a banded
 * full refresh, which reads the live framebuffer and therefore converges on current content no
 * matter what was dropped. A short write would tear the framing, so it ends the mirror. */
#define MIRROR_BAND 32   /* refresh band: 32 rows = 27 KB at 16 bpp, fits a default send buffer */
static int mirror_fit(int fd, size_t need) {
    int queued = 0, sndbuf = 0; socklen_t sl = sizeof sndbuf;
    if (ioctl(fd, TIOCOUTQ, &queued) < 0 || getsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, &sl) < 0) return 0;
    return sndbuf - queued > (int)need + 64;
}
static int mirror_rect(struct hub *hb, int x, int y, int w, int h) {   /* 0 sent, -1 no room, -2 dead */
    unsigned bpp = vinfo.bits_per_pixel / 8;
    size_t rowlen = (size_t)w * bpp, len = rowlen * h;
    char hdr[64]; int hl = snprintf(hdr, sizeof hdr, "b %d %d %d %d %zu\n", x, y, w, h, len);
    if (!mirror_fit(hb->fd, hl + len)) return -1;
    struct iovec iov[1 + 256]; int niov = 0;
    iov[niov++] = (struct iovec){ hdr, (size_t)hl };
    for (int r = 0; r < h; r++) iov[niov++] = (struct iovec){ fbmem + (size_t)(y + r) * finfo.line_length + (size_t)x * bpp, rowlen };
    ssize_t wr = writev(hb->fd, iov, niov);
    if (wr == (ssize_t)(hl + len)) return 0;
    hb->mirror = 0;                               /* short write after the fit check: framing torn */
    return -2;
}
static void mirror_bands(struct hub *hb) {        /* continue a full refresh while there is room */
    while (hb->mirror && hb->mirror_y < H) {
        int rows = H - hb->mirror_y < MIRROR_BAND ? (int)(H - hb->mirror_y) : MIRROR_BAND;
        if (mirror_rect(hb, 0, hb->mirror_y, W, rows) != 0) return;
        hb->mirror_y += rows;
    }
}
static int64_t mirror_last_tee;
static void mirror_tee(int x, int y, int w, int h) {
    mirror_last_tee = now_ms();
    for (int i = 0; i < nhubs; i++) {
        struct hub *hb = &hubs[i];
        if (!hb->mirror) continue;
        if (hb->mirror_y < H) { mirror_bands(hb); continue; }   /* refreshing: bands read live pixels anyway */
        if (mirror_rect(hb, x, y, w, h) == -1) hb->mirror_y = 0;   /* no room: owe a full refresh */
    }
}
static int mirror_pending(void) {
    for (int i = 0; i < nhubs; i++) if (hubs[i].mirror && hubs[i].mirror_y < H) return 1;
    return 0;
}
static int mirror_on(void) {
    for (int i = 0; i < nhubs; i++) if (hubs[i].mirror) return 1;
    return 0;
}
/* Direct-framebuffer writers (Doom pushes its own update windows; fbfill; anything run from the
 * shell) never pass the tee above. Fallback: while mirrors are subscribed and no tee has fired
 * recently, checksum the framebuffer in bands and tee the ones that changed — a few MB/s of
 * reads at worst, ~7 fps of mirror for a 35 fps game, zero cost while the normal tee flows. */
static uint32_t mirror_band_sum[(240 + MIRROR_BAND - 1) / MIRROR_BAND];
static uint32_t band_checksum(unsigned y, unsigned rows) {
    uint32_t s = 2166136261u;
    for (unsigned r = 0; r < rows; r++) {
        const uint32_t *p = (const uint32_t *)(fbmem + (size_t)(y + r) * finfo.line_length);
        for (unsigned i = 0; i < W * (vinfo.bits_per_pixel / 8) / 4; i++) s = (s ^ p[i]) * 16777619u;
    }
    return s;
}
static void mirror_scan(void) {
    if (!mirror_on() || now_ms() - mirror_last_tee < 150) return;
    for (unsigned b = 0, y = 0; y < H; b++, y += MIRROR_BAND) {
        unsigned rows = H - y < MIRROR_BAND ? H - y : MIRROR_BAND;
        uint32_t s = band_checksum(y, rows);
        if (s == mirror_band_sum[b]) continue;
        mirror_band_sum[b] = s;
        mirror_tee(0, y, W, rows);
    }
}
static void mirror_audio(const void *buf, size_t len) {   /* tee of queued speaker PCM; chunks drop, never block */
    for (int i = 0; i < nhubs; i++) {
        struct hub *hb = &hubs[i];
        if (!hb->mirror) continue;
        char hdr[32]; int hl = snprintf(hdr, sizeof hdr, "u %zu\n", len);
        if (!mirror_fit(hb->fd, hl + len)) continue;
        struct iovec iov[2] = { { hdr, (size_t)hl }, { (void *)buf, len } };
        if (writev(hb->fd, iov, 2) != (ssize_t)(hl + len)) hb->mirror = 0;
    }
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
    /* clamp to the panel: vf_draw only clamps the far edges, and a negative origin (a client
     * asking before it knows the geometry) would scribble fbmem outside the rectangle */
    if (x < 0) { w += x; x = 0; } if (y < 0) { h += y; y = 0; }
    if (x + w > (int)W) w = W - x; if (y + h > (int)H) h = H - y;
    if (w <= 0 || h <= 0) { sendf("e viewfinder: empty rectangle\n"); return; }
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
 * The mic is one arecord (hw:0,1, 96 kHz S32 stereo, the DMIC's only mode) downmixed and
 * decimated here to 16 kHz mono S16 in 100 ms chunks; it runs while a turn or the wake word
 * detector needs it.
 * V [max_s]  a turn: chunks stream out as "a <len>\n"+bytes until silence (energy VAD: ~0.8 s
 *            below the floor after speech), max_s (default 8) or "v"; then "A <end|max|stop|error>".
 * D 1 [cutoff [window]]  listen: chunks feed jetwake (agent/wake, a microWakeWord model from
 *            mainline/wake.tflite) instead, except while the speaker plays (no self-waking).
 *            A hit sends "d <avg> <max>" and begins a turn at once: the 300 ms before the hit go
 *            out first (the command's first syllable), the VAD floor is what the room measured
 *            before the wake word and speech counts as already started, so "heya jet, look"
 *            ends on the silence after "look". D 0 stops; "x <on|off|error ...>" reports.
 * W <len>    + <len> bytes of 48 kHz stereo S16 PCM to play (aplay hw:0,0); chunks are queued
 *            and drained without blocking the UI; "w" marks the end -> "w" back when played. */
#define ALPINE "/mnt/data/rootfs"      /* the userdata rootfs (symlink; see kernel/rootfs) */
static pid_t cap_pid, play_pid, wake_pid;
static int cap_fd = -1, play_fd = -1, wake_in = -1, wake_out = -1;
/* turn_on: a turn streams to the clients; listen_on: the mic feeds the detector (both declared with hub_drop) */
static int64_t cap_t0, cap_max_ms, cap_last_voice, play_last;
static int cap_speech, cap_chunks; static double cap_floor, cap_peak;
static int32_t cap_acc[2]; static int cap_accn;              /* decimation accumulator */
static int16_t cap_out[1600]; static int cap_outn;            /* 100 ms of 16 kHz mono */
static unsigned char cap_in[76800]; static size_t cap_inlen;
static double floor_hist[30]; static int floor_i;             /* chunk RMS over the last 3 s of listening */
static int16_t pre[3][1600]; static int pre_n, pre_i;         /* the last 300 ms before a wake */
static char wake_line[128]; static int wake_linelen;
static unsigned char *play_buf; static size_t play_len, play_off, play_cap; static int play_end;
static void listen_stop(const char *why);

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
/* a child fed on stdin (*in, non-blocking: a stalled detector drops audio rather than stalling jetd) and read on stdout (*out); stderr stays ours */
static pid_t spawn_duplex(char *const argv[], int *in, int *out) {
    int a[2], b[2];
    if (pipe2(a, O_CLOEXEC) < 0) return -1;
    if (pipe2(b, O_CLOEXEC) < 0) { close(a[0]); close(a[1]); return -1; }
    pid_t pid = fork();
    if (pid < 0) { close(a[0]); close(a[1]); close(b[0]); close(b[1]); return -1; }
    if (pid == 0) { dup2(a[0], 0); dup2(b[1], 1); close(a[0]); close(a[1]); close(b[0]); close(b[1]); execv(argv[0], argv); _exit(127); }
    close(a[0]); close(b[1]); *in = a[1]; *out = b[0];
    fcntl(*in, F_SETFL, fcntl(*in, F_GETFL) | O_NONBLOCK);
    return pid;
}

static double chunk_rms(void) { double sq = 0; for (int i = 0; i < cap_outn; i++) sq += (double)cap_out[i] * cap_out[i]; return sqrt(sq / (cap_outn ? cap_outn : 1)); }
/* energy VAD: the first 300 ms set the floor, speech is 3x it, 0.8 s under 1.5x it (or under 8 % of the
 * loudest chunk: the mics take seconds to settle back to the room after a loud voice) ends the turn */
static void turn_vad(double rms) {
    cap_chunks++;
    if (cap_chunks <= 3) { if (rms > cap_floor) cap_floor = rms; return; }
    if (rms > cap_peak) cap_peak = rms;
    double start = cap_floor * 3 > 300 ? cap_floor * 3 : 300, end = cap_floor * 1.5 > 150 ? cap_floor * 1.5 : 150;
    if (cap_peak * 0.08 > end) end = cap_peak * 0.08;
    if (rms > start) { cap_speech = 1; cap_last_voice = now_ms(); }
    else if (cap_speech && rms < end && now_ms() - cap_last_voice > 800) cap_speech = 2;   /* trailing silence done */
}
static void chunk_send(const int16_t *pcm, int n) { if (nhubs && n > 0) { sendf("a %d\n", n * 2); send_all(pcm, n * 2); } }
/* a 100 ms chunk is complete (or a turn ends on a partial one): to the clients during a turn, else to the detector */
static void chunk_ready(void) {
    if (!cap_outn) return;
    double rms = chunk_rms();
    if (turn_on) { turn_vad(rms); chunk_send(cap_out, cap_outn); if (getenv("JETD_VAD")) fprintf(stderr, "vad %lld %.0f %d\n", (long long)(now_ms() - cap_t0), rms, cap_speech); }
    else {
        floor_hist[floor_i++ % 30] = rms;
        memcpy(pre[pre_i], cap_out, cap_outn * 2); pre_i = (pre_i + 1) % 3; if (pre_n < 3) pre_n++;
        if (listen_on && wake_in >= 0 && play_pid <= 0 && write(wake_in, cap_out, cap_outn * 2) < 0 && errno != EAGAIN) listen_stop("error detector gone");
    }
    cap_outn = 0;
}
static void mic_close(void) {
    if (cap_pid <= 0 || turn_on || listen_on) return;
    kill(cap_pid, SIGTERM); close(cap_fd); cap_fd = -1; waitpid(cap_pid, NULL, 0); cap_pid = 0;
}
static int mic_open(void) {
    if (cap_pid > 0) return 1;
    /* from the initramfs the ALSA tools live in the Alpine chroot; when jetd itself runs inside
     * the chroot (live testing over ssh) they are plain /usr/bin paths */
    char *argv_chroot[] = { "/bin/chroot", ALPINE, "/usr/bin/arecord", "-q", "-D", "hw:0,1", "-c", "2", "-r", "96000", "-f", "S32_LE", "-t", "raw", "-", NULL };
    char *argv_direct[] = { "/usr/bin/arecord", "-q", "-D", "hw:0,1", "-c", "2", "-r", "96000", "-f", "S32_LE", "-t", "raw", "-", NULL };
    cap_pid = spawn_pipe(access(ALPINE "/usr/bin/arecord", X_OK) == 0 ? argv_chroot : argv_direct, &cap_fd, 0);
    if (cap_pid <= 0) return 0;
    cap_accn = 0; cap_outn = 0; cap_inlen = 0; cap_acc[0] = cap_acc[1] = 0; pre_n = 0; pre_i = 0; floor_i = 0;
    return 1;
}
static void turn_end(const char *why) {
    if (!turn_on) return;
    chunk_ready();
    turn_on = 0;
    fprintf(stderr, "jetd: turn %s after %lld ms (last voice %lld ms in, floor %.0f)\n", why, (long long)(now_ms() - cap_t0), (long long)(cap_last_voice - cap_t0), cap_floor);
    sendf("A %s\n", why);
    mic_close();
}
/* V, or a wake word: stream chunks to the clients until silence, max_s or v */
static void turn_begin(int max_s, int wake) {
    if (turn_on) turn_end("restart");
    if (!mic_open()) { sendf("A error\n"); return; }
    cap_t0 = now_ms(); cap_max_ms = (max_s > 0 ? max_s : 8) * 1000LL; cap_last_voice = cap_t0;
    turn_on = 1; cap_speech = 0; cap_chunks = 0; cap_floor = 0; cap_peak = 0;
    if (wake) {
        /* the user is already talking: the floor is the room before the wake word (the mean of the
         * quieter half of the last 3 s, which leaves the wake word itself out), and the last 300 ms
         * carry the command's first syllable */
        int n = floor_i < 30 ? floor_i : 30; double sum = 0, mean = 0, f = 0; int k = 0;
        for (int i = 0; i < n; i++) sum += floor_hist[i];
        if (n) mean = sum / n;
        for (int i = 0; i < n; i++) if (floor_hist[i] <= mean) { f += floor_hist[i]; k++; }
        cap_floor = k ? f / k : 0; cap_chunks = 3; cap_speech = 1;
        fprintf(stderr, "jetd: wake turn: floor %.0f (room mean %.0f over %d chunks), speech above %.0f, silence below %.0f\n", cap_floor, mean, n, cap_floor * 3 > 300 ? cap_floor * 3 : 300, cap_floor * 1.5 > 150 ? cap_floor * 1.5 : 150);
        for (int i = 0; i < pre_n; i++) chunk_send(pre[(pre_i + 3 - pre_n + i) % 3], 1600);
    }
    pre_n = 0;
}
static void cap_read(void) {
    ssize_t r = read(cap_fd, cap_in + cap_inlen, sizeof cap_in - cap_inlen);
    if (r <= 0) {   /* arecord died: the turn (if any) fails, listening stops */
        int t = turn_on; turn_on = 0;
        close(cap_fd); cap_fd = -1; waitpid(cap_pid, NULL, 0); cap_pid = 0;
        if (t) sendf("A error\n");
        if (listen_on) listen_stop("error mic gone");
        return;
    }
    cap_inlen += r;
    size_t frames = cap_inlen / 8, i;
    const int32_t *f = (const int32_t *)cap_in;
    for (i = 0; i < frames; i++) {
        cap_acc[0] += f[2 * i] >> 8; cap_acc[1] += f[2 * i + 1] >> 8;    /* 24-bit samples, headroom for 12 adds */
        if (++cap_accn == 6) {
            int32_t v = (cap_acc[0] + cap_acc[1]) / 12;                   /* average L+R over 6 frames */
            v >>= 8; if (v > 32767) v = 32767; if (v < -32768) v = -32768;
            cap_out[cap_outn++] = (int16_t)v; cap_acc[0] = cap_acc[1] = 0; cap_accn = 0;
            if (cap_outn == 1600) chunk_ready();
        }
    }
    size_t used = frames * 8; memmove(cap_in, cap_in + used, cap_inlen - used); cap_inlen -= used;
    if (turn_on) { if (cap_speech == 2) turn_end("end"); else if (now_ms() - cap_t0 > cap_max_ms) turn_end("max"); }
}
/* ---- wake word: jetwake reads our 16 kHz chunks and prints "wake <ms> <avg> <max>" per hit ---- */
static void listen_stop(const char *why) {
    if (wake_pid > 0) { kill(wake_pid, SIGTERM); close(wake_in); close(wake_out); wake_in = wake_out = -1; waitpid(wake_pid, NULL, 0); wake_pid = 0; }
    listen_on = 0; wake_linelen = 0;
    sendf("x %s\n", why);
    mic_close();
}
static void listen_start(const char *args) {   /* "[cutoff [window]]" after D 1 */
    /* already listening: start over, the client may have a new model or cutoff */
    if (wake_pid > 0) { kill(wake_pid, SIGTERM); close(wake_in); close(wake_out); wake_in = wake_out = -1; waitpid(wake_pid, NULL, 0); wake_pid = 0; wake_linelen = 0; }
    static const char *bins[] = { "/bin/jetwake", "/mnt/data/wake/jetwake", "/android-data/wake/jetwake" };
    static const char *models[] = { "/mnt/data/mainline/wake.tflite", "/android-data/mainline/wake.tflite" };
    const char *bin = NULL, *model = NULL;
    for (int i = 0; i < 3 && !bin; i++) if (access(bins[i], X_OK) == 0) bin = bins[i];
    for (int i = 0; i < 2 && !model; i++) if (access(models[i], R_OK) == 0) model = models[i];
    if (!bin || !model) { sendf("x error %s\n", !bin ? "no detector" : "no model"); return; }
    char cutoff[16] = "0.97", window[8] = "5"; float c; int w;
    int got = sscanf(args, "%f %d", &c, &w);
    if (got >= 1 && c > 0 && c <= 1) snprintf(cutoff, sizeof cutoff, "%.3f", c);
    if (got == 2 && w > 0 && w < 100) snprintf(window, sizeof window, "%d", w);
    char *argv[] = { (char *)bin, "--cutoff", cutoff, "--window", window, (char *)model, NULL };
    wake_pid = spawn_duplex(argv, &wake_in, &wake_out);
    if (wake_pid <= 0) { sendf("x error spawn\n"); return; }
    listen_on = 1;
    if (!mic_open()) { listen_stop("error no mic"); return; }
    fprintf(stderr, "jetd: listening for the wake word (%s, %s, cutoff %s, window %s)\n", bin, model, cutoff, window);
    sendf("x on\n");
}
static void wake_read(void) {
    ssize_t r = read(wake_out, wake_line + wake_linelen, sizeof wake_line - 1 - wake_linelen);
    if (r <= 0) { listen_stop("error detector exited"); return; }
    wake_linelen += r;
    char *nl;
    while ((nl = memchr(wake_line, '\n', wake_linelen))) {
        *nl = 0; long ms; int avg, mx;
        if (sscanf(wake_line, "wake %ld %d %d", &ms, &avg, &mx) == 3 && listen_on && !turn_on && play_pid <= 0) { sendf("d %d %d\n", avg, mx); turn_begin(0, 1); }
        size_t used = nl - wake_line + 1; memmove(wake_line, wake_line + used, wake_linelen - used); wake_linelen -= used;
    }
    if (wake_linelen >= (int)sizeof wake_line - 1) wake_linelen = 0;
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
    case 'E': if (cur_hub) { cur_hub->owns_surface = atoi(l + 1) != 0; recompute_owners(); } sendf("E %u %u %u %u\n", W, H, vinfo.bits_per_pixel, finfo.line_length); if (!ext_surface) dirty = 1; break;
    case 'Z': { int fps = 10; if (sscanf(l + 1, "%d %d %d %d %d", &x, &y, &w, &h, &fps) >= 4) vf_start(x, y, w, h, fps); } break;
    case 'z': vf_stop(); break;
    case 'K': if (cur_hub) { cur_hub->owns_keys = atoi(l + 1) != 0; recompute_owners(); } if (raw_keys) { chooser = 0; auto_remote = 0; if (mode != M_REMOTE) set_mode(M_REMOTE); dirty = 1; } break;   /* a client owns the UI */
    case 'J': { int n = atoi(l + 1); if (n <= 0 || n > klog_n) n = klog_n; for (int i = klog_n - n; i < klog_n; i++) sendf("j %s\n", klog[(klog_head + i) % LROWS]); sendf("J %d\n", n); } break;   /* log backlog: last n lines */
    case 'U': { glance_worn = -1; wear_worn = -1; glance_open(); view_thresholds_load(); sendf("U %d %d %d %d\n", glance_on_thr, glance_off_thr, view_deg_thr, view_still_ms); } break;   /* re-read calibration files */
    case 'L': set_backlight(atoi(l + 1)); break;
    case 'P': sendf("p\n"); break;
    case 'G': sendf("g %d %d\n", glance_worn, glance_raw); break;
    case 'O': sendf("o %d %d\n", wear_worn, glance_raw); break;
    case 'V': turn_begin(atoi(l + 1), 0); break;
    case 'D': { int on = 0; char rest[64] = ""; sscanf(l + 1, "%d %63[^\n]", &on, rest); if (on) listen_start(rest); else listen_stop("off"); } break;
    case 'Q': power_read(); sendf("q %d %d %d %d 0x%02x 0x%02x 0x%02x 0x%02x 0x%02x %s %d\n", pstate.vbat, pstate.vsys, pstate.vbus, pstate.ma, pstate.ctrl1 & 0xff, pstate.stat1 & 0xff, pstate.lin & 0xff, pstate.cin & 0xff, pstate.vichrg & 0xff, pstate.udc[0] ? pstate.udc : "-", pstate.maxpower); break;
    case 'N': if (cur_hub) {                                   /* mirror on/off for THIS client */
            cur_hub->mirror = atoi(l + 1) != 0; cur_hub->mirror_y = H;
            if (cur_hub->mirror) {
                int sb = 1 << 20; setsockopt(cur_hub->fd, SOL_SOCKET, SO_SNDBUF, &sb, sizeof sb);
                only_fd = cur_hub->fd; sendf("N %u %u %u %u\n", W, H, vinfo.bits_per_pixel, finfo.line_length); only_fd = -1;
                cur_hub->mirror_y = 0; mirror_bands(cur_hub);  /* full refresh starts immediately */
            }
        } break;
    case 'H': { char t; int a = 0, v = 0; int got = sscanf(l + 1, " %c %d %d", &t, &a, &v);   /* inject input */
            if (t == 'k' && got == 3) raw_key(a, v);
            else if (t == 'r' && got == 3) dispatch_rel(a, v);
            else if (t == 't' && got == 3) { if (!kbd_key(a, v)) raw_key(a, v); }   /* like an inkbd device event */
        } break;
    case 'v': turn_end("stop"); break;
    case 'W': if (cur_hub) cur_hub->bin_need = strtoul(l + 1, NULL, 10); break;   /* payload bytes follow the line */
    case 'w': if (play_pid > 0) { play_end = 1; play_drain(); } else sendf("w idle\n"); break;
    case 'Y': if (play_pid > 0) { kill(play_pid, SIGKILL); play_close("flushed"); } else sendf("w idle\n"); break;   /* barge-in: drop queued audio now */
    case 'M': { char name[16]; if (sscanf(l + 1, "%15s", name) == 1) for (int i = 0; i < M_COUNT; i++) if (!strcmp(name, mode_names[i])) { chooser = 0; set_mode(i); } } break;
    case 'I': console_write(l + 2); dirty = 1; break;
    case 'S': { unsigned sw = 640, sh = 480, sk = 6; sscanf(l + 1, "%u %u %u", &sw, &sh, &sk); if (sk > 30) sk = 30; if (vf_fd >= 0) vf_snap = 1; else cam_snapshot(sw, sh, sk); } break;
    default: break;
    }
}

/* a crash leaves its address in the log (map with addr2line on an unstripped build) */
static void fatal_signal(int sig, siginfo_t *si, void *ctx) {
    ucontext_t *uc = ctx; char m[160];
    int n = snprintf(m, sizeof m, "jetd: fatal signal %d at addr %p pc %#lx lr %#lx\n", sig, si->si_addr, (unsigned long)uc->uc_mcontext.arm_pc, (unsigned long)uc->uc_mcontext.arm_lr);
    write(2, m, n); signal(sig, SIG_DFL); raise(sig);
}

int main(int argc, char **argv) {
    { struct sigaction sa = { .sa_sigaction = fatal_signal, .sa_flags = SA_SIGINFO | SA_RESETHAND }; sigaction(SIGSEGV, &sa, NULL); sigaction(SIGBUS, &sa, NULL); sigaction(SIGILL, &sa, NULL); sigaction(SIGABRT, &sa, NULL); sigaction(SIGFPE, &sa, NULL); }
    if (argc < 3) { fprintf(stderr, "usage: jetd <host> <port> [scale]\n"); return 1; }
    snprintf(hub_hosts, sizeof hub_hosts, "%s", argv[1]); hub_port = argv[2];
    if (argc > 3) boot_hold_s = atoi(argv[3]);           /* seconds of boot log before remote takes over */
    if (getenv("JETD_LOG_FONT")) log_font = atoi(getenv("JETD_LOG_FONT"));   /* 0 small (default), 1 normal */
    if (fb_open() || font_init()) return 1;
    signal(SIGPIPE, SIG_IGN); signal(SIGCHLD, SIG_IGN);
    fg = px(255, 255, 255);
    input_open();
    kmsg_open(); pstore_load();
    listen_open(); glance_open(); backlight_load(); imu_open(); power_open();
    start_ms = now_ms();
    if (kmsg_fd >= 0) { kmsg_read(); reveal = 0; }   /* backlog loaded; reveal it progressively */
    fprintf(stderr, "jetd: fb %ux%u, font %ux%u x%u => %u cols x %u rows, %d input devs\n", W, H, gw, gh, scale, cols(), rows(), nin);

    dirty = 1; render();   /* log mode from the start */

    for (;;) {
        if (!nhubs && connecting_fd < 0 && now_ms() >= next_connect) try_connect();
        struct pollfd pf[10 + MAXIN + MAXHUB]; int n = 0, ipty = -1, ikmsg = -1, ilisten = -1, inot = -1;
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
        int iwake = -1;
        if (wake_out >= 0) { iwake = n; pf[n++] = (struct pollfd){ wake_out, POLLIN, 0 }; }
        if (play_fd >= 0 && play_off < play_len) { iplay = n; pf[n++] = (struct pollfd){ play_fd, POLLOUT, 0 }; }
        if (inotify_fd >= 0) { inot = n; pf[n++] = (struct pollfd){ inotify_fd, POLLIN, 0 }; }
        int iin = n;
        for (int i = 0; i < nin; i++) pf[n++] = (struct pollfd){ infd[i], POLLIN, 0 };
        int timeout = !nhubs ? 500 : 5000;
        if (reveal >= 0 || auto_remote) timeout = reveal >= 0 ? 25 : 500;
        if (btn[0].down && !btn[0].consumed) { int rem = HOLD_MS - (int)(now_ms() - btn[0].t); timeout = rem < 1 ? 1 : rem; }
        if (glance_path[0] && timeout > 250) timeout = 250;
        if (imu_path[0][0] && timeout > 50) timeout = 50;
        if ((turn_on || play_pid > 0) && timeout > 100) timeout = 100;
        if (mirror_pending() && timeout > 50) timeout = 50;   /* an owed refresh drains as the socket empties */
        if (mirror_on() && timeout > 100) timeout = 100;      /* the dirty-scan fallback needs ticks (direct-fb writers) */
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
                    mirror_audio(h->inbuf, take);                     /* mirror clients hear what the speaker gets */
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
        if (iwake >= 0 && pf[iwake].revents) wake_read();
        PROF(3);
        if (iplay >= 0 && pf[iplay].revents) play_drain();
        PROF(4);
        if (play_pid > 0 && !play_end && play_off == play_len && now_ms() - play_last > 3000) play_close("timeout");
        if (turn_on && now_ms() - cap_t0 > cap_max_ms) turn_end("max");
        if (ikmsg >= 0 && pf[ikmsg].revents) kmsg_read();
        PROF(2);
        if (ilisten >= 0 && pf[ilisten].revents) accept_hub();
        int nin_polled = nin;
        for (int i = 0; i < nin_polled; i++) if (pf[iin + i].revents) {
            struct input_event ev[16];
            ssize_t r = read(infd[i], ev, sizeof ev);
            if (r < 0 && errno != EAGAIN && errno != EINTR) { input_remove(i); break; }   /* device gone (BT keyboard off): table changed, re-poll */
            /* keys go through hold detection; the touchpad driver sends one REL_X, REL_Y, SYN group per gesture */
            int dx = 0, dy = 0, any = 0;
            for (ssize_t k = 0; k < (ssize_t)(r / sizeof ev[0]); k++) {
                if (ev[k].type == EV_KEY) { if (inkbd[i] && kbd_key(ev[k].code, ev[k].value)) continue; raw_key(ev[k].code, ev[k].value); }
                else if (ev[k].type == EV_REL) { any = 1; if (ev[k].code == REL_X) dx = ev[k].value; else if (ev[k].code == REL_Y) dy = ev[k].value; }
            }
            if (any) dispatch_rel(dx, dy);
        }
        if (inot >= 0 && pf[inot].revents) input_hotplug();   /* after the reads: new devices join the next poll */
        PROF(5);
        check_holds(); glance_poll(); imu_poll(); power_poll();
        PROF(6);
        if (reveal >= 0) {                        /* ~80 lines/s boot log replay */
            reveal += 2; dirty = 1;
            if (reveal >= klog_n) reveal = -1;
        }
        if (auto_remote && nhubs && reveal < 0 && now_ms() - start_ms >= boot_hold_s * 1000LL) { auto_remote = 0; set_mode(M_REMOTE); }
        for (int i = 0; i < nhubs; i++) if (hubs[i].mirror && hubs[i].mirror_y < H) mirror_bands(&hubs[i]);
        mirror_scan();
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
