#!/bin/sh
# jsh.sh [-t secs] 'remote command'  : ssh to the Jet (USB address, then jet.local) with a hard
# wall-clock cap (default 120 s; macOS has no `timeout`). Nothing on the Jet legitimately takes
# longer than a couple of minutes; if it does, it is hung.
T=120; [ "$1" = "-t" ] && { T=$2; shift 2; }
HOST=${JET_HOST:-jet.local}   # the Jet announces itself over mDNS on USB and WiFi
# fall back to mDNS (WiFi) when the USB address does not answer
exec perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$T" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 "root@$HOST" "$@"
