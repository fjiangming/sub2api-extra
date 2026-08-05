const crypto = require('crypto');
const { AppError } = require('../errors');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { redactText } = require('../security/redaction');

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

function normalizeAccount(account) {
  const accountId = account?.id ?? account?.account_id;
  if (accountId == null || String(accountId).trim() === '') return null;
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
  }

  settings() {
    const row = this.db.prepare('SELECT * FROM sub2api_account_monitor_settings WHERE id = 1').get();
    return {
      syncEnabled: Boolean(row.sync_enabled),
      syncIntervalMinutes: row.sync_interval_minutes,
      lookbackDays: row.lookback_days,
      sampleRetentionDays: row.sample_retention_days,
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
        sync_enabled = ?, sync_interval_minutes = ?, lookback_days = ?,
        sample_retention_days = ?, probe_enabled = ?, probe_interval_minutes = ?,
        probe_platforms_json = ?, probe_models_json = ?, probe_concurrency = ?, updated_at = ?
      WHERE id = 1
    `).run(
      next.syncEnabled ? 1 : 0,
      integer(next.syncIntervalMinutes, 15),
      integer(next.lookbackDays, 7),
      integer(next.sampleRetentionDays, 30),
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

  async sync(options = {}) {
    const startedAt = nowIso();
    const settings = this.settings();
    try {
      const accountResult = await this.sub2api.listAll(
        '/api/v1/admin/accounts',
        options.platform ? { platform: normalizePlatform(options.platform) } : {},
        { maxItems: 50000 }
      );
      const accounts = accountResult.items.map(normalizeAccount).filter(Boolean);
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
        if (!options.platform && !accountResult.truncated) {
          this.db.prepare(`
            UPDATE sub2api_monitored_accounts
            SET missing_since = COALESCE(missing_since, ?)
          `).run(now);
        }
        for (const account of accounts) {
          upsertAccount.run(
            account.accountId, account.name, account.platform, account.accountType,
            account.status, account.schedulable ? 1 : 0, account.priority,
            account.concurrency, account.rateMultiplier, stringifyJson(account.metadata),
            now, now
          );
        }
      })();

      const lookbackDays = clamp(integer(options.lookbackDays, settings.lookbackDays), 1, 90);
      const oldestAllowed = Date.now() - lookbackDays * 86400000;
      const latest = this.db.prepare('SELECT MAX(created_at) AS value FROM sub2api_account_request_samples').get()?.value;
      const incrementalStart = latest ? Date.parse(latest) - 86400000 : oldestAllowed;
      const startAt = new Date(Math.max(oldestAllowed, Number.isFinite(incrementalStart) ? incrementalStart : oldestAllowed));
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
      let fetchedSampleCount = 0;
      let insertedSamples = 0;
      const truncatedDates = [];
      const startDate = dateInTimezone(startAt, this.config.timezone);
      const endDate = dateInTimezone(new Date(), this.config.timezone);
      for (const date of dateKeysBetween(startDate, endDate)) {
        const usageResult = await this.sub2api.listAll('/api/v1/admin/usage', {
          start_date: date,
          end_date: date,
          timezone: this.config.timezone,
          sort_by: 'created_at',
          sort_order: 'desc'
        }, { maxItems: 50000 });
        const samples = usageResult.items.map(normalizeUsageSample).filter(Boolean);
        fetchedSampleCount += samples.length;
        if (usageResult.truncated) truncatedDates.push(date);
        this.db.transaction(() => {
          for (const sample of samples) {
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
            insertedSamples += result.changes;
          }
        })();
      }
      const cleanup = this.cleanup();
      const completedAt = nowIso();
      const summary = {
        accountCount: accounts.length,
        accountCatalogTruncated: Boolean(accountResult.truncated),
        fetchedSampleCount,
        storedSampleChanges: insertedSamples,
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
      clauses.push('(LOWER(name) LIKE ? OR account_id LIKE ?)');
      const query = `%${String(filters.search).trim().toLowerCase()}%`;
      params.push(query, query);
    }
    return this.db.prepare(`
      SELECT * FROM sub2api_monitored_accounts
      WHERE ${clauses.join(' AND ')}
      ORDER BY name COLLATE NOCASE, account_id
      LIMIT ${ACCOUNT_LIMIT}
    `).all(...params);
  }

  #metrics(accountIds, since) {
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
        WHERE account_id IN (${placeholders}) AND created_at >= ?
        GROUP BY account_id
      `).all(...batch, since);
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
          WHERE account_id IN (${placeholders}) AND created_at >= ?
        )
        SELECT account_id, stream, first_token_ms, duration_ms FROM recent
        WHERE row_number <= ${DISTRIBUTION_SAMPLE_LIMIT}
      `).all(...batch, since);
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
          WHERE account_id IN (${placeholders}) AND completed_at >= ?
        )
        SELECT * FROM recent WHERE row_number <= ${PROBE_SAMPLE_LIMIT}
        ORDER BY completed_at DESC
      `).all(...batch, since);
      const probeGroups = new Map();
      for (const row of probes) {
        const accountId = String(row.account_id);
        const group = probeGroups.get(accountId) || [];
        group.push(row);
        probeGroups.set(accountId, group);
      }
      for (const [accountId, rows] of probeGroups) {
        const item = metrics.get(accountId);
        item.probeCount = rows.length;
        item.probeSuccessRate = round(
          rows.filter((row) => row.status === 'succeeded').length / rows.length * 100,
          1
        );
        const intelligence = rows.map((row) => finite(row.intelligence_score)).filter((value) => value != null);
        const instruction = rows.map((row) => finite(row.instruction_score)).filter((value) => value != null);
        item.intelligenceScore = intelligence.length > 0
          ? round(intelligence.reduce((sum, value) => sum + value, 0) / intelligence.length, 1)
          : null;
        item.instructionScore = instruction.length > 0
          ? round(instruction.reduce((sum, value) => sum + value, 0) / instruction.length, 1)
          : null;
        item.lastProbeAt = rows[0].completed_at;
        item.lastProbeStatus = rows[0].status;
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
          m.connection_id, m.key_id, m.role, m.updated_at AS mapping_updated_at,
          c.name AS provider_name, c.adapter_type, c.last_success_at,
          c.last_error_code, k.name AS key_name, k.remote_id AS remote_key_id,
          k.currency, k.status AS key_status,
          (SELECT COUNT(DISTINCT CAST(shared.account_id AS TEXT))
            FROM sub2api_mappings shared
            WHERE shared.enabled = 1 AND shared.key_id = m.key_id
          ) AS shared_account_count,
          s.status AS request_log_status, s.coverage_from, s.coverage_to,
          s.truncated AS request_log_truncated, s.total_count AS request_log_total,
          s.last_error_code AS request_log_error_code,
          s.last_synced_at AS request_log_synced_at
        FROM sub2api_mappings m
        JOIN provider_connections c ON c.id = m.connection_id
        LEFT JOIN remote_keys k ON k.id = m.key_id
        LEFT JOIN provider_request_log_sync_state s ON s.connection_id = m.connection_id
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

  #snapshotDeltas(keyIds, since, until) {
    const usageRows = [];
    const balanceRows = [];
    for (const batch of chunks(keyIds)) {
      const placeholders = batch.map(() => '?').join(',');
      usageRows.push(...this.db.prepare(`
        SELECT subject_id AS key_id, currency, cost, requests, input_tokens,
          output_tokens, total_tokens, captured_at
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
      balanceRows.push(...this.db.prepare(`
        SELECT subject_id AS key_id, currency, used, captured_at
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
    }

    const reduceRows = (rows, type) => {
      const byKeyAndCurrency = groupBy(rows, (row) => `${row.key_id}\u0000${row.currency}`);
      const candidates = new Map();
      for (const entries of byKeyAndCurrency.values()) {
        if (entries.length < 2) continue;
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
              totalTokens: cumulativeDelta(entries, 'total_tokens'),
              from: entries[0].captured_at,
              to: entries.at(-1).captured_at,
              sampleCount: entries.length
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
              sampleCount: entries.length
            };
        const current = candidates.get(keyId);
        if (!current || value.sampleCount > current.sampleCount) candidates.set(keyId, value);
      }
      return candidates;
    };
    return {
      usage: reduceRows(usageRows, 'usage'),
      balance: reduceRows(balanceRows, 'balance')
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

  #comparisons(accountIds, since, until = nowIso()) {
    const comparisonByAccount = new Map(accountIds.map((accountId) => [String(accountId), {
      status: 'unmapped',
      source: 'unavailable',
      provider: null,
      targets: [],
      upstream: null,
      coverage: null,
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
    const requestMetrics = this.#providerRequestMetrics(ids, since, until);
    const snapshots = this.#snapshotDeltas(ids, since, until);
    const staleBefore = Date.now() - Number(this.config.staleAfterMinutes || 60) * 60000;

    for (const accountId of accountIds.map(String)) {
      const targets = targetsByAccount.get(accountId) || [];
      if (targets.length === 0) continue;
      const publicTargets = targets.map((target) => ({
        connectionId: target.connection_id,
        providerName: target.provider_name,
        adapterType: target.adapter_type,
        keyId: target.key_id,
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
          }
        });
        continue;
      }

      const target = targets[0];
      const provider = {
        connectionId: target.connection_id,
        name: target.provider_name,
        adapterType: target.adapter_type,
        keyId: target.key_id,
        keyName: target.key_name,
        keyStatus: target.key_status,
        lastSyncAt: target.last_success_at,
        lastErrorCode: target.last_error_code
      };
      if (!target.key_id) {
        comparisonByAccount.set(accountId, {
          ...comparisonByAccount.get(accountId),
          status: 'missing_key',
          provider,
          targets: publicTargets,
          cost: { ...comparisonByAccount.get(accountId).cost, reason: 'mapping_key_missing' }
        });
        continue;
      }

      const keyId = String(target.key_id);
      const logMetrics = requestMetrics.get(keyId) || null;
      const hasLogCoverage = Boolean(target.coverage_from && target.coverage_to);
      const usageDelta = snapshots.usage.get(keyId) || null;
      const balanceDelta = snapshots.balance.get(keyId) || null;
      let source = 'unavailable';
      let upstream = null;
      let coverage = null;
      if (hasLogCoverage) {
        source = 'provider_request_logs';
        upstream = logMetrics || emptyUpstreamMetrics(true);
        coverage = {
          from: target.coverage_from,
          to: target.coverage_to,
          complete: Date.parse(target.coverage_from) <= Date.parse(since) &&
            !Boolean(target.request_log_truncated) && target.request_log_status === 'succeeded',
          truncated: Boolean(target.request_log_truncated),
          status: target.request_log_status,
          errorCode: target.request_log_error_code,
          syncedAt: target.request_log_synced_at,
          stale: !target.last_success_at || Date.parse(target.last_success_at) < staleBefore,
          attribution: 'mapped_key'
        };
      } else if (usageDelta) {
        source = 'provider_usage_snapshots';
        upstream = {
          ...emptyUpstreamMetrics(false),
          requestCount: usageDelta.requestCount == null ? null : Math.round(usageDelta.requestCount),
          inputTokens: usageDelta.inputTokens == null ? null : Math.round(usageDelta.inputTokens),
          outputTokens: usageDelta.outputTokens == null ? null : Math.round(usageDelta.outputTokens),
          actualCost: usageDelta.cost
        };
        coverage = {
          from: usageDelta.from,
          to: usageDelta.to,
          complete: Date.parse(usageDelta.from) <= Date.parse(since),
          truncated: false,
          status: 'succeeded',
          syncedAt: target.last_success_at,
          stale: !target.last_success_at || Date.parse(target.last_success_at) < staleBefore,
          attribution: 'mapped_key'
        };
      }

      const costCandidate = usageDelta?.cost != null
        ? usageDelta
        : balanceDelta?.cost != null
          ? balanceDelta
          : hasLogCoverage && target.request_log_status === 'succeeded' &&
            !Boolean(target.request_log_truncated) && logMetrics?.actualCost != null
            ? {
                source: 'provider_request_logs',
                currency: logMetrics.currency || 'USD',
                cost: logMetrics.actualCost,
                from: new Date(Math.max(Date.parse(since), Date.parse(target.coverage_from))).toISOString(),
                to: new Date(Math.min(Date.parse(until), Date.parse(target.coverage_to))).toISOString()
              }
            : null;
      const cost = {
        comparable: false,
        baseCost: null,
        upstreamCost: costCandidate?.cost ?? null,
        differenceAmount: null,
        differenceRatio: null,
        moreExpensive: null,
        currency: costCandidate?.currency || target.currency || null,
        source: costCandidate?.source || null,
        from: costCandidate?.from || null,
        to: costCandidate?.to || null,
        reason: costCandidate ? null : 'provider_cost_unavailable'
      };
      if (Number(target.shared_account_count) > 1) {
        cost.reason = 'shared_provider_key';
      } else if (costCandidate && cost.currency !== 'USD') {
        cost.reason = 'currency_mismatch';
      } else if (costCandidate && Date.parse(costCandidate.to) > Date.parse(costCandidate.from)) {
        const base = this.#baseCost(accountId, costCandidate.from, costCandidate.to);
        cost.baseCost = base.cost;
        if (base.requestCount > 0 && base.costSampleCount === 0) {
          cost.reason = 'sub2api_cost_unavailable';
        } else if (
          base.cost > 0 && Number(costCandidate.cost) === 0 &&
          (
            costCandidate.source === 'provider_key_snapshots' ||
            (costCandidate.source === 'provider_usage_snapshots' &&
              !(Number(usageDelta?.requestCount) > 0)) ||
            (costCandidate.source === 'provider_request_logs' &&
              !(Number(logMetrics?.requestCount) > 0))
          )
        ) {
          cost.reason = 'provider_counter_unchanged';
        } else {
          cost.comparable = true;
          cost.reason = null;
          cost.differenceAmount = round(base.cost - costCandidate.cost, 8);
          cost.differenceRatio = Number(costCandidate.cost) > 0
            ? round(cost.differenceAmount / Number(costCandidate.cost), 6)
            : null;
          cost.moreExpensive = Math.abs(cost.differenceAmount) < 1e-8
            ? 'same'
            : cost.differenceAmount > 0 ? 'sub2api' : 'upstream';
        }
      }

      comparisonByAccount.set(accountId, {
        status: 'mapped',
        source,
        provider,
        targets: publicTargets,
        upstream,
        coverage,
        cost
      });
    }
    return comparisonByAccount;
  }

  #upstreamTrends(comparison, since) {
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
      WHERE key_id = ? AND created_at >= ? AND status = 'success'
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day
    `).all(comparison.provider.keyId, since).map((item) => {
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

  accounts(filters = {}) {
    const days = clamp(integer(filters.days, this.settings().lookbackDays), 1, 90);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = this.#accountRows(filters);
    const accountIds = rows.map((row) => row.account_id);
    const metricMap = this.#metrics(accountIds, since);
    const comparisonMap = this.#comparisons(accountIds, since);
    const decorated = rows.map((row) => {
      const metrics = metricMap.get(String(row.account_id));
      const quality = qualityScore(metrics);
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
        metadata: parseJson(row.metadata_json, {}),
        lastSeenAt: row.last_seen_at,
        metrics: { ...metrics, qualityScore: quality.score, quality },
        comparison: comparisonMap.get(String(row.account_id))
      };
    });
    const sortBy = [
      'name', 'platform', 'status', 'requestCount', 'cacheRate', 'ttftP95Ms',
      'probeSuccessRate', 'intelligenceScore', 'qualityScore', 'lastProbeAt',
      'costDifference'
    ].includes(filters.sortBy) ? filters.sortBy : 'qualityScore';
    const order = filters.order === 'asc' ? 1 : -1;
    decorated.sort((left, right) => {
      const leftValue = ['name', 'platform', 'status'].includes(sortBy)
        ? left[sortBy]
        : sortBy === 'costDifference'
          ? left.comparison?.cost?.differenceAmount
          : left.metrics[sortBy];
      const rightValue = ['name', 'platform', 'status'].includes(sortBy)
        ? right[sortBy]
        : sortBy === 'costDifference'
          ? right.comparison?.cost?.differenceAmount
          : right.metrics[sortBy];
      if (leftValue == null && rightValue == null) return left.name.localeCompare(right.name);
      if (leftValue == null) return 1;
      if (rightValue == null) return -1;
      if (typeof leftValue === 'string') return leftValue.localeCompare(rightValue) * order;
      return (Number(leftValue) - Number(rightValue)) * order;
    });
    const pageSize = clamp(integer(filters.pageSize, 50), 10, 200);
    const total = decorated.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = clamp(integer(filters.page, 1), 1, totalPages);
    const offset = (page - 1) * pageSize;
    const promptTokens = decorated.reduce((sum, item) => sum + item.metrics.inputTokens +
      item.metrics.cacheCreationTokens + item.metrics.cacheReadTokens, 0);
    const cacheReadTokens = decorated.reduce((sum, item) => sum + item.metrics.cacheReadTokens, 0);
    const requestCount = decorated.reduce((sum, item) => sum + item.metrics.requestCount, 0);
    const probes = decorated.reduce((sum, item) => sum + item.metrics.probeCount, 0);
    const successfulProbes = decorated.reduce((sum, item) => sum +
      (item.metrics.probeSuccessRate == null ? 0 : item.metrics.probeCount * item.metrics.probeSuccessRate / 100), 0);
    const capabilityItems = decorated.filter((item) => item.metrics.intelligenceScore != null);
    const mappedItems = decorated.filter((item) => item.comparison?.status === 'mapped');
    const supplierLogItems = mappedItems.filter((item) => item.comparison.source === 'provider_request_logs');
    const comparableCostItems = mappedItems.filter((item) => item.comparison.cost?.comparable);
    return {
      items: decorated.slice(offset, offset + pageSize),
      pagination: { page, pageSize, total, totalPages },
      summary: {
        accountCount: total,
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
        comparableCostAccountCount: comparableCostItems.length,
        supplierLastSyncAt: latestIso(mappedItems.map((item) => item.comparison.provider?.lastSyncAt)),
        days
      },
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
    const days = clamp(integer(options.days, this.settings().lookbackDays), 1, 90);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const metrics = this.#metrics([String(accountId)], since).get(String(accountId));
    const comparison = this.#comparisons([String(accountId)], since).get(String(accountId));
    const quality = qualityScore(metrics);
    const trends = this.db.prepare(`
      SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS requests,
        AVG(CASE WHEN stream = 1 AND first_token_ms > 0 THEN first_token_ms END) AS ttft_ms,
        AVG(duration_ms) AS duration_ms,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(COALESCE(actual_cost, 0)) AS cost
      FROM sub2api_account_request_samples
      WHERE account_id = ? AND created_at >= ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day
    `).all(String(accountId), since).map((item) => {
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
        metadata: parseJson(row.metadata_json, {}),
        lastSeenAt: row.last_seen_at
      },
      metrics: { ...metrics, qualityScore: quality.score, quality },
      comparison,
      trends,
      upstreamTrends: this.#upstreamTrends(comparison, since),
      probes,
      days
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
  normalizeUsageSample,
  scoreChallenge,
  qualityScore
};
