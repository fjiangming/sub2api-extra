'use strict';

function protocolFor(group, profile) {
  if (profile.protocol !== 'auto') return profile.protocol;
  if (group.platform === 'anthropic' || /^claude[-.]/i.test(profile.model)) return 'messages';
  if (['gemini', 'antigravity'].includes(group.platform)) return 'gemini';
  return group.platform === 'openai' ? 'responses' : 'chat';
}

function requestFor(group, profile, maxTokens) {
  const protocol = protocolFor(group, profile), prompt = 'Reply with OK.';
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (protocol === 'messages') return { protocol, path: '/v1/messages', headers: { ...headers, 'x-api-key': profile.key, 'anthropic-version': '2023-06-01' },
    body: { model: profile.model, max_tokens: maxTokens, stream: false, messages: [{ role: 'user', content: prompt }] } };
  if (protocol === 'gemini') return { protocol, path: `/v1beta/models/${encodeURIComponent(profile.model.replace(/^models\//, ''))}:generateContent`,
    headers: { ...headers, 'x-goog-api-key': profile.key }, body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } } };
  headers.authorization = `Bearer ${profile.key}`;
  return protocol === 'responses' ? { protocol, path: '/v1/responses', headers,
    body: { model: profile.model, input: prompt, max_output_tokens: maxTokens, stream: false, store: false } } :
    { protocol, path: '/v1/chat/completions', headers, body: { model: profile.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false } };
}

function hasText(payload, protocol) {
  const text = v => typeof v === 'string' && v.trim().length > 0;
  const some = (items, predicate) => Array.isArray(items) && items.some(item => item != null && predicate(item));
  if (!payload || payload.error) return false;
  if (protocol === 'messages') return payload.type === 'message' && some(payload.content, item => item.type === 'text' && text(item.text));
  if (protocol === 'responses') return ['completed', 'incomplete'].includes(payload.status) && some(payload.output, item => item.type === 'message' && some(item.content, part => part.type === 'output_text' && text(part.text)));
  if (protocol === 'gemini') return some(payload.candidates, item => some(item.content?.parts, part => !part.thought && text(part.text)));
  return some(payload.choices, item => text(item.message?.content));
}

class GroupMonitorProbe {
  constructor({ config, fetchImpl = globalThis.fetch }) { this.config = config; this.fetch = fetchImpl; }

  async probe(group, profile, policy, signal, baseUrl) {
    const started = performance.now(), controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, policy.timeoutSeconds * 1000);
    let httpStatus = null;
    try {
      if (signal?.aborted) controller.abort();
      const base = baseUrl || this.config.sub2apiBaseUrl || this.config.sub2apiPublicUrl;
      if (!base) return { status: 'blocked', code: 'SITE_NOT_CONFIGURED', httpStatus: null, elapsedMs: 0 };
      const url = new URL(base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid site');
      const request = requestFor(group, profile, policy.maxOutputTokens);
      const response = await this.fetch(`${base.replace(/\/$/, '')}${request.path}`, { method: 'POST',
        headers: request.headers, body: JSON.stringify(request.body), redirect: 'error', signal: controller.signal });
      httpStatus = response.status;
      if (!response.ok) { await response.body?.cancel(); return { status: 'failed', code: 'HTTP_ERROR', httpStatus, elapsedMs: Math.round(performance.now() - started), protocol: request.protocol }; }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty body');
      const chunks = []; let bytes = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 262144) { await reader.cancel(); return { status: 'failed', code: 'RESPONSE_TOO_LARGE', httpStatus, elapsedMs: Math.round(performance.now() - started), protocol: request.protocol }; }
        chunks.push(Buffer.from(next.value));
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { payload = null; }
      const valid = hasText(payload, request.protocol) === true;
      const rawId = response.headers.get('x-request-id') || '';
      return { status: valid ? 'ok' : 'failed', code: valid ? 'GENERATED' : 'INVALID_GENERATION', httpStatus,
        elapsedMs: Math.round(performance.now() - started), protocol: request.protocol,
        requestId: /^[A-Za-z0-9_-]{1,128}$/.test(rawId) ? rawId : null };
    } catch {
      return { status: signal?.aborted ? 'cancelled' : 'failed', code: signal?.aborted ? 'CANCELLED' : controller.signal.aborted ? 'TIMEOUT' : 'REQUEST_UNAVAILABLE',
        httpStatus, elapsedMs: Math.round(performance.now() - started) };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
}

module.exports = { GroupMonitorProbe, protocolFor, requestFor, hasText };
