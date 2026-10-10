'use strict';

const { Agent, fetch } = require('undici');
const { AppError, ensure } = require('./errors');
const { secureLookup, safeUrl } = require('./security');

class SafeHttpClient {
  constructor(timeoutMs = 30000) {
    this.timeoutMs = timeoutMs;
    this.dispatcher = new Agent({ connect: { lookup: secureLookup }, connections: 16 });
  }

  async request(provider, relativePath, { method = 'GET', body, headers = {}, download = false } = {}) {
    const origin = new URL(provider.baseUrl);
    const allowed = [origin.hostname.toLowerCase(), ...(download ? provider.downloadHosts : [])];
    let url = safeUrl(new URL(relativePath, provider.baseUrl + '/').toString(), allowed);
    let redirects = 0;
    while (true) {
      const outbound = { Accept: download ? '*/*' : 'application/json', ...headers };
      if (url.origin === origin.origin) outbound.Authorization = `Bearer ${provider.apiKey}`;
      if (body != null) outbound['Content-Type'] = 'application/json';
      const response = await fetch(url, { method, body, headers: outbound, redirect: 'manual', dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs) });
      if (![301,302,303,307,308].includes(response.status)) return response;
      await response.body?.cancel();
      ensure(download && ++redirects <= 3, 'REDIRECT_DENIED', 'Upstream API redirects are forbidden', 502);
      url = safeUrl(new URL(response.headers.get('location'), url).toString(), allowed);
    }
  }

  async json(provider, route, options) {
    const response = await this.request(provider, route, options);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        ensure(size <= 1024 * 1024, 'UPSTREAM_BODY_LIMIT', 'Upstream JSON exceeds the allowed size', 502);
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    if (!response.ok) {
      const failure = new AppError('UPSTREAM_HTTP_ERROR', 'Supplier returned an HTTP error', 502);
      failure.upstreamStatus = response.status;
      const retry = Number(response.headers.get('retry-after'));
      failure.retryAfterMs = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 3600000) : undefined;
      throw failure;
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'),(_key,value,context) => typeof value==='number' ? context.source : value);
    }
    catch { throw new AppError('UPSTREAM_JSON_INVALID', 'Supplier did not return valid JSON', 502); }
  }

  async close() { await this.dispatcher.close(); }
}

module.exports = { SafeHttpClient };
