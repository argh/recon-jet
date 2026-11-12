// One small HTTP client for the web tools: a request with a timeout, an abort signal and a body
// cap, resolving with the status and the text. Not `fetch`, for one reason: `insecureTls` has to
// be per request (`rejectUnauthorized: false` on this request's socket only - a self-hosted
// service whose certificate does not verify), never a process-wide switch.
import http from 'node:http';
import https from 'node:https';

/**
 * @param {string|URL} url
 * @param {{method?: string, json?: object, timeoutMs?: number, signal?: AbortSignal, insecureTls?: boolean, maxBytes?: number, headers?: object}} [options]
 * @returns {Promise<{status: number, text: string}>} rejects on a transport error, `timeout` or `cancelled`
 */
export function request(url, { method = 'GET', json, timeoutMs = 10000, signal, insecureTls = false, maxBytes = 2_000_000, headers = {} } = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const timeout = AbortSignal.timeout(timeoutMs);
  const body = json === undefined ? null : JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const fail = (error) => reject(signal?.aborted ? new Error('cancelled') : timeout.aborted ? new Error(`timeout after ${timeoutMs} ms`) : error);
    const req = (secure ? https : http).request(u, {
      method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/json', ...headers, ...(body == null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) },
      ...(secure && insecureTls ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const parts = []; let size = 0;
      res.on('data', (c) => { if (size < maxBytes) parts.push(c); size += c.length; });
      res.on('error', fail);
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8', 0, maxBytes) }));
    });
    req.on('error', fail);
    req.end(body ?? undefined);
  });
}

/** `request`, a 2xx demanded and the body parsed as JSON; the error names the service. */
export async function requestJson(what, url, options) {
  const { status, text } = await request(url, options);
  if (status < 200 || status > 299) throw new Error(`${what} answered ${status}: ${text.slice(0, 120)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${what} did not answer with JSON`); }
}

/** `base` + a path, whatever slashes the configuration has. */
export const under = (base, route) => new URL(route, `${base.replace(/\/+$/, '')}/`);
