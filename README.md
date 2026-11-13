# Recon Jet on mainline Linux as DIY AI Glasses

A 2013 Recon Jet heads-up display (OMAP4430) running mainline Linux 6.18 from its eMMC as a thin
I/O peripheral: display, camera, mics, speaker, IMU, glance sensor, WiFi and Bluetooth, driven by
a small on-device daemon and a Node application, talking to an OpenAI-compatible inference server
you point it at. The stock software is long abandoned (activation servers are gone); the hardware
is a complete wearable computer that deserves better.

The project is documented at [blog.v0.net](https://blog.v0.net/converting-obsolete-sports-tech-into-ai-glasses-part-1/)

(This repo should be considered a resource for forking/extending, rather than as an active project.)

## You can run it on your own Jet - but use common sense!

First, set your expectations.  Although I've abstracted many settings, the setup is still highly
biased towards an environment shaped like mine.  Most people will need/want to make changes to adapt
to their own inference services.  Be forewarned that if you point at a commercial service, this code 
gleefully burns tokens assuming they are free!  Don't blame me if you get a giant bill.  Or if the
AI tells you to do something stupid.  Oh, and don't run this while doing anything other than sitting
safely in an office chair.  If you wear it out in the world, it will distract you and you will likely
get hurt or die or become emotionally damaged from people making fun of you.  And don't use it to
record people without their consent.  Got it?  Cool.

```
./setup.sh      # your WiFi, your ssh key, your inference server — writes only gitignored files
./install.sh    # builds everything, finds the device in whatever state it is, takes it to mainline
```

`install.sh` is a state machine: it detects where the device is (fresh out of the box on MTP,
stock Android over adb, fastboot, or already on mainline over ssh) and does the next right thing,
so re-running after any interruption continues instead of starting over. The full journey, stage
by stage, is `docs/setup.md`.

Your device stays recoverable the whole way — `docs/recovery.md` is the short proof:

- The bootloader partitions are **never written**, by anything in this repo.
- Before the first flash, every partition except userdata is **backed up with checksums** to
  `refs/backup/` (archive that directory somewhere safe).
- Test images are **RAM-booted**; a bad one costs a power cycle, not a reflash.
- Every flash is **read back and checksum-verified** before a reboot is even suggested.
- `./recover.sh` restores your own verified stock backups. The rooted-Android fallback stays in
  the recovery slot: `reboot2 recovery` from mainline always gets you adb back.

## Map

- `AGENTS.md` is the orientation for people and agents; `docs/` holds the facts by topic
  (`docs/status.md` is the executive summary of what works).
- `kernel/` builds the kernel, device tree, rootfs and boot image (Docker); `agent/` is the
  on-device daemon; `device/jet-app/` the Node application layer; `host/` the `jet` CLI (a
  one-shot jetd client for poking the device from a workstation — never in the runtime path);
  `tools/` build, install and debugging helpers.
- Private configuration (networks, credentials, host lists) never lives in the repo: `./setup.sh`
  generates it all into gitignored files. See the personalisation section of `AGENTS.md`.

## Acknowledgements

This project stands on a lot of other people's work.

**Claude**

- [Claude](https://claude.com/product/claude-code) (Anthropic) did the heavy lifting.  Kudos!
  (@argh provided architectural review, and acted as Product Manager and Chief LGTM officer.)

**The Jet itself: prior art and reverse-engineering references**

- [gilzhaiek/jet](https://github.com/gilzhaiek/jet): the complete ReconOS build tree (AOSP 4.1,
  u-boot, x-loader, the stock 3.0 kernel and its board files). The hardware facts in `docs/` and
  the device tree come from reading it.
- [evandcoleman/jet_kernel](https://github.com/evandcoleman/jet_kernel): the stock kernel source.
- [gstarnet/sdk](https://github.com/gstarnet/sdk): a mirror of the Recon HUD SDK.
- [recom3](https://github.com/recom3), in particular
  [api-hud-goggle issue 6](https://github.com/recom3/api-hud-goggle/issues/6): the
  `PleaseEnableADB` hook that gets adb on a device whose activation servers are gone.
- The XDA thread [Recon Jet Basic Info](https://xdaforums.com/t/recon-jet-basic-info.3086703/):
  partition map, fastboot behaviour, and the community's collected knowledge.
- [Kopin](https://www.kopin.com/products/microdisplays/wqvga-0-2-lcd-color-display/)
  for the WQVGA microdisplay documentation, and the
  [Recon Jet user manual](https://www.intel.com/content/dam/support/us/en/documents/emerging-technologies/wearable-devices/Recon_Jet_User_Manual_June_2016.pdf).

**Kernel and system**

- [Linux](https://kernel.org/) 6.18 and the linux-omap maintainers who keep OMAP4 alive in
  mainline: the `omap4iss` camera driver, `wlcore`/`wl12xx`, the TWL6030/6040 drivers, and the
  Epson Moverio BT-200 device tree (`omap4-epson-embt2ws`), the closest mainline sibling and
  the reference this one was written against.
- [linux-firmware](https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git)
  (TI WiLink blobs) and
  [wireless-regdb](https://git.kernel.org/pub/scm/linux/kernel/git/sforshee/wireless-regdb.git).
- [Debian](https://www.debian.org/) bookworm (the armhf rootfs and the build containers),
  [BusyBox](https://busybox.net/), [BlueZ](https://github.com/bluez/bluez),
  [WireGuard](https://www.wireguard.com/), [wpa_supplicant](https://w1.fi/wpa_supplicant/),
  [Dropbear](https://matt.ucc.asn.au/dropbear/dropbear.html).
- [Zig](https://ziglang.org/) (`zig cc`) and [musl](https://musl.libc.org/): every static ARM
  binary here is cross-built with them.
- [Terminus Font](https://terminus-font.sourceforge.net/): the glass's typeface.
- [Node.js](https://nodejs.org/), [jpeg-js](https://github.com/jpeg-js/jpeg-js) and
  [@photostructure/tz-lookup](https://github.com/photostructure/tz-lookup).

**Wake word**

- [microWakeWord](https://github.com/kahrendt/microWakeWord) (Kevin Ahrendt): the model
  architecture and training pipeline, with
  [piper-sample-generator](https://github.com/rhasspy/piper-sample-generator) for the synthetic
  training speech.
- [ESPHome micro_wake_word](https://github.com/esphome/micro-wake-word-models): the inference
  pipeline `agent/wake` follows.
- [TensorFlow Lite Micro](https://github.com/tensorflow/tflite-micro), via
  [esp-tflite-micro](https://github.com/espressif/esp-tflite-micro), and
  [pymicro-features](https://github.com/rhasspy/pymicro-features) for the audio frontend.
- [@versionzero/module-manager](https://github.com/argh/module-manager),
  [@versionzero/configurator](https://github.com/argh/configurator) and
  [@versionzero/schema](https://github.com/argh/schema) encode some of my architectural opinions; used as the
  module, configuration and command-line structure of both `device/jet-app` and the `jet` CLI.

**Inference and the agent's tools** (none of it runs on the Jet; all of it is why the Jet is useful)

- [llama.cpp](https://github.com/ggml-org/llama.cpp) and
  [llama-swap](https://github.com/mostlygeek/llama-swap): the inference server.
- [Qwen](https://github.com/QwenLM): chat and vision,
  [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) for speech recognition, and
  [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), whose voice cloning is Jet's voice.
- [Kokoro](https://github.com/hexgrad/kokoro): the stock voice a fresh `./setup.sh` defaults to.
- [SearXNG](https://github.com/searxng/searxng) and
  [Firecrawl](https://github.com/firecrawl/firecrawl): web search and page reading.
- [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors for the map tiles, and
  [GeoNames](https://www.geonames.org/) (CC BY 4.0) for the offline place names.

**Doom**

- [doomgeneric](https://github.com/ozkl/doomgeneric) and
  [Chocolate Doom](https://github.com/chocolate-doom/chocolate-doom), and id Software for
  releasing the source in the first place.

## Licensing

This is a non-commercial project. The code written for it (the `jetd` daemon and the rest of `agent/`,
`device/jet-app/`, the `host/` CLI, `tools/`, the build and install scripts, and the docs) is
licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE).

Parts of the repository derive from or bundle other work and keep that work's licence:

| Path | What it is | Licence |
|---|---|---|
| `kernel/overlay/`, `kernel/patches/`, `kernel/*.dts` | Linux drivers, patches and device trees | GPL-2.0, as marked in each file's SPDX line |
| `device/doom/` | platform code written against doomgeneric and Chocolate Doom, parts adapted from Chocolate Doom's SDL drivers | GPL-2.0-or-later |
| `agent/font/`, `device/jet-app/assets/fonts/` | Terminus Font | SIL Open Font License 1.1 |
| `device/jet-app/assets/places/` | city table derived from GeoNames | CC BY 4.0 |
| `agent/wake/jetwake`, `agent/wake/jetwake-native` | prebuilt binaries linking TensorFlow Lite Micro | Apache-2.0 |

A boot image built from this repository contains the Linux kernel and is distributed under the
kernel's GPL-2.0 terms. Nothing here includes Recon's stock firmware or Doom's game data.
