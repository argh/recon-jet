# Off-home auto-VPN (WireGuard)

The Jet travels (it is a helmet display), so off home WiFi it rides on a phone hotspot. A
WireGuard tunnel brings it back onto a network that reaches home services (the inference server,
etc.). The tunnel is raised automatically on any untrusted WiFi and dropped on a trusted one, so
nothing has to be toggled by hand.

Nothing here hard-codes a network. The repo ships only generic glue; every site fact is a data
file on the Jet's userdata, so a clone works the same once you drop in your own tunnel.

## What the repo provides (generic)

- `CONFIG_WIREGUARD=m` in `kernel/jet.config` — the module ships to the device in `modules.tar`
  like the others (`docs/rootfs.md`); `wg-quick` modprobes it on demand.
- `wireguard-tools` in the rootfs (`kernel/rootfs/Dockerfile`) — gives `wg` and `wg-quick`.
- `kernel/rootfs/wireguard/on-wifi.sh` — a `wpa_cli` action hook. On each association it fetches a
  fresh DHCP lease for the joined network and then toggles the tunnel by SSID. Installed into the
  chroot at `/etc/wireguard/on-wifi.sh`.
- `kernel/initramfs/init` arms the hook with `wpa_cli -a` right after `wpa_supplicant`, but only
  when a tunnel conf is present — so a device without one is unaffected.

## What you provide (per-device, never committed; `./setup.sh` generates all three and `./install.sh` pushes them)

On the Jet's userdata, under `/android-data/mainline/wireguard/`:

- `wg0.conf` — your tunnel, standard wg-quick format (see `kernel/rootfs/wireguard/wg0.conf.example`).
  Its presence is what enables the feature. It holds a private key and your endpoint, so it stays
  on the device only (gitignored if it ever lands in the tree).
- `trusted` — your home SSID(s), one per line (see `trusted.example`). While associated with one of
  these the tunnel stays down, because you already reach home; everywhere else it comes up.
- `routes` — the home networks to send through the tunnel, one CIDR per line (see `routes.example`).
  If absent, the hook routes just the tunnel address's own /24.

Add the hotspot (and any other roaming networks) to the chroot's
`/etc/wpa_supplicant/wpa_supplicant.conf` as ordinary `network={}` blocks. Give home a higher
`priority=` than the hotspot so it wins when both are in range. (That file is per-device and lives
in `work/`, never the repo; see `docs/networking.md`.)

## Split tunnel, not full tunnel

This kernel is built without policy routing (`CONFIG_IP_MULTIPLE_TABLES` off), so `wg-quick`'s
full-tunnel mode (`AllowedIPs = 0.0.0.0/0`, routed via an fwmark + a separate table + `ip rule`)
cannot work -- `ip rule` returns "Operation not supported". The hook therefore brings `wg0` up by
hand and routes only the `routes` prefixes through it, leaving the Jet's default route on the local
link. The peer's `AllowedIPs` stays `0.0.0.0/0` (that is the crypto scope, not a system route). This
matches the goal -- reach home services off-home -- and keeps the Jet's general traffic direct. (To
make it a true full tunnel instead, enable `CONFIG_IP_MULTIPLE_TABLES` + `CONFIG_IP_ADVANCED_ROUTER`
and switch the hook back to `wg-quick`.)

## The clock comes first

A Jet that boots in the year 2000 cannot handshake (and no TLS certificate is valid). The hook does
not deal with it: the DHCP lease hook sets the clock on every lease, before `dhcp()` returns and so
before the tunnel comes up. See "The clock" in networking.md.

## DNS and MTU

The conf's `DNS` is reachable only through the tunnel, so the hook writes `/etc/resolv.conf` with it
while `wg0` is up. `udhcpc` leaves `resolv.conf` alone whenever `wg0` exists (see
`udhcpc-default.script`), so a lease renewal mid-ride does not clobber it; a trusted join drops the
tunnel first, so its own lease then writes the LAN's resolver back.

Set `PersistentKeepalive = 25` on the `[Peer]`. A phone hotspot sits behind carrier-grade NAT, so
without keepalives the handshake is not kept open and the tunnel comes up with routes and DNS set
but no connectivity (traffic silently goes nowhere). Most server exports omit it; add it on the client.

MTU defaults to 1280 (overridable with `MTU =` in the conf). A phone hotspot's path MTU is smaller
than Ethernet's, and at the default 1420 the handshake and request headers flow but full-size
response packets are silently dropped (a classic PMTU blackhole): you see HTTP 200 with an empty
body. 1280 clears it.

## Notes

- Full tunnel sends the default route through `wg0`, but the USB link (a more-specific /24) is
  unaffected — so the development path over USB survives the tunnel.
- The tunnel only rises on an untrusted SSID; on home WiFi it stays down even while armed, which is
  why it is safe to arm and leave.
- Roaming is seamless without a reboot: `init` runs `udhcpc` once at boot, but the hook re-leases on
  every association, so moving between home and the hotspot re-homes the interface and the tunnel
  follows. (The hook is armed only when a tunnel conf is present, so this re-lease behaviour rides
  along with the VPN; a device with no conf still relies on the boot-time lease.)
- To arm without a reboot (the `init` change needs a boot flash to persist):
  `chroot <rootfs> wpa_cli -B -i wlan0 -a /etc/wireguard/on-wifi.sh`.
