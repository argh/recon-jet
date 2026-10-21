# Recon Jet on mainline Linux

A 2013 Recon Jet heads-up display (OMAP4430) running mainline Linux 6.18 from its eMMC as a thin
I/O peripheral: display, camera, mics, speaker, IMU, glance sensor, WiFi and Bluetooth, driven by
a small on-device daemon and an assistant that runs on a host.

- `AGENTS.md` is the orientation for people and agents; `docs/` holds the facts by topic.
- `kernel/` builds the kernel, device tree and boot image (Docker); `agent/` is the device daemon;
  `host/` is the host-side hub and voice scripts; `tools/` are helpers.
- Private configuration (network, credentials, host lists) never lives in the repo: see the
  personalisation section of `AGENTS.md`.
