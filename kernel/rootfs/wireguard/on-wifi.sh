#!/bin/sh
# wpa_cli action hook (docs/vpn.md): on each WiFi (re)association it fetches a fresh DHCP lease for
# the joined network, then -- if that network is untrusted -- raises a split-tunnel WireGuard link
# that routes only the home networks through wg0 (the Jet's own traffic stays on the local link). On
# a trusted network it drops the tunnel. wpa_cli -a calls it with the interface ($1) and event ($2).
# Re-leasing here (init leases only once, at boot) is what makes roaming home<->hotspot seamless.
# Split tunnel, not wg-quick full tunnel: this kernel has no policy routing (CONFIG_IP_MULTIPLE_TABLES
# off), so wg-quick's 0.0.0.0/0 fwmark/table trick cannot work; routing the home prefixes explicitly
# needs none of it. The peer's AllowedIPs stay 0.0.0.0/0 (crypto scope); the system routes below
# decide what actually enters the tunnel.
# Everything site-specific is data on the Jet's userdata; this script carries none of it:
#   /android-data/mainline/wireguard/wg0.conf   the tunnel (wg-quick format); its presence enables the VPN
#   /android-data/mainline/wireguard/trusted    SSIDs, one per line, where the tunnel stays down (home)
#   /android-data/mainline/wireguard/routes     CIDRs, one per line, to send through the tunnel
#                                               (default: the tunnel address's own /24)
# DNS: the conf's DNS is reachable only through the tunnel, so the hook points /etc/resolv.conf at it
# while up; udhcpc leaves resolv.conf alone while wg0 exists (udhcpc-default.script), and a trusted
# join drops the tunnel first so its lease then writes the LAN's own resolver back.
# Clock: the Jet has no clock that survives a deep discharge; after one it boots in the year 2000,
# and then no TLS certificate is valid and WireGuard's handshake timestamps run backwards - the
# device looks as if the network were down. So every association sets the clock from the network,
# over the fresh lease and BEFORE the tunnel: synchronously when the clock is absurd, in the
# background otherwise (it only bounds drift then). An NTP client is used when the rootfs has one
# (ntpdig/ntpdate/sntp); busybox rdate (RFC 868) is the fallback. Servers: one per line in
#   /android-data/mainline/wireguard/timeservers   (default: pool.ntp.org, and time.nist.gov for rdate)
IFACE=${1:-wlan0}
DIR=/android-data/mainline/wireguard
CONF=$DIR/wg0.conf
TRUSTED=$DIR/trusted
ROUTES=$DIR/routes
SCRIPT=/usr/share/udhcpc/default.script
field() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//Ip" "$CONF" | head -1; }

dhcp() {   # fresh lease for whatever network the interface is now on (flushes the stale IP/route)
  kill $(pgrep -f "udhcpc.*$IFACE") 2>/dev/null
  udhcpc -i "$IFACE" -q -n -t 15 -s "$SCRIPT" >/dev/null 2>&1
}

up() {   # split-tunnel wg0: route only the home prefixes, point resolv.conf at the tunnel DNS
  [ -s "$CONF" ] || return 0
  wg show wg0 >/dev/null 2>&1 && return 0
  modprobe wireguard 2>/dev/null
  ADDR=$(field Address); DNS=$(field DNS | cut -d, -f1 | tr -d '[:space:]')
  MTU=$(field MTU | tr -d '[:space:]'); MTU=${MTU:-1280}
  tmp=$(mktemp); wg-quick strip "$CONF" > "$tmp"
  ip link add wg0 type wireguard 2>/dev/null
  wg setconf wg0 "$tmp"; rm -f "$tmp"
  [ -n "$ADDR" ] && ip address add "$ADDR" dev wg0
  ip link set wg0 up mtu "$MTU"
  if [ -s "$ROUTES" ]; then
    while IFS= read -r r; do case "$r" in ''|\#*) ;; *) ip route add "$r" dev wg0 2>/dev/null ;; esac; done < "$ROUTES"
  else
    net=$(echo "$ADDR" | sed 's|\.[0-9]*/.*|.0/24|'); [ -n "$net" ] && ip route add "$net" dev wg0 2>/dev/null
  fi
  [ -n "$DNS" ] && printf 'nameserver %s\n' "$DNS" > /etc/resolv.conf
}

down() { ip link show wg0 >/dev/null 2>&1 && ip link del wg0 2>/dev/null; }

settime() {   # one shot at the network's time; quiet, bounded, first server that answers
  servers=$(grep -v '^[[:space:]]*\(#\|$\)' "$DIR/timeservers" 2>/dev/null)
  for s in ${servers:-pool.ntp.org}; do
    if command -v ntpdig >/dev/null 2>&1; then timeout 10 ntpdig -S -t 5 "$s" >/dev/null 2>&1 && return 0
    elif command -v ntpdate >/dev/null 2>&1; then timeout 10 ntpdate -u "$s" >/dev/null 2>&1 && return 0
    elif command -v sntp >/dev/null 2>&1; then timeout 10 sntp -S "$s" >/dev/null 2>&1 && return 0
    fi
  done
  for s in ${servers:-time.nist.gov}; do timeout 10 busybox rdate -s "$s" >/dev/null 2>&1 && return 0; done
  return 1
}

clock() {
  if [ "$(date -u +%Y)" -lt 2025 ]; then
    settime && logger -t on-wifi "clock was wrong, set to $(date -u +%FT%TZ)" 2>/dev/null
    hwclock -w 2>/dev/null
  else
    ( settime && hwclock -w 2>/dev/null ) &
  fi
}

case "$2" in
  CONNECTED)
    SSID=$(wpa_cli -i "$IFACE" status 2>/dev/null | sed -n 's/^ssid=//p')
    [ -n "$SSID" ] || exit 0
    if grep -qxF "$SSID" "$TRUSTED" 2>/dev/null; then
      down; dhcp; clock   # trusted: tunnel off first, then the lease writes the LAN's own resolver
    else
      dhcp; clock; up     # untrusted: lease first so the endpoint is routable, the clock before any crypto, then the tunnel
    fi
    ;;
  DISCONNECTED|TERMINATING) down ;;
esac
exit 0
