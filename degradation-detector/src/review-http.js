'use strict';

const dns = require('dns').promises;
const https = require('https');
const net = require('net');

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
  constructor(code) {
    super(code);
    this.code = code;
  }
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

async function requestReviewJson(value, { method, body, apiKey, signal, taskKey }, dependencies = {}) {
  const url = reviewUrl(value);
  const address = await resolveReviewAddress(url, signal, dependencies.lookup);
  const raw = body == null ? null : Buffer.from(JSON.stringify(body));
  if (raw?.length > 2 * 1024 * 1024) throw new ReviewError('REVIEW_INPUT_TOO_LARGE');
  const request = dependencies.request || https.request;
  return new Promise((resolve, reject) => {
    const connection = request(url, {
      method,
      signal,
      agent: false,
      autoSelectFamily: false,
      family: address.family,
      headers: {
        accept: 'application/json',
        ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(method === 'POST' ? { 'Idempotency-Key': taskKey } : {})
      },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
    }, async (response) => {
      try {
        // Redirects never receive credentials or trigger an additional POST.
        if (![200, 201].includes(response.statusCode)) throw new ReviewError('REVIEW_HTTP_ERROR');
        if (Number(response.headers['content-length'] || 0) > 256 * 1024) throw new ReviewError('REVIEW_RESPONSE_TOO_LARGE');
        const chunks = [];
        let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          if (length > 256 * 1024) throw new ReviewError('REVIEW_RESPONSE_TOO_LARGE');
          chunks.push(chunk);
        }
        let result;
        try { result = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
        catch { throw new ReviewError('REVIEW_RESPONSE_INVALID'); }
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ReviewError('REVIEW_RESPONSE_INVALID');
        resolve(result);
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    connection.once('error', (error) => reject(signal.aborted ? new ReviewError('REVIEW_TIMEOUT') : error));
    connection.end(raw);
  });
}

module.exports = { ReviewError, publicAddress, requestReviewJson, resolveReviewAddress, reviewUrl };
