#!/usr/bin/env node
// Interactive personalisation for a cloned repo: everything about YOUR Jet and YOUR network
// lives in gitignored files, and this wizard writes all of them. Run via ./setup.sh.
//
// Answers persist in work/setup.json: a re-run presents the previous answers as defaults, so
// changing one thing never means re-typing the rest. Non-interactive paths for agents: pipe
// answer lines on stdin (blank line = keep/default), or edit work/setup.json and re-run with
// --from-answers to regenerate every output file without any questions.
//
// Files written (all gitignored; none of them ever belong in a commit):
//   work/setup.json                        the answers themselves (chmod 600)
//   work/wifi/wpa_supplicant.conf          WiFi networks (PSKs stored as WPA hex, not plaintext)
//   work/ssh/authorized_keys               your public key, for root ssh to the Jet
//   work/device/jet-app.json               per-device app config -> /android-data/mainline/jet-app.json
//   device/jet-app/personal/jet-app.json   host-side dev config (running jet-app from the Mac)
//   work/wireguard/{wg0.conf,trusted,routes}  optional off-home VPN (docs/vpn.md)
//   work/usbnet                            only when you change the USB subnet default
//   work/env.sh                            `. work/env.sh` to point host tools at your setup
//
// No prompt here talks to the device; ./install.sh pushes these files where they belong.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline'); // classic, not /promises: masking needs _writeToOutput

const root = path.join(__dirname, '..');
const W = (...p) => path.join(root, 'work', ...p);
const answersFile = W('setup.json');

// ---------- prompt plumbing ----------------------------------------------------------------

let rl = null;
let muted = false;
let promptText = '';

let piped = null; // non-TTY: all answer lines, read up front (readline drops lines between questions)

function openRl() {
  if (!process.stdin.isTTY) { piped = fs.readFileSync(0, 'utf8').split('\n'); return; }
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const write = rl._writeToOutput.bind(rl);
  // readline redraws "<prompt><buffer>" as you type: keep the prompt, star the buffer
  rl._writeToOutput = (s) => {
    if (!muted) return write(s);
    if (s.startsWith(promptText)) return write(promptText + s.slice(promptText.length).replace(/[^\r\n]/g, '*'));
    return write(s.replace(/[^\r\n]/g, '*'));
  };
}

function question(prompt) {
  if (piped) {
    if (!piped.length) return Promise.reject(new Error('stdin ended before all questions were answered'));
    const a = piped.shift();
    process.stdout.write(`${prompt}${muted && a ? '********' : a}\n`);
    return Promise.resolve(a);
  }
  return new Promise((res) => rl.question(prompt, res));
}

/** ask(label, previous, {secret, validate}) -> string (trimmed; empty allowed unless validate) */
async function ask(label, prev, { secret = false, validate = null } = {}) {
  for (;;) {
    const hint = prev ? (secret ? ' [keep current]' : ` [${prev}]`) : '';
    promptText = `  ${label}${hint}: `;
    muted = secret;
    const raw = (await question(promptText)).trim();
    muted = false;
    const v = raw === '' ? (prev ?? '') : raw;
    const bad = validate && validate(v);
    if (bad) { console.log(`    ! ${bad}`); continue; }
    return v;
  }
}

async function askYn(label, prevBool) {
  const prev = prevBool ? 'y' : 'n';
  const v = await ask(`${label} (y/n)`, prev, { validate: (s) => (/^[yn]$/i.test(s) ? null : 'y or n') });
  return /^y$/i.test(v);
}

// ---------- helpers ------------------------------------------------------------------------

const load = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function save(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode); // writeFileSync mode only applies on create
  written.push(path.relative(root, file));
}
const written = [];

/** WPA-PSK derivation (what wpa_passphrase prints): the conf never holds the plaintext. */
const wpaHex = (ssid, psk) => crypto.pbkdf2Sync(psk, ssid, 4096, 32, 'sha1').toString('hex');

function findSshKey() {
  for (const n of ['id_ed25519.pub', 'id_rsa.pub', 'id_ecdsa.pub']) {
    const f = path.join(os.homedir(), '.ssh', n);
    if (fs.existsSync(f)) return f;
  }
  return '';
}

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// ---------- the questions ------------------------------------------------------------------

async function collect(prev) {
  const a = { wifi: { networks: [] }, llm: {}, wireguard: {} };

  console.log('\nWiFi — the Jet is 2.4 GHz only (WL1283). The first network is "home": highest');
  console.log('priority, and the default trusted network for the optional VPN below.');
  const prevNets = prev?.wifi?.networks ?? [];
  for (let i = 0; ; i++) {
    const p = prevNets[i];
    if (i > 0 && !(await askYn(i < prevNets.length ? `keep/edit extra network "${prevNets[i].ssid}"` : 'add another network (phone hotspot, office, ...)', i < prevNets.length))) break;
    const ssid = await ask(i === 0 ? 'home network SSID' : 'SSID', p?.ssid, { validate: (s) => (s ? null : 'required') });
    const psk = await ask('passphrase (empty = open network)', p?.psk, {
      secret: true,
      validate: (s) => (s === '' || (s.length >= 8 && s.length <= 63) ? null : 'WPA passphrases are 8-63 characters'),
    });
    a.wifi.networks.push({ ssid, psk, priority: 10 - i });
  }

  console.log('\nSSH — your public key becomes root\'s authorized_keys on the Jet.');
  a.sshKey = await ask('public key file', prev?.sshKey || findSshKey(), {
    validate: (f) => (f && fs.existsSync(expand(f)) ? null : 'file not found'),
  });

  console.log('\nInference server — an OpenAI-compatible endpoint (llama-swap, llama.cpp server,');
  console.log('vLLM, ...) reachable from the Jet over WiFi. Empty = skip; the Jet still runs,');
  console.log('without the assistant. TLS must verify (public CA): no insecure options on-device.');
  a.llm.base = await ask('base URL (https://host/v1)', prev?.llm?.base ?? '', {
    validate: (s) => (s === '' || /^https?:\/\//.test(s) ? null : 'a URL, or empty to skip'),
  });
  if (a.llm.base) {
    const d = { asrModel: 'qwen3-asr', chatModel: 'qwen-27b', ttsModel: 'kokoro', ttsVoice: 'af_heart', visionModel: 'qwen-vision' };
    for (const k of Object.keys(d)) a.llm[k] = await ask(k, prev?.llm?.[k] ?? d[k]);
  }

  console.log('\nMap — OpenStreetMap\'s tile policy prefers a User-Agent with a contact.');
  a.tileAgent = await ask('tile User-Agent (empty = generic default)', prev?.tileAgent ?? '');

  console.log('\nAddressing — defaults are fine unless they collide with your networks.');
  a.jetHost = await ask('how host tools reach the Jet (mDNS name or address)', prev?.jetHost ?? 'jet.local');
  a.usbnet = await ask('USB link subnet, first three octets', prev?.usbnet ?? '10.42.0', {
    validate: (s) => (/^\d+\.\d+\.\d+$/.test(s) ? null : 'like 10.42.0'),
  });

  console.log('\nOff-home VPN (optional, docs/vpn.md) — on any WiFi except the trusted one(s) the');
  console.log('Jet raises a WireGuard tunnel to reach your home services. Point this at a client');
  console.log('conf exported by your WireGuard server; empty = skip.');
  a.wireguard.conf = await ask('wg-quick conf to import', prev?.wireguard?.conf ?? '', {
    validate: (f) => (f === '' || fs.existsSync(expand(f)) ? null : 'file not found'),
  });
  if (a.wireguard.conf) {
    a.wireguard.trusted = await ask('trusted SSIDs (comma-separated; tunnel stays DOWN on these)',
      prev?.wireguard?.trusted ?? a.wifi.networks[0].ssid);
    a.wireguard.routes = await ask('home networks to route through it (CIDRs, comma-separated; empty = the tunnel\'s own /24)',
      prev?.wireguard?.routes ?? '');
  }
  return a;
}

// ---------- the outputs --------------------------------------------------------------------

function emit(a) {
  // WiFi
  const nets = a.wifi.networks.map((n) => {
    const key = n.psk === '' ? '    key_mgmt=NONE' : `    psk=${wpaHex(n.ssid, n.psk)}\n    key_mgmt=WPA-PSK`;
    return `network={\n    ssid="${n.ssid}"\n${key}\n    priority=${n.priority}\n}`;
  });
  save(W('wifi', 'wpa_supplicant.conf'),
    `ctrl_interface=/run/wpa_supplicant\nupdate_config=0\n${nets.join('\n')}\n`, 0o600);

  // SSH
  save(W('ssh', 'authorized_keys'), fs.readFileSync(expand(a.sshKey), 'utf8'), 0o600);

  // App config: device layer (pushed to /android-data/mainline/jet-app.json) ...
  const dev = {};
  if (a.llm.base) {
    dev.llm = { base: a.llm.base };
    for (const k of ['asrModel', 'chatModel', 'ttsModel', 'ttsVoice', 'visionModel'])
      if (a.llm[k]) dev.llm[k] = a.llm[k];
  }
  if (a.tileAgent) dev.mapMode = { userAgent: a.tileAgent };
  save(W('device', 'jet-app.json'), JSON.stringify(dev, null, 2) + '\n');
  // ... and the host-side personal layer (running jet-app on the Mac against the device)
  const personal = { deviceLink: { host: a.jetHost }, ...(a.llm.base ? { llm: { base: a.llm.base } } : {}) };
  save(path.join(root, 'device', 'jet-app', 'personal', 'jet-app.json'), JSON.stringify(personal, null, 2) + '\n');

  // WireGuard
  if (a.wireguard.conf) {
    let conf = fs.readFileSync(expand(a.wireguard.conf), 'utf8');
    if (!/^\s*\[Interface\]/m.test(conf) || !/^\s*\[Peer\]/m.test(conf))
      throw new Error(`${a.wireguard.conf} does not look like a wg-quick conf ([Interface] + [Peer])`);
    if (!/PersistentKeepalive/i.test(conf)) {
      conf = conf.replace(/^\s*\[Peer\]/m,
        '[Peer]\n# added by setup.sh: hotspots sit behind carrier NAT; without keepalives the tunnel\n# comes up but carries nothing (docs/vpn.md)\nPersistentKeepalive = 25');
      console.log('  - added PersistentKeepalive = 25 (your export lacked it; see docs/vpn.md)');
    }
    save(W('wireguard', 'wg0.conf'), conf, 0o600);
    save(W('wireguard', 'trusted'), a.wireguard.trusted.split(',').map((s) => s.trim()).filter(Boolean).join('\n') + '\n');
    const routes = (a.wireguard.routes || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (routes.length) save(W('wireguard', 'routes'), routes.join('\n') + '\n');
    else fs.rmSync(W('wireguard', 'routes'), { force: true });
  }

  // USB subnet override (only when not the built-in default)
  if (a.usbnet !== '10.42.0') save(W('usbnet'), a.usbnet + '\n');
  else fs.rmSync(W('usbnet'), { force: true });

  // Host environment
  const env = [`export JET_HOST=${a.jetHost}`];
  if (a.llm.base) {
    env.push(`export LLM_BASE=${a.llm.base}`);
    for (const [k, v] of [['ASR', a.llm.asrModel], ['CHAT', a.llm.chatModel], ['TTS', a.llm.ttsModel], ['VISION', a.llm.visionModel]])
      if (v) env.push(`export LLM_${k}_MODEL=${v}`);
    if (a.llm.ttsVoice) env.push(`export LLM_TTS_VOICE=${a.llm.ttsVoice}`);
  }
  save(W('env.sh'), '# generated by setup.sh: `. work/env.sh` points the host tools at your setup\n' + env.join('\n') + '\n');

  save(answersFile, JSON.stringify(a, null, 2) + '\n', 0o600);
}

// ---------- main ---------------------------------------------------------------------------

(async () => {
  const prev = load(answersFile);
  const fromAnswers = process.argv.includes('--from-answers');
  let a;
  if (fromAnswers) {
    if (!prev) { console.error('FAIL: --from-answers needs work/setup.json (run interactively once, or write it)'); process.exit(1); }
    a = prev;
  } else {
    // a tty prompts; a pipe answers the same questions line by line (blank = keep/default)
    console.log(prev ? 'setup: previous answers found; enter keeps each one' : 'setup: first run; enter accepts a [default]');
    openRl();
    a = await collect(prev);
    if (rl) rl.close();
  }
  emit(a);
  console.log('\nsetup: wrote');
  for (const f of written) console.log(`  ${f}`);
  console.log(`\n  wifi: ${a.wifi.networks.map((n) => `"${n.ssid}"`).join(', ')} (passphrases stored as WPA hex)`);
  console.log(`  vpn:  ${a.wireguard.conf ? 'on (trusted: ' + a.wireguard.trusted + ')' : 'off'}`);
  console.log('\nnext: ./install.sh  (builds everything and walks the device to mainline)');
})().catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1); });
