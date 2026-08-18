const crypto = require('crypto');
const { AppError } = require('../errors');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { redactText } = require('../security/redaction');
const {
  backfillMissingValuations,
  baseValuationContext,
  recordBaseGroupRates,
  rebuildBaseCostRollups,
  refreshBaseCostAttributions,
  refreshPendingBaseCostAttributions
} = require('./accounting-context');

const CHALLENGE_PROMPT = [
  'This is a deterministic capability check.',
  'Reply with exactly IQCHECK|A|B|C and no other text.',
  'A: calculate 17 * 3 - 8.',
  'B: all Rens are Tals and no Tal is a Vek; can any Ren be a Vek? Reply YES or NO.',
  'C: give the next number in 2, 6, 12, 20, 30.'
].join(' ');
const CHALLENGE_EXPECTED = 'IQCHECK|43|NO|42';
const CAPABILITY_PLATFORMS = new Set(['openai', 'gemini']);
const CAPABILITY_WORDS = [
  'amber', 'cobalt', 'delta', 'ember', 'forest', 'granite',
  'harbor', 'indigo', 'juniper', 'kernel', 'lotus', 'meadow'
];
const ACCOUNT_LIMIT = 5000;
const DISTRIBUTION_SAMPLE_LIMIT = 500;
const PROBE_SAMPLE_LIMIT = 200;
const PROBE_CREDENTIAL_TTL_MS = 10 * 60 * 1000;
const REQUEST_PAIR_TIME_TOLERANCE_MS = 5000;
const REQUEST_ID_TIME_TOLERANCE_MS = 60000;
const REQUEST_PAIR_MIN_SAMPLES = 30;
const REQUEST_PAIR_MIN_MATCH_RATE = 95;
const UNGROUPED_GROUP_ID = '__ungrouped__';
const GROUPS_PENDING_GROUP_ID = '__groups_pending__';

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value, fallback = 0) {
  const number = finite(value);
  return number == null ? fallback : Math.trunc(number);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizePlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  const aliases = {
    anthropic: 'anthropic',
    claude: 'anthropic',
    chatgpt: 'openai',
    'open-ai': 'openai',
    google: 'gemini'
  };
  return aliases[platform] || platform || 'unknown';
}

function normalizeGroupId(value) {
  const raw = value?.id ?? value?.group_id ?? value?.groupId ?? value;
  if (raw == null) return null;
  const normalized = String(raw).trim();
  return normalized || null;
}

function groupAssociationValues(account) {
  const values = [];
  for (const key of ['group_ids', 'groupIds', 'groups', 'group_id', 'groupId']) {
    if (!Object.prototype.hasOwnProperty.call(account || {}, key)) continue;
    let source = account[key];
    if (typeof source === 'string') {
      try {
        source = JSON.parse(source);
      } catch {
        source = source.split(',').map((item) => item.trim()).filter(Boolean);
      }
    }
    values.push(...(Array.isArray(source) ? source : [source]));
  }
  return values;
}

function normalizeBaseGroup(group) {
  const id = normalizeGroupId(group);
  if (!id) return null;
  return {
    id,
    name: String(group?.name || group?.display_name || `分组 #${id}`).trim().slice(0, 240),
    platform: group?.platform == null ? null : normalizePlatform(group.platform),
    status: String(group?.status || (group?.enabled === false ? 'inactive' : 'active'))
      .trim().toLowerCase(),
    rateMultiplier: finite(
      group?.effective_rate_multiplier ?? group?.rate_multiplier ?? group?.ratio
    )
  };
}

function normalizeAccountGroups(account, groupCatalog = new Map()) {
  const groups = new Map();
  for (const value of groupAssociationValues(account)) {
    const id = normalizeGroupId(value);
    if (!id) continue;
    const catalogGroup = groupCatalog.get(id) || null;
    const embeddedName = value && typeof value === 'object'
      ? value.name ?? value.display_name
      : null;
    groups.set(id, {
      id,
      name: catalogGroup?.name || (embeddedName == null
        ? `分组 #${id}`
        : String(embeddedName).trim().slice(0, 240)) || `分组 #${id}`,
      platform: catalogGroup?.platform || (
        value && typeof value === 'object' && value.platform != null
          ? normalizePlatform(value.platform)
          : null
      ),
      status: catalogGroup?.status || (
        value && typeof value === 'object' && value.status != null
          ? String(value.status).trim().toLowerCase()
          : 'unknown'
      ),
      rateMultiplier: catalogGroup?.rateMultiplier ?? finite(
        value?.rateMultiplier ?? value?.effective_rate_multiplier ??
        value?.rate_multiplier ?? value?.ratio
      )
    });
  }
  return [...groups.values()];
}

function normalizeAccount(account, groupCatalog = new Map()) {
  const accountId = account?.id ?? account?.account_id;
  if (accountId == null || String(accountId).trim() === '') return null;
  const groups = normalizeAccountGroups(account, groupCatalog);
  return {
    accountId: String(accountId),
    name: String(account?.name || `Account ${accountId}`).trim().slice(0, 240),
    platform: normalizePlatform(account?.platform),
    accountType: String(account?.type || account?.account_type || 'unknown').trim().toLowerCase(),
    status: String(account?.status || 'unknown').trim().toLowerCase(),
    schedulable: account?.schedulable === true || account?.schedulable === 1,
    priority: finite(account?.priority),
    concurrency: finite(account?.concurrency),
    rateMultiplier: finite(account?.rate_multiplier ?? account?.rateMultiplier),
    metadata: {
      createdAt: account?.created_at || null,
      updatedAt: account?.updated_at || null,
      lastUsedAt: account?.last_used_at || null,
      expiresAt: account?.expires_at || null,
      rateLimitedAt: account?.rate_limited_at || null,
      rateLimitResetAt: account?.rate_limit_reset_at || null,
      groupIds: groups.map((group) => group.id),
      groups,
      errorMessage: account?.error_message
        ? redactText(String(account.error_message)).slice(0, 500)
        : null
    }
  };
}

function normalizeUsageSample(log) {
  const sourceLogId = log?.id ?? log?.usage_id;
  const accountId = log?.account_id ?? log?.account?.id;
  const createdAt = log?.created_at || log?.timestamp;
  if (sourceLogId == null || accountId == null || !createdAt || !Number.isFinite(Date.parse(createdAt))) {
    return null;
  }
  return {
    sourceLogId: String(sourceLogId),
    accountId: String(accountId),
    requestId: log?.request_id == null ? null : String(log.request_id).slice(0, 160),
    model: log?.model == null ? null : String(log.model).slice(0, 200),
    upstreamModel: log?.upstream_model == null ? null : String(log.upstream_model).slice(0, 200),
    modelMappingChain: log?.model_mapping_chain == null
      ? null
      : String(log.model_mapping_chain).slice(0, 500),
    requestType: log?.request_type == null ? null : String(log.request_type).slice(0, 80),
    stream: log?.stream === true || log?.stream === 1,
    durationMs: finite(log?.duration_ms),
    firstTokenMs: finite(log?.first_token_ms),
    inputTokens: Math.max(0, integer(log?.input_tokens)),
    outputTokens: Math.max(0, integer(log?.output_tokens)),
    cacheCreationTokens: Math.max(0, integer(log?.cache_creation_tokens)),
    cacheReadTokens: Math.max(0, integer(log?.cache_read_tokens)),
    actualCost: finite(log?.actual_cost),
    createdAt: new Date(createdAt).toISOString()
  };
}

function percentile(values, ratio) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function emptyUpstreamMetrics(zeroCounts = false) {
  return {
    requestCount: zeroCounts ? 0 : null,
    inputTokens: zeroCounts ? 0 : null,
    outputTokens: zeroCounts ? 0 : null,
    cacheCreationTokens: zeroCounts ? 0 : null,
    cacheReadTokens: zeroCounts ? 0 : null,
    actualCost: zeroCounts ? 0 : null,
    ttftAverageMs: null,
    ttftP50Ms: null,
    ttftP95Ms: null,
    ttftSampleCount: 0,
    durationAverageMs: null,
    durationP95Ms: null,
    durationSampleCount: 0,
    outputTokensPerSecond: null,
    cacheRate: null,
    cacheHitRequestRate: null,
    lastSampleAt: null
  };
}

function cumulativeDelta(rows, field) {
  let total = 0;
  let observed = false;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = finite(rows[index - 1]?.[field]);
    const current = finite(rows[index]?.[field]);
    if (previous == null || current == null) continue;
    observed = true;
    const difference = current - previous;
    total += difference >= 0 ? difference : Math.max(0, current);
  }
  return observed ? total : null;
}

function rowNumber(row, camelName, snakeName = camelName) {
  return finite(row?.[camelName] ?? row?.[snakeName]);
}

function rowInteger(row, camelName, snakeName = camelName) {
  return Math.max(0, integer(row?.[camelName] ?? row?.[snakeName]));
}

function rowTimestamp(row) {
  const value = row?.createdAt ?? row?.created_at;
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function rowModels(row) {
  return [...new Set([
    row?.upstreamModel ?? row?.upstream_model,
    row?.model
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function requestFingerprintKeys(row) {
  const usage = [
    rowInteger(row, 'inputTokens', 'input_tokens'),
    rowInteger(row, 'outputTokens', 'output_tokens'),
    rowInteger(row, 'cacheCreationTokens', 'cache_creation_tokens'),
    rowInteger(row, 'cacheReadTokens', 'cache_read_tokens'),
    (row?.stream === true || row?.stream === 1) ? 1 : 0
  ].join(':');
  const models = rowModels(row);
  return (models.length > 0 ? models : ['']).map((model) => `${model}\u0000${usage}`);
}

function requestMetricsFromRows(rows, currencyFallback = 'USD') {
  const item = emptyUpstreamMetrics(true);
  const ordered = [...rows].filter((row) => rowTimestamp(row) != null)
    .sort((left, right) => rowTimestamp(left) - rowTimestamp(right));
  item.requestCount = ordered.length;
  item.inputTokens = ordered.reduce((sum, row) => sum + rowInteger(row, 'inputTokens', 'input_tokens'), 0);
  item.outputTokens = ordered.reduce((sum, row) => sum + rowInteger(row, 'outputTokens', 'output_tokens'), 0);
  item.cacheCreationTokens = ordered.reduce(
    (sum, row) => sum + rowInteger(row, 'cacheCreationTokens', 'cache_creation_tokens'),
    0
  );
  item.cacheReadTokens = ordered.reduce(
    (sum, row) => sum + rowInteger(row, 'cacheReadTokens', 'cache_read_tokens'),
    0
  );
  const costSamples = ordered.map((row) => rowNumber(row, 'actualCost', 'actual_cost'))
    .filter((value) => value != null);
  item.actualCostSampleCount = costSamples.length;
  item.actualCost = ordered.length === 0
    ? 0
    : costSamples.length > 0
      ? round(costSamples.reduce((sum, value) => sum + value, 0), 8)
      : null;
  const promptTokens = item.inputTokens + item.cacheCreationTokens + item.cacheReadTokens;
  item.cacheRate = promptTokens > 0 ? round(item.cacheReadTokens / promptTokens * 100, 1) : null;
  item.cacheHitRequestRate = ordered.length > 0
    ? round(ordered.filter((row) => rowInteger(row, 'cacheReadTokens', 'cache_read_tokens') > 0).length /
      ordered.length * 100, 1)
    : null;

  const recent = [...ordered].sort((left, right) => rowTimestamp(right) - rowTimestamp(left))
    .slice(0, DISTRIBUTION_SAMPLE_LIMIT);
  const ttft = recent.filter((row) => row?.stream === true || row?.stream === 1)
    .map((row) => rowNumber(row, 'firstTokenMs', 'first_token_ms'))
    .filter((value) => value != null && value > 0);
  const duration = recent.map((row) => rowNumber(row, 'durationMs', 'duration_ms'))
    .filter((value) => value != null);
  item.ttftAverageMs = ttft.length > 0
    ? round(ttft.reduce((sum, value) => sum + value, 0) / ttft.length, 0)
    : null;
  item.ttftP50Ms = percentile(ttft, 0.5);
  item.ttftP95Ms = percentile(ttft, 0.95);
  item.ttftSampleCount = ttft.length;
  item.durationAverageMs = duration.length > 0
    ? round(duration.reduce((sum, value) => sum + value, 0) / duration.length, 0)
    : null;
  item.durationP95Ms = percentile(duration, 0.95);
  item.durationSampleCount = duration.length;

  let throughputTokens = 0;
  let generationMs = 0;
  for (const row of ordered) {
    if (!(row?.stream === true || row?.stream === 1)) continue;
    const firstTokenMs = rowNumber(row, 'firstTokenMs', 'first_token_ms');
    const durationMs = rowNumber(row, 'durationMs', 'duration_ms');
    if (!(firstTokenMs > 0) || !(durationMs > firstTokenMs)) continue;
    throughputTokens += rowInteger(row, 'outputTokens', 'output_tokens');
    generationMs += durationMs - firstTokenMs;
  }
  item.outputTokensPerSecond = generationMs > 0
    ? round(throughputTokens * 1000 / generationMs, 1)
    : null;
  item.firstSampleAt = ordered[0]?.created_at ?? ordered[0]?.createdAt ?? null;
  item.lastSampleAt = ordered.at(-1)?.created_at ?? ordered.at(-1)?.createdAt ?? null;
  const currencies = [...new Set(ordered.map((row) => row?.currency).filter(Boolean))];
  item.currency = currencies.length === 1 ? currencies[0] : currencies.length === 0 ? currencyFallback : null;
  return item;
}

function pairRequestRows(baseRows, upstreamRows, toleranceMs = REQUEST_PAIR_TIME_TOLERANCE_MS) {
  const bases = [...baseRows].sort((left, right) => rowTimestamp(left) - rowTimestamp(right));
  const upstreams = [...upstreamRows].sort((left, right) => rowTimestamp(left) - rowTimestamp(right));
  const unused = new Set(upstreams.map((_, index) => index));
  const pairs = [];
  const matchedBy = { requestId: 0, fingerprint: 0 };

  const pickNearest = (base, candidates, maximumDifference) => {
    const baseTime = rowTimestamp(base);
    if (baseTime == null) return null;
    let selected = null;
    let selectedDifference = Number.POSITIVE_INFINITY;
    for (const index of candidates) {
      if (!unused.has(index)) continue;
      const difference = Math.abs(rowTimestamp(upstreams[index]) - baseTime);
      if (difference <= maximumDifference && difference < selectedDifference) {
        selected = index;
        selectedDifference = difference;
      }
    }
    return selected;
  };

  const byRequestId = new Map();
  upstreams.forEach((row, index) => {
    const requestId = String(row.request_id ?? row.requestId ?? '').trim();
    if (!requestId) return;
    const candidates = byRequestId.get(requestId) || [];
    candidates.push(index);
    byRequestId.set(requestId, candidates);
  });
  const unmatchedBases = [];
  for (const base of bases) {
    const requestId = String(base.request_id ?? base.requestId ?? '').trim();
    const index = requestId
      ? pickNearest(base, byRequestId.get(requestId) || [], REQUEST_ID_TIME_TOLERANCE_MS)
      : null;
    if (index == null) {
      unmatchedBases.push(base);
      continue;
    }
    unused.delete(index);
    matchedBy.requestId += 1;
    pairs.push({ base, upstream: upstreams[index], method: 'request_id' });
  }

  const byFingerprint = new Map();
  for (const index of unused) {
    for (const key of requestFingerprintKeys(upstreams[index])) {
      const candidates = byFingerprint.get(key) || [];
      candidates.push(index);
      byFingerprint.set(key, candidates);
    }
  }
  for (const base of unmatchedBases) {
    const candidateSet = new Set(requestFingerprintKeys(base)
      .flatMap((key) => byFingerprint.get(key) || []));
    const index = pickNearest(base, candidateSet, toleranceMs);
    if (index == null) continue;
    unused.delete(index);
    matchedBy.fingerprint += 1;
    pairs.push({ base, upstream: upstreams[index], method: 'fingerprint' });
  }
  pairs.sort((left, right) => rowTimestamp(left.base) - rowTimestamp(right.base));

  const cacheMismatchCount = pairs.filter(({ base, upstream }) =>
    rowInteger(base, 'cacheReadTokens', 'cache_read_tokens') !==
      rowInteger(upstream, 'cacheReadTokens', 'cache_read_tokens') ||
    rowInteger(base, 'cacheCreationTokens', 'cache_creation_tokens') !==
      rowInteger(upstream, 'cacheCreationTokens', 'cache_creation_tokens')
  ).length;
  const ttftOverheads = pairs.map(({ base, upstream }) => {
    const baseValue = rowNumber(base, 'firstTokenMs', 'first_token_ms');
    const upstreamValue = rowNumber(upstream, 'firstTokenMs', 'first_token_ms');
    return baseValue > 0 && upstreamValue > 0 ? baseValue - upstreamValue : null;
  }).filter((value) => value != null);
  const durationOverheads = pairs.map(({ base, upstream }) => {
    const baseValue = rowNumber(base, 'durationMs', 'duration_ms');
    const upstreamValue = rowNumber(upstream, 'durationMs', 'duration_ms');
    return baseValue != null && upstreamValue != null ? baseValue - upstreamValue : null;
  }).filter((value) => value != null);

  return {
    pairs,
    matchedBy,
    matchedCount: pairs.length,
    baseRequestCount: bases.length,
    upstreamRequestCount: upstreams.length,
    baseUnmatchedCount: Math.max(0, bases.length - pairs.length),
    upstreamExtraCount: Math.max(0, upstreams.length - pairs.length),
    baseMatchRate: bases.length > 0 ? round(pairs.length / bases.length * 100, 1) : null,
    upstreamMatchRate: upstreams.length > 0 ? round(pairs.length / upstreams.length * 100, 1) : null,
    cacheMismatchCount,
    overhead: {
      ttftP50Ms: percentile(ttftOverheads, 0.5),
      ttftP95Ms: percentile(ttftOverheads, 0.95),
      ttftSampleCount: ttftOverheads.length,
      durationP50Ms: percentile(durationOverheads, 0.5),
      durationP95Ms: percentile(durationOverheads, 0.95),
      durationSampleCount: durationOverheads.length
    }
  };
}

function requestPairingTrust(pairing, { baseCoverageComplete = false } = {}) {
  if (!baseCoverageComplete) {
    return { trusted: false, reason: 'base_request_logs_incomplete' };
  }
  if (pairing.matchedCount === 0) {
    return { trusted: false, reason: 'request_pairing_unavailable' };
  }
  if (pairing.matchedCount < REQUEST_PAIR_MIN_SAMPLES) {
    return { trusted: false, reason: 'request_pairing_insufficient' };
  }
  if (
    pairing.baseMatchRate < REQUEST_PAIR_MIN_MATCH_RATE ||
    pairing.upstreamMatchRate < REQUEST_PAIR_MIN_MATCH_RATE
  ) {
    return { trusted: false, reason: 'request_pairing_partial' };
  }
  return { trusted: true, reason: null };
}

function latestIso(values) {
  return values.filter(Boolean).sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

function scoreChallenge(responseText) {
  const compact = String(responseText || '').trim().toUpperCase().replace(/\s+/g, '');
  const fields = compact.split('|');
  const answers = {
    arithmetic: fields.includes('43') || /(?:^|[^0-9])43(?:[^0-9]|$)/.test(compact),
    logic: fields.includes('NO') || /\bNO\b/.test(compact),
    sequence: fields.includes('42') || /(?:^|[^0-9])42(?:[^0-9]|$)/.test(compact)
  };
  const correct = Object.values(answers).filter(Boolean).length;
  return {
    intelligenceScore: round((correct / 3) * 100, 1),
    instructionScore: compact === CHALLENGE_EXPECTED ? 100 : compact.startsWith('IQCHECK|') ? 60 : 0,
    answers,
    exact: compact === CHALLENGE_EXPECTED
  };
}

function createCapabilityChallenge(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  const pick = (offset, minimum, maximum) =>
    minimum + digest[offset % digest.length] % (maximum - minimum + 1);
  const arithmetic = {
    left: pick(0, 12, 29),
    multiplier: pick(1, 3, 9),
    subtract: pick(2, 2, 17)
  };
  arithmetic.expected = arithmetic.left * arithmetic.multiplier - arithmetic.subtract;
  const sequenceBase = pick(3, 0, 8);
  const sequenceDelta = pick(4, 1, 5);
  const sequenceValues = Array.from(
    { length: 5 },
    (_, index) => sequenceBase + (index + 1) * (index + 1 + sequenceDelta)
  );
  const sortingValues = [
    pick(5, 11, 39), pick(6, 41, 69), pick(7, 71, 99), pick(8, 20, 88)
  ];
  const wordOffset = pick(9, 0, CAPABILITY_WORDS.length - 1);
  const checksumWords = Array.from(
    { length: 4 },
    (_, index) => CAPABILITY_WORDS[(wordOffset + index * 2) % CAPABILITY_WORDS.length]
  );
  const id = digest.subarray(0, 6).toString('hex');
  const expected = {
    arithmetic: arithmetic.expected,
    logic: 'NO',
    sequence: sequenceBase + 6 * (6 + sequenceDelta),
    sorted: [...sortingValues].sort((left, right) => right - left),
    checksum: checksumWords.map((word) => word[0].toUpperCase()).join('')
  };
  const prompt = [
    `LOCALCAP2 challenge ${id}. Evaluate every task independently.`,
    'Reply with exactly one line of JSON and no markdown or explanation.',
    'Use exactly these keys: arithmetic, logic, sequence, sorted, checksum.',
    `Arithmetic: calculate ${arithmetic.left} * ${arithmetic.multiplier} - ${arithmetic.subtract}.`,
    'Logic: every Ren is a Tal and no Tal is a Vek; can any Ren be a Vek? Reply YES or NO.',
    `Sequence: give the next number in ${sequenceValues.join(', ')}.`,
    `Sort: sort [${sortingValues.join(', ')}] in descending order.`,
    `Checksum: concatenate the uppercase first letters of ${checksumWords.join(', ')}.`
  ].join(' ');
  return {
    id,
    version: 2,
    prompt,
    expected,
    tasks: {
      arithmetic: `${arithmetic.left} * ${arithmetic.multiplier} - ${arithmetic.subtract}`,
      logic: 'Every Ren is a Tal; no Tal is a Vek; can any Ren be a Vek?',
      sequence: sequenceValues,
      sorted: sortingValues,
      checksum: checksumWords
    }
  };
}

function parseChallengeJson(responseText) {
  const trimmed = String(responseText || '').trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidates.push(fenced[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const value = JSON.parse(candidates[index]);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { value, strict: index === 0 && !trimmed.includes('\n') };
      }
    } catch {
      // Continue with fenced or embedded JSON when the model added prose.
    }
  }
  return { value: null, strict: false };
}

function scoreCapabilityChallenge(challenge, responseText) {
  const parsed = parseChallengeJson(responseText);
  const value = parsed.value || {};
  const numeric = (actual, expected) => Number(actual) === Number(expected);
  const answers = {
    arithmetic: numeric(value.arithmetic, challenge.expected.arithmetic),
    logic: String(value.logic || '').trim().toUpperCase() === challenge.expected.logic,
    sequence: numeric(value.sequence, challenge.expected.sequence),
    sorted: Array.isArray(value.sorted) &&
      value.sorted.length === challenge.expected.sorted.length &&
      value.sorted.every((item, index) => numeric(item, challenge.expected.sorted[index])),
    checksum: String(value.checksum || '').trim().toUpperCase() === challenge.expected.checksum
  };
  const expectedKeys = Object.keys(challenge.expected).sort();
  const actualKeys = parsed.value ? Object.keys(parsed.value).sort() : [];
  const exactKeys = actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]);
  const correct = Object.values(answers).filter(Boolean).length;
  return {
    intelligenceScore: round(correct / expectedKeys.length * 100, 1),
    instructionScore: parsed.strict && exactKeys ? 100 : parsed.value ? 60 : 0,
    answers,
    exact: correct === expectedKeys.length && parsed.strict && exactKeys,
    parsed: Boolean(parsed.value)
  };
}

function isDefaultConnectivityGreeting(responseText) {
  const value = String(responseText || '').replace(/\s+/g, ' ').trim();
  if (!value || value.length > 180) return false;
  return /^(?:hi|hello|hey)[!. ,]*(?:how can i (?:help|assist)(?: you)?(?: today)?|what would you like help with)\??[!.]?$/i
    .test(value);
}

function openAiEndpoint(baseUrl, capability) {
  const normalized = String(baseUrl || 'https://api.openai.com').trim().replace(/\/+$/, '');
  if (capability === 'responses') {
    if (/\/responses$/i.test(normalized)) return normalized;
    return /\/v1$/i.test(normalized)
      ? `${normalized}/responses`
      : `${normalized}/v1/responses`;
  }
  if (/\/responses$/i.test(normalized)) {
    return normalized.replace(/\/responses$/i, '/chat/completions');
  }
  return /\/v1$/i.test(normalized)
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
}

function responseTextFromOpenAi(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const chatContent = data?.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string') return chatContent;
  if (Array.isArray(chatContent)) {
    const text = chatContent.map((item) => item?.text || item?.content || '').join('');
    if (text) return text;
  }
  if (Array.isArray(data?.output)) {
    return data.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .map((item) => item?.text || item?.output_text || '')
      .join('');
  }
  return '';
}

function canTryAlternateOpenAiEndpoint(error) {
  const status = Number(error?.details?.remoteStatus || error?.status);
  return ['CAPABILITY_UNSUPPORTED', 'REMOTE_REQUEST_FAILED'].includes(String(error?.code || '')) &&
    [400, 404, 405, 501].includes(status);
}

function accountExportSignature(account) {
  return JSON.stringify([
    String(account?.name || '').trim(),
    normalizePlatform(account?.platform),
    String(account?.type || account?.account_type || '').trim().toLowerCase()
  ]);
}

function groupBy(items, keyForItem) {
  const groups = new Map();
  for (const item of items) {
    const key = keyForItem(item);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function latencyScore(ttftMs) {
  if (!Number.isFinite(ttftMs)) return null;
  const points = [
    [1500, 100],
    [3000, 85],
    [6000, 65],
    [12000, 40],
    [30000, 10]
  ];
  if (ttftMs <= points[0][0]) return 100;
  for (let index = 1; index < points.length; index += 1) {
    const [rightX, rightY] = points[index];
    const [leftX, leftY] = points[index - 1];
    if (ttftMs <= rightX) {
      const progress = (ttftMs - leftX) / (rightX - leftX);
      return round(leftY + (rightY - leftY) * progress, 1);
    }
  }
  return 0;
}

function qualityScore(metrics) {
  const components = [
    { name: 'latency', value: latencyScore(metrics.ttftP95Ms), weight: 0.4 },
    { name: 'reliability', value: metrics.probeSuccessRate, weight: 0.4 },
    { name: 'capability', value: metrics.intelligenceScore, weight: 0.2 }
  ].filter((item) => Number.isFinite(item.value));
  const totalWeight = components.reduce((sum, item) => sum + item.weight, 0);
  return {
    score: totalWeight > 0
      ? round(components.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight, 1)
      : null,
    coverage: components.map((item) => item.name),
    components: Object.fromEntries(components.map((item) => [item.name, item.value]))
  };
}

function attachQuality(metrics) {
  const quality = qualityScore(metrics);
  return { ...metrics, qualityScore: quality.score, quality };
}

function storedAccountGroups(metadata) {
  return normalizeAccountGroups({
    group_ids: Array.isArray(metadata?.groupIds) ? metadata.groupIds : [],
    groups: Array.isArray(metadata?.groups) ? metadata.groups : []
  });
}

function accountGroupState(row, fallbackGroups = new Map()) {
  const metadata = parseJson(row.metadata_json, {});
  const storedGroups = storedAccountGroups(metadata);
  const known = Array.isArray(metadata?.groupIds) || Array.isArray(metadata?.groups);
  if (known || storedGroups.length > 0) {
    return { groups: storedGroups, known: true, source: 'account_catalog' };
  }
  const cachedGroups = fallbackGroups.get(String(row.account_id)) || [];
  return {
    groups: cachedGroups,
    known: false,
    source: cachedGroups.length > 0 ? 'mapping_cache' : 'pending'
  };
}

function accountGroupDefinitions(rows, groupStates = new Map()) {
  const definitions = new Map();
  let ungroupedCount = 0;
  let pendingCount = 0;
  for (const row of rows) {
    const state = groupStates.get(String(row.account_id)) || accountGroupState(row);
    const { groups } = state;
    if (groups.length === 0) {
      if (state.known) ungroupedCount += 1;
      else pendingCount += 1;
      continue;
    }
    for (const group of groups) {
      const current = definitions.get(group.id) || {
        ...group,
        accountCount: 0,
        cachedAccountCount: 0
      };
      current.accountCount += 1;
      if (!state.known) current.cachedAccountCount += 1;
      if (current.name.startsWith('分组 #') && !group.name.startsWith('分组 #')) {
        current.name = group.name;
      }
      if (!current.platform && group.platform) current.platform = group.platform;
      if (current.status === 'unknown' && group.status !== 'unknown') current.status = group.status;
      if (current.rateMultiplier == null && group.rateMultiplier != null) {
        current.rateMultiplier = group.rateMultiplier;
      }
      definitions.set(group.id, current);
    }
  }
  const groups = [...definitions.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id, 'zh-CN')
  );
  if (ungroupedCount > 0) {
    groups.push({
      id: UNGROUPED_GROUP_ID,
      name: '未分组',
      platform: null,
      status: 'unknown',
      rateMultiplier: null,
      accountCount: ungroupedCount,
      unassigned: true
    });
  }
  if (pendingCount > 0) {
    groups.push({
      id: GROUPS_PENDING_GROUP_ID,
      name: '分组待同步',
      platform: null,
      status: 'pending',
      rateMultiplier: null,
      accountCount: pendingCount,
      cachedAccountCount: 0,
      pending: true
    });
  }
  return groups;
}

function accountBelongsToGroup(row, groupId, groupStates = new Map()) {
  const state = groupStates.get(String(row.account_id)) || accountGroupState(row);
  const { groups } = state;
  if (groupId === UNGROUPED_GROUP_ID) return state.known && groups.length === 0;
  if (groupId === GROUPS_PENDING_GROUP_ID) return !state.known && groups.length === 0;
  return groups.some((group) => group.id === String(groupId));
}

function averageFinite(items, valueFor) {
  const values = items.map(valueFor).map(finite).filter((value) => value != null);
  return values.length > 0
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 1)
    : null;
}

function weightedAverage(items, valueFor, weightFor) {
  let total = 0;
  let weight = 0;
  for (const item of items) {
    const value = finite(valueFor(item));
    const itemWeight = finite(weightFor(item));
    if (value == null || itemWeight == null || itemWeight <= 0) continue;
    total += value * itemWeight;
    weight += itemWeight;
  }
  return weight > 0 ? round(total / weight, 1) : null;
}

function aggregateAccountGroups(accounts) {
  const grouped = new Map();
  for (const account of accounts) {
    const memberships = account.groups.length > 0
      ? account.groups
      : account.groupAssociationsKnown
        ? [{
            id: UNGROUPED_GROUP_ID,
            name: '未分组',
            platform: null,
            status: 'unknown',
            rateMultiplier: null,
            unassigned: true
          }]
        : [{
            id: GROUPS_PENDING_GROUP_ID,
            name: '分组待同步',
            platform: null,
            status: 'pending',
            rateMultiplier: null,
            pending: true
          }];
    for (const membership of memberships) {
      const group = grouped.get(membership.id) || { definition: membership, accounts: [] };
      group.accounts.push(account);
      grouped.set(membership.id, group);
    }
  }

  return [...grouped.values()].map(({ definition, accounts: members }) => {
    const inputTokens = members.reduce((sum, item) => sum + item.metrics.inputTokens, 0);
    const outputTokens = members.reduce((sum, item) => sum + item.metrics.outputTokens, 0);
    const cacheCreationTokens = members.reduce(
      (sum, item) => sum + item.metrics.cacheCreationTokens,
      0
    );
    const cacheReadTokens = members.reduce((sum, item) => sum + item.metrics.cacheReadTokens, 0);
    const promptTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
    const probeCount = members.reduce((sum, item) => sum + item.metrics.probeCount, 0);
    const qualityItems = members.filter((item) => item.metrics.qualityScore != null);
    const qualityCoverage = [...new Set(qualityItems.flatMap(
      (item) => item.metrics.quality?.coverage || []
    ))];
    const mapped = members.filter((item) => item.comparison?.status === 'mapped');
    const supplierLogs = mapped.filter(
      (item) => item.comparison?.source === 'provider_request_logs'
    );
    const comparableCosts = mapped.filter(
      (item) => item.comparison?.cost?.windowComparable
    );
    const profitStatuses = comparableCosts.map(
      (item) => item.comparison?.cost?.windowProfitStatus
    );
    const costCurrencies = [...new Set(comparableCosts.map(
      (item) => item.comparison?.cost?.cashCurrency || item.comparison?.cost?.currency
    ).filter(Boolean))];
    const costDifferences = comparableCosts.map(
      (item) => finite(item.comparison?.cost?.windowDifferenceAmount)
    ).filter((value) => value != null);
    const qualityScoreAverage = averageFinite(qualityItems, (item) => item.metrics.qualityScore);
    return {
      groupId: definition.id,
      groupName: definition.name,
      groupPlatform: definition.platform,
      groupStatus: definition.status,
      rateMultiplier: definition.rateMultiplier,
      unassigned: Boolean(definition.unassigned),
      pending: Boolean(definition.pending),
      accountCount: members.length,
      cachedMembershipAccountCount: members.filter(
        (item) => item.groupAssociationSource === 'mapping_cache'
      ).length,
      activeAccountCount: members.filter(
        (item) => ['active', 'enabled'].includes(item.status)
      ).length,
      platforms: [...new Set(members.map((item) => item.platform))].sort(),
      memberNames: members.map((item) => item.name).sort((left, right) =>
        left.localeCompare(right, 'zh-CN')
      ).slice(0, 3),
      accounts: members,
      coverage: {
        mappedAccountCount: mapped.length,
        supplierLogAccountCount: supplierLogs.length,
        capabilityAccountCount: members.filter(
          (item) => item.metrics.intelligenceScore != null
        ).length,
        probeAccountCount: members.filter((item) => item.metrics.probeCount > 0).length
      },
      metrics: {
        requestCount: members.reduce((sum, item) => sum + item.metrics.requestCount, 0),
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        actualCost: round(members.reduce((sum, item) => sum + item.metrics.actualCost, 0), 6),
        cacheRate: promptTokens > 0 ? round(cacheReadTokens / promptTokens * 100, 1) : null,
        ttftP95Ms: weightedAverage(
          members,
          (item) => item.metrics.ttftP95Ms,
          (item) => item.metrics.ttftSampleCount
        ),
        durationP95Ms: weightedAverage(
          members,
          (item) => item.metrics.durationP95Ms,
          (item) => item.metrics.durationSampleCount
        ),
        outputTokensPerSecond: weightedAverage(
          members,
          (item) => item.metrics.outputTokensPerSecond,
          (item) => item.metrics.requestCount
        ),
        probeCount,
        probeSuccessRate: weightedAverage(
          members,
          (item) => item.metrics.probeSuccessRate,
          (item) => item.metrics.probeCount
        ),
        intelligenceScore: averageFinite(
          members,
          (item) => item.metrics.intelligenceScore
        ),
        instructionScore: averageFinite(
          members,
          (item) => item.metrics.instructionScore
        ),
        qualityScore: qualityScoreAverage,
        quality: { score: qualityScoreAverage, coverage: qualityCoverage }
      },
      cost: {
        comparableAccountCount: comparableCosts.length,
        profitAccountCount: profitStatuses.filter((status) => status === 'profit').length,
        lossAccountCount: profitStatuses.filter((status) => status === 'loss').length,
        breakEvenAccountCount: profitStatuses.filter((status) => status === 'break_even').length,
        differenceAmount: costCurrencies.length === 1 && costDifferences.length > 0
          ? round(costDifferences.reduce((sum, value) => sum + value, 0), 8)
          : null,
        currency: costCurrencies.length === 1 ? costCurrencies[0] : null
      }
    };
  });
}

function emptyAccountMetrics() {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    actualCost: 0,
    ttftAverageMs: null,
    ttftP50Ms: null,
    ttftP95Ms: null,
    ttftSampleCount: 0,
    durationAverageMs: null,
    durationP95Ms: null,
    durationSampleCount: 0,
    outputTokensPerSecond: null,
    cacheRate: null,
    cacheHitRequestRate: null,
    probeCount: 0,
    probeSuccessRate: null,
    intelligenceScore: null,
    instructionScore: null,
    lastProbeAt: null,
    lastProbeStatus: null,
    baseProbeCount: 0,
    baseProbeSuccessRate: null,
    baseIntelligenceScore: null,
    baseInstructionScore: null,
    baseLastProbeAt: null,
    baseLastProbeStatus: null,
    upstreamProbeCount: 0,
    upstreamProbeSuccessRate: null,
    upstreamIntelligenceScore: null,
    upstreamInstructionScore: null,
    upstreamLastProbeAt: null,
    upstreamLastProbeStatus: null
  };
}

function probeMetricsSummary(rows) {
  if (rows.length === 0) {
    return {
      probeCount: 0,
      probeSuccessRate: null,
      intelligenceScore: null,
      instructionScore: null,
      lastProbeAt: null,
      lastProbeStatus: null
    };
  }
  const intelligence = rows.map((row) => finite(row.intelligence_score))
    .filter((value) => value != null);
  const instruction = rows.map((row) => finite(row.instruction_score))
    .filter((value) => value != null);
  return {
    probeCount: rows.length,
    probeSuccessRate: round(
      rows.filter((row) => row.status === 'succeeded').length / rows.length * 100,
      1
    ),
    intelligenceScore: intelligence.length > 0
      ? round(intelligence.reduce((sum, value) => sum + value, 0) / intelligence.length, 1)
      : null,
    instructionScore: instruction.length > 0
      ? round(instruction.reduce((sum, value) => sum + value, 0) / instruction.length, 1)
      : null,
    lastProbeAt: rows[0].completed_at,
    lastProbeStatus: rows[0].status
  };
}

function metricsForProbeScope(metrics, scope) {
  const prefix = scope === 'upstream' ? 'upstream' : 'base';
  const title = prefix[0].toUpperCase() + prefix.slice(1);
  return {
    probeCount: metrics[`${prefix}ProbeCount`] || 0,
    probeSuccessRate: metrics[`${prefix}ProbeSuccessRate`] ?? null,
    intelligenceScore: metrics[`${prefix}IntelligenceScore`] ?? null,
    instructionScore: metrics[`${prefix}InstructionScore`] ?? null,
    lastProbeAt: metrics[`${prefix}LastProbeAt`] ?? null,
    lastProbeStatus: metrics[`${prefix}LastProbeStatus`] ?? null,
    probeScope: prefix,
    probeScopeLabel: title
  };
}

function aggregateMetrics(items, valueFor = (item) => item) {
  const values = items.map(valueFor).filter(Boolean);
  const result = emptyAccountMetrics();
  for (const field of [
    'requestCount', 'inputTokens', 'outputTokens', 'cacheCreationTokens',
    'cacheReadTokens', 'actualCost', 'probeCount'
  ]) {
    result[field] = round(values.reduce((sum, item) => sum + Number(item[field] || 0), 0),
      field === 'actualCost' ? 8 : 2);
  }
  const promptTokens = result.inputTokens + result.cacheCreationTokens + result.cacheReadTokens;
  result.cacheRate = promptTokens > 0
    ? round(result.cacheReadTokens / promptTokens * 100, 1)
    : null;
  result.cacheHitRequestRate = weightedAverage(
    values,
    (item) => item.cacheHitRequestRate,
    (item) => item.requestCount
  );
  result.ttftAverageMs = weightedAverage(
    values,
    (item) => item.ttftAverageMs,
    (item) => item.ttftSampleCount
  );
  result.ttftP50Ms = weightedAverage(
    values,
    (item) => item.ttftP50Ms,
    (item) => item.ttftSampleCount
  );
  result.ttftP95Ms = weightedAverage(
    values,
    (item) => item.ttftP95Ms,
    (item) => item.ttftSampleCount
  );
  result.ttftSampleCount = values.reduce(
    (sum, item) => sum + Number(item.ttftSampleCount || 0),
    0
  );
  result.durationAverageMs = weightedAverage(
    values,
    (item) => item.durationAverageMs,
    (item) => item.durationSampleCount
  );
  result.durationP95Ms = weightedAverage(
    values,
    (item) => item.durationP95Ms,
    (item) => item.durationSampleCount
  );
  result.durationSampleCount = values.reduce(
    (sum, item) => sum + Number(item.durationSampleCount || 0),
    0
  );
  result.outputTokensPerSecond = weightedAverage(
    values,
    (item) => item.outputTokensPerSecond,
    (item) => item.requestCount
  );
  result.probeSuccessRate = weightedAverage(
    values,
    (item) => item.probeSuccessRate,
    (item) => item.probeCount
  );
  result.intelligenceScore = averageFinite(values, (item) => item.intelligenceScore);
  result.instructionScore = averageFinite(values, (item) => item.instructionScore);
  result.lastProbeAt = latestIso(values.map((item) => item.lastProbeAt));
  result.lastProbeStatus = values.find(
    (item) => item.lastProbeAt === result.lastProbeAt
  )?.lastProbeStatus || null;
  for (const prefix of ['base', 'upstream']) {
    const countField = `${prefix}ProbeCount`;
    const rateField = `${prefix}ProbeSuccessRate`;
    const intelligenceField = `${prefix}IntelligenceScore`;
    const instructionField = `${prefix}InstructionScore`;
    const lastAtField = `${prefix}LastProbeAt`;
    const lastStatusField = `${prefix}LastProbeStatus`;
    result[countField] = values.reduce(
      (sum, item) => sum + Number(item[countField] || 0),
      0
    );
    result[rateField] = weightedAverage(
      values,
      (item) => item[rateField],
      (item) => item[countField]
    );
    result[intelligenceField] = averageFinite(
      values,
      (item) => item[intelligenceField]
    );
    result[instructionField] = averageFinite(
      values,
      (item) => item[instructionField]
    );
    result[lastAtField] = latestIso(values.map((item) => item[lastAtField]));
    result[lastStatusField] = values.find(
      (item) => item[lastAtField] === result[lastAtField]
    )?.[lastStatusField] || null;
  }
  return result;
}

function sortAccountGroups(groups, sortBy, order) {
  const direction = order === 'asc' ? 1 : -1;
  const field = [
    'name', 'accountCount', 'requestCount', 'cacheRate', 'ttftP95Ms',
    'probeSuccessRate', 'intelligenceScore', 'qualityScore', 'costDifference'
  ].includes(sortBy) ? sortBy : 'qualityScore';
  return groups.sort((left, right) => {
    const valueFor = (group) => {
      if (field === 'name') return group.groupName;
      if (field === 'accountCount') return group.accountCount;
      if (field === 'costDifference') return group.cost.differenceAmount;
      return group.metrics[field];
    };
    const leftValue = valueFor(left);
    const rightValue = valueFor(right);
    if (leftValue == null && rightValue == null) {
      return left.groupName.localeCompare(right.groupName, 'zh-CN');
    }
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    if (typeof leftValue === 'string') return leftValue.localeCompare(rightValue, 'zh-CN') * direction;
    const difference = (Number(leftValue) - Number(rightValue)) * direction;
    return difference || left.groupName.localeCompare(right.groupName, 'zh-CN');
  });
}

function dateInTimezone(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function shiftDateKey(value, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return value;
  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + days
  )).toISOString().slice(0, 10);
}

function startOfDateInTimezone(value, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let timestamp = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const instant = new Date(timestamp);
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value])
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const offset = represented - Math.floor(timestamp / 1000) * 1000;
    timestamp = target - offset;
  }
  return new Date(timestamp);
}

function normalizeAccountMonitorWindowSelection(value, fallbackDays = 7) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (['24h', '24_hours', 'last24h', 'rolling24h', 'rolling_24h'].includes(raw)) {
    return { type: '24h', value: '24h', days: 1 };
  }
  if (['today', 'day', 'current_day', 'calendar_day'].includes(raw)) {
    return { type: 'today', value: 'today', days: 1 };
  }
  const days = clamp(integer(value, fallbackDays), 1, 90);
  // Keep the original numeric one-day filter as the rolling 24-hour option.
  // The explicit `today` value above is reserved for the local calendar day.
  if (days === 1) return { type: '24h', value: '24h', days: 1 };
  return { type: 'days', value: String(days), days };
}

function accountMonitorWindow(selection, timezone, current = new Date()) {
  const normalized = typeof selection === 'object' && selection !== null
    ? normalizeAccountMonitorWindowSelection(selection.value ?? selection.type, selection.days)
    : normalizeAccountMonitorWindowSelection(selection);
  const endDate = dateInTimezone(current, timezone);
  const end = current.toISOString();
  if (normalized.type === '24h') {
    const start = new Date(current.getTime() - 86400000);
    return {
      from: start.toISOString(),
      to: end,
      startDate: dateInTimezone(start, timezone),
      endDate,
      days: 1
    };
  }
  const startDate = shiftDateKey(endDate, -(normalized.days - 1));
  const start = startOfDateInTimezone(startDate, timezone);
  return {
    from: (start || new Date(current.getTime() - normalized.days * 86400000)).toISOString(),
    to: end,
    startDate,
    endDate,
    days: normalized.days
  };
}

function dateKeysBetween(startDate, endDate) {
  const dates = [];
  let cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end && dates.length < 91) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return dates;
}

function chunks(items, size = 400) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

class AccountMonitorService {
  constructor({ db, config, sub2api, http = null }) {
    this.db = db;
    this.config = config;
    this.sub2api = sub2api;
    this.http = http;
    this.probeCredentials = new Map();
    backfillMissingValuations(this.db);
    refreshPendingBaseCostAttributions(this.db);
  }

  settings() {
    const row = this.db.prepare('SELECT * FROM sub2api_account_monitor_settings WHERE id = 1').get();
    return {
      syncEnabled: Boolean(row.sync_enabled),
      autoMappingEnabled: Boolean(row.auto_mapping_enabled),
      syncIntervalMinutes: row.sync_interval_minutes,
      lookbackDays: row.lookback_days,
      sampleRetentionDays: row.sample_retention_days,
      baseRechargeMultiplier: finite(row.base_recharge_multiplier) || 1,
      probeEnabled: Boolean(row.probe_enabled),
      probeIntervalMinutes: row.probe_interval_minutes,
      probePlatforms: parseJson(row.probe_platforms_json, []),
      probeModels: parseJson(row.probe_models_json, {}),
      probeConcurrency: row.probe_concurrency,
      updatedAt: row.updated_at
    };
  }

  saveSettings(input) {
    const current = this.settings();
    const next = {
      ...current,
      ...input,
      probePlatforms: [...new Set((input.probePlatforms ?? current.probePlatforms)
        .map(normalizePlatform).filter(Boolean))],
      probeModels: Object.fromEntries(Object.entries(input.probeModels ?? current.probeModels)
        .map(([platform, model]) => [normalizePlatform(platform), String(model || '').trim().slice(0, 200)]))
    };
    if (next.probeEnabled && next.probePlatforms.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        '启用定时账号检测时至少选择一个平台',
        { status: 400 }
      );
    }
    const updatedAt = nowIso();
    this.db.prepare(`
      UPDATE sub2api_account_monitor_settings SET
        sync_enabled = ?, auto_mapping_enabled = ?, sync_interval_minutes = ?, lookback_days = ?,
        sample_retention_days = ?, base_recharge_multiplier = ?,
        probe_enabled = ?, probe_interval_minutes = ?,
        probe_platforms_json = ?, probe_models_json = ?, probe_concurrency = ?, updated_at = ?
      WHERE id = 1
    `).run(
      next.syncEnabled ? 1 : 0,
      next.autoMappingEnabled ? 1 : 0,
      integer(next.syncIntervalMinutes, 15),
      integer(next.lookbackDays, 7),
      integer(next.sampleRetentionDays, 30),
      finite(next.baseRechargeMultiplier) || 1,
      next.probeEnabled ? 1 : 0,
      integer(next.probeIntervalMinutes, 360),
      stringifyJson(next.probePlatforms, []),
      stringifyJson(next.probeModels, {}),
      integer(next.probeConcurrency, 3),
      updatedAt
    );
    return this.settings();
  }

  state() {
    const row = this.db.prepare('SELECT * FROM sub2api_account_monitor_state WHERE id = 1').get();
    return {
      lastAccountSyncAt: row.last_account_sync_at,
      lastLogSyncAt: row.last_log_sync_at,
      lastProbeAt: row.last_probe_at,
      lastSyncStatus: row.last_sync_status,
      lastSyncError: row.last_sync_error,
      lastSyncSummary: parseJson(row.last_sync_summary_json, {}),
      updatedAt: row.updated_at
    };
  }

  #baseLogCoverage() {
    const state = this.state();
    const summary = state.lastSyncSummary || {};
    const from = summary.usageCoverageFrom || null;
    const to = summary.usageCoverageTo || state.lastLogSyncAt || null;
    return {
      from,
      to,
      exact: summary.usageExactTotal === true,
      truncated: Boolean(summary.usageTruncated),
      verified: Boolean(
        from && to && summary.usageExactTotal === true && !summary.usageTruncated
      ),
      fullBackfill: Boolean(summary.usageFullBackfill),
      status: state.lastSyncStatus,
      lastSyncedAt: state.lastLogSyncAt,
      error: state.lastSyncError || null
    };
  }

  syncDue(at = Date.now()) {
    const settings = this.settings();
    if (!settings.syncEnabled) return false;
    const state = this.state();
    const last = Date.parse(state.lastLogSyncAt || state.updatedAt || 0);
    return !Number.isFinite(last) || at - last >= settings.syncIntervalMinutes * 60000;
  }

  probeDue(at = Date.now()) {
    const settings = this.settings();
    if (!settings.probeEnabled || settings.probePlatforms.length === 0) return false;
    const last = Date.parse(this.state().lastProbeAt || 0);
    return !Number.isFinite(last) || at - last >= settings.probeIntervalMinutes * 60000;
  }

  cleanup() {
    const before = new Date(
      Date.now() - this.settings().sampleRetentionDays * 86400000
    ).toISOString();
    return {
      samples: this.db.prepare(
        'DELETE FROM sub2api_account_request_samples WHERE created_at < ?'
      ).run(before).changes,
      providerSamples: this.db.prepare(
        'DELETE FROM provider_request_samples WHERE created_at < ?'
      ).run(before).changes,
      probes: this.db.prepare(
        'DELETE FROM sub2api_account_probe_runs WHERE completed_at < ?'
      ).run(before).changes,
      before
    };
  }

  async #baseGroups() {
    let primaryError = null;
    if (typeof this.sub2api.data === 'function') {
      try {
        const payload = await this.sub2api.data('/api/v1/admin/groups/all', {
          query: { include_inactive: true }
        });
        const items = Array.isArray(payload) ? payload : payload?.items || payload?.groups;
        if (!Array.isArray(items)) {
          throw new AppError(
            'SCHEMA_MISMATCH',
            'Sub2API group response did not contain an array',
            { status: 502, details: { endpoint: '/api/v1/admin/groups/all' } }
          );
        }
        return { items: items.map(normalizeBaseGroup).filter(Boolean), complete: true, error: null };
      } catch (error) {
        primaryError = error;
      }
    }
    if (typeof this.sub2api.listAll === 'function') {
      try {
        const result = await this.sub2api.listAll(
          '/api/v1/admin/groups',
          { include_inactive: true },
          { maxItems: 5000 }
        );
        return {
          items: result.items.map(normalizeBaseGroup).filter(Boolean),
          complete: !result.truncated,
          error: result.truncated ? 'Sub2API group catalog reached the collection limit' : null
        };
      } catch (error) {
        primaryError ||= error;
      }
    }
    return {
      items: [],
      complete: false,
      error: redactText(primaryError?.message || 'Sub2API group catalog is unavailable').slice(0, 500)
    };
  }

  async sync(options = {}) {
    const startedAt = nowIso();
    const settings = this.settings();
    try {
      const [accountResult, groupResult] = await Promise.all([
        this.sub2api.listAll(
          '/api/v1/admin/accounts',
          options.platform ? { platform: normalizePlatform(options.platform) } : {},
          { maxItems: 50000 }
        ),
        this.#baseGroups()
      ]);
      recordBaseGroupRates(this.db, groupResult.items, startedAt);
      const groupCatalog = new Map();
      for (const row of this.db.prepare(
        'SELECT metadata_json FROM sub2api_monitored_accounts'
      ).all()) {
        for (const group of storedAccountGroups(parseJson(row.metadata_json, {}))) {
          groupCatalog.set(group.id, group);
        }
      }
      for (const group of groupResult.items) groupCatalog.set(group.id, group);
      const accounts = accountResult.items
        .map((account) => normalizeAccount(account, groupCatalog))
        .filter(Boolean);
      const now = nowIso();
      const upsertAccount = this.db.prepare(`
        INSERT INTO sub2api_monitored_accounts(
          account_id, name, platform, account_type, status, schedulable,
          priority, concurrency, rate_multiplier, metadata_json,
          first_seen_at, last_seen_at, missing_since
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(account_id) DO UPDATE SET
          name = excluded.name, platform = excluded.platform,
          account_type = excluded.account_type, status = excluded.status,
          schedulable = excluded.schedulable, priority = excluded.priority,
          concurrency = excluded.concurrency, rate_multiplier = excluded.rate_multiplier,
          metadata_json = excluded.metadata_json, last_seen_at = excluded.last_seen_at,
          missing_since = NULL
      `);
      this.db.transaction(() => {
        for (const account of accounts) {
          upsertAccount.run(
            account.accountId, account.name, account.platform, account.accountType,
            account.status, account.schedulable ? 1 : 0, account.priority,
            account.concurrency, account.rateMultiplier, stringifyJson(account.metadata),
            now, now
          );
        }
        if (!options.platform && !accountResult.truncated) {
          this.db.prepare(`
            UPDATE sub2api_monitored_accounts
            SET missing_since = COALESCE(missing_since, ?)
            WHERE last_seen_at IS NOT ?
          `).run(now, now);
        }
      })();

      const lookbackDays = clamp(integer(options.lookbackDays, settings.lookbackDays), 1, 90);
      const usageCoverageTo = nowIso();
      const oldestAllowed = Date.parse(usageCoverageTo) - lookbackDays * 86400000;
      const previousSummary = this.state().lastSyncSummary || {};
      const previousCoverageFrom = Date.parse(previousSummary.usageCoverageFrom || '');
      const previousCoverageVerified = previousSummary.usageExactTotal === true &&
        !previousSummary.usageTruncated && Number.isFinite(previousCoverageFrom) &&
        previousCoverageFrom <= oldestAllowed;
      const latest = this.db.prepare(
        'SELECT MAX(last_at) AS value FROM sub2api_account_cost_rollups'
      ).get()?.value;
      const incrementalStart = latest ? Date.parse(latest) - 86400000 : oldestAllowed;
      const usageFullBackfill = !previousCoverageVerified;
      const startAt = new Date(usageFullBackfill
        ? oldestAllowed
        : Math.max(oldestAllowed, Number.isFinite(incrementalStart) ? incrementalStart : oldestAllowed));
      const guaranteedCoverageFrom = usageFullBackfill ? oldestAllowed : previousCoverageFrom;
      const ensureAccount = this.db.prepare(`
        INSERT OR IGNORE INTO sub2api_monitored_accounts(
          account_id, name, platform, account_type, status, schedulable,
          metadata_json, first_seen_at, last_seen_at, missing_since
        ) VALUES (?, ?, 'unknown', 'unknown', 'unknown', 0, '{}', ?, ?, ?)
      `);
      const insertSample = this.db.prepare(`
        INSERT INTO sub2api_account_request_samples(
          source_log_id, account_id, request_id, model, upstream_model,
          model_mapping_chain, request_type, stream, duration_ms, first_token_ms,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          actual_cost, created_at, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_log_id) DO UPDATE SET
          account_id = excluded.account_id, request_id = excluded.request_id,
          model = excluded.model, upstream_model = excluded.upstream_model,
          model_mapping_chain = excluded.model_mapping_chain,
          request_type = excluded.request_type, stream = excluded.stream,
          duration_ms = excluded.duration_ms, first_token_ms = excluded.first_token_ms,
          input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
          cache_creation_tokens = excluded.cache_creation_tokens,
          cache_read_tokens = excluded.cache_read_tokens, actual_cost = excluded.actual_cost,
          created_at = excluded.created_at, ingested_at = excluded.ingested_at
      `);
      const insertCost = this.db.prepare(`
        INSERT INTO sub2api_account_cost_ledger(
          source_log_id, account_id, currency, cost, request_count,
          occurred_at, ingested_at, updated_at, recharge_multiplier,
          recharge_source, cash_currency, cash_revenue, valuation_status,
          context_json, revision, first_observed_at, last_observed_at
        ) VALUES (?, ?, 'USD', ?, 1, ?, ?, ?, ?, ?, ?, ?, 'observed', ?, 1, ?, ?)
        ON CONFLICT(source_log_id) DO UPDATE SET
          account_id = excluded.account_id,
          currency = excluded.currency,
          cost = excluded.cost,
          request_count = excluded.request_count,
          occurred_at = excluded.occurred_at,
          cash_revenue = CASE WHEN excluded.cost IS NULL THEN NULL
            ELSE excluded.cost / sub2api_account_cost_ledger.recharge_multiplier END,
          revision = sub2api_account_cost_ledger.revision + CASE WHEN
            sub2api_account_cost_ledger.account_id IS NOT excluded.account_id OR
            sub2api_account_cost_ledger.currency IS NOT excluded.currency OR
            sub2api_account_cost_ledger.cost IS NOT excluded.cost OR
            sub2api_account_cost_ledger.request_count IS NOT excluded.request_count OR
            sub2api_account_cost_ledger.occurred_at IS NOT excluded.occurred_at
            THEN 1 ELSE 0 END,
          last_observed_at = excluded.last_observed_at,
          updated_at = excluded.updated_at
      `);
      const valuation = baseValuationContext(this.db);
      this.db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS sub2api_usage_log_presence (
          source_log_id TEXT PRIMARY KEY
        ) WITHOUT ROWID
      `);
      const clearPresence = this.db.prepare('DELETE FROM sub2api_usage_log_presence');
      const recordPresence = this.db.prepare(`
        INSERT OR IGNORE INTO sub2api_usage_log_presence(source_log_id) VALUES (?)
      `);
      const markObserved = this.db.prepare(`
        UPDATE sub2api_account_cost_ledger AS ledger SET
          source_status = 'observed', source_last_checked_at = ?, updated_at = ?
        WHERE EXISTS (
          SELECT 1 FROM sub2api_usage_log_presence presence
          WHERE presence.source_log_id = ledger.source_log_id
        )
      `);
      const markMissing = this.db.prepare(`
        UPDATE sub2api_account_cost_ledger AS ledger SET
          source_status = 'missing_upstream',
          source_missing_at = COALESCE(source_missing_at, ?),
          source_last_checked_at = ?, updated_at = ?
        WHERE ledger.occurred_at >= ? AND ledger.occurred_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM sub2api_usage_log_presence presence
            WHERE presence.source_log_id = ledger.source_log_id
          )
      `);
      let fetchedSampleCount = 0;
      let insertedSamples = 0;
      const affectedAccountIds = new Set();
      const truncatedDates = [];
      const startDate = dateInTimezone(startAt, this.config.timezone);
      const endDate = dateInTimezone(new Date(usageCoverageTo), this.config.timezone);
      for (const date of dateKeysBetween(startDate, endDate)) {
        const usageResult = await this.sub2api.listAll('/api/v1/admin/usage', {
          start_date: date,
          end_date: date,
          timezone: this.config.timezone,
          exact_total: true,
          sort_by: 'created_at',
          sort_order: 'desc'
        }, { maxItems: 50000 });
        const samples = usageResult.items.map(normalizeUsageSample).filter(Boolean);
        fetchedSampleCount += samples.length;
        if (usageResult.truncated) truncatedDates.push(date);
        clearPresence.run();
        this.db.transaction(() => {
          for (const sample of samples) {
            recordPresence.run(sample.sourceLogId);
            ensureAccount.run(
              sample.accountId,
              `Account ${sample.accountId}`,
              now,
              now,
              now
            );
            const result = insertSample.run(
              sample.sourceLogId, sample.accountId, sample.requestId, sample.model,
              sample.upstreamModel, sample.modelMappingChain, sample.requestType,
              sample.stream ? 1 : 0, sample.durationMs, sample.firstTokenMs,
              sample.inputTokens, sample.outputTokens, sample.cacheCreationTokens,
              sample.cacheReadTokens, sample.actualCost, sample.createdAt, now
            );
            insertCost.run(
              sample.sourceLogId,
              sample.accountId,
              sample.actualCost,
              sample.createdAt,
              now,
              now,
              valuation.multiplier,
              valuation.source,
              valuation.cashCurrency,
              sample.actualCost == null ? null : Number(sample.actualCost) / valuation.multiplier,
              stringifyJson({
                recharge: {
                  source: valuation.source,
                  observedAt: valuation.observedAt
                }
              }),
              now,
              now
            );
            affectedAccountIds.add(String(sample.accountId));
            insertedSamples += result.changes;
          }
          markObserved.run(now, now);
          if (!usageResult.truncated) {
            const dateFrom = startOfDateInTimezone(date, this.config.timezone).toISOString();
            const dateTo = startOfDateInTimezone(
              shiftDateKey(date, 1),
              this.config.timezone
            ).toISOString();
            markMissing.run(now, now, now, dateFrom, dateTo);
          }
        })();
      }
      clearPresence.run();
      rebuildBaseCostRollups(this.db, [...affectedAccountIds]);
      refreshBaseCostAttributions(this.db, [...affectedAccountIds]);
      const cleanup = this.cleanup();
      const completedAt = nowIso();
      const retainedCoverageFrom = new Date(Math.max(
        guaranteedCoverageFrom,
        Date.parse(cleanup.before)
      )).toISOString();
      const summary = {
        accountCount: accounts.length,
        accountCatalogTruncated: Boolean(accountResult.truncated),
        groupCount: groupResult.items.length,
        groupCatalogComplete: groupResult.complete,
        groupCatalogError: groupResult.error,
        fetchedSampleCount,
        storedSampleChanges: insertedSamples,
        usageExactTotal: true,
        usageFullBackfill,
        usageCoverageFrom: retainedCoverageFrom,
        usageCoverageTo,
        usageTruncated: truncatedDates.length > 0,
        truncatedDates,
        deletedSamples: cleanup.samples,
        deletedProbes: cleanup.probes,
        startedAt,
        completedAt
      };
      this.db.prepare(`
        UPDATE sub2api_account_monitor_state SET
          last_account_sync_at = ?, last_log_sync_at = ?, last_sync_status = 'succeeded',
          last_sync_error = NULL, last_sync_summary_json = ?, updated_at = ?
        WHERE id = 1
      `).run(completedAt, completedAt, stringifyJson(summary), completedAt);
      return summary;
    } catch (error) {
      const failedAt = nowIso();
      this.db.prepare(`
        UPDATE sub2api_account_monitor_state SET
          last_sync_status = 'failed', last_sync_error = ?, updated_at = ?
        WHERE id = 1
      `).run(redactText(error?.message || error).slice(0, 1000), failedAt);
      throw error;
    }
  }

  #accountRows(filters = {}) {
    const clauses = ['missing_since IS NULL'];
    const params = [];
    if (filters.platform) {
      clauses.push('platform = ?');
      params.push(normalizePlatform(filters.platform));
    }
    if (filters.status) {
      clauses.push('status = ?');
      params.push(String(filters.status).trim().toLowerCase());
    }
    if (filters.search) {
      clauses.push('(LOWER(name) LIKE ? OR account_id LIKE ? OR LOWER(metadata_json) LIKE ?)');
      const query = `%${String(filters.search).trim().toLowerCase()}%`;
      params.push(query, query, query);
    }
    return this.db.prepare(`
      SELECT * FROM sub2api_monitored_accounts
      WHERE ${clauses.join(' AND ')}
      ORDER BY name COLLATE NOCASE, account_id
      LIMIT ${ACCOUNT_LIMIT}
    `).all(...params);
  }

  #mappedAccountGroups() {
    const groupsByAccount = new Map();
    const rows = this.db.prepare(`
      SELECT m.id, m.account_id, m.group_id, m.updated_at,
        s.base_group_name, s.base_group_rate, s.details_json, s.checked_at
      FROM sub2api_mappings m
      LEFT JOIN sub2api_mapping_states s ON s.mapping_id = m.id
      WHERE m.account_id IS NOT NULL AND m.group_id IS NOT NULL
      ORDER BY COALESCE(s.checked_at, m.updated_at) DESC, m.id
    `).all();
    for (const row of rows) {
      const details = parseJson(row.details_json, {});
      const group = normalizeBaseGroup({
        id: row.group_id,
        name: row.base_group_name,
        platform: details.baseGroupPlatform,
        status: details.baseGroupStatus || 'unknown',
        rate_multiplier: row.base_group_rate
      });
      if (!group) continue;
      const accountId = String(row.account_id);
      const accountGroups = groupsByAccount.get(accountId) || new Map();
      if (!accountGroups.has(group.id)) accountGroups.set(group.id, group);
      groupsByAccount.set(accountId, accountGroups);
    }
    return new Map([...groupsByAccount].map(([accountId, groups]) => [
      accountId,
      [...groups.values()]
    ]));
  }

  #metrics(accountIds, since, until = nowIso()) {
    const metrics = new Map(accountIds.map((accountId) => [String(accountId), {
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      actualCost: 0,
      ttftAverageMs: null,
      ttftP50Ms: null,
      ttftP95Ms: null,
      ttftSampleCount: 0,
      durationAverageMs: null,
      durationP95Ms: null,
      durationSampleCount: 0,
      outputTokensPerSecond: null,
      cacheRate: null,
      cacheHitRequestRate: null,
      probeCount: 0,
      probeSuccessRate: null,
      intelligenceScore: null,
      instructionScore: null,
      lastProbeAt: null,
      lastProbeStatus: null
    }]));
    if (accountIds.length === 0) return metrics;

    for (const batch of chunks(accountIds)) {
      const placeholders = batch.map(() => '?').join(',');
      const aggregateRows = this.db.prepare(`
        SELECT account_id, COUNT(*) AS request_count,
          SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
          SUM(cache_creation_tokens) AS cache_creation_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(COALESCE(actual_cost, 0)) AS actual_cost,
          AVG(CASE WHEN stream = 1 AND first_token_ms > 0 THEN first_token_ms END) AS ttft_average_ms,
          AVG(duration_ms) AS duration_average_ms,
          SUM(CASE WHEN stream = 1 AND first_token_ms > 0 AND duration_ms > first_token_ms
            THEN output_tokens ELSE 0 END) AS throughput_tokens,
          SUM(CASE WHEN stream = 1 AND first_token_ms > 0 AND duration_ms > first_token_ms
            THEN duration_ms - first_token_ms ELSE 0 END) AS generation_ms,
          SUM(CASE WHEN cache_read_tokens > 0 THEN 1 ELSE 0 END) AS cache_hit_requests
        FROM sub2api_account_request_samples
        WHERE account_id IN (${placeholders}) AND created_at >= ? AND created_at <= ?
        GROUP BY account_id
      `).all(...batch, since, until);
      for (const row of aggregateRows) {
        const item = metrics.get(String(row.account_id));
        item.requestCount = integer(row.request_count);
        item.inputTokens = integer(row.input_tokens);
        item.outputTokens = integer(row.output_tokens);
        item.cacheCreationTokens = integer(row.cache_creation_tokens);
        item.cacheReadTokens = integer(row.cache_read_tokens);
        item.actualCost = round(finite(row.actual_cost) || 0, 6);
        item.ttftAverageMs = round(finite(row.ttft_average_ms), 0);
        item.durationAverageMs = round(finite(row.duration_average_ms), 0);
        const promptTokens = item.inputTokens + item.cacheCreationTokens + item.cacheReadTokens;
        item.cacheRate = promptTokens > 0 ? round(item.cacheReadTokens / promptTokens * 100, 1) : null;
        item.cacheHitRequestRate = item.requestCount > 0
          ? round(integer(row.cache_hit_requests) / item.requestCount * 100, 1)
          : null;
        item.outputTokensPerSecond = Number(row.generation_ms) > 0
          ? round(Number(row.throughput_tokens) * 1000 / Number(row.generation_ms), 1)
          : null;
      }

      const distributions = this.db.prepare(`
        WITH recent AS (
          SELECT account_id, stream, first_token_ms, duration_ms,
            ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at DESC) AS row_number
          FROM sub2api_account_request_samples
          WHERE account_id IN (${placeholders}) AND created_at >= ? AND created_at <= ?
        )
        SELECT account_id, stream, first_token_ms, duration_ms FROM recent
        WHERE row_number <= ${DISTRIBUTION_SAMPLE_LIMIT}
      `).all(...batch, since, until);
      const byAccount = new Map();
      for (const row of distributions) {
        const item = byAccount.get(String(row.account_id)) || { ttft: [], duration: [] };
        if (Boolean(row.stream) && Number(row.first_token_ms) > 0) {
          item.ttft.push(Number(row.first_token_ms));
        }
        if (finite(row.duration_ms) != null) item.duration.push(Number(row.duration_ms));
        byAccount.set(String(row.account_id), item);
      }
      for (const [accountId, values] of byAccount) {
        const item = metrics.get(accountId);
        item.ttftP50Ms = percentile(values.ttft, 0.5);
        item.ttftP95Ms = percentile(values.ttft, 0.95);
        item.ttftSampleCount = values.ttft.length;
        item.durationP95Ms = percentile(values.duration, 0.95);
        item.durationSampleCount = values.duration.length;
      }

      const probes = this.db.prepare(`
        WITH recent AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY account_id ORDER BY completed_at DESC, id DESC
          ) AS row_number
          FROM sub2api_account_probe_runs
          WHERE account_id IN (${placeholders}) AND completed_at >= ? AND completed_at <= ?
        )
        SELECT * FROM recent WHERE row_number <= ${PROBE_SAMPLE_LIMIT}
        ORDER BY completed_at DESC
      `).all(...batch, since, until);
      const probeGroups = new Map();
      for (const row of probes) {
        const accountId = String(row.account_id);
        const group = probeGroups.get(accountId) || [];
        group.push(row);
        probeGroups.set(accountId, group);
      }
      for (const [accountId, rows] of probeGroups) {
        const item = metrics.get(accountId);
        Object.assign(item, probeMetricsSummary(rows));
        const scopedRows = { base: [], upstream: [] };
        for (const row of rows) {
          const details = parseJson(row.details_json, {});
          const scope = details.transport === 'direct_api_key' ? 'upstream' : 'base';
          scopedRows[scope].push(row);
        }
        for (const scope of ['base', 'upstream']) {
          const summary = probeMetricsSummary(scopedRows[scope]);
          const prefix = scope === 'base' ? 'base' : 'upstream';
          item[`${prefix}ProbeCount`] = summary.probeCount;
          item[`${prefix}ProbeSuccessRate`] = summary.probeSuccessRate;
          item[`${prefix}IntelligenceScore`] = summary.intelligenceScore;
          item[`${prefix}InstructionScore`] = summary.instructionScore;
          item[`${prefix}LastProbeAt`] = summary.lastProbeAt;
          item[`${prefix}LastProbeStatus`] = summary.lastProbeStatus;
        }
      }
    }
    return metrics;
  }

  mappedConnectionIds() {
    return this.db.prepare(`
      SELECT DISTINCT m.connection_id
      FROM sub2api_mappings m
      JOIN provider_connections c ON c.id = m.connection_id
      JOIN sub2api_monitored_accounts a ON a.account_id = CAST(m.account_id AS TEXT)
      WHERE m.enabled = 1 AND c.enabled = 1 AND a.missing_since IS NULL
      ORDER BY m.connection_id
    `).all().map((row) => row.connection_id);
  }

  #mappingRows(accountIds) {
    const rows = [];
    for (const batch of chunks(accountIds)) {
      const placeholders = batch.map(() => '?').join(',');
      rows.push(...this.db.prepare(`
        SELECT CAST(m.account_id AS TEXT) AS account_id, m.id AS mapping_id,
          m.connection_id, m.key_id, m.role, m.config_json AS mapping_config_json,
          m.updated_at AS mapping_updated_at,
          c.name AS provider_name, c.adapter_type, c.auth_mode, c.last_success_at,
           c.last_error_code, k.name AS key_name, k.remote_id AS remote_key_id,
           k.currency, k.status AS key_status,
           rr.detected_multiplier AS recharge_detected_multiplier,
           rr.manual_multiplier AS recharge_manual_multiplier,
           rr.paid_currency AS recharge_paid_currency,
           rr.balance_currency AS recharge_balance_currency,
           rr.detection_source AS recharge_detection_source,
           rr.status AS recharge_status,
           rr.checked_at AS recharge_checked_at,
          (SELECT COUNT(DISTINCT CAST(shared.account_id AS TEXT))
            FROM sub2api_mappings shared
            WHERE shared.enabled = 1 AND shared.key_id = m.key_id
          ) AS shared_account_count,
          COALESCE(ks.status, s.status) AS request_log_status,
          COALESCE(ks.coverage_from, s.coverage_from) AS coverage_from,
          COALESCE(ks.coverage_to, s.coverage_to) AS coverage_to,
          COALESCE(ks.truncated, s.truncated) AS request_log_truncated,
          COALESCE(ks.total_count, s.total_count) AS request_log_total,
          COALESCE(ks.last_error_code, s.last_error_code) AS request_log_error_code,
          COALESCE(ks.last_synced_at, s.last_synced_at) AS request_log_synced_at,
          CASE WHEN ks.key_id IS NULL THEN 'connection' ELSE 'key' END AS request_log_scope
        FROM sub2api_mappings m
         JOIN provider_connections c ON c.id = m.connection_id
         LEFT JOIN remote_keys k ON k.id = m.key_id
         LEFT JOIN provider_recharge_rates rr ON rr.connection_id = m.connection_id
        LEFT JOIN provider_request_log_sync_state s ON s.connection_id = m.connection_id
        LEFT JOIN provider_request_key_sync_state ks ON ks.key_id = m.key_id
        WHERE m.enabled = 1 AND CAST(m.account_id AS TEXT) IN (${placeholders})
        ORDER BY CASE m.role WHEN 'primary' THEN 0 ELSE 1 END, m.updated_at DESC
      `).all(...batch));
    }
    return rows;
  }

  #providerRequestMetrics(keyIds, since, until) {
    const result = new Map();
    for (const batch of chunks(keyIds)) {
      const placeholders = batch.map(() => '?').join(',');
      const aggregates = this.db.prepare(`
        SELECT key_id, COUNT(*) AS request_count,
          SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
          SUM(cache_creation_tokens) AS cache_creation_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(COALESCE(actual_cost, 0)) AS actual_cost,
          AVG(CASE WHEN stream = 1 AND first_token_ms > 0 THEN first_token_ms END) AS ttft_average_ms,
          AVG(duration_ms) AS duration_average_ms,
          SUM(CASE WHEN stream = 1 AND first_token_ms > 0 AND duration_ms > first_token_ms
            THEN output_tokens ELSE 0 END) AS throughput_tokens,
          SUM(CASE WHEN stream = 1 AND first_token_ms > 0 AND duration_ms > first_token_ms
            THEN duration_ms - first_token_ms ELSE 0 END) AS generation_ms,
          SUM(CASE WHEN cache_read_tokens > 0 THEN 1 ELSE 0 END) AS cache_hit_requests,
          MIN(created_at) AS first_sample_at, MAX(created_at) AS last_sample_at,
          MAX(currency) AS currency
        FROM provider_request_samples
        WHERE key_id IN (${placeholders}) AND created_at >= ? AND created_at <= ?
          AND status = 'success'
        GROUP BY key_id
      `).all(...batch, since, until);
      for (const row of aggregates) {
        const item = emptyUpstreamMetrics(true);
        item.requestCount = integer(row.request_count);
        item.inputTokens = integer(row.input_tokens);
        item.outputTokens = integer(row.output_tokens);
        item.cacheCreationTokens = integer(row.cache_creation_tokens);
        item.cacheReadTokens = integer(row.cache_read_tokens);
        item.actualCost = round(finite(row.actual_cost) || 0, 8);
        item.ttftAverageMs = round(finite(row.ttft_average_ms), 0);
        item.durationAverageMs = round(finite(row.duration_average_ms), 0);
        const promptTokens = item.inputTokens + item.cacheCreationTokens + item.cacheReadTokens;
        item.cacheRate = promptTokens > 0 ? round(item.cacheReadTokens / promptTokens * 100, 1) : null;
        item.cacheHitRequestRate = item.requestCount > 0
          ? round(integer(row.cache_hit_requests) / item.requestCount * 100, 1)
          : null;
        item.outputTokensPerSecond = Number(row.generation_ms) > 0
          ? round(Number(row.throughput_tokens) * 1000 / Number(row.generation_ms), 1)
          : null;
        item.firstSampleAt = row.first_sample_at;
        item.lastSampleAt = row.last_sample_at;
        item.currency = row.currency || 'USD';
        result.set(String(row.key_id), item);
      }

      const distributions = this.db.prepare(`
        WITH recent AS (
          SELECT key_id, stream, first_token_ms, duration_ms,
            ROW_NUMBER() OVER (PARTITION BY key_id ORDER BY created_at DESC) AS row_number
          FROM provider_request_samples
          WHERE key_id IN (${placeholders}) AND created_at >= ? AND created_at <= ?
            AND status = 'success'
        )
        SELECT key_id, stream, first_token_ms, duration_ms FROM recent
        WHERE row_number <= ${DISTRIBUTION_SAMPLE_LIMIT}
      `).all(...batch, since, until);
      const grouped = new Map();
      for (const row of distributions) {
        const item = grouped.get(String(row.key_id)) || { ttft: [], duration: [] };
        if (Boolean(row.stream) && Number(row.first_token_ms) > 0) {
          item.ttft.push(Number(row.first_token_ms));
        }
        if (finite(row.duration_ms) != null) item.duration.push(Number(row.duration_ms));
        grouped.set(String(row.key_id), item);
      }
      for (const [keyId, values] of grouped) {
        const item = result.get(keyId);
        if (!item) continue;
        item.ttftP50Ms = percentile(values.ttft, 0.5);
        item.ttftP95Ms = percentile(values.ttft, 0.95);
        item.ttftSampleCount = values.ttft.length;
        item.durationP95Ms = percentile(values.duration, 0.95);
        item.durationSampleCount = values.duration.length;
      }
    }
    return result;
  }

  #providerCostLedger(keyIds, since, until) {
    const result = new Map();
    for (const batch of chunks(keyIds)) {
      const placeholders = batch.map(() => '?').join(',');
      const windows = this.db.prepare(`
        SELECT key_id, currency,
          SUM(CASE WHEN status = 'success' THEN request_count ELSE 0 END) AS window_requests,
          SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END) AS window_input_tokens,
          SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END) AS window_output_tokens,
          SUM(CASE WHEN status = 'success' THEN cache_creation_tokens ELSE 0 END) AS window_cache_creation_tokens,
          SUM(CASE WHEN status = 'success' THEN cache_read_tokens ELSE 0 END) AS window_cache_read_tokens,
          SUM(COALESCE(cost, 0)) AS window_cost,
          SUM(CASE WHEN cost IS NULL THEN 0 ELSE request_count END) AS window_cost_samples,
          COUNT(*) AS window_entries,
          SUM(CASE WHEN source_status = 'missing_upstream' THEN request_count ELSE 0 END)
            AS window_source_missing
        FROM provider_cost_ledger
        WHERE key_id IN (${placeholders})
          AND accounting_status = 'active' AND comparable = 1
          AND occurred_at >= ? AND occurred_at <= ?
        GROUP BY key_id, currency
      `).all(...batch, since, until);
      const totals = this.db.prepare(`
        SELECT key_id, currency, SUM(request_count) AS lifetime_requests,
          SUM(cost) AS lifetime_cost, SUM(cost_sample_count) AS lifetime_cost_samples,
          MIN(first_at) AS first_at, MAX(last_at) AS last_at
        FROM provider_cost_rollups
        WHERE key_id IN (${placeholders})
        GROUP BY key_id, currency
      `).all(...batch);
      const missingTotals = this.db.prepare(`
        SELECT key_id, currency,
          SUM(CASE WHEN source_status = 'missing_upstream' THEN request_count ELSE 0 END)
            AS lifetime_source_missing
        FROM provider_cost_ledger
        WHERE key_id IN (${placeholders}) AND source_status = 'missing_upstream'
          AND accounting_status = 'active' AND comparable = 1
        GROUP BY key_id, currency
      `).all(...batch);
      const reportedTotals = this.db.prepare(`
        SELECT key_id, currency,
          SUM(lifetime_request_offset + COALESCE(last_request_count, 0))
            AS reported_lifetime_requests,
          SUM(lifetime_input_offset + COALESCE(last_input_tokens, 0))
            AS reported_lifetime_input_tokens,
          SUM(lifetime_output_offset + COALESCE(last_output_tokens, 0))
            AS reported_lifetime_output_tokens,
          SUM(lifetime_cache_creation_offset + COALESCE(last_cache_creation_tokens, 0))
            AS reported_lifetime_cache_creation_tokens,
          SUM(lifetime_cache_read_offset + COALESCE(last_cache_read_tokens, 0))
            AS reported_lifetime_cache_read_tokens,
          SUM(lifetime_cost_offset + COALESCE(last_cost, 0))
            AS reported_lifetime_cost,
          SUM(reset_count) AS counter_reset_count,
          SUM(CASE WHEN last_captured_at > first_observed_at THEN 1 ELSE 0 END)
            AS counter_observed_intervals,
          MIN(counter_accounting_started_at) AS counter_accounting_started_at,
          MAX(last_captured_at) AS counter_last_captured_at
        FROM provider_usage_counter_state
        WHERE key_id IN (${placeholders}) AND counter_accounting_started_at IS NOT NULL
        GROUP BY key_id, currency
      `).all(...batch);
      const sourceTotals = this.db.prepare(`
        SELECT key_id, currency,
          SUM(CASE WHEN source_type = 'usage_counter' AND comparable = 1
            AND accounting_status = 'active' THEN 1 ELSE 0 END) AS counter_entries,
          SUM(CASE WHEN source_type = 'request_log'
            AND accounting_status = 'active' THEN 1 ELSE 0 END) AS request_entries,
          SUM(CASE WHEN entry_kind = 'counter_opening'
            AND accounting_status = 'active' THEN COALESCE(cost, 0) ELSE 0 END)
            AS opening_cost,
          SUM(CASE WHEN entry_kind = 'counter_opening'
            AND accounting_status = 'active' THEN request_count ELSE 0 END)
            AS opening_requests,
          SUM(CASE WHEN entry_kind = 'counter_opening'
            AND accounting_status = 'active' THEN 1 ELSE 0 END) AS unallocated_entries,
          MAX(CASE WHEN source_type = 'usage_counter' AND comparable = 1
            AND accounting_status = 'active' THEN precision_seconds END)
            AS maximum_precision_seconds
        FROM provider_cost_ledger
        WHERE key_id IN (${placeholders})
        GROUP BY key_id, currency
      `).all(...batch);
      const entriesByIdentity = new Map();
      const ensureEntry = (row) => {
        const keyId = String(row.key_id);
        const identity = `${keyId}\u0000${row.currency || 'USD'}`;
        if (entriesByIdentity.has(identity)) return entriesByIdentity.get(identity);
        const entries = result.get(keyId) || [];
        const entry = {
          currency: row.currency || 'USD',
          windowRequestCount: 0,
          windowInputTokens: 0,
          windowOutputTokens: 0,
          windowCacheCreationTokens: 0,
          windowCacheReadTokens: 0,
          windowCost: 0,
          windowCostSampleCount: 0,
          windowEntryCount: 0,
          windowSourceMissingCount: 0,
          lifetimeRequestCount: 0,
          lifetimeCost: 0,
          lifetimeCostSampleCount: 0,
          lifetimeSourceMissingCount: 0,
          reportedLifetimeRequestCount: null,
          reportedLifetimeInputTokens: null,
          reportedLifetimeOutputTokens: null,
          reportedLifetimeCacheCreationTokens: null,
          reportedLifetimeCacheReadTokens: null,
          reportedLifetimeCost: null,
          counterResetCount: 0,
          counterObservedIntervalCount: 0,
          counterAccountingStartedAt: null,
          counterLastCapturedAt: null,
          counterEntryCount: 0,
          requestEntryCount: 0,
          openingCost: 0,
          openingRequestCount: 0,
          unallocatedEntryCount: 0,
          maximumPrecisionSeconds: null,
          firstAt: null,
          lastAt: null
        };
        entries.push(entry);
        result.set(keyId, entries);
        entriesByIdentity.set(identity, entry);
        return entry;
      };
      for (const row of windows) {
        Object.assign(ensureEntry(row), {
          windowRequestCount: integer(row.window_requests),
          windowInputTokens: integer(row.window_input_tokens),
          windowOutputTokens: integer(row.window_output_tokens),
          windowCacheCreationTokens: integer(row.window_cache_creation_tokens),
          windowCacheReadTokens: integer(row.window_cache_read_tokens),
          windowCost: round(finite(row.window_cost) || 0, 8),
          windowCostSampleCount: integer(row.window_cost_samples),
          windowEntryCount: integer(row.window_entries),
          windowSourceMissingCount: integer(row.window_source_missing)
        });
      }
      for (const row of totals) {
        Object.assign(ensureEntry(row), {
          lifetimeRequestCount: integer(row.lifetime_requests),
          lifetimeCost: round(finite(row.lifetime_cost) || 0, 8),
          lifetimeCostSampleCount: integer(row.lifetime_cost_samples),
          firstAt: row.first_at,
          lastAt: row.last_at
        });
      }
      for (const row of missingTotals) {
        ensureEntry(row).lifetimeSourceMissingCount = integer(row.lifetime_source_missing);
      }
      for (const row of reportedTotals) Object.assign(ensureEntry(row), {
        reportedLifetimeRequestCount: integer(row.reported_lifetime_requests),
        reportedLifetimeInputTokens: integer(row.reported_lifetime_input_tokens),
        reportedLifetimeOutputTokens: integer(row.reported_lifetime_output_tokens),
        reportedLifetimeCacheCreationTokens: integer(
          row.reported_lifetime_cache_creation_tokens
        ),
        reportedLifetimeCacheReadTokens: integer(row.reported_lifetime_cache_read_tokens),
        reportedLifetimeCost: round(finite(row.reported_lifetime_cost) || 0, 8),
        counterResetCount: integer(row.counter_reset_count),
        counterObservedIntervalCount: integer(row.counter_observed_intervals),
        counterAccountingStartedAt: row.counter_accounting_started_at,
        counterLastCapturedAt: row.counter_last_captured_at
      });
      for (const row of sourceTotals) Object.assign(ensureEntry(row), {
        counterEntryCount: integer(row.counter_entries),
        requestEntryCount: integer(row.request_entries),
        openingCost: round(finite(row.opening_cost) || 0, 8),
        openingRequestCount: integer(row.opening_requests),
        unallocatedEntryCount: integer(row.unallocated_entries),
        maximumPrecisionSeconds: finite(row.maximum_precision_seconds)
      });
    }
    return result;
  }

  #providerCashLedger(keyIds, since, until) {
    const result = new Map();
    for (const batch of chunks(keyIds)) {
      const placeholders = batch.map(() => '?').join(',');
      const windows = this.db.prepare(`
        SELECT key_id, COALESCE(cash_currency, currency, 'USD') AS cash_currency,
          SUM(COALESCE(cash_cost,
            CASE WHEN cost IS NULL THEN 0 ELSE cost / recharge_multiplier END
          )) AS window_cash_cost,
          SUM(CASE WHEN cost IS NULL THEN 0 ELSE request_count END) AS window_cost_samples,
          SUM(CASE WHEN cost IS NOT NULL AND COALESCE(recharge_source, 'default') = 'default'
            THEN 1 ELSE 0 END) AS window_unconfirmed_samples
        FROM provider_cost_ledger
        WHERE key_id IN (${placeholders})
          AND accounting_status = 'active' AND comparable = 1
          AND occurred_at >= ? AND occurred_at <= ?
        GROUP BY key_id, COALESCE(cash_currency, currency, 'USD')
      `).all(...batch, since, until);
      const totals = this.db.prepare(`
        SELECT key_id, cash_currency, SUM(cash_cost) AS lifetime_cash_cost,
          SUM(cost_sample_count) AS lifetime_cost_samples,
          MIN(first_at) AS first_at, MAX(last_at) AS last_at
        FROM provider_cost_cash_rollups
        WHERE key_id IN (${placeholders})
        GROUP BY key_id, cash_currency
      `).all(...batch);
      const auditTotals = this.db.prepare(`
        SELECT key_id, COALESCE(cash_currency, currency, 'USD') AS cash_currency,
          SUM(CASE WHEN entry_kind = 'counter_opening'
            AND accounting_status = 'active' THEN COALESCE(cash_cost,
              CASE WHEN cost IS NULL THEN 0 ELSE cost / recharge_multiplier END
            ) ELSE 0 END) AS opening_cash_cost,
          SUM(CASE WHEN entry_kind = 'counter_opening'
            AND accounting_status = 'active' AND cost IS NOT NULL
            AND COALESCE(recharge_source, 'default') = 'default'
            THEN 1 ELSE 0 END) AS opening_unconfirmed_samples,
          SUM(CASE WHEN comparable = 1 AND accounting_status = 'active'
            AND cost IS NOT NULL AND COALESCE(recharge_source, 'default') = 'default'
            THEN 1 ELSE 0 END) AS lifetime_unconfirmed_samples
        FROM provider_cost_ledger
        WHERE key_id IN (${placeholders})
        GROUP BY key_id, COALESCE(cash_currency, currency, 'USD')
      `).all(...batch);
      const entries = new Map();
      const ensure = (row) => {
        const keyId = String(row.key_id);
        const currency = row.cash_currency || 'USD';
        const identity = `${keyId}\u0000${currency}`;
        if (entries.has(identity)) return entries.get(identity);
        const entry = {
          cashCurrency: currency,
          windowCashCost: 0,
          windowCostSampleCount: 0,
          lifetimeCashCost: 0,
          lifetimeCostSampleCount: 0,
          openingCashCost: 0,
          reportedLifetimeCashCost: 0,
          windowUnconfirmedSampleCount: 0,
          lifetimeUnconfirmedSampleCount: 0,
          openingUnconfirmedSampleCount: 0,
          windowConfirmed: true,
          lifetimeComparableConfirmed: true,
          reportedLifetimeConfirmed: true,
          firstAt: null,
          lastAt: null
        };
        const list = result.get(keyId) || [];
        list.push(entry);
        result.set(keyId, list);
        entries.set(identity, entry);
        return entry;
      };
      for (const row of windows) Object.assign(ensure(row), {
        windowCashCost: round(finite(row.window_cash_cost) || 0, 8),
        windowCostSampleCount: integer(row.window_cost_samples),
        windowUnconfirmedSampleCount: integer(row.window_unconfirmed_samples),
        windowConfirmed: integer(row.window_unconfirmed_samples) === 0
      });
      for (const row of totals) Object.assign(ensure(row), {
        lifetimeCashCost: round(finite(row.lifetime_cash_cost) || 0, 8),
        reportedLifetimeCashCost: round(finite(row.lifetime_cash_cost) || 0, 8),
        lifetimeCostSampleCount: integer(row.lifetime_cost_samples),
        firstAt: row.first_at,
        lastAt: row.last_at
      });
      for (const row of auditTotals) {
        const entry = ensure(row);
        entry.openingCashCost = round(finite(row.opening_cash_cost) || 0, 8);
        entry.reportedLifetimeCashCost = round(
          Number(entry.lifetimeCashCost || 0) + Number(entry.openingCashCost || 0),
          8
        );
        entry.lifetimeUnconfirmedSampleCount = integer(row.lifetime_unconfirmed_samples);
        entry.openingUnconfirmedSampleCount = integer(row.opening_unconfirmed_samples);
        entry.lifetimeComparableConfirmed = entry.lifetimeUnconfirmedSampleCount === 0;
        entry.reportedLifetimeConfirmed = entry.lifetimeComparableConfirmed &&
          entry.openingUnconfirmedSampleCount === 0;
      }
    }
    return result;
  }

  #attributedBaseCostLedger(keyIds, since, until) {
    const result = new Map();
    for (const batch of chunks(keyIds)) {
      const placeholders = batch.map(() => '?').join(',');
      const windows = this.db.prepare(`
        SELECT key_id, COALESCE(cash_currency, currency, 'USD') AS cash_currency,
          SUM(request_count) AS window_requests,
          SUM(COALESCE(cash_revenue,
            CASE WHEN cost IS NULL THEN 0 ELSE cost / recharge_multiplier END
          )) AS window_cash_revenue,
          SUM(CASE WHEN cost IS NULL THEN 0 ELSE request_count END) AS window_cost_samples
        FROM sub2api_account_cost_ledger
        WHERE key_id IN (${placeholders})
          AND attribution_status IN ('attributed', 'attributed_multi_group')
          AND occurred_at >= ? AND occurred_at <= ?
        GROUP BY key_id, COALESCE(cash_currency, currency, 'USD')
      `).all(...batch, since, until);
      const totals = this.db.prepare(`
        SELECT key_id, cash_currency, SUM(request_count) AS lifetime_requests,
          SUM(cash_revenue) AS lifetime_cash_revenue,
          SUM(cost_sample_count) AS lifetime_cost_samples,
          MIN(first_at) AS first_at, MAX(last_at) AS last_at
        FROM sub2api_attributed_cost_rollups
        WHERE key_id IN (${placeholders})
        GROUP BY key_id, cash_currency
      `).all(...batch);
      const entries = new Map();
      const ensure = (row) => {
        const keyId = String(row.key_id);
        const currency = row.cash_currency || 'USD';
        const identity = `${keyId}\u0000${currency}`;
        if (entries.has(identity)) return entries.get(identity);
        const entry = {
          cashCurrency: currency,
          windowRequestCount: 0,
          windowCashRevenue: 0,
          windowCostSampleCount: 0,
          lifetimeRequestCount: 0,
          lifetimeCashRevenue: 0,
          lifetimeCostSampleCount: 0,
          firstAt: null,
          lastAt: null
        };
        const list = result.get(keyId) || [];
        list.push(entry);
        result.set(keyId, list);
        entries.set(identity, entry);
        return entry;
      };
      for (const row of windows) Object.assign(ensure(row), {
        windowRequestCount: integer(row.window_requests),
        windowCashRevenue: round(finite(row.window_cash_revenue) || 0, 8),
        windowCostSampleCount: integer(row.window_cost_samples)
      });
      for (const row of totals) Object.assign(ensure(row), {
        lifetimeRequestCount: integer(row.lifetime_requests),
        lifetimeCashRevenue: round(finite(row.lifetime_cash_revenue) || 0, 8),
        lifetimeCostSampleCount: integer(row.lifetime_cost_samples),
        firstAt: row.first_at,
        lastAt: row.last_at
      });
    }
    return result;
  }

  #baseCostLedger(accountIds, since, until) {
    const result = new Map();
    for (const batch of chunks(accountIds)) {
      const placeholders = batch.map(() => '?').join(',');
      const windows = this.db.prepare(`
        SELECT account_id, currency,
          SUM(request_count) AS window_requests,
          SUM(COALESCE(cost, 0)) AS window_cost,
          SUM(CASE WHEN cost IS NULL THEN 0 ELSE request_count END) AS window_cost_samples
        FROM sub2api_account_cost_ledger
        WHERE account_id IN (${placeholders}) AND occurred_at >= ? AND occurred_at <= ?
        GROUP BY account_id, currency
      `).all(...batch, since, until);
      const totals = this.db.prepare(`
        SELECT account_id, currency, request_count AS lifetime_requests,
          cost AS lifetime_cost, cost_sample_count AS lifetime_cost_samples,
          first_at, last_at
        FROM sub2api_account_cost_rollups
        WHERE account_id IN (${placeholders})
      `).all(...batch);
      const entriesByIdentity = new Map();
      const ensureEntry = (row) => {
        const accountId = String(row.account_id);
        const identity = `${accountId}\u0000${row.currency || 'USD'}`;
        if (entriesByIdentity.has(identity)) return entriesByIdentity.get(identity);
        const entries = result.get(accountId) || [];
        const entry = {
          currency: row.currency || 'USD',
          windowRequestCount: 0,
          windowCost: 0,
          windowCostSampleCount: 0,
          lifetimeRequestCount: 0,
          lifetimeCost: 0,
          lifetimeCostSampleCount: 0,
          firstAt: null,
          lastAt: null
        };
        entries.push(entry);
        result.set(accountId, entries);
        entriesByIdentity.set(identity, entry);
        return entry;
      };
      for (const row of windows) {
        Object.assign(ensureEntry(row), {
          windowRequestCount: integer(row.window_requests),
          windowCost: round(finite(row.window_cost) || 0, 8),
          windowCostSampleCount: integer(row.window_cost_samples)
        });
      }
      for (const row of totals) {
        Object.assign(ensureEntry(row), {
          lifetimeRequestCount: integer(row.lifetime_requests),
          lifetimeCost: round(finite(row.lifetime_cost) || 0, 8),
          lifetimeCostSampleCount: integer(row.lifetime_cost_samples),
          firstAt: row.first_at,
          lastAt: row.last_at
        });
      }
    }
    return result;
  }

  #auditCurrencySettings() {
    const rows = this.db.prepare(`
      SELECT key, value_json FROM settings
      WHERE key IN ('displayCurrency', 'currencyRates')
    `).all();
    const settings = Object.fromEntries(
      rows.map((row) => [row.key, parseJson(row.value_json, null)])
    );
    return {
      displayCurrency: String(settings.displayCurrency || 'USD').toUpperCase(),
      rates: settings.currencyRates && typeof settings.currencyRates === 'object'
        ? settings.currencyRates
        : { USD: 1 }
    };
  }

  #auditAmount(amount, currency, settings) {
    const value = finite(amount);
    if (value == null) return null;
    const source = String(currency || settings.displayCurrency).toUpperCase();
    if (source === settings.displayCurrency) return round(value, 8);
    const rate = finite(settings.rates[source]);
    return rate == null ? null : round(value * rate, 8);
  }

  providerRechargeAudit(connectionId) {
    const provider = this.db.prepare(`
      SELECT id, name FROM provider_connections WHERE id = ?
    `).get(String(connectionId));
    if (!provider) {
      throw new AppError('PROVIDER_NOT_FOUND', 'Provider connection was not found', { status: 404 });
    }
    const row = this.db.prepare(`
      SELECT * FROM provider_recharge_audits WHERE connection_id = ?
    `).get(provider.id);
    return {
      connectionId: provider.id,
      providerName: provider.name,
      configured: Boolean(row),
      rechargedAmount: row ? Number(row.recharged_amount) : null,
      currency: row?.currency || 'USD',
      note: row?.note || '',
      updatedAt: row?.updated_at || null
    };
  }

  saveProviderRechargeAudit(connectionId, input = {}) {
    const current = this.providerRechargeAudit(connectionId);
    const amount = finite(input.rechargedAmount);
    if (amount == null || amount < 0) {
      throw new AppError('VALIDATION_ERROR', 'Recharge amount must be a non-negative number', {
        status: 400
      });
    }
    const currency = String(input.currency || current.currency || 'USD').trim().toUpperCase();
    const note = String(input.note || '').trim().slice(0, 500);
    const updatedAt = nowIso();
    this.db.prepare(`
      INSERT INTO provider_recharge_audits(
        connection_id, recharged_amount, currency, note, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        recharged_amount = excluded.recharged_amount,
        currency = excluded.currency,
        note = excluded.note,
        updated_at = excluded.updated_at
    `).run(String(connectionId), amount, currency, note, updatedAt);
    return this.providerRechargeAudit(connectionId);
  }

  #snapshotDeltas(keyIds, since, until) {
    const usageRows = [];
    const dailyRows = [];
    const balanceRows = [];
    const counterRows = [];
    const currentIdentityByKey = new Map();
    const startDate = dateInTimezone(new Date(since), this.config.timezone);
    const endDate = dateInTimezone(new Date(until), this.config.timezone);
    for (const batch of chunks(keyIds)) {
      const placeholders = batch.map(() => '?').join(',');
      for (const row of this.db.prepare(`
        SELECT id, metadata_json FROM remote_keys WHERE id IN (${placeholders})
      `).all(...batch)) {
        const metadata = parseJson(row.metadata_json, {});
        currentIdentityByKey.set(String(row.id), metadata.identityHash || null);
      }
      usageRows.push(...this.db.prepare(`
        SELECT subject_id AS key_id, currency, cost, requests, input_tokens,
          output_tokens, total_tokens, raw_json, captured_at
        FROM usage_snapshots current
        WHERE subject_type = 'key' AND subject_id IN (${placeholders})
          AND period = 'cumulative' AND model IS NULL
          AND captured_at <= ?
          AND (
            captured_at >= ?
            OR captured_at = (
              SELECT MAX(previous.captured_at)
              FROM usage_snapshots previous
              WHERE previous.subject_type = 'key'
                AND previous.subject_id = current.subject_id
                AND previous.currency = current.currency
                AND previous.period = 'cumulative'
                AND previous.model IS NULL
                AND previous.captured_at < ?
            )
          )
        ORDER BY subject_id, currency, captured_at
      `).all(...batch, until, since, since));
      dailyRows.push(...this.db.prepare(`
        SELECT subject_id AS key_id, currency, cost, requests, input_tokens,
          output_tokens, total_tokens, period, raw_json, captured_at
        FROM usage_snapshots current
        WHERE subject_type = 'key' AND subject_id IN (${placeholders})
          AND period >= ? AND period <= ? AND period LIKE 'day:%'
          AND model IS NULL AND captured_at <= ?
          AND captured_at = (
            SELECT MAX(previous.captured_at)
            FROM usage_snapshots previous
            WHERE previous.subject_type = 'key'
              AND previous.subject_id = current.subject_id
              AND previous.currency = current.currency
              AND previous.period = current.period
              AND previous.model IS NULL
              AND previous.captured_at <= ?
          )
        ORDER BY subject_id, currency, period
      `).all(...batch, `day:${startDate}`, `day:${endDate}`, until, until));
      balanceRows.push(...this.db.prepare(`
        SELECT subject_id AS key_id, currency, used, raw_json, captured_at
        FROM balance_snapshots current
        WHERE subject_type = 'key' AND subject_id IN (${placeholders})
          AND captured_at <= ? AND used IS NOT NULL
          AND (
            captured_at >= ?
            OR captured_at = (
              SELECT MAX(previous.captured_at)
              FROM balance_snapshots previous
              WHERE previous.subject_type = 'key'
                AND previous.subject_id = current.subject_id
                AND previous.currency = current.currency
                AND previous.used IS NOT NULL
                AND previous.captured_at < ?
            )
          )
        ORDER BY subject_id, currency, captured_at
      `).all(...batch, until, since, since));
      counterRows.push(...this.db.prepare(`
        SELECT key_id, attributed_account_id AS account_id, currency, cost,
          request_count, input_tokens, output_tokens, cache_creation_tokens,
          cache_read_tokens, interval_start, occurred_at, source_log_id,
          precision_seconds, attribution_status
        FROM provider_cost_ledger
        WHERE key_id IN (${placeholders}) AND source_type = 'usage_counter'
          AND accounting_status = 'active' AND comparable = 1
          AND attributed_account_id IS NOT NULL
          AND occurred_at >= ? AND occurred_at <= ?
        ORDER BY key_id, attributed_account_id, occurred_at
      `).all(...batch, since, until));
    }

    const normalizeUsageRow = (row) => {
      const raw = parseJson(row.raw_json, {});
      const monitorMetrics = raw.monitorMetrics && typeof raw.monitorMetrics === 'object'
        ? raw.monitorMetrics
        : {};
      return {
        ...row,
        cost: finite(monitorMetrics.actualCost) ?? finite(raw.actual_cost) ?? row.cost,
        cache_creation_tokens: finite(monitorMetrics.cacheCreationCount) ??
          finite(raw.cache_creation_tokens),
        cache_read_tokens: finite(monitorMetrics.cacheReadCount) ?? finite(raw.cache_read_tokens),
        credential_identity: monitorMetrics.credentialIdentity || null,
        usage_date: monitorMetrics.usageDate || String(row.period || '').replace(/^day:/, '') || null,
        daily_history_complete: monitorMetrics.dailyHistoryComplete === true,
        daily_coverage_start: monitorMetrics.dailyCoverageStart || null,
        daily_coverage_end: monitorMetrics.dailyCoverageEnd || null
      };
    };
    const normalizedUsageRows = usageRows.map(normalizeUsageRow);
    const normalizedDailyRows = dailyRows.map(normalizeUsageRow);
    const normalizedBalanceRows = balanceRows.map((row) => {
      const raw = parseJson(row.raw_json, {});
      return {
        ...row,
        credential_identity: raw.monitorMetrics?.credentialIdentity || null
      };
    });

    const matchesCurrentIdentity = (row) => {
      const expected = currentIdentityByKey.get(String(row.key_id));
      return !expected || row.credential_identity === expected;
    };

    const reduceRows = (rows, type) => {
      const currentRows = rows.filter(matchesCurrentIdentity);
      const byKeyAndCurrency = groupBy(currentRows, (row) => (
        `${row.key_id}\u0000${row.currency}\u0000${row.credential_identity || 'legacy'}`
      ));
      const candidates = new Map();
      for (const entries of byKeyAndCurrency.values()) {
        if (entries.length < 2) continue;
        entries.sort((left, right) => String(left.captured_at).localeCompare(String(right.captured_at)));
        const keyId = String(entries[0].key_id);
        const value = type === 'usage'
          ? {
              source: 'provider_usage_snapshots',
              keyId,
              currency: entries[0].currency || 'USD',
              cost: round(cumulativeDelta(entries, 'cost'), 8),
              requestCount: cumulativeDelta(entries, 'requests'),
              inputTokens: cumulativeDelta(entries, 'input_tokens'),
              outputTokens: cumulativeDelta(entries, 'output_tokens'),
              cacheCreationTokens: cumulativeDelta(entries, 'cache_creation_tokens'),
              cacheReadTokens: cumulativeDelta(entries, 'cache_read_tokens'),
              totalTokens: cumulativeDelta(entries, 'total_tokens'),
              from: entries[0].captured_at,
              to: entries.at(-1).captured_at,
              sampleCount: entries.length,
              exactWindow: false,
              snapshotKind: 'cumulative_delta'
            }
          : {
              source: 'provider_key_snapshots',
              keyId,
              currency: entries[0].currency || 'USD',
              cost: round(cumulativeDelta(entries, 'used'), 8),
              requestCount: null,
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
              from: entries[0].captured_at,
              to: entries.at(-1).captured_at,
              sampleCount: entries.length,
              exactWindow: false,
              snapshotKind: 'balance_delta'
            };
        const current = candidates.get(keyId);
        if (
          !current ||
          Date.parse(value.to) > Date.parse(current.to) ||
          (value.to === current.to && value.sampleCount > current.sampleCount)
        ) candidates.set(keyId, value);
      }
      return candidates;
    };

    const reduceDailyRows = () => {
      // Daily snapshots represent complete local calendar dates. They cannot
      // safely answer a rolling 24-hour window that starts mid-day.
      const calendarWindowStart = startOfDateInTimezone(startDate, this.config.timezone);
      if (!calendarWindowStart || calendarWindowStart.toISOString() !== since) return new Map();
      const currentRows = normalizedDailyRows.filter(matchesCurrentIdentity);
      const grouped = groupBy(currentRows, (row) => (
        `${row.key_id}\u0000${row.currency}\u0000${row.credential_identity || 'legacy'}`
      ));
      const candidates = new Map();
      for (const entries of grouped.values()) {
        if (entries.length === 0) continue;
        entries.sort((left, right) => String(left.period).localeCompare(String(right.period)));
        const metadata = entries.at(-1);
        const coverageComplete = metadata.daily_history_complete || (
          metadata.daily_coverage_start && metadata.daily_coverage_start <= startDate &&
          metadata.daily_coverage_end && metadata.daily_coverage_end >= endDate
        );
        if (!coverageComplete) continue;
        const sum = (field) => entries.reduce(
          (total, row) => total + Number(finite(row[field]) || 0),
          0
        );
        const keyId = String(entries[0].key_id);
        const capturedAt = entries.reduce(
          (latest, row) => Date.parse(row.captured_at) > Date.parse(latest) ? row.captured_at : latest,
          entries[0].captured_at
        );
        const value = {
          source: 'provider_usage_snapshots',
          keyId,
          currency: entries[0].currency || 'USD',
          cost: round(sum('cost'), 8),
          requestCount: Math.round(sum('requests')),
          inputTokens: Math.round(sum('input_tokens')),
          outputTokens: Math.round(sum('output_tokens')),
          cacheCreationTokens: Math.round(sum('cache_creation_tokens')),
          cacheReadTokens: Math.round(sum('cache_read_tokens')),
          totalTokens: Math.round(sum('total_tokens')),
          from: startOfDateInTimezone(startDate, this.config.timezone).toISOString(),
          to: capturedAt,
          sampleCount: entries.length,
          exactWindow: true,
          snapshotKind: 'daily_usage'
        };
        const current = candidates.get(keyId);
        if (!current || Date.parse(value.to) > Date.parse(current.to)) candidates.set(keyId, value);
      }
      return candidates;
    };
    const usage = reduceRows(normalizedUsageRows, 'usage');
    for (const [keyId, daily] of reduceDailyRows()) usage.set(keyId, daily);
    const counter = new Map();
    const counterGroups = groupBy(counterRows, (row) => (
      `${row.key_id}\u0000${row.account_id}`
    ));
    for (const [identity, entries] of counterGroups) {
      const currencies = [...new Set(entries.map((row) => row.currency || 'USD'))];
      if (currencies.length !== 1) continue;
      const sum = (field) => entries.reduce((total, row) => (
        total + Number(finite(row[field]) || 0)
      ), 0);
      const costSamples = entries.filter((row) => finite(row.cost) != null);
      const from = entries.reduce((earliest, row) => {
        const value = row.interval_start || row.occurred_at;
        return !earliest || Date.parse(value) < Date.parse(earliest) ? value : earliest;
      }, null);
      const to = entries.reduce((latest, row) => (
        !latest || Date.parse(row.occurred_at) > Date.parse(latest)
          ? row.occurred_at
          : latest
      ), null);
      counter.set(identity, {
        source: 'provider_counter_ledger',
        keyId: String(entries[0].key_id),
        accountId: String(entries[0].account_id),
        currency: currencies[0],
        cost: costSamples.length > 0 ? round(sum('cost'), 8) : null,
        requestCount: Math.round(sum('request_count')),
        inputTokens: Math.round(sum('input_tokens')),
        outputTokens: Math.round(sum('output_tokens')),
        cacheCreationTokens: Math.round(sum('cache_creation_tokens')),
        cacheReadTokens: Math.round(sum('cache_read_tokens')),
        totalTokens: Math.round(
          sum('input_tokens') + sum('output_tokens') +
          sum('cache_creation_tokens') + sum('cache_read_tokens')
        ),
        from,
        to,
        sampleCount: entries.length,
        exactWindow: false,
        snapshotKind: 'counter_ledger',
        precisionSeconds: entries.reduce(
          (maximum, row) => Math.max(maximum, integer(row.precision_seconds)),
          0
        ),
        sourceLogIds: entries.map((row) => String(row.source_log_id)),
        attributionStatuses: [...new Set(entries.map((row) => row.attribution_status))]
      });
    }
    return {
      usage,
      balance: reduceRows(normalizedBalanceRows, 'balance'),
      counter
    };
  }

  #baseCost(accountId, from, to) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS request_count,
        SUM(CASE WHEN actual_cost IS NOT NULL THEN 1 ELSE 0 END) AS cost_sample_count,
        SUM(COALESCE(actual_cost, 0)) AS cost
      FROM sub2api_account_request_samples
      WHERE account_id = ? AND created_at >= ? AND created_at <= ?
    `).get(String(accountId), from, to);
    return {
      requestCount: integer(row.request_count),
      costSampleCount: integer(row.cost_sample_count),
      cost: round(finite(row.cost) || 0, 8)
    };
  }

  #baseRequestRows(accountId, from, to) {
    return this.db.prepare(`
      SELECT source_log_id, request_id, model, upstream_model, stream,
        duration_ms, first_token_ms, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, actual_cost,
        'USD' AS currency, created_at
      FROM sub2api_account_request_samples
      WHERE account_id = ? AND created_at >= ? AND created_at <= ?
      ORDER BY created_at
    `).all(String(accountId), from, to);
  }

  #providerRequestRows(keyId, from, to) {
    return this.db.prepare(`
      SELECT source_log_id, request_id, model, upstream_model, stream,
        duration_ms, first_token_ms, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, actual_cost,
        currency, created_at
      FROM provider_request_samples
      WHERE key_id = ? AND created_at >= ? AND created_at <= ? AND status = 'success'
      ORDER BY created_at
    `).all(String(keyId), from, to);
  }

  #frozenLedgerCash({ side, accountId = null, keyId, from, to, sourceLogIds = null }) {
    const base = side === 'base';
    const table = base ? 'sub2api_account_cost_ledger' : 'provider_cost_ledger';
    const value = base ? 'cash_revenue' : 'cash_cost';
    const ownerClause = base
      ? 'account_id = ? AND key_id = ?'
      : "key_id = ? AND status = 'success' AND accounting_status = 'active' AND comparable = 1";
    const confirmedCost = base
      ? 'cost IS NOT NULL'
      : "cost IS NOT NULL AND COALESCE(recharge_source, 'default') != 'default'";
    const ownerParams = base ? [String(accountId), String(keyId)] : [String(keyId)];
    const batches = sourceLogIds == null
      ? [null]
      : chunks([...new Set(sourceLogIds.map(String).filter(Boolean))]);
    const settings = this.#auditCurrencySettings();
    let amount = 0;
    let requestCount = 0;
    let costSampleCount = 0;
    let unconfirmedCostCount = 0;
    let rowCount = 0;
    for (const batch of batches) {
      if (batch && batch.length === 0) continue;
      const sourceClause = batch
        ? `AND source_log_id IN (${batch.map(() => '?').join(',')})`
        : '';
      const rows = this.db.prepare(`
        SELECT COALESCE(cash_currency, currency, 'USD') AS cash_currency,
          SUM(COALESCE(${value},
            CASE WHEN cost IS NULL THEN 0 ELSE cost / recharge_multiplier END
          )) AS cash_amount,
          SUM(request_count) AS request_count,
          SUM(CASE WHEN ${confirmedCost} THEN request_count ELSE 0 END) AS cost_sample_count,
          SUM(CASE WHEN cost IS NOT NULL AND NOT (${confirmedCost}) THEN 1 ELSE 0 END)
            AS unconfirmed_cost_count
        FROM ${table}
        WHERE ${ownerClause} AND occurred_at >= ? AND occurred_at <= ? ${sourceClause}
        GROUP BY COALESCE(cash_currency, currency, 'USD')
      `).all(...ownerParams, from, to, ...(batch || []));
      for (const row of rows) {
        const converted = this.#auditAmount(row.cash_amount, row.cash_currency, settings);
        if (converted == null) {
          return {
            available: false,
            reason: 'currency_conversion_unavailable',
            amount: null,
            currency: settings.displayCurrency,
            requestCount,
            costSampleCount
          };
        }
        amount += converted;
        requestCount += integer(row.request_count);
        costSampleCount += integer(row.cost_sample_count);
        unconfirmedCostCount += integer(row.unconfirmed_cost_count);
        rowCount += 1;
      }
    }
    return {
      available: rowCount > 0 && requestCount === costSampleCount && unconfirmedCostCount === 0,
      reason: rowCount === 0
        ? 'ledger_snapshot_unavailable'
        : requestCount !== costSampleCount || unconfirmedCostCount > 0
          ? 'ledger_cost_incomplete'
          : null,
      amount: rowCount > 0 ? round(amount, 8) : null,
      currency: settings.displayCurrency,
      requestCount,
      costSampleCount
    };
  }

  #providerRecharge(target) {
    const manual = finite(target.recharge_manual_multiplier);
    const detected = finite(target.recharge_detected_multiplier);
    const multiplier = manual > 0 ? manual : detected > 0 ? detected : null;
    return {
      multiplier,
      source: manual > 0
        ? 'manual'
        : detected > 0 ? target.recharge_detection_source || 'detected' : null,
      status: target.recharge_status || 'unknown',
      paidCurrency: target.recharge_paid_currency || null,
      balanceCurrency: target.recharge_balance_currency || null,
      checkedAt: target.recharge_checked_at || null,
      confirmed: multiplier != null
    };
  }

  #costComparison({
    accountId, target, requestedWindow, logContext, baseLogCoverage, usageDelta, balanceDelta
  }) {
    const hasActivity = (delta, fields) => delta && fields.some((field) => Number(delta[field]) > 0);
    const usageFields = [
      'cost', 'requestCount', 'inputTokens', 'outputTokens', 'totalTokens'
    ];
    const usageHasActivity = usageDelta?.source === 'provider_counter_ledger'
      ? usageFields.some((field) => Math.abs(Number(usageDelta[field] || 0)) > 1e-10)
      : hasActivity(usageDelta, usageFields);
    const balanceHasActivity = hasActivity(balanceDelta, ['cost']);
    let candidate = null;

    if (logContext) {
      const paired = logContext.pairing.trusted === true;
      const baseMetrics = paired ? logContext.pairedBase : logContext.windowBase;
      const upstreamMetrics = paired ? logContext.pairedUpstream : logContext.windowUpstream;
      const hasLogCost = upstreamMetrics.actualCostSampleCount > 0 ||
        logContext.windowUpstream.actualCostSampleCount > 0;
      if (hasLogCost) {
        candidate = {
          source: 'provider_request_logs',
          scope: paired ? 'paired_requests' : 'key_window',
          from: logContext.window.from,
          to: logContext.window.to,
          currency: upstreamMetrics.currency || target.currency || 'USD',
          baseMetrics,
          upstreamMetrics,
          windowBaseMetrics: logContext.windowBase,
          windowUpstreamMetrics: logContext.windowUpstream,
          baseCoverageComplete: logContext.baseCoverageComplete,
          baseCost: baseMetrics.actualCost,
          upstreamCost: upstreamMetrics.actualCost,
          baseWindowCost: logContext.windowBase.actualCost,
          keyTotalUpstreamCost: logContext.windowUpstream.actualCost,
          pairedBaseCost: paired ? logContext.pairedBase.actualCost : null,
          pairedUpstreamCost: paired ? logContext.pairedUpstream.actualCost : null,
          requestCount: paired ? logContext.pairing.matchedCount : null,
          pairing: logContext.pairing
        };
      }
    }

    const snapshotCandidate = !candidate && usageHasActivity
      ? usageDelta
      : !candidate && balanceHasActivity ? balanceDelta : null;
    if (snapshotCandidate) {
      const baseRows = this.#baseRequestRows(accountId, snapshotCandidate.from, snapshotCandidate.to);
      const baseMetrics = requestMetricsFromRows(baseRows, 'USD');
      candidate = {
        source: snapshotCandidate.source,
        scope: 'snapshot_window',
        from: snapshotCandidate.from,
        to: snapshotCandidate.to,
        currency: snapshotCandidate.currency || target.currency || 'USD',
        baseMetrics,
        upstreamMetrics: null,
        windowBaseMetrics: baseMetrics,
        windowUpstreamMetrics: null,
        baseCoverageComplete: Boolean(
          baseLogCoverage?.verified &&
          Date.parse(baseLogCoverage.from) <= Date.parse(snapshotCandidate.from) &&
          Date.parse(baseLogCoverage.to) >= Date.parse(snapshotCandidate.to)
        ),
        baseCost: baseMetrics.actualCost,
        upstreamCost: snapshotCandidate.cost,
        baseWindowCost: baseMetrics.actualCost,
        keyTotalUpstreamCost: snapshotCandidate.cost,
        pairedBaseCost: null,
        pairedUpstreamCost: null,
        requestCount: snapshotCandidate.requestCount,
        pairing: null,
        exactWindow: snapshotCandidate.exactWindow === true,
        precisionSeconds: snapshotCandidate.precisionSeconds ?? null,
        sourceLogIds: snapshotCandidate.sourceLogIds || null
      };
    }

    let frozenCash = null;
    if (
      ['provider_request_logs', 'provider_counter_ledger'].includes(candidate?.source) &&
      target.key_id
    ) {
      const common = {
        accountId,
        keyId: String(target.key_id),
        from: candidate.from,
        to: candidate.to
      };
      frozenCash = {
        windowBase: this.#frozenLedgerCash({ ...common, side: 'base' }),
        windowUpstream: this.#frozenLedgerCash({
          ...common,
          side: 'upstream',
          sourceLogIds: candidate.source === 'provider_counter_ledger'
            ? candidate.sourceLogIds
            : null
        }),
        pairedBase: candidate.scope === 'paired_requests'
          ? this.#frozenLedgerCash({
              ...common,
              side: 'base',
              sourceLogIds: logContext.pairedBaseSourceIds
            })
          : null,
        pairedUpstream: candidate.scope === 'paired_requests'
          ? this.#frozenLedgerCash({
              ...common,
              side: 'upstream',
              sourceLogIds: logContext.pairedUpstreamSourceIds
            })
          : null
      };
    }

    const providerRecharge = this.#providerRecharge(target);
    const baseRechargeMultiplier = finite(this.settings().baseRechargeMultiplier) || 1;
    const cost = {
      comparable: false,
      rawComparable: false,
      scope: candidate?.scope || null,
      baseCost: candidate?.baseCost ?? null,
      upstreamCost: candidate?.upstreamCost ?? null,
      baseWindowCost: candidate?.baseWindowCost ?? null,
      keyTotalUpstreamCost: candidate?.keyTotalUpstreamCost ?? null,
      baseWindowCashEquivalent: null,
      keyTotalUpstreamCashEquivalent: null,
      windowComparable: false,
      windowDifferenceAmount: null,
      windowGrossMarginRatio: null,
      windowProfitStatus: null,
      windowReason: candidate ? null : 'provider_cost_unavailable',
      pairedBaseCost: candidate?.pairedBaseCost ?? null,
      pairedUpstreamCost: candidate?.pairedUpstreamCost ?? null,
      extraUpstreamCost: null,
      baseCashEquivalent: null,
      upstreamCashEquivalent: null,
      extraUpstreamCashEquivalent: null,
      differenceAmount: null,
      differenceRatio: null,
      grossMarginRatio: null,
      moreExpensive: null,
      profitStatus: null,
      currency: candidate?.currency || target.currency || null,
      cashCurrency: null,
      source: candidate?.source || null,
      from: candidate?.from || null,
      to: candidate?.to || null,
      requestCount: candidate?.requestCount ?? null,
      baseRechargeMultiplier,
      providerRecharge,
      valuationMode: frozenCash ? 'transaction_snapshot' : 'current_multiplier_fallback',
      estimated: candidate?.source === 'provider_counter_ledger',
      precisionSeconds: candidate?.precisionSeconds ?? null,
      reason: candidate ? null : 'provider_cost_unavailable',
      requestedFrom: requestedWindow.from,
      requestedTo: requestedWindow.to
    };
    if (!candidate) {
      if ((usageDelta?.cost === 0 || balanceDelta?.cost === 0) &&
        this.#baseRequestRows(accountId, requestedWindow.from, requestedWindow.to)
          .some((row) => Number(row.actual_cost) > 0)) {
        cost.reason = 'provider_counter_unchanged';
      }
      return cost;
    }

    if (
      candidate.scope === 'paired_requests' &&
      candidate.baseCoverageComplete &&
      finite(candidate.keyTotalUpstreamCost) != null &&
      finite(candidate.pairedUpstreamCost) != null
    ) {
      cost.extraUpstreamCost = round(Math.max(
        0,
        Number(candidate.keyTotalUpstreamCost) - Number(candidate.pairedUpstreamCost)
      ), 8);
    }
    const baseCostAvailable = finite(candidate.baseCost) != null &&
      candidate.baseMetrics?.actualCostSampleCount === candidate.baseMetrics?.requestCount;
    const upstreamCostAvailable = finite(candidate.upstreamCost) != null && (
      candidate.scope === 'snapshot_window' ||
      candidate.upstreamMetrics?.actualCostSampleCount === candidate.upstreamMetrics?.requestCount
    );
    const baseWindowCostAvailable = finite(candidate.baseWindowCost) != null &&
      candidate.windowBaseMetrics?.actualCostSampleCount === candidate.windowBaseMetrics?.requestCount;
    const upstreamWindowCostAvailable = finite(candidate.keyTotalUpstreamCost) != null && (
      candidate.scope === 'snapshot_window' ||
      candidate.windowUpstreamMetrics?.actualCostSampleCount ===
        candidate.windowUpstreamMetrics?.requestCount
    );
    const sameRawCurrency = String(candidate.currency || 'USD').toUpperCase() === 'USD';
    cost.rawComparable = candidate.scope === 'paired_requests' && baseCostAvailable &&
      upstreamCostAvailable && sameRawCurrency;
    const pairedFrozenAvailable = candidate.scope === 'paired_requests' &&
      frozenCash?.pairedBase?.available && frozenCash?.pairedUpstream?.available &&
      frozenCash.pairedBase.requestCount === candidate.baseMetrics.requestCount &&
      frozenCash.pairedUpstream.requestCount === candidate.upstreamMetrics.requestCount;
    const expectedWindowUpstreamRequests = candidate.scope === 'snapshot_window'
      ? candidate.requestCount
      : candidate.windowUpstreamMetrics?.requestCount;
    const windowFrozenAvailable = frozenCash?.windowBase?.available &&
      frozenCash?.windowUpstream?.available &&
      frozenCash.windowBase.requestCount === candidate.windowBaseMetrics.requestCount &&
      frozenCash.windowUpstream.requestCount === expectedWindowUpstreamRequests;
    cost.baseCashEquivalent = pairedFrozenAvailable
      ? frozenCash.pairedBase.amount
      : baseCostAvailable ? round(Number(candidate.baseCost) / baseRechargeMultiplier, 8) : null;
    cost.upstreamCashEquivalent = pairedFrozenAvailable
      ? frozenCash.pairedUpstream.amount
      : upstreamCostAvailable && providerRecharge.multiplier
        ? round(Number(candidate.upstreamCost) / providerRecharge.multiplier, 8)
        : null;
    cost.baseWindowCashEquivalent = windowFrozenAvailable
      ? frozenCash.windowBase.amount
      : baseWindowCostAvailable
        ? round(Number(candidate.baseWindowCost) / baseRechargeMultiplier, 8)
        : null;
    cost.keyTotalUpstreamCashEquivalent = windowFrozenAvailable
      ? frozenCash.windowUpstream.amount
      : upstreamWindowCostAvailable && providerRecharge.multiplier
        ? round(Number(candidate.keyTotalUpstreamCost) / providerRecharge.multiplier, 8)
        : null;
    cost.extraUpstreamCashEquivalent = pairedFrozenAvailable && windowFrozenAvailable
      ? round(Math.max(0, frozenCash.windowUpstream.amount - frozenCash.pairedUpstream.amount), 8)
      : finite(cost.extraUpstreamCost) != null && providerRecharge.multiplier
        ? round(Number(cost.extraUpstreamCost) / providerRecharge.multiplier, 8)
        : null;
    const upstreamCashCurrency = windowFrozenAvailable
      ? frozenCash.windowUpstream.currency
      : providerRecharge.paidCurrency || candidate.currency || 'USD';
    cost.cashCurrency = String(upstreamCashCurrency).toUpperCase();
    cost.valuationMode = pairedFrozenAvailable || windowFrozenAvailable
      ? 'transaction_snapshot'
      : 'current_multiplier_fallback';

    if (
      candidate.source !== 'provider_request_logs' &&
      candidate.source !== 'provider_counter_ledger' &&
      !candidate.exactWindow
    ) {
      cost.windowReason = 'request_logs_unavailable';
    } else if (!candidate.baseCoverageComplete) {
      cost.windowReason = 'base_request_logs_incomplete';
    } else if (Number(target.shared_account_count) > 1) {
      cost.windowReason = 'shared_provider_key';
    } else if (!baseWindowCostAvailable) {
      cost.windowReason = 'sub2api_cost_unavailable';
    } else if (!upstreamWindowCostAvailable) {
      cost.windowReason = 'provider_cost_unavailable';
    } else if (!windowFrozenAvailable && (!sameRawCurrency || cost.cashCurrency !== 'USD')) {
      cost.windowReason = 'currency_mismatch';
    } else if (!windowFrozenAvailable && !providerRecharge.confirmed) {
      cost.windowReason = 'provider_recharge_multiplier_missing';
    } else {
      cost.windowComparable = true;
      cost.windowReason = null;
      cost.windowDifferenceAmount = round(
        cost.baseWindowCashEquivalent - cost.keyTotalUpstreamCashEquivalent,
        8
      );
      cost.windowGrossMarginRatio = cost.baseWindowCashEquivalent > 0
        ? round(cost.windowDifferenceAmount / cost.baseWindowCashEquivalent, 6)
        : null;
      cost.windowProfitStatus = Math.abs(cost.windowDifferenceAmount) < 1e-8
        ? 'break_even'
        : cost.windowDifferenceAmount > 0 ? 'profit' : 'loss';
    }

    if (candidate.scope !== 'paired_requests') {
      cost.reason = Number(target.shared_account_count) > 1
        ? 'shared_provider_key'
        : 'request_pairing_unavailable';
    } else if (!baseCostAvailable) {
      cost.reason = 'sub2api_cost_unavailable';
    } else if (!upstreamCostAvailable) {
      cost.reason = 'provider_cost_unavailable';
    } else if (!pairedFrozenAvailable && (!sameRawCurrency || cost.cashCurrency !== 'USD')) {
      cost.reason = 'currency_mismatch';
    } else if (!pairedFrozenAvailable && !providerRecharge.confirmed) {
      cost.reason = 'provider_recharge_multiplier_missing';
    } else {
      cost.comparable = true;
      cost.reason = null;
      cost.differenceAmount = round(cost.baseCashEquivalent - cost.upstreamCashEquivalent, 8);
      cost.differenceRatio = cost.upstreamCashEquivalent > 0
        ? round(cost.differenceAmount / cost.upstreamCashEquivalent, 6)
        : null;
      cost.grossMarginRatio = cost.baseCashEquivalent > 0
        ? round(cost.differenceAmount / cost.baseCashEquivalent, 6)
        : null;
      cost.moreExpensive = Math.abs(cost.differenceAmount) < 1e-8
        ? 'same'
        : cost.differenceAmount > 0 ? 'sub2api' : 'upstream';
      cost.profitStatus = Math.abs(cost.differenceAmount) < 1e-8
        ? 'break_even'
        : cost.differenceAmount > 0 ? 'profit' : 'loss';
    }
    return cost;
  }

  #comparisons(accountIds, since, until = nowIso()) {
    const comparisonByAccount = new Map(accountIds.map((accountId) => [String(accountId), {
      status: 'unmapped',
      source: 'unavailable',
      provider: null,
      targets: [],
      base: null,
      upstream: null,
      windowTotals: null,
      window: { requestedFrom: since, requestedTo: until, from: null, to: null },
      pairing: null,
      overhead: null,
      coverage: null,
      metricReason: 'no_enabled_mapping',
      attribution: {
        base: { scope: 'account_id', accountId: String(accountId) },
        upstream: null,
        mappingId: null
      },
      cost: {
        comparable: false,
        baseCost: null,
        upstreamCost: null,
        differenceAmount: null,
        differenceRatio: null,
        moreExpensive: null,
        currency: null,
        source: null,
        from: null,
        to: null,
        reason: 'no_enabled_mapping'
      }
    }]));
    if (accountIds.length === 0) return comparisonByAccount;

    const rows = this.#mappingRows(accountIds);
    const grouped = groupBy(rows, (row) => String(row.account_id));
    const targetsByAccount = new Map();
    const keyIds = new Set();
    for (const [accountId, mappingRows] of grouped) {
      const unique = new Map();
      for (const row of mappingRows) {
        const identity = `${row.connection_id}\u0000${row.key_id || ''}`;
        if (!unique.has(identity)) unique.set(identity, row);
      }
      const targets = [...unique.values()];
      targetsByAccount.set(accountId, targets);
      for (const target of targets) if (target.key_id) keyIds.add(String(target.key_id));
    }
    const ids = [...keyIds];
    const snapshots = this.#snapshotDeltas(ids, since, until);
    const staleBefore = Date.now() - Number(this.config.staleAfterMinutes || 60) * 60000;
    const baseLogCoverage = this.#baseLogCoverage();

    for (const accountId of accountIds.map(String)) {
      const targets = targetsByAccount.get(accountId) || [];
      if (targets.length === 0) continue;
      const publicTargets = targets.map((target) => ({
        connectionId: target.connection_id,
        providerName: target.provider_name,
        adapterType: target.adapter_type,
        authMode: target.auth_mode,
        keyId: target.key_id,
        remoteKeyId: target.remote_key_id,
        keyName: target.key_name,
        role: target.role
      }));
      if (targets.length > 1) {
        comparisonByAccount.set(accountId, {
          ...comparisonByAccount.get(accountId),
          status: 'multiple_upstreams',
          targets: publicTargets,
          cost: {
            ...comparisonByAccount.get(accountId).cost,
            reason: 'multiple_upstreams'
          },
          metricReason: 'multiple_upstreams'
        });
        continue;
      }

      const target = targets[0];
      const provider = {
        connectionId: target.connection_id,
        name: target.provider_name,
        adapterType: target.adapter_type,
        authMode: target.auth_mode,
        keyId: target.key_id,
        remoteKeyId: target.remote_key_id,
        keyName: target.key_name,
        keyStatus: target.key_status,
        lastSyncAt: target.last_success_at,
        lastErrorCode: target.last_error_code,
        recharge: this.#providerRecharge(target)
      };
      const mappingConfig = parseJson(target.mapping_config_json, {});
      const automaticKeyMatch = mappingConfig.autoMapping?.keyMatch || null;
      const unverifiedAutomaticApiKey = target.adapter_type === 'sub2api' &&
        automaticKeyMatch && (
          automaticKeyMatch === 'verified_gateway_billing' ||
          (target.auth_mode === 'api_key' && automaticKeyMatch !== 'exact_configured_secret')
        );
      if (unverifiedAutomaticApiKey) {
        const previous = comparisonByAccount.get(accountId);
        comparisonByAccount.set(accountId, {
          ...previous,
          status: 'mapping_unverified',
          provider,
          targets: publicTargets,
          metricReason: 'mapping_key_unverified',
          attribution: {
            base: { scope: 'account_id', accountId },
            upstream: null,
            mappingId: target.mapping_id
          },
          cost: { ...previous.cost, reason: 'mapping_key_unverified' }
        });
        continue;
      }
      if (!target.key_id || target.key_status === 'missing') {
        comparisonByAccount.set(accountId, {
          ...comparisonByAccount.get(accountId),
          status: 'missing_key',
          provider,
          targets: publicTargets,
          metricReason: 'mapping_key_missing',
          cost: { ...comparisonByAccount.get(accountId).cost, reason: 'mapping_key_missing' }
        });
        continue;
      }

      const keyId = String(target.key_id);
      const hasCoverageWindow = Boolean(target.coverage_from && target.coverage_to);
      const hasLogCoverage = target.request_log_status === 'succeeded' && hasCoverageWindow;
      const hasRetainedKeyLogCoverage = target.request_log_status !== 'succeeded' &&
        hasCoverageWindow && Boolean(target.request_log_synced_at) &&
        target.request_log_scope === 'key';
      const hasKeyLogCoverage = (hasLogCoverage &&
        target.request_log_scope === 'key') || hasRetainedKeyLogCoverage;
      const usageDelta = snapshots.counter.get(`${keyId}\u0000${accountId}`) ||
        snapshots.usage.get(keyId) || null;
      const balanceDelta = snapshots.balance.get(keyId) || null;
      let source = 'unavailable';
      let base = null;
      let upstream = null;
      let windowTotals = null;
      let window = { requestedFrom: since, requestedTo: until, from: null, to: null, source: null };
      let pairing = null;
      let overhead = null;
      let logContext = null;
      let coverage = null;
      let metricReason = null;
      if (hasKeyLogCoverage) {
        source = 'provider_request_logs';
        const baseCoverageFrom = baseLogCoverage.verified ? Date.parse(baseLogCoverage.from) : null;
        const baseCoverageTo = baseLogCoverage.verified ? Date.parse(baseLogCoverage.to) : null;
        const windowFrom = new Date(Math.max(
          Date.parse(since),
          Date.parse(target.coverage_from),
          Number.isFinite(baseCoverageFrom) ? baseCoverageFrom : Number.NEGATIVE_INFINITY
        )).toISOString();
        const windowTo = new Date(Math.min(
          Date.parse(until),
          Date.parse(target.coverage_to),
          Number.isFinite(baseCoverageTo) ? baseCoverageTo : Number.POSITIVE_INFINITY
        )).toISOString();
        const baseCoverageComplete = baseLogCoverage.verified &&
          Date.parse(baseLogCoverage.from) <= Date.parse(windowFrom) &&
          Date.parse(baseLogCoverage.to) >= Date.parse(windowTo);
        const baseRequestedCoverageComplete = baseLogCoverage.verified &&
          Date.parse(baseLogCoverage.from) <= Date.parse(since);
        window = {
          requestedFrom: since,
          requestedTo: until,
          from: windowFrom,
          to: windowTo,
          source: 'request_log_intersection',
          complete: Date.parse(windowFrom) <= Date.parse(since) &&
            Date.parse(windowTo) >= Date.parse(until) && !Boolean(target.request_log_truncated) &&
            baseRequestedCoverageComplete
        };
        const baseRows = Date.parse(windowTo) > Date.parse(windowFrom)
          ? this.#baseRequestRows(accountId, windowFrom, windowTo)
          : [];
        const upstreamRows = Date.parse(windowTo) > Date.parse(windowFrom)
          ? this.#providerRequestRows(keyId, windowFrom, windowTo)
          : [];
        const windowBase = requestMetricsFromRows(baseRows, 'USD');
        const windowUpstream = requestMetricsFromRows(upstreamRows, target.currency || 'USD');
        const paired = pairRequestRows(baseRows, upstreamRows);
        const pairingTrust = requestPairingTrust(paired, { baseCoverageComplete });
        const usePairedMetrics = pairingTrust.trusted;
        const pairedBase = requestMetricsFromRows(paired.pairs.map((item) => item.base), 'USD');
        const pairedUpstream = requestMetricsFromRows(
          paired.pairs.map((item) => item.upstream),
          target.currency || 'USD'
        );
        pairing = {
          mode: usePairedMetrics ? 'paired_requests' : 'window_aggregate',
          trusted: usePairedMetrics,
          trustReason: pairingTrust.reason,
          minimumSampleCount: REQUEST_PAIR_MIN_SAMPLES,
          minimumMatchRate: REQUEST_PAIR_MIN_MATCH_RATE,
          matchedCount: paired.matchedCount,
          matchedBy: paired.matchedBy,
          baseRequestCount: paired.baseRequestCount,
          upstreamRequestCount: paired.upstreamRequestCount,
          baseUnmatchedCount: paired.baseUnmatchedCount,
          upstreamExtraCount: baseCoverageComplete && usePairedMetrics
            ? paired.upstreamExtraCount
            : null,
          observedUpstreamUnmatchedCount: paired.upstreamExtraCount,
          extraCountTrusted: baseCoverageComplete && usePairedMetrics,
          baseMatchRate: paired.baseMatchRate,
          upstreamMatchRate: baseCoverageComplete ? paired.upstreamMatchRate : null,
          cacheMismatchCount: paired.cacheMismatchCount,
          toleranceMs: REQUEST_PAIR_TIME_TOLERANCE_MS,
          reason: pairingTrust.reason ||
            (paired.cacheMismatchCount > 0 ? 'cache_token_mismatch' : null)
        };
        base = usePairedMetrics ? pairedBase : windowBase;
        upstream = usePairedMetrics ? pairedUpstream : windowUpstream;
        windowTotals = { base: windowBase, upstream: windowUpstream };
        overhead = usePairedMetrics ? paired.overhead : null;
        logContext = {
          window,
          windowBase,
          windowUpstream,
          pairedBase,
          pairedUpstream,
          pairedBaseSourceIds: paired.pairs.map((item) => item.base.source_log_id),
          pairedUpstreamSourceIds: paired.pairs.map((item) => item.upstream.source_log_id),
          pairing,
          baseCoverageComplete
        };
        coverage = {
          from: target.coverage_from,
          to: target.coverage_to,
          complete: Date.parse(target.coverage_from) <= Date.parse(since) &&
            Date.parse(target.coverage_to) >= Date.parse(until) &&
            !Boolean(target.request_log_truncated) && target.request_log_status === 'succeeded',
          truncated: Boolean(target.request_log_truncated),
          status: target.request_log_status,
          errorCode: target.request_log_error_code,
          syncedAt: target.request_log_synced_at,
          stale: target.request_log_status !== 'succeeded' || !target.request_log_synced_at ||
            Date.parse(target.request_log_synced_at) < staleBefore,
          attribution: 'mapped_key',
          syncScope: target.request_log_scope
        };
        metricReason = !baseLogCoverage.verified || !baseRequestedCoverageComplete
          ? 'base_request_logs_incomplete'
          : hasRetainedKeyLogCoverage
          ? 'request_logs_stale'
          : Boolean(target.request_log_truncated)
          ? 'request_logs_truncated'
          : Date.parse(target.coverage_from) > Date.parse(since)
            ? 'request_logs_incomplete'
            : windowUpstream.requestCount === 0
              ? 'no_successful_requests'
              : pairing.reason;
      } else if (usageDelta) {
        source = usageDelta.snapshotKind === 'counter_ledger'
          ? 'provider_counter_ledger'
          : usageDelta.snapshotKind === 'daily_usage'
            ? 'provider_daily_usage'
            : 'provider_usage_snapshots';
        window = {
          requestedFrom: since,
          requestedTo: until,
          from: usageDelta.from,
          to: usageDelta.to,
          source: usageDelta.snapshotKind === 'counter_ledger'
            ? 'counter_ledger'
            : usageDelta.snapshotKind === 'daily_usage' ? 'daily_usage' : 'snapshot_delta',
          complete: usageDelta.exactWindow === true || (
            Date.parse(usageDelta.from) <= Date.parse(since) &&
            Date.parse(usageDelta.to) >= Date.parse(until)
          )
        };
        base = requestMetricsFromRows(
          this.#baseRequestRows(accountId, usageDelta.from, usageDelta.to),
          'USD'
        );
        upstream = {
          ...emptyUpstreamMetrics(false),
          requestCount: usageDelta.requestCount == null ? null : Math.round(usageDelta.requestCount),
          inputTokens: usageDelta.inputTokens == null ? null : Math.round(usageDelta.inputTokens),
          outputTokens: usageDelta.outputTokens == null ? null : Math.round(usageDelta.outputTokens),
          cacheCreationTokens: usageDelta.cacheCreationTokens == null
            ? null
            : Math.round(usageDelta.cacheCreationTokens),
          cacheReadTokens: usageDelta.cacheReadTokens == null
            ? null
            : Math.round(usageDelta.cacheReadTokens),
          cacheRate: (() => {
            const promptTokens = Number(usageDelta.inputTokens || 0) +
              Number(usageDelta.cacheCreationTokens || 0) +
              Number(usageDelta.cacheReadTokens || 0);
            return promptTokens > 0
              ? round(Number(usageDelta.cacheReadTokens || 0) / promptTokens * 100, 1)
              : null;
          })(),
          actualCost: usageDelta.cost
        };
        windowTotals = { base, upstream };
        pairing = {
          mode: 'window_aggregate',
          matchedCount: 0,
          baseRequestCount: base.requestCount,
          upstreamRequestCount: upstream.requestCount,
          baseUnmatchedCount: base.requestCount,
          upstreamExtraCount: null,
          baseMatchRate: null,
          upstreamMatchRate: null,
          cacheMismatchCount: 0,
          reason: 'request_logs_unavailable'
        };
        coverage = {
          from: usageDelta.from,
          to: usageDelta.to,
          complete: usageDelta.exactWindow === true || (
            Date.parse(usageDelta.from) <= Date.parse(since) &&
            Date.parse(usageDelta.to) >= Date.parse(until)
          ),
          truncated: false,
          status: 'succeeded',
          syncedAt: target.last_success_at,
          stale: !target.last_success_at || Date.parse(target.last_success_at) < staleBefore,
          attribution: 'mapped_key'
        };
        metricReason = usageDelta.requestCount == null
          ? 'provider_performance_unavailable'
          : usageDelta.requestCount > 0
            ? 'provider_latency_unavailable'
            : 'provider_counter_unchanged';
      } else if (target.last_error_code || target.request_log_error_code ||
        ['failed', 'unavailable', 'partial'].includes(target.request_log_status)) {
        metricReason = 'provider_sync_unavailable';
      } else if (hasLogCoverage) {
        metricReason = 'request_logs_key_unverified';
      } else if (['account', 'bearer', 'token_pair'].includes(String(target.auth_mode || '').toLowerCase())) {
        metricReason = 'account_usage_not_attributable';
      } else if (balanceDelta) {
        metricReason = 'provider_performance_unavailable';
      } else {
        metricReason = 'provider_performance_unavailable';
      }

      const cost = this.#costComparison({
        accountId,
        target,
        requestedWindow: { from: since, to: until },
        logContext,
        baseLogCoverage,
        usageDelta,
        balanceDelta
      });

      comparisonByAccount.set(accountId, {
        status: 'mapped',
        source,
        provider,
        targets: publicTargets,
        base,
        upstream,
        windowTotals,
        window,
        pairing,
        overhead,
        coverage,
        baseCoverage: baseLogCoverage,
        metricReason,
        attribution: {
          base: { scope: 'account_id', accountId },
          upstream: {
            scope: 'api_key_id',
            connectionId: target.connection_id,
            keyId: target.key_id,
            remoteKeyId: target.remote_key_id
          },
          mappingId: target.mapping_id
        },
        cost
      });
    }
    return comparisonByAccount;
  }

  #upstreamTrends(comparison, since, until) {
    if (comparison?.source !== 'provider_request_logs' || !comparison.provider?.keyId) return [];
    return this.db.prepare(`
      SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS requests,
        AVG(CASE WHEN stream = 1 AND first_token_ms > 0 THEN first_token_ms END) AS ttft_ms,
        AVG(duration_ms) AS duration_ms,
        SUM(input_tokens) AS input_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(COALESCE(actual_cost, 0)) AS cost
      FROM provider_request_samples
      WHERE key_id = ? AND created_at >= ? AND created_at <= ? AND status = 'success'
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day
    `).all(comparison.provider.keyId, since, until).map((item) => {
      const promptTokens = integer(item.input_tokens) + integer(item.cache_creation_tokens) +
        integer(item.cache_read_tokens);
      return {
        day: item.day,
        requests: integer(item.requests),
        ttftMs: round(finite(item.ttft_ms), 0),
        durationMs: round(finite(item.duration_ms), 0),
        cacheRate: promptTokens > 0 ? round(integer(item.cache_read_tokens) / promptTokens * 100, 1) : null,
        cost: round(finite(item.cost) || 0, 8)
      };
    });
  }

  providersView(filters = {}) {
    const windowSelection = normalizeAccountMonitorWindowSelection(
      filters.window || filters.timeWindow || filters.period || filters.days,
      this.settings().lookbackDays
    );
    const days = windowSelection.days;
    const requestedWindow = accountMonitorWindow(windowSelection, this.config.timezone);
    const { from: since, to: until } = requestedWindow;
    const pageSize = clamp(integer(filters.pageSize, 50), 10, 200);
    const clauses = ['connection.enabled = 1'];
    const params = [];
    if (filters.search) {
      const query = `%${String(filters.search).trim().toLowerCase()}%`;
      clauses.push(`(
        LOWER(connection.name) LIKE ? OR LOWER(connection.adapter_type) LIKE ? OR
        EXISTS (
          SELECT 1 FROM remote_keys search_key
          WHERE search_key.connection_id = connection.id
            AND (LOWER(search_key.name) LIKE ? OR LOWER(search_key.remote_id) LIKE ? OR
              LOWER(search_key.masked_key) LIKE ?)
        )
      )`);
      params.push(query, query, query, query, query);
    }
    const where = clauses.join(' AND ');
    const total = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM provider_connections connection WHERE ${where}
    `).get(...params).count || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = clamp(integer(filters.page, 1), 1, totalPages);
    const offset = (page - 1) * pageSize;
    const providerRows = this.db.prepare(`
      SELECT connection.id, connection.name, connection.adapter_type,
        connection.auth_mode, connection.last_success_at, connection.last_error_code,
        recharge.detected_multiplier AS recharge_detected_multiplier,
        recharge.manual_multiplier AS recharge_manual_multiplier,
        recharge.paid_currency AS recharge_paid_currency,
        recharge.balance_currency AS recharge_balance_currency,
        recharge.detection_source AS recharge_detection_source,
        recharge.status AS recharge_status,
        recharge.checked_at AS recharge_checked_at,
        audit.recharged_amount, audit.currency AS audit_currency,
        audit.note AS audit_note, audit.updated_at AS audit_updated_at,
        (SELECT COUNT(*) FROM remote_keys key_count
          WHERE key_count.connection_id = connection.id
        ) AS key_count
      FROM provider_connections connection
      LEFT JOIN provider_recharge_rates recharge ON recharge.connection_id = connection.id
      LEFT JOIN provider_recharge_audits audit ON audit.connection_id = connection.id
      WHERE ${where}
      ORDER BY connection.name COLLATE NOCASE, connection.id
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    const providerIds = providerRows.map((row) => row.id);
    const keys = [];
    for (const batch of chunks(providerIds)) {
      const placeholders = batch.map(() => '?').join(',');
      keys.push(...this.db.prepare(`
        SELECT key.id, key.connection_id, key.remote_id, key.name, key.masked_key,
          key.status, key.currency, key.expires_at, key.last_used_at,
          key.metadata_json, key.last_seen_at,
          COALESCE(key_sync.status, connection_sync.status) AS request_log_status
        FROM remote_keys key
        LEFT JOIN provider_request_key_sync_state key_sync ON key_sync.key_id = key.id
        LEFT JOIN provider_request_log_sync_state connection_sync
          ON connection_sync.connection_id = key.connection_id
        WHERE key.connection_id IN (${placeholders})
        ORDER BY key.connection_id, key.name COLLATE NOCASE, key.remote_id
      `).all(...batch));
    }
    const keyIds = keys.map((key) => String(key.id));
    const mappings = [];
    for (const batch of chunks(keyIds)) {
      const placeholders = batch.map(() => '?').join(',');
      mappings.push(...this.db.prepare(`
        SELECT mapping.key_id, CAST(mapping.account_id AS TEXT) AS account_id,
          mapping.connection_id, mapping.role, account.name, account.platform,
          account.status, account.account_type
        FROM sub2api_mappings mapping
        JOIN sub2api_monitored_accounts account
          ON account.account_id = CAST(mapping.account_id AS TEXT)
        WHERE mapping.enabled = 1 AND mapping.key_id IN (${placeholders})
          AND account.missing_since IS NULL
        ORDER BY mapping.key_id, account.name COLLATE NOCASE, account.account_id
      `).all(...batch));
    }
    const mappingsByKey = new Map();
    for (const mapping of mappings) {
      const keyId = String(mapping.key_id);
      const byAccount = mappingsByKey.get(keyId) || new Map();
      if (!byAccount.has(String(mapping.account_id))) {
        byAccount.set(String(mapping.account_id), {
          accountId: String(mapping.account_id),
          name: mapping.name,
          platform: mapping.platform,
          status: mapping.status,
          accountType: mapping.account_type
        });
      }
      mappingsByKey.set(keyId, byAccount);
    }
    const accountIds = [...new Set(mappings.map((mapping) => String(mapping.account_id)))];
    const targetsByAccount = new Map();
    for (const batch of chunks(accountIds)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT CAST(account_id AS TEXT) AS account_id, connection_id, key_id
        FROM sub2api_mappings
        WHERE enabled = 1 AND key_id IS NOT NULL
          AND CAST(account_id AS TEXT) IN (${placeholders})
        GROUP BY account_id, connection_id, key_id
      `).all(...batch);
      for (const row of rows) {
        const accountId = String(row.account_id);
        const targets = targetsByAccount.get(accountId) || [];
        targets.push({ connectionId: row.connection_id, keyId: String(row.key_id) });
        targetsByAccount.set(accountId, targets);
      }
    }
    const upstreamMetrics = this.#providerRequestMetrics(keyIds, since, until);
    const providerLedger = this.#providerCostLedger(keyIds, since, until);
    const providerCashLedger = this.#providerCashLedger(keyIds, since, until);
    const baseMetrics = this.#metrics(accountIds, since, until);
    const baseLedger = this.#baseCostLedger(accountIds, since, until);
    const attributedBaseLedger = this.#attributedBaseCostLedger(keyIds, since, until);
    const auditSettings = this.#auditCurrencySettings();

    const ledgerValue = (entries, field) => entries.reduce(
      (sum, entry) => sum + Number(entry[field] || 0),
      0
    );
    const ledgerCash = (entries, field, confirmationField = null) => {
      let totalAmount = 0;
      for (const entry of entries) {
        if (confirmationField && entry[confirmationField] === false) return null;
        const converted = this.#auditAmount(
          Number(entry[field] || 0),
          entry.cashCurrency,
          auditSettings
        );
        if (converted == null) return null;
        totalAmount += converted;
      }
      return round(totalAmount, 8);
    };
    const baseLedgerValue = (ids, field) => ids.reduce((sum, accountId) =>
      sum + (baseLedger.get(String(accountId)) || []).reduce(
        (accountSum, entry) => accountSum + Number(entry[field] || 0),
        0
      ), 0);

    const keysByProvider = groupBy(keys, (key) => key.connection_id);
    const items = providerRows.map((providerRow) => {
      const recharge = this.#providerRecharge(providerRow);
      const providerKeys = (keysByProvider.get(providerRow.id) || []).map((key) => {
        const keyId = String(key.id);
        const accounts = [...(mappingsByKey.get(keyId) || new Map()).values()];
        const mappedAccountIds = accounts.map((account) => account.accountId);
        const attributedAccountIds = mappedAccountIds.filter((accountId) => {
          const targets = targetsByAccount.get(String(accountId)) || [];
          return targets.length === 1 && targets[0].connectionId === providerRow.id &&
            targets[0].keyId === keyId;
        });
        const attributionComplete = mappedAccountIds.length > 0 &&
          attributedAccountIds.length === mappedAccountIds.length;
        const accountMetricValues = attributedAccountIds.map(
          (accountId) => baseMetrics.get(String(accountId))
        ).filter(Boolean);
        const accountMetric = aggregateMetrics(accountMetricValues);
        const keyBaseMetrics = attachQuality({
          ...accountMetric,
          ...metricsForProbeScope(accountMetric, 'base'),
          requestCount: baseLedgerValue(attributedAccountIds, 'windowRequestCount'),
          available: attributionComplete,
          unavailableReason: attributionComplete
            ? null
            : mappedAccountIds.length === 0
              ? 'base_key_unmapped'
              : 'base_key_attribution_incomplete'
        });
        const ledgerEntries = providerLedger.get(keyId) || [];
        const cashLedgerEntries = providerCashLedger.get(keyId) || [];
        const baseCashEntries = attributedBaseLedger.get(keyId) || [];
        const sampleMetric = upstreamMetrics.get(keyId) || emptyUpstreamMetrics(true);
        const windowRequestCount = ledgerValue(ledgerEntries, 'windowRequestCount');
        const windowInputTokens = ledgerValue(ledgerEntries, 'windowInputTokens');
        const windowOutputTokens = ledgerValue(ledgerEntries, 'windowOutputTokens');
        const windowCacheCreationTokens = ledgerValue(
          ledgerEntries,
          'windowCacheCreationTokens'
        );
        const windowCacheReadTokens = ledgerValue(ledgerEntries, 'windowCacheReadTokens');
        const promptTokens = windowInputTokens + windowCacheCreationTokens + windowCacheReadTokens;
        const currencies = [...new Set(ledgerEntries.map((entry) => entry.currency))];
        const counterWindowCovered = ledgerEntries.some((entry) => (
          entry.counterObservedIntervalCount > 0 &&
          Date.parse(entry.counterLastCapturedAt) >= Date.parse(since) &&
          Date.parse(entry.counterAccountingStartedAt) <= Date.parse(until)
        ));
        const hasWindowAccounting = ledgerValue(ledgerEntries, 'windowEntryCount') > 0 ||
          counterWindowCovered || ['succeeded', 'partial'].includes(key.request_log_status);
        const windowCost = currencies.length === 1 && hasWindowAccounting
          ? ledgerValue(ledgerEntries, 'windowCost')
          : null;
        const lifetimeBalanceCost = currencies.length === 1
          ? ledgerValue(ledgerEntries, 'lifetimeCost')
          : null;
        const hasReportedCounter = ledgerEntries.some(
          (entry) => entry.reportedLifetimeCost != null
        );
        const reportedLifetimeBalanceCost = currencies.length === 1
          ? hasReportedCounter
            ? ledgerValue(ledgerEntries, 'reportedLifetimeCost')
            : lifetimeBalanceCost
          : null;
        const openingBalanceCost = currencies.length === 1
          ? ledgerValue(ledgerEntries, 'openingCost')
          : null;
        const keyUpstreamMetrics = attachQuality({
          ...sampleMetric,
          requestCount: windowRequestCount,
          inputTokens: windowInputTokens,
          outputTokens: windowOutputTokens,
          cacheCreationTokens: windowCacheCreationTokens,
          cacheReadTokens: windowCacheReadTokens,
          cacheRate: promptTokens > 0
            ? round(windowCacheReadTokens / promptTokens * 100, 1)
            : null,
          actualCost: windowCost,
          actualCostSampleCount: ledgerValue(ledgerEntries, 'windowCostSampleCount'),
          currency: currencies.length === 1 ? currencies[0] : null,
          ...metricsForProbeScope(accountMetric, 'upstream'),
          available: ledgerEntries.length > 0 ||
            ['succeeded', 'partial'].includes(key.request_log_status),
          unavailableReason: ledgerEntries.length > 0 ||
            ['succeeded', 'partial'].includes(key.request_log_status)
            ? null
            : 'upstream_request_logs_unavailable'
        });
        const metrics = attachQuality({
          ...keyUpstreamMetrics,
          probeCount: keyBaseMetrics.probeCount + keyUpstreamMetrics.probeCount,
          probeSuccessRate: accountMetric.probeSuccessRate,
          intelligenceScore: accountMetric.intelligenceScore,
          instructionScore: accountMetric.instructionScore,
          lastProbeAt: accountMetric.lastProbeAt,
          lastProbeStatus: accountMetric.lastProbeStatus
        });
        const upstreamWindowCash = keyUpstreamMetrics.available
          ? ledgerCash(cashLedgerEntries, 'windowCashCost', 'windowConfirmed')
          : null;
        const upstreamComparableLifetimeCash = keyUpstreamMetrics.available
          ? ledgerCash(
              cashLedgerEntries,
              'lifetimeCashCost',
              'lifetimeComparableConfirmed'
            )
          : null;
        const upstreamReportedLifetimeCash = keyUpstreamMetrics.available
          ? ledgerCash(
              cashLedgerEntries,
              'reportedLifetimeCashCost',
              'reportedLifetimeConfirmed'
            )
          : null;
        const baseWindowCash = baseCashEntries.length > 0
          ? ledgerCash(baseCashEntries, 'windowCashRevenue')
          : attributionComplete ? 0 : null;
        const baseLifetimeCash = baseCashEntries.length > 0
          ? ledgerCash(baseCashEntries, 'lifetimeCashRevenue')
          : attributionComplete ? 0 : null;
        const comparableLifetimeRequestCount = ledgerValue(
          ledgerEntries,
          'lifetimeRequestCount'
        );
        const lifetimeRequestCount = hasReportedCounter
          ? ledgerValue(ledgerEntries, 'reportedLifetimeRequestCount')
          : comparableLifetimeRequestCount;
        const lifetimeCostSamples = ledgerValue(ledgerEntries, 'lifetimeCostSampleCount');
        const unallocatedEntryCount = ledgerValue(ledgerEntries, 'unallocatedEntryCount');
        const counterEntryCount = ledgerValue(ledgerEntries, 'counterEntryCount');
        const requestEntryCount = ledgerValue(ledgerEntries, 'requestEntryCount');
        const accountingMode = counterEntryCount > 0 && requestEntryCount > 0
          ? 'mixed'
          : counterEntryCount > 0 || hasReportedCounter
            ? 'counter_ledger'
            : requestEntryCount > 0 ? 'request_log' : 'unavailable';
        const hasComparableUpstreamWindow = hasWindowAccounting;
        keyUpstreamMetrics.available = hasComparableUpstreamWindow;
        keyUpstreamMetrics.unavailableReason = hasComparableUpstreamWindow
          ? null
          : hasReportedCounter
            ? 'provider_counter_baseline_only'
            : 'upstream_request_logs_unavailable';
        return {
          keyId,
          remoteKeyId: String(key.remote_id),
          name: key.name,
          maskedKey: key.masked_key,
          status: key.status,
          currency: key.currency || metrics.currency || 'USD',
          expiresAt: key.expires_at,
          lastUsedAt: key.last_used_at,
          lastSeenAt: key.last_seen_at,
          mappedAccountCount: accounts.length,
          accounts,
          metrics,
          baseMetrics: keyBaseMetrics,
          upstreamMetrics: keyUpstreamMetrics,
          audit: {
            displayCurrency: auditSettings.displayCurrency,
            upstreamBalanceCurrency: currencies.length === 1 ? currencies[0] : null,
            windowUpstreamCost: upstreamWindowCash,
            lifetimeUpstreamCost: upstreamReportedLifetimeCash,
            comparableLifetimeUpstreamCost: upstreamComparableLifetimeCash,
            windowUpstreamBalanceCost: windowCost,
            lifetimeUpstreamBalanceCost: lifetimeBalanceCost,
            reportedLifetimeUpstreamBalanceCost: reportedLifetimeBalanceCost,
            openingUpstreamBalanceCost: openingBalanceCost,
            windowBaseRevenue: baseWindowCash,
            lifetimeBaseRevenue: baseLifetimeCash,
            windowGrossProfit: baseWindowCash == null || upstreamWindowCash == null
              ? null
              : round(baseWindowCash - upstreamWindowCash, 8),
            lifetimeGrossProfit: baseLifetimeCash == null ||
              upstreamReportedLifetimeCash == null || unallocatedEntryCount > 0
              ? null
              : round(baseLifetimeCash - upstreamReportedLifetimeCash, 8),
            attributedAccountCount: attributedAccountIds.length,
            unattributedAccountCount: mappedAccountIds.length - attributedAccountIds.length,
            attributionComplete,
            lifetimeBaseRequestCount: baseCashEntries.length > 0
              ? ledgerValue(baseCashEntries, 'lifetimeRequestCount')
              : attributionComplete ? 0 : null,
            lifetimeRequestCount,
            comparableLifetimeRequestCount,
            lifetimeCostSampleCount: lifetimeCostSamples,
            accountingMode,
            counterEntryCount,
            requestEntryCount,
            unallocatedEntryCount,
            maximumPrecisionSeconds: ledgerEntries.reduce(
              (maximum, entry) => Math.max(
                maximum,
                finite(entry.maximumPrecisionSeconds) || 0
              ),
              0
            ),
            counterResetCount: ledgerValue(ledgerEntries, 'counterResetCount'),
            counterAccountingStartedAt: latestIso(
              ledgerEntries.map((entry) => entry.counterAccountingStartedAt).filter(Boolean)
                .sort((left, right) => Date.parse(left) - Date.parse(right)).slice(0, 1)
            ),
            counterLastCapturedAt: latestIso(
              ledgerEntries.map((entry) => entry.counterLastCapturedAt)
            ),
            windowSourceMissingCount: ledgerValue(
              ledgerEntries,
              'windowSourceMissingCount'
            ),
            lifetimeSourceMissingCount: ledgerValue(
              ledgerEntries,
              'lifetimeSourceMissingCount'
            ),
            firstObservedAt: latestIso(ledgerEntries.map((entry) => entry.firstAt).filter(Boolean)
              .sort((left, right) => Date.parse(left) - Date.parse(right)).slice(0, 1)),
            lastObservedAt: latestIso(ledgerEntries.map((entry) => entry.lastAt))
          }
        };
      });
      const mappedAccounts = new Map();
      for (const key of providerKeys) {
        for (const account of key.accounts) mappedAccounts.set(account.accountId, account);
      }
      const mappedAccountIds = [...mappedAccounts.keys()];
      const attributedAccountIds = mappedAccountIds.filter((accountId) => {
        const targets = targetsByAccount.get(String(accountId)) || [];
        return targets.length > 0 && targets.every(
          (target) => target.connectionId === providerRow.id
        );
      });
      const providerAttributionComplete = mappedAccountIds.length > 0 &&
        attributedAccountIds.length === mappedAccountIds.length;
      const providerBaseMetricValues = attributedAccountIds.map(
        (accountId) => baseMetrics.get(String(accountId))
      ).filter(Boolean);
      const aggregatedProviderBaseMetrics = aggregateMetrics(providerBaseMetricValues);
      const providerBaseMetrics = attachQuality({
        ...aggregatedProviderBaseMetrics,
        ...metricsForProbeScope(aggregatedProviderBaseMetrics, 'base'),
        requestCount: baseLedgerValue(attributedAccountIds, 'windowRequestCount'),
        available: providerAttributionComplete,
        unavailableReason: providerAttributionComplete
          ? null
          : mappedAccountIds.length === 0
            ? 'base_provider_unmapped'
            : 'base_provider_attribution_incomplete'
      });
      const providerCombinedProbeMetrics = aggregateMetrics(providerBaseMetricValues);
      const aggregatedProviderUpstreamMetrics = aggregateMetrics(
        providerKeys,
        (key) => key.upstreamMetrics
      );
      const providerUpstreamAvailable = providerKeys.some(
        (key) => key.upstreamMetrics.available
      );
      const providerUnavailableReasons = [...new Set(providerKeys
        .map((key) => key.upstreamMetrics.unavailableReason)
        .filter(Boolean))];
      const providerUpstreamMetrics = attachQuality({
        ...aggregatedProviderUpstreamMetrics,
        ...metricsForProbeScope(providerCombinedProbeMetrics, 'upstream'),
        available: providerUpstreamAvailable,
        unavailableReason: providerUpstreamAvailable
          ? null
          : providerUnavailableReasons.length === 1
            ? providerUnavailableReasons[0]
            : 'upstream_request_logs_unavailable'
      });
      const metrics = attachQuality({
        ...providerUpstreamMetrics,
        probeCount: providerBaseMetrics.probeCount + providerUpstreamMetrics.probeCount,
        probeSuccessRate: providerCombinedProbeMetrics.probeSuccessRate,
        intelligenceScore: providerCombinedProbeMetrics.intelligenceScore,
        instructionScore: providerCombinedProbeMetrics.instructionScore,
        lastProbeAt: providerCombinedProbeMetrics.lastProbeAt,
        lastProbeStatus: providerCombinedProbeMetrics.lastProbeStatus
      });
      const providerLedgerEntries = providerKeys.flatMap(
        (key) => providerLedger.get(key.keyId) || []
      );
      const upstreamWindowCost = providerKeys.length === 0 || providerKeys.some(
        (key) => key.audit.windowUpstreamCost == null
      )
        ? null
        : round(providerKeys.reduce(
            (sum, key) => sum + Number(key.audit.windowUpstreamCost || 0),
            0
          ), 8);
      const upstreamLifetimeCost = providerKeys.length === 0 || providerKeys.some(
        (key) => key.audit.lifetimeUpstreamCost == null
      )
        ? null
        : round(providerKeys.reduce(
            (sum, key) => sum + Number(key.audit.lifetimeUpstreamCost || 0),
            0
          ), 8);
      const upstreamWindowBalanceCost = providerKeys.length === 0 || providerKeys.some(
        (key) => key.audit.windowUpstreamBalanceCost == null
      ) ? null : round(providerKeys.reduce(
        (sum, key) => sum + Number(key.audit.windowUpstreamBalanceCost || 0),
        0
      ), 8);
      const reportedLifetimeUpstreamBalanceCost = providerKeys.length === 0 ||
        providerKeys.some((key) => key.audit.reportedLifetimeUpstreamBalanceCost == null)
        ? null
        : round(providerKeys.reduce(
            (sum, key) => sum + Number(key.audit.reportedLifetimeUpstreamBalanceCost || 0),
            0
          ), 8);
      const comparableLifetimeUpstreamBalanceCost = providerKeys.length === 0 ||
        providerKeys.some((key) => key.audit.lifetimeUpstreamBalanceCost == null)
        ? null
        : round(providerKeys.reduce(
            (sum, key) => sum + Number(key.audit.lifetimeUpstreamBalanceCost || 0),
            0
          ), 8);
      const unallocatedEntryCount = providerKeys.reduce(
        (sum, key) => sum + Number(key.audit.unallocatedEntryCount || 0),
        0
      );
      const providerBalanceCurrencies = [...new Set(
        providerKeys.map((key) => key.audit.upstreamBalanceCurrency).filter(Boolean)
      )];
      const attributionComplete = providerAttributionComplete;
      const keyBaseWindowValues = providerKeys.map((key) => key.audit.windowBaseRevenue)
        .filter((value) => value != null);
      const keyBaseLifetimeValues = providerKeys.map((key) => key.audit.lifetimeBaseRevenue)
        .filter((value) => value != null);
      const baseWindowRevenue = keyBaseWindowValues.length > 0
        ? round(keyBaseWindowValues.reduce((sum, value) => sum + Number(value), 0), 8)
        : attributionComplete ? 0 : null;
      const baseLifetimeRevenue = keyBaseLifetimeValues.length > 0
        ? round(keyBaseLifetimeValues.reduce((sum, value) => sum + Number(value), 0), 8)
        : attributionComplete ? 0 : null;
      const rechargeAuditConfigured = providerRow.recharged_amount != null;
      const configuredRecharge = rechargeAuditConfigured
        ? this.#auditAmount(
            providerRow.recharged_amount,
            providerRow.audit_currency || 'USD',
            auditSettings
          )
        : null;
      const lifetimeGrossProfit = baseLifetimeRevenue == null ||
        upstreamLifetimeCost == null || unallocatedEntryCount > 0
        ? null
        : round(baseLifetimeRevenue - upstreamLifetimeCost, 8);
      const windowGrossProfit = baseWindowRevenue == null || upstreamWindowCost == null
        ? null
        : round(baseWindowRevenue - upstreamWindowCost, 8);
      return {
        connectionId: providerRow.id,
        providerName: providerRow.name,
        adapterType: providerRow.adapter_type,
        authMode: providerRow.auth_mode,
        lastSyncAt: providerRow.last_success_at,
        lastErrorCode: providerRow.last_error_code,
        keyCount: providerKeys.length,
        activeKeyCount: providerKeys.filter(
          (key) => ['active', 'enabled', 'healthy'].includes(key.status)
        ).length,
        mappedAccountCount: mappedAccounts.size,
        keys: providerKeys,
        metrics,
        baseMetrics: providerBaseMetrics,
        upstreamMetrics: providerUpstreamMetrics,
        recharge,
        rechargeAudit: {
          configured: rechargeAuditConfigured,
          rechargedAmount: rechargeAuditConfigured ? Number(providerRow.recharged_amount) : null,
          currency: providerRow.audit_currency || 'USD',
          note: providerRow.audit_note || '',
          updatedAt: providerRow.audit_updated_at || null,
          displayAmount: configuredRecharge
        },
        audit: {
          displayCurrency: auditSettings.displayCurrency,
          upstreamBalanceCurrency: providerBalanceCurrencies.length === 1
            ? providerBalanceCurrencies[0]
            : null,
          windowUpstreamCost: upstreamWindowCost,
          lifetimeUpstreamCost: upstreamLifetimeCost,
          windowUpstreamBalanceCost: upstreamWindowBalanceCost,
          lifetimeUpstreamBalanceCost: comparableLifetimeUpstreamBalanceCost,
          reportedLifetimeUpstreamBalanceCost,
          windowBaseRevenue: baseWindowRevenue,
          lifetimeBaseRevenue: baseLifetimeRevenue,
          windowGrossProfit,
          lifetimeGrossProfit,
          lifetimeGrossMarginRatio: baseLifetimeRevenue > 0 && lifetimeGrossProfit != null
            ? round(lifetimeGrossProfit / baseLifetimeRevenue, 6)
            : null,
          fundingDifference: configuredRecharge == null || baseLifetimeRevenue == null
            ? null
            : round(baseLifetimeRevenue - configuredRecharge, 8),
          unconsumedRecharge: configuredRecharge == null || upstreamLifetimeCost == null
            ? null
            : round(configuredRecharge - upstreamLifetimeCost, 8),
          attributedAccountCount: attributedAccountIds.length,
          unattributedAccountCount: mappedAccountIds.length - attributedAccountIds.length,
          attributionComplete,
          accountingMode: providerKeys.some(
            (key) => key.audit.accountingMode === 'mixed'
          ) || new Set(providerKeys.map((key) => key.audit.accountingMode)).size > 1
            ? 'mixed'
            : providerKeys[0]?.audit.accountingMode || 'unavailable',
          counterEntryCount: providerKeys.reduce(
            (sum, key) => sum + Number(key.audit.counterEntryCount || 0),
            0
          ),
          requestEntryCount: providerKeys.reduce(
            (sum, key) => sum + Number(key.audit.requestEntryCount || 0),
            0
          ),
          unallocatedEntryCount,
          maximumPrecisionSeconds: providerKeys.reduce(
            (maximum, key) => Math.max(
              maximum,
              Number(key.audit.maximumPrecisionSeconds || 0)
            ),
            0
          ),
          counterResetCount: providerKeys.reduce(
            (sum, key) => sum + Number(key.audit.counterResetCount || 0),
            0
          ),
          lifetimeBaseRequestCount: providerKeys.some(
            (key) => key.audit.lifetimeBaseRequestCount != null
          ) ? providerKeys.reduce(
              (sum, key) => sum + Number(key.audit.lifetimeBaseRequestCount || 0),
              0
            ) : attributionComplete ? 0 : null,
          lifetimeRequestCount: providerKeys.reduce(
            (sum, key) => sum + Number(key.audit.lifetimeRequestCount || 0),
            0
          ),
          windowSourceMissingCount: providerKeys.reduce(
            (sum, key) => sum + Number(key.audit.windowSourceMissingCount || 0),
            0
          ),
          lifetimeSourceMissingCount: providerKeys.reduce(
            (sum, key) => sum + Number(key.audit.lifetimeSourceMissingCount || 0),
            0
          ),
          firstObservedAt: providerLedgerEntries.map((entry) => entry.firstAt)
            .filter(Boolean).sort((left, right) => Date.parse(left) - Date.parse(right))[0] || null,
          lastObservedAt: latestIso(providerLedgerEntries.map((entry) => entry.lastAt))
        }
      };
    });
    return {
      items,
      itemType: 'provider',
      pagination: { page, pageSize, total, totalPages },
      windowType: windowSelection.type,
      window: {
        from: requestedWindow.from,
        to: requestedWindow.to,
        startDate: requestedWindow.startDate,
        endDate: requestedWindow.endDate
      },
      summary: {
        providerCount: total,
        visibleProviderCount: items.length,
        keyCount: providerRows.reduce((sum, row) => sum + Number(row.key_count || 0), 0),
        visibleKeyCount: items.reduce((sum, item) => sum + item.keyCount, 0),
        mappedAccountCount: new Set(items.flatMap(
          (item) => item.keys.flatMap((key) => key.accounts.map((account) => account.accountId))
        )).size,
        requestCount: items.reduce((sum, item) => sum + Number(item.metrics.requestCount || 0), 0),
        lifetimeRequestCount: items.reduce(
          (sum, item) => sum + Number(item.audit.lifetimeRequestCount || 0),
          0
        ),
        configuredRechargeAmount: items.every(
          (item) => item.rechargeAudit.displayAmount != null
        ) ? round(items.reduce(
            (sum, item) => sum + Number(item.rechargeAudit.displayAmount || 0),
            0
          ), 8) : null,
        lifetimeUpstreamCost: items.every(
          (item) => item.audit.lifetimeUpstreamCost != null
        ) ? round(items.reduce(
            (sum, item) => sum + Number(item.audit.lifetimeUpstreamCost || 0),
            0
          ), 8) : null,
        lifetimeBaseRevenue: items.every(
          (item) => item.audit.lifetimeBaseRevenue != null
        ) ? round(items.reduce(
            (sum, item) => sum + Number(item.audit.lifetimeBaseRevenue || 0),
            0
          ), 8) : null,
        lifetimeGrossProfit: items.every(
          (item) => item.audit.lifetimeGrossProfit != null
        ) ? round(items.reduce(
            (sum, item) => sum + Number(item.audit.lifetimeGrossProfit || 0),
            0
          ), 8) : null,
        supplierLastSyncAt: latestIso(items.map((item) => item.lastSyncAt)),
        displayCurrency: auditSettings.displayCurrency,
        days,
        windowType: windowSelection.type,
        window: {
          from: requestedWindow.from,
          to: requestedWindow.to,
          startDate: requestedWindow.startDate,
          endDate: requestedWindow.endDate
        }
      },
      groups: [],
      platforms: this.db.prepare(`
        SELECT DISTINCT platform FROM sub2api_monitored_accounts
        WHERE missing_since IS NULL ORDER BY platform
      `).all().map((row) => row.platform),
      state: this.state(),
      settings: this.settings()
    };
  }

  accounts(filters = {}) {
    if (filters.display === 'providers') {
      return this.providersView(filters);
    }
    const windowSelection = normalizeAccountMonitorWindowSelection(
      filters.window || filters.timeWindow || filters.period || filters.days,
      this.settings().lookbackDays
    );
    const days = windowSelection.days;
    const requestedWindow = accountMonitorWindow(windowSelection, this.config.timezone);
    const { from: since, to: until } = requestedWindow;
    const candidateRows = this.#accountRows(filters);
    const fallbackGroups = this.#mappedAccountGroups();
    const groupStates = new Map(candidateRows.map((row) => [
      String(row.account_id),
      accountGroupState(row, fallbackGroups)
    ]));
    const groupOptions = accountGroupDefinitions(candidateRows, groupStates);
    const groupId = String(filters.groupId || '').trim();
    const rows = groupId
      ? candidateRows.filter((row) => accountBelongsToGroup(row, groupId, groupStates))
      : candidateRows;
    const accountIds = rows.map((row) => row.account_id);
    const display = filters.display === 'groups' ? 'groups' : 'accounts';
    const requestedSortBy = [
      'name', 'platform', 'status', 'requestCount', 'cacheRate', 'ttftP95Ms',
      'probeSuccessRate', 'intelligenceScore', 'qualityScore', 'lastProbeAt',
      'costDifference', 'accountCount'
    ].includes(filters.sortBy) ? filters.sortBy : 'qualityScore';
    const needsAllComparisons = display === 'groups' || requestedSortBy === 'costDifference';
    const metricMap = this.#metrics(accountIds, since, until);
    const comparisonMap = needsAllComparisons
      ? this.#comparisons(accountIds, since, until)
      : new Map();
    const decorated = rows.map((row) => {
      const metrics = metricMap.get(String(row.account_id));
      const quality = qualityScore(metrics);
      const metadata = parseJson(row.metadata_json, {});
      const groupState = groupStates.get(String(row.account_id));
      return {
        accountId: row.account_id,
        name: row.name,
        platform: row.platform,
        accountType: row.account_type,
        status: row.status,
        schedulable: Boolean(row.schedulable),
        priority: row.priority,
        concurrency: row.concurrency,
        rateMultiplier: row.rate_multiplier,
        groups: groupState.groups,
        groupAssociationsKnown: groupState.known,
        groupAssociationSource: groupState.source,
        metadata,
        lastSeenAt: row.last_seen_at,
        metrics: { ...metrics, qualityScore: quality.score, quality },
        comparison: comparisonMap.get(String(row.account_id)) || null
      };
    });
    const sortBy = requestedSortBy === 'accountCount' ? 'qualityScore' : requestedSortBy;
    const order = filters.order === 'asc' ? 1 : -1;
    decorated.sort((left, right) => {
      const leftComparisonMetric = sortBy === 'requestCount'
        ? left.comparison?.windowTotals?.base?.requestCount
        : left.comparison?.base?.[sortBy];
      const rightComparisonMetric = sortBy === 'requestCount'
        ? right.comparison?.windowTotals?.base?.requestCount
        : right.comparison?.base?.[sortBy];
      const leftValue = ['name', 'platform', 'status'].includes(sortBy)
        ? left[sortBy]
        : sortBy === 'costDifference'
          ? left.comparison?.cost?.differenceAmount
          : leftComparisonMetric ?? left.metrics[sortBy];
      const rightValue = ['name', 'platform', 'status'].includes(sortBy)
        ? right[sortBy]
        : sortBy === 'costDifference'
          ? right.comparison?.cost?.differenceAmount
          : rightComparisonMetric ?? right.metrics[sortBy];
      if (leftValue == null && rightValue == null) return left.name.localeCompare(right.name);
      if (leftValue == null) return 1;
      if (rightValue == null) return -1;
      if (typeof leftValue === 'string') return leftValue.localeCompare(rightValue) * order;
      return (Number(leftValue) - Number(rightValue)) * order;
    });
    const grouped = display === 'groups'
      ? sortAccountGroups(
          aggregateAccountGroups(decorated).filter(
            (group) => !groupId || group.groupId === groupId
          ),
          requestedSortBy,
          filters.order
        )
      : [];
    const collection = display === 'groups' ? grouped : decorated;
    const pageSize = clamp(integer(filters.pageSize, 50), 10, 200);
    const total = collection.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = clamp(integer(filters.page, 1), 1, totalPages);
    const offset = (page - 1) * pageSize;
    const items = collection.slice(offset, offset + pageSize);
    if (display === 'accounts' && !needsAllComparisons) {
      const visibleComparisons = this.#comparisons(
        items.map((item) => item.accountId),
        since,
        until
      );
      for (const item of items) {
        item.comparison = visibleComparisons.get(String(item.accountId)) || null;
      }
    }
    const promptTokens = decorated.reduce((sum, item) => sum + item.metrics.inputTokens +
      item.metrics.cacheCreationTokens + item.metrics.cacheReadTokens, 0);
    const cacheReadTokens = decorated.reduce((sum, item) => sum + item.metrics.cacheReadTokens, 0);
    const requestCount = decorated.reduce((sum, item) => sum + item.metrics.requestCount, 0);
    const probes = decorated.reduce((sum, item) => sum + item.metrics.probeCount, 0);
    const successfulProbes = decorated.reduce((sum, item) => sum +
      (item.metrics.probeSuccessRate == null ? 0 : item.metrics.probeCount * item.metrics.probeSuccessRate / 100), 0);
    const capabilityItems = decorated.filter((item) => item.metrics.intelligenceScore != null);
    const comparisonItems = display === 'accounts' && !needsAllComparisons
      ? items
      : decorated;
    const mappedItems = comparisonItems.filter((item) => item.comparison?.status === 'mapped');
    const supplierLogItems = mappedItems.filter((item) => item.comparison.source === 'provider_request_logs');
    const pairedItems = supplierLogItems.filter((item) => item.comparison.pairing?.matchedCount > 0);
    const comparableCostItems = mappedItems.filter((item) => item.comparison.cost?.windowComparable);
    return {
      items,
      itemType: display === 'groups' ? 'group' : 'account',
      pagination: { page, pageSize, total, totalPages },
      windowType: windowSelection.type,
      window: {
        from: requestedWindow.from,
        to: requestedWindow.to,
        startDate: requestedWindow.startDate,
        endDate: requestedWindow.endDate
      },
      summary: {
        accountCount: decorated.length,
        filteredAccountCount: decorated.length,
        groupCount: groupOptions.length,
        baseGroupCount: groupOptions.filter(
          (item) => item.id !== UNGROUPED_GROUP_ID && item.id !== GROUPS_PENDING_GROUP_ID
        ).length,
        ungroupedAccountCount: groupOptions.find(
          (item) => item.id === UNGROUPED_GROUP_ID
        )?.accountCount || 0,
        pendingGroupAccountCount: decorated.filter(
          (item) => !item.groupAssociationsKnown
        ).length,
        mappingCachedGroupAccountCount: decorated.filter(
          (item) => !item.groupAssociationsKnown && item.groups.length > 0
        ).length,
        groupMembershipCount: groupOptions.reduce((sum, item) => sum + item.accountCount, 0),
        platformCount: new Set(decorated.map((item) => item.platform)).size,
        requestCount,
        cacheRate: promptTokens > 0 ? round(cacheReadTokens / promptTokens * 100, 1) : null,
        probeSuccessRate: probes > 0 ? round(successfulProbes / probes * 100, 1) : null,
        intelligenceScore: capabilityItems.length > 0
          ? round(capabilityItems.reduce((sum, item) => sum + item.metrics.intelligenceScore, 0) / capabilityItems.length, 1)
          : null,
        capabilityAccountCount: capabilityItems.length,
        mappedAccountCount: mappedItems.length,
        supplierLogAccountCount: supplierLogItems.length,
        pairedAccountCount: pairedItems.length,
        upstreamExtraRequestCount: pairedItems.reduce(
          (sum, item) => sum + Number(item.comparison.pairing?.upstreamExtraCount || 0),
          0
        ),
        comparableCostAccountCount: comparableCostItems.length,
        supplierLastSyncAt: latestIso(mappedItems.map((item) => item.comparison.provider?.lastSyncAt)),
        comparisonScope: display === 'accounts' && !needsAllComparisons ? 'page' : 'filtered',
        comparisonAccountCount: comparisonItems.length,
        days,
        windowType: windowSelection.type,
        window: {
          from: requestedWindow.from,
          to: requestedWindow.to,
          startDate: requestedWindow.startDate,
          endDate: requestedWindow.endDate
        }
      },
      groups: groupOptions,
      platforms: this.db.prepare(`
        SELECT DISTINCT platform FROM sub2api_monitored_accounts
        WHERE missing_since IS NULL ORDER BY platform
      `).all().map((row) => row.platform),
      state: this.state(),
      settings: this.settings()
    };
  }

  account(accountId, options = {}) {
    const row = this.db.prepare(
      'SELECT * FROM sub2api_monitored_accounts WHERE account_id = ?'
    ).get(String(accountId));
    if (!row) throw new AppError('ACCOUNT_NOT_FOUND', 'Sub2API account was not found', { status: 404 });
    const windowSelection = normalizeAccountMonitorWindowSelection(
      options.window || options.timeWindow || options.period || options.days,
      this.settings().lookbackDays
    );
    const days = windowSelection.days;
    const requestedWindow = accountMonitorWindow(windowSelection, this.config.timezone);
    const { from: since, to: until } = requestedWindow;
    const metrics = this.#metrics([String(accountId)], since, until).get(String(accountId));
    const comparison = this.#comparisons([String(accountId)], since, until).get(String(accountId));
    const quality = qualityScore(metrics);
    const trendFrom = comparison?.window?.from || since;
    const trendTo = comparison?.window?.to || until;
    const trends = this.db.prepare(`
      SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS requests,
        AVG(CASE WHEN stream = 1 AND first_token_ms > 0 THEN first_token_ms END) AS ttft_ms,
        AVG(duration_ms) AS duration_ms,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(COALESCE(actual_cost, 0)) AS cost
      FROM sub2api_account_request_samples
      WHERE account_id = ? AND created_at >= ? AND created_at <= ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day
    `).all(String(accountId), trendFrom, trendTo).map((item) => {
      const promptTokens = integer(item.input_tokens) + integer(item.cache_creation_tokens) + integer(item.cache_read_tokens);
      return {
        day: item.day,
        requests: item.requests,
        ttftMs: round(finite(item.ttft_ms), 0),
        durationMs: round(finite(item.duration_ms), 0),
        cacheRate: promptTokens > 0 ? round(integer(item.cache_read_tokens) / promptTokens * 100, 1) : null,
        cost: round(finite(item.cost) || 0, 8)
      };
    });
    const probes = this.runs({ accountId, limit: 50 }).items;
    const metadata = parseJson(row.metadata_json, {});
    const groupState = accountGroupState(row, this.#mappedAccountGroups());
    return {
      account: {
        accountId: row.account_id,
        name: row.name,
        platform: row.platform,
        accountType: row.account_type,
        status: row.status,
        schedulable: Boolean(row.schedulable),
        priority: row.priority,
        concurrency: row.concurrency,
        rateMultiplier: row.rate_multiplier,
        groups: groupState.groups,
        groupAssociationsKnown: groupState.known,
        groupAssociationSource: groupState.source,
        metadata,
        lastSeenAt: row.last_seen_at
      },
      metrics: { ...metrics, qualityScore: quality.score, quality },
      comparison,
      trends,
      upstreamTrends: this.#upstreamTrends(comparison, trendFrom, trendTo),
      probes,
      days,
      windowType: windowSelection.type,
      window: {
        from: requestedWindow.from,
        to: requestedWindow.to,
        startDate: requestedWindow.startDate,
        endDate: requestedWindow.endDate
      },
      requestedWindow: { from: since, to: until },
      comparisonWindow: { from: trendFrom, to: trendTo }
    };
  }

  runs(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.accountId != null) {
      clauses.push('p.account_id = ?');
      params.push(String(filters.accountId));
    }
    if (filters.batchId) {
      clauses.push('p.batch_id = ?');
      params.push(String(filters.batchId));
    }
    const limit = clamp(integer(filters.limit, 100), 1, 500);
    const rows = this.db.prepare(`
      SELECT p.*, a.name AS account_name, a.platform
      FROM sub2api_account_probe_runs p
      JOIN sub2api_monitored_accounts a ON a.account_id = p.account_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY p.completed_at DESC, p.id DESC LIMIT ?
    `).all(...params, limit);
    return {
      items: rows.map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        accountId: row.account_id,
        accountName: row.account_name,
        platform: row.platform,
        triggerType: row.trigger_type,
        suite: row.suite,
        model: row.model,
        status: row.status,
        intelligenceScore: row.intelligence_score,
        instructionScore: row.instruction_score,
        firstTokenMs: row.first_token_ms,
        durationMs: row.duration_ms,
        responseExcerpt: row.response_excerpt,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        details: parseJson(row.details_json, {}),
        startedAt: row.started_at,
        completedAt: row.completed_at
      }))
    };
  }

  #probeRows(options = {}) {
    const settings = this.settings();
    let rows;
    const requestedIds = [...new Set((options.accountIds || []).map(String).filter(Boolean))];
    if (requestedIds.length > 0) {
      const selected = [];
      for (const batch of chunks(requestedIds)) {
        const placeholders = batch.map(() => '?').join(',');
        selected.push(...this.db.prepare(`
          SELECT * FROM sub2api_monitored_accounts
          WHERE account_id IN (${placeholders}) AND missing_since IS NULL
        `).all(...batch));
      }
      rows = selected;
    } else {
      const platforms = (options.platforms?.length ? options.platforms :
        options.triggerType === 'scheduled' ? settings.probePlatforms : [])
        .map(normalizePlatform).filter(Boolean);
      const clauses = ["missing_since IS NULL", "status NOT IN ('disabled', 'inactive')"];
      const params = [];
      if (platforms.length > 0) {
        clauses.push(`platform IN (${platforms.map(() => '?').join(',')})`);
        params.push(...platforms);
      }
      rows = this.db.prepare(`
        SELECT * FROM sub2api_monitored_accounts
        WHERE ${clauses.join(' AND ')}
        ORDER BY platform, name
        LIMIT ${ACCOUNT_LIMIT}
      `).all(...params);
    }
    if (rows.length === 0) {
      throw new AppError('ACCOUNT_SELECTION_EMPTY', 'No Sub2API accounts matched the probe scope', {
        status: 409
      });
    }
    return rows;
  }

  #translateAccountExportError(error) {
    const remoteCode = String(error?.details?.remoteCode || '');
    const remoteStatus = Number(error?.details?.remoteStatus || error?.status) || null;
    if (remoteCode === 'STEP_UP_REQUIRED') {
      return new AppError(
        'SUB2API_STEP_UP_REQUIRED',
        'Sub2API requires recent TOTP verification before account API keys can be used for capability probes',
        { status: 403, details: { remoteCode, remoteStatus: remoteStatus || 403 } }
      );
    }
    if (['STEP_UP_TOTP_NOT_ENABLED', 'TOTP_NOT_SETUP'].includes(remoteCode)) {
      return new AppError(
        'SUB2API_TOTP_NOT_ENABLED',
        'TOTP must be enabled for the Sub2API administrator before API-key capability probes can run',
        { status: 409, details: { remoteCode, remoteStatus: remoteStatus || 403 } }
      );
    }
    if (remoteCode === 'STEP_UP_ADMIN_API_KEY_FORBIDDEN') {
      return new AppError(
        'SUB2API_SSO_REQUIRED',
        'A Sub2API administrator SSO session is required for API-key capability probes',
        { status: 409, details: { remoteCode, remoteStatus: remoteStatus || 403 } }
      );
    }
    if (remoteCode === 'STEP_UP_UNAVAILABLE') {
      return new AppError(
        'SUB2API_STEP_UP_UNAVAILABLE',
        'Sub2API step-up verification is temporarily unavailable',
        { status: 503, retryable: true, details: { remoteCode, remoteStatus: remoteStatus || 503 } }
      );
    }
    if (Number(error?.status) === 403) {
      return new AppError(
        'SUB2API_KEY_EXPORT_FORBIDDEN',
        'Sub2API requires a recent two-factor verified administrator session for API-key capability probes',
        { status: 403, details: { remoteStatus: 403 } }
      );
    }
    if ([404, 405, 501].includes(Number(error?.status))) {
      return new AppError(
        'SUB2API_KEY_EXPORT_UNSUPPORTED',
        'This Sub2API version does not expose the administrator account export endpoint',
        { status: 409, details: { remoteStatus: Number(error?.status) } }
      );
    }
    return error;
  }

  async #requestProbeCredentialExport(rows) {
    let payload;
    try {
      payload = await this.sub2api.data('/api/v1/admin/accounts/data', {
        query: {
          ids: rows.map((account) => account.account_id).join(','),
          include_proxies: true
        }
      });
    } catch (error) {
      throw this.#translateAccountExportError(error);
    }
    const exported = payload?.accounts;
    if (!Array.isArray(exported) || exported.length !== rows.length) {
      throw new AppError('SCHEMA_MISMATCH', 'Sub2API account export did not preserve the requested account set', {
        status: 502,
        details: { requested: rows.length, received: Array.isArray(exported) ? exported.length : null }
      });
    }
    payload = null;
    return exported;
  }

  #captureProbeCredential(credentialsByAccount, source, item) {
    if (
      normalizePlatform(item?.platform) !== normalizePlatform(source.platform) ||
      String(item?.type || '').toLowerCase() !== String(source.account_type || '').toLowerCase()
    ) {
      throw new AppError('SCHEMA_MISMATCH', 'Sub2API account export did not match the requested account', {
        status: 502,
        details: { accountId: source.account_id }
      });
    }
    const apiKey = String(item?.credentials?.api_key || '').trim();
    if (!apiKey) return;
    credentialsByAccount.set(String(source.account_id), {
      apiKey,
      baseUrl: String(item.credentials?.base_url || 'https://api.openai.com').trim(),
      responsesSupported: item?.extra?.openai_responses_supported !== false,
      proxyConfigured: Boolean(item?.proxy_key)
    });
  }

  async #exportProbeCredentials(rows) {
    const credentialsByAccount = new Map();
    for (let offset = 0; offset < rows.length; offset += 50) {
      const batch = rows.slice(offset, offset + 50);
      const exported = await this.#requestProbeCredentialExport(batch);
      const sourceGroups = groupBy(batch, accountExportSignature);
      const exportedGroups = groupBy(exported, accountExportSignature);
      const matchedAccountIds = new Set();
      for (const [signature, sources] of sourceGroups) {
        const items = exportedGroups.get(signature) || [];
        // Duplicate names cannot be associated with IDs safely because the export DTO omits IDs.
        if (sources.length !== 1 || items.length !== 1) continue;
        const source = sources[0];
        this.#captureProbeCredential(credentialsByAccount, source, items[0]);
        matchedAccountIds.add(String(source.account_id));
      }
      for (const source of batch) {
        if (matchedAccountIds.has(String(source.account_id))) continue;
        const exact = await this.#requestProbeCredentialExport([source]);
        if (exact.length !== 1) {
          throw new AppError('SCHEMA_MISMATCH', 'Sub2API account export did not preserve the requested account set', {
            status: 502,
            details: { requested: 1, received: exact.length }
          });
        }
        this.#captureProbeCredential(credentialsByAccount, source, exact[0]);
      }
    }
    return credentialsByAccount;
  }

  async prepareProbe(options = {}) {
    if (!this.http) return { ...options };
    const rows = this.#probeRows(options);
    const eligible = rows.filter((row) =>
      normalizePlatform(row.platform) === 'openai' &&
      String(row.account_type || '').toLowerCase() === 'apikey'
    );
    if (eligible.length === 0) return { ...options };
    const now = Date.now();
    for (const [ticket, entry] of this.probeCredentials) {
      if (entry.expiresAt <= now) this.probeCredentials.delete(ticket);
    }
    const ticket = crypto.randomUUID();
    this.probeCredentials.set(ticket, {
      expiresAt: now + PROBE_CREDENTIAL_TTL_MS,
      accounts: await this.#exportProbeCredentials(eligible)
    });
    return { ...options, credentialTicket: ticket };
  }

  #credentialsForTicket(ticket) {
    if (!ticket) return null;
    const entry = this.probeCredentials.get(String(ticket));
    if (!entry || entry.expiresAt <= Date.now()) {
      this.probeCredentials.delete(String(ticket));
      return null;
    }
    return entry.accounts;
  }

  async probe(options = {}) {
    const settings = this.settings();
    const rows = this.#probeRows(options);
    const probeCredentials = this.#credentialsForTicket(options.credentialTicket);
    const batchId = crypto.randomUUID();
    const triggerType = options.triggerType === 'scheduled' ? 'scheduled' : 'manual';
    const concurrency = clamp(integer(options.concurrency, settings.probeConcurrency), 1, 10);
    const results = new Array(rows.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (cursor < rows.length) {
        const index = cursor;
        cursor += 1;
        const row = rows[index];
        const configuredModel = settings.probeModels[normalizePlatform(row.platform)] || '';
        results[index] = await this.#probeOne(row, {
          batchId,
          triggerType,
          model: String(options.model || configuredModel || '').trim(),
          credential: probeCredentials?.get(String(row.account_id)) || null
        });
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      if (options.credentialTicket) this.probeCredentials.delete(String(options.credentialTicket));
    }
    const completedAt = nowIso();
    this.db.prepare(`
      UPDATE sub2api_account_monitor_state SET last_probe_at = ?, updated_at = ? WHERE id = 1
    `).run(completedAt, completedAt);
    return {
      batchId,
      triggerType,
      accountCount: rows.length,
      succeeded: results.filter((item) => item.status === 'succeeded').length,
      failed: results.filter((item) => item.status !== 'succeeded').length,
      results
    };
  }

  async #directOpenAiCapability(credential, model, prompt) {
    const order = credential.responsesSupported
      ? ['responses', 'chat_completions']
      : ['chat_completions', 'responses'];
    let lastError;
    for (let index = 0; index < order.length; index += 1) {
      const capability = order[index];
      const body = capability === 'responses'
        ? {
            model,
            input: [{
              role: 'user',
              content: [{ type: 'input_text', text: prompt }]
            }],
            stream: false
          }
        : {
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false
          };
      try {
        const result = await this.http.requestJson(
          openAiEndpoint(credential.baseUrl, capability === 'responses' ? 'responses' : 'chat'),
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential.apiKey}`
            },
            body,
            timeoutMs: 120000,
            maxResponseBytes: Math.min(this.config.maxResponseBytes, 2 * 1024 * 1024),
            maxRedirects: 0,
            retries: 0
          }
        );
        const responseText = responseTextFromOpenAi(result.data);
        if (!responseText) {
          throw new AppError('INCOMPLETE_PROBE', 'OpenAI-compatible capability probe returned no text', {
            status: 502
          });
        }
        return {
          responseText: responseText.slice(0, 4000),
          model: String(result.data?.model || model),
          capability
        };
      } catch (error) {
        lastError = error;
        if (index === order.length - 1 || !canTryAlternateOpenAiEndpoint(error)) throw error;
      }
    }
    throw lastError;
  }

  async #probeOne(account, options) {
    const startedAt = nowIso();
    const started = performance.now();
    const platform = normalizePlatform(account.platform);
    const capabilitySupported = CAPABILITY_PLATFORMS.has(platform);
    let suite = capabilitySupported ? 'capability_v2' : 'connectivity_v1';
    const challengeDefinition = capabilitySupported
      ? createCapabilityChallenge(`${options.batchId}:${account.account_id}`)
      : null;
    let firstTokenMs = null;
    let responseText = '';
    let remoteModel = options.model || '';
    let completed = false;
    let eventCount = 0;
    let status = 'succeeded';
    let errorCode = null;
    let errorMessage = null;
    let challenge = null;
    let challengeExecuted = capabilitySupported;
    let unscoredReason = null;
    let transport = 'sub2api_account_test';
    let directCapability = null;
    const canProbeDirectly = platform === 'openai' &&
      String(account.account_type || '').toLowerCase() === 'apikey' &&
      options.credential && !options.credential.proxyConfigured && Boolean(options.model);
    const directUnavailableReason = platform === 'openai' && options.credential?.proxyConfigured
      ? 'account_proxy_configured'
      : platform === 'openai' && options.credential && !options.model
        ? 'probe_model_not_configured'
        : null;
    try {
      if (canProbeDirectly) {
        transport = 'direct_api_key';
        const direct = await this.#directOpenAiCapability(
          options.credential,
          options.model,
          challengeDefinition.prompt
        );
        responseText = direct.responseText;
        remoteModel = direct.model;
        directCapability = direct.capability;
        eventCount = 1;
        completed = true;
      } else {
        await this.sub2api.sse(`/api/v1/admin/accounts/${encodeURIComponent(account.account_id)}/test`, {
          method: 'POST',
          timeoutMs: 120000,
          body: {
            model_id: options.model || '',
            prompt: challengeDefinition?.prompt || '',
            mode: ''
          },
          onEvent: (event) => {
            eventCount += 1;
            if (event?.type === 'test_start' && event.model) remoteModel = String(event.model);
            if (event?.type === 'content' && event.text) {
              if (firstTokenMs == null) firstTokenMs = Math.round(performance.now() - started);
              responseText += String(event.text);
              if (responseText.length > 4000) responseText = responseText.slice(0, 4000);
            }
            if (event?.type === 'error') {
              errorCode = String(event.code || 'UPSTREAM_TEST_FAILED');
              errorMessage = String(event.error || event.text || 'Sub2API account test failed');
            }
            if (event?.type === 'test_complete' && event.success !== false) completed = true;
          }
        });
      }
      if (errorMessage || !completed) {
        throw new AppError(
          errorCode || 'INCOMPLETE_PROBE',
          errorMessage || 'Sub2API account test ended without a completion event',
          { status: 502 }
        );
      }
      if (capabilitySupported) {
        const scored = scoreCapabilityChallenge(challengeDefinition, responseText);
        const promptWasNotForwarded = platform === 'openai' &&
          transport === 'sub2api_account_test' &&
          !scored.parsed && isDefaultConnectivityGreeting(responseText);
        if (promptWasNotForwarded) {
          suite = 'capability_v2_unexecuted';
          challengeExecuted = false;
          unscoredReason = 'sub2api_prompt_not_forwarded';
        } else {
          challenge = scored;
        }
      }
    } catch (error) {
      status = 'failed';
      errorCode = String(error?.code || errorCode || 'PROBE_FAILED');
      errorMessage = redactText(error?.message || errorMessage || error).slice(0, 1000);
    }
    const completedAt = nowIso();
    const durationMs = Math.round(performance.now() - started);
    const id = crypto.randomUUID();
    const excerpt = responseText
      ? redactText(responseText).replace(/\s+/g, ' ').trim().slice(0, 500)
      : null;
    const details = {
      capabilitySupported,
      benchmark: capabilitySupported ? 'local_capability_v2' : 'connectivity_v1',
      challengeVersion: challengeDefinition?.version || null,
      challengeId: challengeDefinition?.id || null,
      challengeTasks: challengeDefinition?.tasks || null,
      challengeExpected: challengeDefinition?.expected || null,
      challengeAnswers: challenge?.answers || null,
      exactInstructionMatch: challenge?.exact || false,
      challengeExecuted,
      unscoredReason,
      transport,
      directCapability,
      directUnavailableReason,
      eventCount
    };
    this.db.prepare(`
      INSERT INTO sub2api_account_probe_runs(
        id, batch_id, account_id, trigger_type, suite, model, status,
        intelligence_score, instruction_score, first_token_ms, duration_ms,
        response_excerpt, error_code, error_message, details_json, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, options.batchId, String(account.account_id), options.triggerType, suite,
      remoteModel || null, status, challenge?.intelligenceScore ?? null,
      challenge?.instructionScore ?? null, firstTokenMs, durationMs, excerpt,
      errorCode, errorMessage, stringifyJson(details), startedAt, completedAt
    );
    return {
      id,
      batchId: options.batchId,
      accountId: String(account.account_id),
      accountName: account.name,
      platform,
      triggerType: options.triggerType,
      suite,
      model: remoteModel || null,
      status,
      intelligenceScore: challenge?.intelligenceScore ?? null,
      instructionScore: challenge?.instructionScore ?? null,
      firstTokenMs,
      durationMs,
      responseExcerpt: excerpt,
      errorCode,
      errorMessage,
      details,
      startedAt,
      completedAt
    };
  }
}

module.exports = {
  AccountMonitorService,
  CHALLENGE_PROMPT,
  CHALLENGE_EXPECTED,
  createCapabilityChallenge,
  scoreCapabilityChallenge,
  normalizeAccount,
  normalizeAccountGroups,
  normalizeUsageSample,
  normalizeAccountMonitorWindowSelection,
  accountMonitorWindow,
  aggregateAccountGroups,
  requestPairingTrust,
  scoreChallenge,
  qualityScore
};
