'use strict';

const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const { readEventStream, retryAfterMs } = require('./sub2api-client');

const ipv4Blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3]
]) ipv4Blocked.addSubnet(address, prefix, 'ipv4');
const ipv6Public = new net.BlockList();
ipv6Public.addSubnet('2000::', 3, 'ipv6');
const ipv6Blocked = new net.BlockList();
for (const [address, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]]) {
  ipv6Blocked.addSubnet(address, prefix, 'ipv6');
}

class ReviewError extends Error {
  constructor(code, { httpStatus, diagnostic } = {}) {
    super(code);
    this.code = code;
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
      this.httpStatus = httpStatus;
    }
    if (diagnostic) this.diagnostic = diagnostic;
  }
}

function sanitizeReviewDiagnostic(value, secrets = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const clean = (input, limit) => {
    if (typeof input !== 'string') return '';
    let text = input.slice(0, 8192);
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret) text = text.split(secret).join('[REDACTED]');
    }
    if (/<[!/?a-z]/i.test(text)) return '';
    return text
      .replace(/https?:\/\/[^\s<>"']+/gi, '[URL]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk-|admin-|sess-)[a-zA-Z0-9_-]+/g, '[REDACTED]')
      .replace(/\b(api[_ -]?key|authorization|token|password|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]')
      .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[EMAIL]')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, limit);
  };
  const result = {};
  if (['prepare', 'generate', 'submit', 'poll'].includes(value.stage)) result.stage = value.stage;
  if (Number.isInteger(value.http_status) && value.http_status >= 300 && value.http_status <= 599) {
    result.http_status = value.http_status;
  }
  const code = clean(value.provider_code, 64);
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(code)) result.provider_code = code;
  const message = clean(value.provider_message, 300);
  if (message) result.provider_message = message;
  return Object.keys(result).length ? result : undefined;
}

async function responseDiagnostic(response, apiKey) {
  const chunks = [];
  let length = 0;
  const timer = setTimeout(() => response.destroy(), 2000);
  try {
    for await (const chunk of response) {
      length += chunk.length;
      if (length > 8192) return undefined;
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
    const error = data?.error;
    return sanitizeReviewDiagnostic({
      provider_code: error?.code ?? data?.code ?? data?.error_code,
      provider_message: typeof error === 'string' ? error : error?.message ?? data?.message ?? data?.detail
    }, [apiKey]);
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

function publicAddress(address) {
  if (net.isIP(address) === 4) return !ipv4Blocked.check(address, 'ipv4');
  return net.isIP(address) === 6 && ipv6Public.check(address, 'ipv6') && !ipv6Blocked.check(address, 'ipv6');
}

function reviewUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ReviewError('REVIEW_URL_UNSAFE'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ReviewError('REVIEW_URL_UNSAFE');
  }
  return url;
}

async function resolveReviewAddress(url, signal, lookup = dns.lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let abort;
  try {
    const cancelled = new Promise((_resolve, reject) => {
      abort = () => reject(new ReviewError('REVIEW_TIMEOUT'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), cancelled]);
    if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address))) {
      throw new ReviewError('REVIEW_URL_UNSAFE');
    }
    return addresses.find((entry) => entry.family === 4) || addresses[0];
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function readReviewJson(response, maxResponseBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response) {
    length += chunk.length;
    if (length > maxResponseBytes) throw new ReviewError('REVIEW_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new ReviewError('REVIEW_RESPONSE_INVALID'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ReviewError('REVIEW_RESPONSE_INVALID');
  return result;
}

async function requestReview(value, { method, body, apiKey, signal, taskKey, sessionId, maxResponseBytes = 256 * 1024, secrets = [], accept = 'application/json' }, dependencies, read) {
  const url = reviewUrl(value);
  const address = await resolveReviewAddress(url, signal, dependencies.lookup);
  const raw = body == null ? null : Buffer.from(JSON.stringify(body));
  if (raw?.length > 2 * 1024 * 1024) throw new ReviewError('REVIEW_INPUT_TOO_LARGE');
  const request = dependencies.request || https.request;
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const connection = request(url, {
      method,
      signal,
      agent: false,
      autoSelectFamily: false,
      family: address.family,
      headers: {
        accept,
        'accept-encoding': 'identity',
        ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(sessionId ? { 'session-id': sessionId } : {}),
        ...(method === 'POST' && taskKey ? { 'Idempotency-Key': taskKey } : {})
      },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
    }, async (response) => {
      responseStarted = true;
      try {
        // Redirects never receive credentials or trigger an additional POST.
        if (![200, 201, 202].includes(response.statusCode)) {
          const diagnostic = response.statusCode >= 400 ? await responseDiagnostic(response, apiKey) : undefined;
          const error = new ReviewError('REVIEW_HTTP_ERROR', { httpStatus: response.statusCode, diagnostic: sanitizeReviewDiagnostic(diagnostic, secrets) });
          error.retryAfterMs = retryAfterMs(response.headers['retry-after']);
          if (error.retryAfterMs > 0) error.retryAfterSeconds = Math.min(86400, Math.ceil(error.retryAfterMs / 1000));
          throw error;
        }
        if (Number(response.headers['content-length'] || 0) > maxResponseBytes) throw new ReviewError('REVIEW_RESPONSE_TOO_LARGE');
        resolve(await read(response, maxResponseBytes));
      } catch (error) {
        error.responseStarted = true;
        response.destroy();
        reject(error);
      }
    });
    connection.once('error', (error) => {
      const failure = signal.aborted ? new ReviewError('REVIEW_TIMEOUT') : error;
      failure.responseStarted = responseStarted;
      reject(failure);
    });
    connection.end(raw);
  });
}

function requestReviewJson(value, options, dependencies = {}) {
  return requestReview(value, options, dependencies, readReviewJson);
}

function requestReviewEvents(value, options, onEvent, dependencies = {}) {
  return requestReview(value, { ...options, accept: 'text/event-stream' }, dependencies, async (response, maxBytes) => {
    try {
      if (String(response.headers['content-type'] || '').toLowerCase().includes('text/event-stream')) {
        return await readEventStream({ body: response }, maxBytes, onEvent);
      }
      const payload = await readReviewJson(response, maxBytes);
      if (payload.error) return await onEvent({ type: 'error', error: payload.error });
      if (payload.object !== 'response' || !payload.status) throw new ReviewError('REVIEW_RESPONSE_INVALID');
      return await onEvent({ type: `response.${payload.status}`, response: payload });
    } finally { response.destroy(); }
  });
}

module.exports = { ReviewError, publicAddress, requestReviewJson, requestReviewEvents, resolveReviewAddress, reviewUrl, sanitizeReviewDiagnostic };
