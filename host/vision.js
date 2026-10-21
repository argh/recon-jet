#!/usr/bin/env node
// vision — ask the local llama-swap vision model (or Claude) about an image.
//
//   node host/vision.js <image.jpg> ["question"] [--claude]
//
// Local model: LLM_BASE (OpenAI-compatible base URL, required), model LLM_VISION_MODEL (default "qwen-vision").
// Claude escalation uses ANTHROPIC_API_KEY and claude-haiku-5-5 by default.

const fs = require('fs');
const https = require('https');

const LOCAL = { base: process.env.LLM_BASE || '', model: process.env.LLM_VISION_MODEL || 'qwen-vision' };
if (!LOCAL.base) console.error('vision: LLM_BASE is not set (OpenAI-compatible base URL)');
const agent = new https.Agent({ rejectUnauthorized: false }); // local CA

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, agent: process.env.LLM_INSECURE_TLS ? agent : undefined }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 300))); } });
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}

async function askLocal(imagePath, question, { maxTokens = 200 } = {}) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const mime = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const r = await post(`${LOCAL.base}/chat/completions`, {}, {
    model: LOCAL.model, max_tokens: maxTokens, temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false },   // qwen3-vl thinks by default and burns the budget
    messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }],
  });
  if (!r.choices) throw new Error(JSON.stringify(r).slice(0, 300));
  const m = r.choices[0].message;
  return (m.content || m.reasoning_content || '').trim();
}

async function askClaude(imagePath, question, { model = 'claude-haiku-5-5', maxTokens = 300 } = {}) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const r = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, {
    model, max_tokens: maxTokens,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: question }] }],
  });
  if (!r.content) throw new Error(JSON.stringify(r).slice(0, 300));
  return r.content.map((c) => c.text || '').join('').trim();
}

if (require.main === module) {
  const [img, q = 'Describe what is in this image in one short sentence.'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const useClaude = process.argv.includes('--claude');
  const t0 = Date.now();
  (useClaude ? askClaude : askLocal)(img, q).then((a) => { console.log(a); console.error(`[${useClaude ? 'claude' : LOCAL.model}] ${Date.now() - t0} ms`); }).catch((e) => { console.error('error:', e.message); process.exit(1); });
}

module.exports = { askLocal, askClaude };
