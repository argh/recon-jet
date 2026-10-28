/* doomgeneric platform for the Recon Jet.
 *
 * Pixels: Doom's 320x200 8-bit frame is palette-mapped to RGB565 (or XRGB) into /dev/fb0 and
 * pushed to the Kopin panel with OMAPFB_UPDATE_WINDOW for just that rectangle (the panel is
 * manual-update: plain fb writes show nothing). Default output is 320x240 centred (Doom's
 * intended 4:3 aspect); `-stretch` fills the whole 428x240 glass; `-noscale` is 320x200 1:1.
 *
 * Keys: as a client of jetd (loopback 7777, `K 1` + `E 1`): `k <evdev code> <1|0>` lines carry
 * the pod buttons, the touchpad swipe keys and a Bluetooth keyboard alike. Front button = Enter
 * and Fire, rear = Escape, swipes = arrows. If jetd cannot be reached the keyboards in
 * /dev/input are read directly (`-evdev` forces that).
 *
 * Freeze: SIGUSR1 (or jetd leaving remote mode, `m <mode>`) pauses the game, stops drawing and
 * discards input so another screen can show; SIGUSR2 (or `m remote` / a new hello) resumes with
 * every key released. jetd going away ends the game. */
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/input.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#include <dirent.h>

#include "doomgeneric.h"
#include "i_video.h"    /* struct color colors[256]: the gamma-corrected palette (CMAP256 build) */
#include "m_argv.h"

extern boolean palette_changed;   /* i_video.c, CMAP256 build */

/* Doom's key codes (doomkeys.h), spelled DK_* because that header's KEY_* names collide with
 * linux/input.h, whose values are what jetd and evdev deliver. */
#define DK_ENTER 13
#define DK_ESCAPE 27
#define DK_TAB 9
#define DK_BACKSPACE 0x7f
#define DK_F(n) (0x80 + 0x3a + (n))      /* F1..F10 */
#define DK_PAUSE 0xff
#define DK_LEFT 0xac
#define DK_UP 0xad
#define DK_RIGHT 0xae
#define DK_DOWN 0xaf
#define DK_STRAFE_L 0xa0
#define DK_STRAFE_R 0xa1
#define DK_USE 0xa2
#define DK_FIRE 0xa3
#define DK_RSHIFT (0x80 + 0x36)
#define DK_LALT (0x80 + 0x38)

struct omapfb_update_window { uint32_t x, y, width, height, format, out_x, out_y, out_width, out_height, reserved[8]; };
#define OMAPFB_UPDATE_WINDOW _IOW('O', 54, struct omapfb_update_window)

#define SRC_W DOOMGENERIC_RESX
#define SRC_H DOOMGENERIC_RESY

/* ---- framebuffer ------------------------------------------------------------------- */
static int fbfd = -1;
static uint8_t *fbmem;
static struct fb_var_screeninfo vinfo;
static struct fb_fix_screeninfo finfo;
static unsigned out_x, out_y, out_w, out_h;    /* the panel rectangle Doom fills */
static uint16_t *xmap;                         /* output column -> source column */
static uint16_t *ymap;                         /* output row -> source row */
static uint32_t pal[256];                      /* palette packed for the fb's pixel layout */

/* Black the whole glass, not just our window: whatever was on it (jet-app, the switcher) stays
 * in the side bars otherwise, since the panel only repaints what is pushed. */
static int need_clear = 1;     /* cleared with the first frame: by then jet-app has stopped painting */
static void fb_clear(void) {
    struct omapfb_update_window uw = { 0, 0, vinfo.xres, vinfo.yres, 0, 0, 0, vinfo.xres, vinfo.yres, {0} };
    memset(fbmem, 0, finfo.line_length * vinfo.yres);
    ioctl(fbfd, OMAPFB_UPDATE_WINDOW, &uw);
}

static void fb_init(void) {
    fbfd = open("/dev/fb0", O_RDWR);
    if (fbfd < 0) fbfd = open("/dev/graphics/fb0", O_RDWR);
    if (fbfd < 0) { perror("fb0"); exit(1); }
    ioctl(fbfd, FBIOGET_VSCREENINFO, &vinfo);
    ioctl(fbfd, FBIOGET_FSCREENINFO, &finfo);
    if (vinfo.bits_per_pixel != 16 && vinfo.bits_per_pixel != 32) { fprintf(stderr, "fb0: %u bpp unsupported\n", vinfo.bits_per_pixel); exit(1); }
    fbmem = mmap(0, finfo.smem_len, PROT_READ | PROT_WRITE, MAP_SHARED, fbfd, 0);
    if (fbmem == MAP_FAILED) { perror("mmap fb0"); exit(1); }

    if (M_CheckParm("-stretch")) { out_w = vinfo.xres; out_h = vinfo.yres; }
    else if (M_CheckParm("-noscale")) { out_w = SRC_W; out_h = SRC_H; }
    else { out_h = vinfo.yres; out_w = out_h * 4 / 3; }          /* 4:3, as tall as the glass */
    if (out_w > vinfo.xres) out_w = vinfo.xres;
    if (out_h > vinfo.yres) out_h = vinfo.yres;
    out_x = (vinfo.xres - out_w) / 2; out_y = (vinfo.yres - out_h) / 2;
    xmap = malloc(out_w * sizeof *xmap); ymap = malloc(out_h * sizeof *ymap);
    for (unsigned x = 0; x < out_w; x++) xmap[x] = x * SRC_W / out_w;
    for (unsigned y = 0; y < out_h; y++) ymap[y] = y * SRC_H / out_h;
    printf("jet: fb %ux%u %u bpp stride %u, doom at %u,%u %ux%u\n", vinfo.xres, vinfo.yres, vinfo.bits_per_pixel, finfo.line_length, out_x, out_y, out_w, out_h);
}

static void fb_palette(void) {
    for (int i = 0; i < 256; i++) {
        unsigned r = colors[i].r, g = colors[i].g, b = colors[i].b;
        pal[i] = ((r >> (8 - vinfo.red.length)) << vinfo.red.offset) |
                 ((g >> (8 - vinfo.green.length)) << vinfo.green.offset) |
                 ((b >> (8 - vinfo.blue.length)) << vinfo.blue.offset);
    }
}

static void fb_push(void) {
    struct omapfb_update_window uw = { out_x, out_y, out_w, out_h, 0, out_x, out_y, out_w, out_h, {0} };
    if (ioctl(fbfd, OMAPFB_UPDATE_WINDOW, &uw) < 0) { static int once; if (!once++) perror("OMAPFB_UPDATE_WINDOW"); }
}

static void fb_blit(void) {
    const uint8_t *src = (const uint8_t *)DG_ScreenBuffer;
    for (unsigned y = 0; y < out_h; y++) {
        const uint8_t *row = src + ymap[y] * SRC_W;
        uint8_t *dst = fbmem + (out_y + y) * finfo.line_length + out_x * (vinfo.bits_per_pixel / 8);
        if (vinfo.bits_per_pixel == 16) { uint16_t *d = (uint16_t *)dst; for (unsigned x = 0; x < out_w; x++) d[x] = pal[row[xmap[x]]]; }
        else { uint32_t *d = (uint32_t *)dst; for (unsigned x = 0; x < out_w; x++) d[x] = pal[row[xmap[x]]]; }
    }
    fb_push();
}

/* ---- keys ------------------------------------------------------------------------- */
#define KEYQ 64
static unsigned short keyq[KEYQ];
static unsigned kq_w, kq_r;
static unsigned char held[256];      /* Doom key -> down, so a freeze can release everything */

static void push_key(int pressed, unsigned char key) {
    if (held[key] == (pressed != 0)) return;   /* autorepeat and duplicates */
    held[key] = pressed != 0;
    if ((kq_w + 1) % KEYQ == kq_r) return;     /* full: drop */
    keyq[kq_w] = (pressed << 8) | key; kq_w = (kq_w + 1) % KEYQ;
}

static int shift_down;
static const char *unshifted = "1234567890-=" "qwertyuiop[]" "asdfghjkl;'`" "\\zxcvbnm,./";
static const char *shifted   = "!@#$%^&*()_+" "QWERTYUIOP{}" "ASDFGHJKL:\"~" "|ZXCVBNM<>?";

/* evdev code -> Doom key (0 = ignored). The engine's bindings are its own codes (doomkeys.h), not
 * ASCII: strafing is KEY_STRAFE_L/R, which vanilla put on , and . and we put on Z and X as well,
 * next to Ctrl (fire) and Space (use). KEY_1..KEY_EQUAL, KEY_Q..KEY_RIGHTBRACE, KEY_A..KEY_GRAVE,
 * KEY_BACKSLASH..KEY_SLASH are contiguous runs in input-event-codes.h. */
static unsigned char doom_key(unsigned code) {
    const char *t = shift_down ? shifted : unshifted;
    if (code == KEY_Z || code == KEY_COMMA) return DK_STRAFE_L;
    if (code == KEY_X || code == KEY_DOT) return DK_STRAFE_R;
    if (code >= KEY_1 && code <= KEY_EQUAL) return t[code - KEY_1];
    if (code >= KEY_Q && code <= KEY_RIGHTBRACE) return t[12 + code - KEY_Q];
    if (code >= KEY_A && code <= KEY_GRAVE) return t[24 + code - KEY_A];
    if (code >= KEY_BACKSLASH && code <= KEY_SLASH) return t[36 + code - KEY_BACKSLASH];
    if (code >= KEY_F1 && code <= KEY_F10) return DK_F(code - KEY_F1 + 1);
    switch (code) {
    case KEY_ENTER: case KEY_KPENTER: return DK_ENTER;
    case KEY_ESC: return DK_ESCAPE;
    case KEY_TAB: return DK_TAB;
    case KEY_BACKSPACE: return DK_BACKSPACE;
    case KEY_SPACE: return DK_USE;
    case KEY_LEFT: return DK_LEFT;
    case KEY_RIGHT: return DK_RIGHT;
    case KEY_UP: return DK_UP;
    case KEY_DOWN: return DK_DOWN;
    case KEY_LEFTCTRL: case KEY_RIGHTCTRL: return DK_FIRE;
    case KEY_LEFTALT: case KEY_RIGHTALT: return DK_LALT;
    case KEY_LEFTSHIFT: case KEY_RIGHTSHIFT: return DK_RSHIFT;
    case KEY_PAUSE: return DK_PAUSE;
    }
    return 0;
}

#define POD_FRONT 86    /* KEY_102ND: pod front button */
#define POD_REAR 107    /* KEY_END: pod rear button */

static void evdev_key(unsigned code, int value) {
    if (value > 1) return;                          /* autorepeat */
    if (code == KEY_LEFTSHIFT || code == KEY_RIGHTSHIFT) shift_down = value;
    if (code == POD_FRONT) { push_key(value, DK_ENTER); push_key(value, DK_FIRE); return; }   /* menus and the trigger */
    if (code == POD_REAR) { push_key(value, DK_ESCAPE); return; }
    unsigned char k = doom_key(code);
    if (k) push_key(value, k);
}

/* ---- freeze ------------------------------------------------------------------------- */
static volatile sig_atomic_t want_freeze, want_thaw;
static int frozen, frz_sig, frz_mode;   /* frozen = frz_sig || frz_mode */
static void on_usr1(int s) { (void)s; want_freeze = 1; }
static void on_usr2(int s) { (void)s; want_thaw = 1; }

static void set_frozen(int on) {
    if (on == frozen) return;
    frozen = on;
    printf("jet: %s\n", on ? "frozen" : "resumed");
    if (on) { for (int k = 0; k < 256; k++) if (held[k]) push_key(0, k); }   /* nothing stays held */
    else need_clear = 1;                                                       /* the switcher painted over us */
    /* Doom's own pause stops the world while another screen shows (and a second one resumes it) */
    push_key(1, DK_PAUSE); push_key(0, DK_PAUSE);
}
static void freeze_sig(int on) { frz_sig = on; set_frozen(frz_sig || frz_mode); }
static void freeze_mode(int on) { frz_mode = on; set_frozen(frz_sig || frz_mode); }

/* ---- input sources: jetd socket, or evdev directly ------------------------------------- */
static int jfd = -1;
static char jbuf[1024]; static size_t jlen;
static struct pollfd evfd[8]; static int nev;

static void jetd_line(char *l) {
    if (l[0] == 'k') { unsigned code; int value; if (sscanf(l + 1, "%u %d", &code, &value) == 2 && !frozen) evdev_key(code, value); }
    else if (l[0] == 'm') freeze_mode(strcmp(l + 2, "remote") != 0);   /* jetd's own screens are showing */
    else if (l[0] == 'h') freeze_mode(0);
}

static void jetd_read(void) {
    ssize_t n = recv(jfd, jbuf + jlen, sizeof jbuf - 1 - jlen, MSG_DONTWAIT);
    if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) { printf("jet: jetd gone, leaving\n"); exit(0); }
    if (n <= 0) return;
    jlen += n; jbuf[jlen] = 0;
    char *s = jbuf, *nl;
    while ((nl = strchr(s, '\n'))) { *nl = 0; jetd_line(s); s = nl + 1; }
    jlen = strlen(s); memmove(jbuf, s, jlen + 1);
    if (jlen == sizeof jbuf - 1) jlen = 0;   /* a payload line we do not speak: drop and resync */
}

static int jetd_connect(void) {
    const char *spec = getenv("JETD"); int p = M_CheckParmWithArgs("-jetd", 1);
    if (p) spec = myargv[p + 1];
    char host[64] = "127.0.0.1"; int port = 7777;
    if (spec) { const char *c = strrchr(spec, ':'); if (c) { snprintf(host, sizeof host, "%.*s", (int)(c - spec), spec); port = atoi(c + 1); } else snprintf(host, sizeof host, "%s", spec); }
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(port) };
    if (inet_pton(AF_INET, host, &a.sin_addr) != 1) { close(fd); return -1; }
    struct timeval tv = { 2, 0 }; setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { close(fd); return -1; }
    int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    const char *hello = "K 1\nE 1\n";          /* raw keys to us, pixels are ours: jetd draws nothing */
    if (send(fd, hello, strlen(hello), MSG_NOSIGNAL) < 0) { close(fd); return -1; }
    printf("jet: keys from jetd at %s:%d\n", host, port);
    return fd;
}

static void evdev_open(void) {
    DIR *d = opendir("/dev/input"); struct dirent *e;
    if (!d) return;
    while ((e = readdir(d)) && nev < 8) {
        if (strncmp(e->d_name, "event", 5)) continue;
        char path[280]; snprintf(path, sizeof path, "/dev/input/%s", e->d_name);
        int fd = open(path, O_RDONLY | O_NONBLOCK);
        if (fd < 0) continue;
        unsigned long keybits[(KEY_MAX + 1) / (8 * sizeof(long)) + 1] = {0};
        ioctl(fd, EVIOCGBIT(EV_KEY, sizeof keybits), keybits);
        #define HAS(k) (keybits[(k) / (8 * sizeof(long))] >> ((k) % (8 * sizeof(long))) & 1)
        if (!HAS(KEY_A) && !HAS(POD_FRONT) && !HAS(POD_REAR)) { close(fd); continue; }   /* keyboards and the pod only */
        evfd[nev].fd = fd; evfd[nev].events = POLLIN; nev++;
        printf("jet: keys from %s\n", path);
    }
    closedir(d);
}

static void evdev_read(void) {
    struct input_event ev;
    for (int i = 0; i < nev; i++)
        while (read(evfd[i].fd, &ev, sizeof ev) == (ssize_t)sizeof ev)
            if (ev.type == EV_KEY && !frozen) evdev_key(ev.code, ev.value);
}

static void pump(void) {
    if (want_freeze) { want_freeze = 0; freeze_sig(1); }
    if (want_thaw) { want_thaw = 0; freeze_sig(0); }
    if (jfd >= 0) { struct pollfd p = { jfd, POLLIN, 0 }; if (poll(&p, 1, 0) > 0) jetd_read(); }
    if (nev && poll(evfd, nev, 0) > 0) evdev_read();
}

/* ---- doomgeneric hooks ---------------------------------------------------------------- */
static struct timespec t0;

void DG_Init(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);   /* the engine's log reaches jet-app's logger line by line */
    clock_gettime(CLOCK_MONOTONIC, &t0);
    signal(SIGUSR1, on_usr1); signal(SIGUSR2, on_usr2); signal(SIGPIPE, SIG_IGN);
    fb_init();
    if (!M_CheckParm("-evdev")) jfd = jetd_connect();
    if (jfd < 0) evdev_open();
    if (jfd < 0 && !nev) fprintf(stderr, "jet: no input source (jetd unreachable, no keyboards)\n");
}

void DG_DrawFrame(void) {
    pump();
    if (frozen) return;
    if (palette_changed) { fb_palette(); palette_changed = 0; }
    if (need_clear) { fb_clear(); need_clear = 0; }
    fb_blit();
}

void DG_SleepMs(uint32_t ms) { usleep(ms * 1000); }

uint32_t DG_GetTicksMs(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (t.tv_sec - t0.tv_sec) * 1000 + (t.tv_nsec - t0.tv_nsec) / 1000000;
}

int DG_GetKey(int *pressed, unsigned char *key) {
    pump();
    if (kq_r == kq_w) return 0;
    unsigned short k = keyq[kq_r]; kq_r = (kq_r + 1) % KEYQ;
    *pressed = k >> 8; *key = k & 0xff;
    return 1;
}

void DG_SetWindowTitle(const char *title) { (void)title; }

int main(int argc, char **argv) {
    doomgeneric_Create(argc, argv);
    for (;;) doomgeneric_Tick();
}
