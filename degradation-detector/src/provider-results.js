'use strict';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percentage = value => number(value) != null && value <= 100 ? value : null;
const text = (value, max = 4000) => typeof value === 'string' ? value.slice(0, max) : null;

// Persist an allowlist of result fields; never persist echoed credentials, request headers or remote share links.
function cleanManxue(data, secrets = []) {
  if (!object(data)) throw new Error('PROVIDER_RESPONSE_INVALID');
  const cleanText = (value, max) => {
    let output = text(value, max);
    for (const secret of secrets) if (secret && output) output = output.split(secret).join('[REDACTED]');
    return output;
  };
  const candy = object(data.candy) ? {
    status: text(data.candy.status, 30), answer: cleanText(data.candy.answer, 100000),
    duration_ms: number(data.candy.duration_ms), input_tokens: number(data.candy.input_tokens), output_tokens: number(data.candy.output_tokens)
  } : null;
  const assessment = object(data.assessment) ? { quality: text(data.assessment.quality, 40), label: cleanText(data.assessment.label, 100), reason: cleanText(data.assessment.reason, 4000) } : null;
  return {
    status: text(data.status, 30), phase: text(data.phase, 50), candy, assessment,
    result: object(data.result) ? { html: cleanText(data.result.html, 2 * 1024 * 1024), duration_ms: number(data.result.duration_ms), input_tokens: number(data.result.input_tokens), output_tokens: number(data.result.output_tokens) } : null,
    prompt: cleanText(data.prompt, 100000)
  };
}

function cleanReport(data, mode) {
  if (!object(data) || data.mode !== mode || !object(data.engines?.[mode])) throw new Error('PROVIDER_RESPONSE_INVALID');
  const engine = data.engines[mode];
  const common = { duration: number(engine.duration) };
  if (mode === 'iq') {
    if (!['excellent', 'high', 'normal', 'timeout', 'failed'].includes(engine.level)) throw new Error('PROVIDER_RESPONSE_INVALID');
    return { ...common, level: engine.level, timeout: engine.timeout === true };
  }
  if (mode === 'cache') return { ...common, hit_rate: percentage(engine.hit_rate), request_hit_rate: percentage(engine.request_hit_rate), supported: engine.supported === true, total: number(engine.total) };
  if (typeof engine.has_thinking !== 'boolean' || typeof engine.has_signature !== 'boolean') throw new Error('PROVIDER_RESPONSE_INVALID');
  return { ...common, has_thinking: engine.has_thinking, has_signature: engine.has_signature };
}

function conclusion(channel, response) {
  if (channel === 'candy') return ({ passed: 'passed', incorrect: 'failed', error: 'error' })[response?.candy?.status] || 'unknown';
  if (channel === 'pelican') return ({ normal: 'passed', degraded: 'failed', suspicious: 'failed', unknown: 'unknown' })[response?.assessment?.quality] || 'unknown';
  return ({ excellent: 'passed', high: 'passed', normal: 'failed', failed: 'error', timeout: 'error' })[response?.iq?.level] || 'unknown';
}

function runSummary(row) {
  if (!row) return null;
  const response = JSON.parse(row.summary_json || '{}');
  return {
    id: row.id, group_id: row.group_id, channel: row.channel, model: row.model,
    status: row.status, conclusion: row.conclusion, reason: row.reason || null, trigger: row.trigger_type,
    created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at, duration_ms: row.duration_ms,
    ...response
  };
}

function compactResult(channel, response) {
  if (channel === 'testllm') return { iq: response?.iq || null, cache: response?.cache || null, think: response?.think || null, errors: response?.errors || {} };
  return { answer: text(response?.candy?.answer, 500), assessment: response?.assessment || null,
    input_tokens: response?.candy?.input_tokens ?? response?.result?.input_tokens ?? null,
    output_tokens: response?.candy?.output_tokens ?? response?.result?.output_tokens ?? null };
}

module.exports = { cleanManxue, cleanReport, conclusion, runSummary, compactResult };
