#!/bin/sh
# Dump the OMAP4 CONTROL_CORE pad registers for the RFBI/Kopin pins (run on the Jet as root,
# needs busybox devmem). Each 32-bit word at 0x4a100000+0x40+off holds two 16-bit pads:
# low half = even offset, high half = even offset + 2. Mux mode = bits 0-2, pull/in = bits 3-8.
B=0x4a100000
for off in 0x05c 0x062 0x064 0x078 0x16c 0x16e 0x170 0x172 0x174 0x176 0x1b4 0x1b6 0x1b8 0x1ba 0x1bc 0x1be 0x1c0 0x1c2 0x1c4 0x1c6 0x1c8 0x1ca 0x1cc 0x1ce 0x1d0 0x1d2 0x1d4; do
  o=$((off)); w=$((B + (o & ~3))); v=$(devmem $w 32)
  if [ $((o & 2)) -eq 0 ]; then p=$(( v & 0xffff )); else p=$(( (v >> 16) & 0xffff )); fi
  printf "pad 0x%03x = 0x%04x  mode%d%s%s%s\n" $o $p $((p & 7)) "$([ $((p & 0x100)) -ne 0 ] && echo ' INPUT' )" "$([ $((p & 0x8)) -ne 0 ] && echo ' pullen')" "$([ $((p & 0x10)) -ne 0 ] && echo ' pullup')"
done
