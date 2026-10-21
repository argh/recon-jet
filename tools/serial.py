#!/usr/bin/env python3
"""Minimal non-interactive serial talker for the Jet's USB gadget console (no pyserial).
   tools/serial.py /dev/cu.usbmodemXXXX [-w secs] 'cmd1' 'cmd2' ...   # each cmd is sent + CR, output printed
   With no cmds, just reads for -w seconds."""
import os, sys, termios, time, select
args = sys.argv[1:]; port = args.pop(0); wait = 3.0
if args and args[0] == '-w': args.pop(0); wait = float(args.pop(0))
fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
a = termios.tcgetattr(fd)
a[0] = 0; a[1] = 0; a[2] = termios.CS8 | termios.CREAD | termios.CLOCAL; a[3] = 0
a[4] = a[5] = termios.B115200
termios.tcsetattr(fd, termios.TCSANOW, a)
def drain(t):
    end = time.time() + t; out = b''
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: out += os.read(fd, 4096)
            except BlockingIOError: pass
    return out
sys.stdout.write(drain(0.5).decode('utf-8', 'replace'))
for c in args:
    os.write(fd, (c + '\r').encode()); sys.stdout.write(drain(wait).decode('utf-8', 'replace'))
if not args: sys.stdout.write(drain(wait).decode('utf-8', 'replace'))
