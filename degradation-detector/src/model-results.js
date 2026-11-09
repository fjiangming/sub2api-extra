'use strict';

const protectedFields = /^(?:api.?key|user.?key|key.?cipher|key.?fingerprint|key.?context|.*headers?|authorization|cookie|set.cookie|password|secret|access.?token|refresh.?token|session.?token|base.?url|target.?url|url|run.?id|task.?id|report.?url|ip|client.?ip|remote.?ip|source.?ip|started.?by.?ip|.*ip.?address|email)$/i;

function fingerprintComparison(analysis, requestedModel) {
  const name = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  // Build aliases from reference version numbers; retain sizes, dates and other suffixes.
  const versionAlias = value => name(value).replace(/(\d)\.(?=\d+(?:[.-]|$))/g, '$1-');
  const requested = name(requestedModel);
  const prediction = name(analysis?.prediction);
  let verdictKey = analysis?.decision || 'unscorable';
  let method = 'unavailable';
  if (verdictKey === 'scored' && requested && prediction) {
    const candidates = (Array.isArray(analysis.results) ? analysis.results : []).filter(item => name(item?.model));
    if (!candidates.some(item => name(item.model) === prediction)) candidates.push({ model: analysis.prediction, display_name: analysis.prediction_name });
    const exact = candidates.filter(item => name(item.model) === requested);
    const named = candidates.filter(item => name(item.display_name) === requested);
    const aliased = candidates.filter(item => [item.model, item.display_name].some(value => versionAlias(value) === requested));
    const matches = exact.length ? exact : named.length ? named : aliased;
    const ids = new Set(matches.map(item => name(item.model)));
    if (ids.size > 1) method = 'ambiguous';
    else if (ids.has(prediction)) {
      verdictKey = 'candidate_match';
      method = exact.length ? 'exact_id' : named.length ? 'reference_name' : 'version_separator';
    } else { verdictKey = 'candidate_differs'; method = 'different'; }
  }
  return { verdictKey, comparison: { version: 1, method } };
}

function sanitizeModelResponse(value, secrets = [], depth = 0) {
  if (depth > 64) throw new Error('MODEL_RESPONSE_INVALID');
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join('[已隐藏]');
    return result.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
      .replace(/\b(?:sk-|cct-|sess-)[a-zA-Z0-9_-]+/g, '[已隐藏]')
      .replace(/https?:\/\/[^\s<>"']+/gi, '[地址已隐藏]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP 已隐藏]')
      .replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, '[邮箱已隐藏]');
  }
  if (Array.isArray(value)) return value.map(item => sanitizeModelResponse(item, secrets, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, protectedFields.test(key) ? '[已隐藏]' : sanitizeModelResponse(item, secrets, depth + 1)]));
}

function modelConclusion(channel, response, status) {
  if (status === 'queued') return 'queued';
  if (status === 'running') return 'running';
  if (status !== 'completed') return 'error';
  const value = channel === 'bazaarlink'
    ? response?.identityAssessment?.verdict?.status || response?.identityAssessment?.status
    : channel === 'fingerpoint' ? response?.verdictKey || response?.analysis?.decision : response?.verdictKey;
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : 'unconfirmed';
}

function modelRunSummary(row) {
  if (!row) return null;
  return {
    id: row.id, group_id: row.group_id, channel: row.channel, status: row.status,
    model: row.model, conclusion: row.conclusion || row.status, total: row.total ?? null,
    item_count: row.item_count ?? 0, started: (row.started_at || row.created_at) / 1000,
    finished: row.finished_at == null ? null : row.finished_at / 1000,
    duration_ms: row.duration_ms ?? null, trigger_type: row.trigger_type,
    progress: row.progress ?? null, reason: row.reason || '', has_response: Boolean(row.has_response ?? row.response_json)
  };
}

module.exports = { fingerprintComparison, modelConclusion, modelRunSummary, sanitizeModelResponse };
