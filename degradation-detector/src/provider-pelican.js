'use strict';

const { responseText, extractHtml } = require('./detection-runner');
const { requestReviewEvents, ReviewError } = require('./review-http');
const { prepareReviewHtml } = require('./visual-review');
const { PELICAN_METHOD, PELICAN_PROMPT } = require('./provider-config');

async function generatePelican({ snapshot, key, signal, maxResponseBytes, taskKey }, request = requestReviewEvents) {
  const started = Date.now();
  let firstTokenMs = null, terminal = null, deltas = '';
  const body = {
    model: snapshot.model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: snapshot.prompt }] }],
    stream: true,
    reasoning: { effort: snapshot.reasoning_effort },
    ...(snapshot.service_tier ? { service_tier: snapshot.service_tier } : {})
  };
  const endpoint = snapshot.target_url.replace(/\/+$/, '') + '/responses';
  await request(endpoint, { method: 'POST', body, apiKey: key, secrets: [key], signal, maxResponseBytes, taskKey }, event => {
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      if (firstTokenMs == null && event.delta) firstTokenMs = Date.now() - started;
      deltas += event.delta;
    }
    if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled', 'error'].includes(event.type)) {
      terminal = event;
      return false;
    }
  });
  signal.throwIfAborted();
  if (terminal?.type !== 'response.completed' || terminal.response?.status !== 'completed' || terminal.response.error) {
    const error = new ReviewError(terminal ? 'PROVIDER_GENERATION_FAILED' : 'PROVIDER_GENERATION_INCOMPLETE');
    const detail = terminal?.response?.error || terminal?.error;
    error.diagnostic = { provider_code: detail?.code, provider_message: typeof detail === 'string' ? detail : detail?.message };
    throw error;
  }
  const payload = terminal.response;
  const html = extractHtml(responseText(payload, 'responses') || deltas);
  // Use the existing bounded HTML/SVG preparation without repairing the artwork.
  prepareReviewHtml(html);
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    html, duration_ms: Date.now() - started, first_token_ms: firstTokenMs,
    input_tokens: count(payload.usage?.input_tokens), output_tokens: count(payload.usage?.output_tokens)
  };
}

module.exports = { generatePelican, PELICAN_METHOD, PELICAN_PROMPT };
