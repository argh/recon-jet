/* regdump: dump OMAP4 DSS/DISPC/RFBI/PRCM/pad registers via /dev/mem.
 * Static ARMv7 (zig cc). Reads only; never touches RFBI CMD/PARAM/DATA/READ.
 * -f : if CM_DSS_DSS_CLKCTRL says the module is idle, force MODULEMODE=2 and
 *      wait for IDLEST=0 before reading DSS registers (restores nothing;
 *      the kernel's next runtime put rewrites the register anyway).
 * addr=val : write one 32-bit register (hex) and exit.
 * -n N : repeat the DISPC/RFBI section N times (catches changes between frames).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdint.h>
#include <sys/mman.h>

static int fd;
static volatile uint32_t *map(uint32_t pa) {
	static uint32_t cur_page = 0; static void *cur = NULL;
	uint32_t page = pa & ~0xfffu;
	if (cur == NULL || page != cur_page) {
		if (cur) munmap(cur, 4096);
		cur = mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_SHARED, fd, page);
		if (cur == MAP_FAILED) { perror("mmap"); exit(1); }
		cur_page = page;
	}
	return (volatile uint32_t *)((char *)cur + (pa & 0xfff));
}
static uint32_t rd(uint32_t pa) { return *map(pa); }
static void wr(uint32_t pa, uint32_t v) { *map(pa) = v; }

struct reg { const char *name; uint32_t addr; };
#define DSS 0x58000000
#define DISPC 0x58001000
#define RFBI 0x58002000
static const struct reg prcm[] = {
	{"CM_CLKMODE_DPLL_PER", 0x4a008140}, {"CM_IDLEST_DPLL_PER", 0x4a008144},
	{"CM_AUTOIDLE_DPLL_PER", 0x4a008148}, {"CM_CLKSEL_DPLL_PER", 0x4a00814c},
	{"CM_DIV_M2_DPLL_PER", 0x4a008150}, {"CM_DIV_M3_DPLL_PER", 0x4a008154},
	{"CM_DIV_M4_DPLL_PER", 0x4a008158}, {"CM_DIV_M5_DPLL_PER", 0x4a00815c},
	{"CM_DIV_M6_DPLL_PER", 0x4a008160}, {"CM_DIV_M7_DPLL_PER", 0x4a008164},
	{"CM_DSS_CLKSTCTRL", 0x4a009100}, {"CM_DSS_DSS_CLKCTRL", 0x4a009120},
	{"SCRM_AUXCLK3", 0x4a30a31c}, {"SCRM_AUXCLK4", 0x4a30a320}, {"SCRM_AUXCLK5", 0x4a30a324},
	{"SCRM_ALTCLKSRC", 0x4a30a110},
	{0,0}
};
static const struct reg dss[] = {
	{"DSS_REVISION", DSS+0x00}, {"DSS_SYSCONFIG", DSS+0x10}, {"DSS_SYSSTATUS", DSS+0x14},
	{"DSS_CONTROL", DSS+0x40}, {"DSS_STATUS", DSS+0x5c},
	{"DISPC_REVISION", DISPC+0x00}, {"DISPC_SYSCONFIG", DISPC+0x10}, {"DISPC_SYSSTATUS", DISPC+0x14},
	{"DISPC_IRQSTATUS", DISPC+0x18}, {"DISPC_IRQENABLE", DISPC+0x1c},
	{"DISPC_CONTROL1", DISPC+0x40}, {"DISPC_CONFIG1", DISPC+0x44},
	{"DISPC_DEFAULT_COLOR0", DISPC+0x4c}, {"DISPC_TRANS_COLOR0", DISPC+0x54},
	{"DISPC_LINE_STATUS", DISPC+0x5c}, {"DISPC_LINE_NUMBER", DISPC+0x60},
	{"DISPC_TIMING_H1", DISPC+0x64}, {"DISPC_TIMING_V1", DISPC+0x68}, {"DISPC_POL_FREQ1", DISPC+0x6c},
	{"DISPC_DIVISOR1", DISPC+0x70}, {"DISPC_GLOBAL_ALPHA", DISPC+0x74},
	{"DISPC_SIZE_TV", DISPC+0x78}, {"DISPC_SIZE_LCD1", DISPC+0x7c},
	{"DISPC_GFX_BA0", DISPC+0x80}, {"DISPC_GFX_BA1", DISPC+0x84}, {"DISPC_GFX_POSITION", DISPC+0x88},
	{"DISPC_GFX_SIZE", DISPC+0x8c}, {"DISPC_GFX_ATTRIBUTES", DISPC+0xa0},
	{"DISPC_GFX_BUF_THRESHOLD", DISPC+0xa4}, {"DISPC_GFX_BUF_SIZE_STATUS", DISPC+0xa8},
	{"DISPC_GFX_ROW_INC", DISPC+0xac}, {"DISPC_GFX_PIXEL_INC", DISPC+0xb0},
	{"DISPC_GFX_WINDOW_SKIP", DISPC+0xb4}, {"DISPC_GFX_TABLE_BA", DISPC+0xb8},
	{"DISPC_DATA1_CYCLE1", DISPC+0x1d4}, {"DISPC_DATA1_CYCLE2", DISPC+0x1d8}, {"DISPC_DATA1_CYCLE3", DISPC+0x1dc},
	{"DISPC_CPR1_COEF_R", DISPC+0x220}, {"DISPC_CPR1_COEF_G", DISPC+0x224}, {"DISPC_CPR1_COEF_B", DISPC+0x228},
	{"DISPC_GFX_PRELOAD", DISPC+0x22c}, {"DISPC_CONTROL2", DISPC+0x238}, {"DISPC_CONFIG2", DISPC+0x620},
	{"DISPC_GLOBAL_BUFFER", DISPC+0x800}, {"DISPC_DIVISOR", DISPC+0x804},
	{"DISPC_GLOBAL_MFLAG", DISPC+0x85c},
	{"RFBI_REVISION", RFBI+0x00}, {"RFBI_SYSCONFIG", RFBI+0x10}, {"RFBI_SYSSTATUS", RFBI+0x14},
	{"RFBI_CONTROL", RFBI+0x40}, {"RFBI_PIXEL_CNT", RFBI+0x44}, {"RFBI_LINE_NUMBER", RFBI+0x48},
	{"RFBI_STATUS", RFBI+0x5c},
	{"RFBI_CONFIG0", RFBI+0x60}, {"RFBI_ONOFF_TIME0", RFBI+0x64}, {"RFBI_CYCLE_TIME0", RFBI+0x68},
	{"RFBI_DATA_CYCLE1_0", RFBI+0x6c}, {"RFBI_DATA_CYCLE2_0", RFBI+0x70}, {"RFBI_DATA_CYCLE3_0", RFBI+0x74},
	{"RFBI_CONFIG1", RFBI+0x78}, {"RFBI_ONOFF_TIME1", RFBI+0x7c}, {"RFBI_CYCLE_TIME1", RFBI+0x80},
	{"RFBI_DATA_CYCLE1_1", RFBI+0x84}, {"RFBI_DATA_CYCLE2_1", RFBI+0x88}, {"RFBI_DATA_CYCLE3_1", RFBI+0x8c},
	{"RFBI_VSYNC_WIDTH", RFBI+0x90}, {"RFBI_HSYNC_WIDTH", RFBI+0x94},
	/* Kopin GPIOs: gpio2 bits 9 (41 clk-en) 10 (42 reset) 20 (52 power); gpio6 bit 3 (163 A16) */
	{"GPIO2_OE", 0x48055134}, {"GPIO2_DATAIN", 0x48055138}, {"GPIO2_DATAOUT", 0x4805513c},
	{"GPIO6_OE", 0x4805d134}, {"GPIO6_DATAIN", 0x4805d138}, {"GPIO6_DATAOUT", 0x4805d13c},
	{0,0}
};
/* pads: 16-bit each at 0x4a100000 + off */
static const struct { const char *name; uint32_t off; } pads[] = {
	{"fref_clk4_out(0x05c)", 0x05c}, {"gpmc_a17/gpio41 clk-en(0x062)", 0x062},
	{"gpmc_a18/gpio42 reset(0x064)", 0x064}, {"gpmc_ncs2/gpio52 power(0x078)", 0x078},
	{"usbb2_ulpitll_dat0/gpio163 A16(0x16c)", 0x16c},
	{"usbb2_ulpitll_dat3 data15(0x16e)", 0x16e}, {"usbb2_ulpitll_dat4 data14(0x170)", 0x170},
	{"usbb2_ulpitll_dat5 data13(0x172)", 0x172}, {"usbb2_ulpitll_dat6 data12(0x174)", 0x174},
	{"usbb2_ulpitll_dat7 data11(0x176)", 0x176},
	{"dpm_emu3 data10(0x1b4)", 0x1b4}, {"dpm_emu4 data9(0x1b6)", 0x1b6}, {"dpm_emu5 te_vsync0(0x1b8)", 0x1b8},
	{"dpm_emu6 (0x1ba)", 0x1ba}, {"dpm_emu7 cs0(0x1bc)", 0x1bc}, {"dpm_emu8 re(0x1be)", 0x1be},
	{"dpm_emu9 we(0x1c0)", 0x1c0}, {"dpm_emu10 a0(0x1c2)", 0x1c2}, {"dpm_emu11 data8(0x1c4)", 0x1c4},
	{"dpm_emu12 data7(0x1c6)", 0x1c6}, {"dpm_emu13 data6(0x1c8)", 0x1c8}, {"dpm_emu14 data5(0x1ca)", 0x1ca},
	{"dpm_emu15 data4(0x1cc)", 0x1cc}, {"dpm_emu16 data3(0x1ce)", 0x1ce}, {"dpm_emu17 data2(0x1d0)", 0x1d0},
	{"dpm_emu18 data1(0x1d2)", 0x1d2}, {"dpm_emu19 data0(0x1d4)", 0x1d4},
	{0,0}
};

static void dump(const struct reg *t) {
	for (; t->name; t++) printf("%-28s %08x = %08x\n", t->name, t->addr, rd(t->addr));
}

int main(int argc, char **argv) {
	int force = 0, n = 1, i;
	for (i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "-f")) force = 1;
		else if (!strcmp(argv[i], "-n") && i+1 < argc) n = atoi(argv[++i]);
	}
	fd = open("/dev/mem", O_RDWR | O_SYNC);
	if (fd < 0) { perror("/dev/mem"); return 1; }
	/* addr=val : write a 32-bit register; addr (8 hex digits) : read one; then exit (no dump) */
	for (i = 1; i < argc; i++) {
		char *eq = strchr(argv[i], '=');
		if (!eq && strlen(argv[i]) == 8 && strspn(argv[i], "0123456789abcdefABCDEF") == 8) {
			uint32_t a = strtoul(argv[i], NULL, 16);
			printf("%08x: %08x\n", a, rd(a)); force = -1; continue;
		}
		if (!eq) continue;
		uint32_t a = strtoul(argv[i], NULL, 16), v = strtoul(eq + 1, NULL, 16);
		printf("%08x: %08x -> ", a, rd(a)); wr(a, v); printf("%08x\n", rd(a));
		force = -1;
	}
	if (force == -1) return 0;
	printf("== PRCM/SCRM ==\n"); dump(prcm);
	printf("== PADS (0x4a100000+off, 16-bit) ==\n");
	for (i = 0; pads[i].name; i++) {
		uint32_t w = rd(0x4a100000 + (pads[i].off & ~3u));
		uint16_t v = (pads[i].off & 2) ? w >> 16 : w & 0xffff;
		printf("%-40s = %04x\n", pads[i].name, v);
	}
	uint32_t cc = rd(0x4a009120);
	if ((cc >> 16 & 3) != 0) {
		if (!force) { printf("DSS module idle (CLKCTRL %08x); use -f to force\n", cc); return 2; }
		wr(0x4a009120, (cc & ~3u) | 2);
		for (i = 0; i < 100000 && (rd(0x4a009120) >> 16 & 3); i++) ;
		printf("forced DSS on: CLKCTRL %08x after %d polls\n", rd(0x4a009120), i);
		if (rd(0x4a009120) >> 16 & 3) return 3;
	}
	while (n-- > 0) { printf("== DSS/DISPC/RFBI ==\n"); dump(dss); if (n) usleep(20000); }
	return 0;
}
