'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { z } = require('zod');
const { AppError } = require('./errors');
const { evolveTimeline, TICK_MS } = require('./simulation-timeline');
const { createSimulationNames } = require('./simulation-identity');
const { createUsageProfiles } = require('./simulation-distribution');

const AVATARS = ['mountain', 'lake', 'night', 'forest', 'hills', 'sea', 'peak', 'valley', 'coast', 'green'];
const PERIODS = ['today', 'week', 'month', 'all'];
const legacyRulesSchema = z.object({
  minimumTokens: z.number().int().min(1e6).max(1e9),
  maximumTokens: z.number().int().min(1e6).max(1e9),
  distribution: z.enum(['natural', 'close', 'concentrated'])
}).strict().refine((value) => value.maximumTokens > value.minimumTokens, '上限必须大于下限');
const rulesSchema = legacyRulesSchema.safeExtend({
  boardMinimumTokens: z.number().int().min(1e6).max(1e9),
  boardMaximumTokens: z.number().int().min(1e6).max(1e9)
}).refine((value) => value.boardMaximumTokens > value.boardMinimumTokens, '榜单上限必须大于下限')
  .refine((value) => Math.min(value.maximumTokens, value.boardMaximumTokens) > Math.max(value.minimumTokens, value.boardMinimumTokens),
    '单人模拟范围与榜单范围必须有可生成的交集');
const DEFAULT_RULES = { minimumTokens: 1370000, maximumTokens: 980830000, distribution: 'natural', boardMinimumTokens: 1370000, boardMaximumTokens: 980830000 };
const identitySchema = z.object({
  key: z.string().regex(/^sim_[a-f0-9]{16}$/),
  name: z.string().regex(/^(?:[1-9][0-9]\*\*\*@qq\.com|[a-z]{2}\*\*\*@(?:gmail\.com|163\.com|example\.com))$/),
  avatar: z.enum(AVATARS).nullable()
}).strict();
const valueSchema = z.object({ tokens: z.number().int().min(1e6).max(1e9), requests: z.number().int().positive().max(1e9) }).strict();
const candidateSchema = z.object({
  version: z.literal(1), seed: z.string().regex(/^[a-f0-9]{32}$/), generatedAt: z.iso.datetime(),
  timezone: z.string().max(80), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), rules: legacyRulesSchema,
  rows: z.array(identitySchema.extend({ values: z.object(Object.fromEntries(PERIODS.map((period) => [period, valueSchema]))).strict() }).strict()).length(10)
}).strict();

const currentCandidateSchema = candidateSchema.extend({ version: z.literal(2), rules: rulesSchema });
const seriesCandidateSchema = currentCandidateSchema.extend({
  version: z.literal(3),
  origin: z.object({ generatedAt: z.iso.datetime(), rules: rulesSchema, distributionVersion: z.literal(2).optional() }).strict()
});
const liveCandidateSchema = currentCandidateSchema.extend({ version: z.literal(4), origin: seriesCandidateSchema });

function calendarDate(now, timezone) { return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(now); }
function shiftDay(date, days) { return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10); }
function randomSource(seed) {
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function fractional(value) { return Number.isSafeInteger(value) && value % 1000 !== 0 && !(value / 1e6).toFixed(2).endsWith('.00'); }
function invalidRange() { return new AppError('SIMULATION_RANGE_INVALID', '当前范围无法生成十组随机小数，请扩大上下限间距', 400); }

function generateLegacySimulation(input, { now = new Date(), timezone = 'Asia/Shanghai', seed = crypto.randomBytes(16).toString('hex'), roster, captureDays, distributionVersion = 1 } = {}) {
  const result = legacyRulesSchema.safeParse(input);
  if (!result.success) throw new AppError('INVALID_REQUEST', '模拟 Token 范围须为 1M～1B，且上限大于下限', 400);
  const rules = result.data;
  const random = randomSource(seed);
  const profiles = distributionVersion === 2 ? createUsageProfiles(rules.distribution, randomSource(`${seed}:distribution:2`)) : null;
  const choose = (low, high, preferred) => {
    for (let attempt = 0; attempt < 64; attempt++) {
      // Decimal display retries must not move an outlier into another usage group.
      const radius = Math.max(25000, (high - low) * .015);
      const from = profiles ? Math.max(low, preferred - radius) : low;
      const to = profiles ? Math.min(high, preferred + radius) : high;
      const value = attempt === 0 ? Math.round(preferred) : Math.floor(from + random() * (to - from + 1));
      if (value >= low && value <= high && fractional(value)) return value;
    }
    throw invalidRange();
  };
  const date = calendarDate(now, timezone);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const weekStart = shiftDay(date, -((weekday + 6) % 7));
  const monthStart = `${date.slice(0, 7)}-01`;
  const floor = choose(rules.minimumTokens, rules.maximumTokens, rules.minimumTokens + 12347);
  const identityRandom = randomSource(`${seed}:names`);
  const names = roster ? null : createSimulationNames(identityRandom);
  const identities = roster ? z.array(identitySchema).length(10).parse(roster) : Array.from({ length: 10 }, (_, i) => ({
    key: `sim_${crypto.createHash('sha256').update(`${seed}:identity:${i}`).digest('hex').slice(0, 16)}`,
    name: names[i], avatar: null
  }));
  // Metrics use a separate stream so retaining identities does not change seeded replay.
  const metricRandom = randomSource(`${seed}:metrics`);
  const used = Object.fromEntries(PERIODS.map((period) => [period, new Set()]));
  const rows = identities.map((identity, index) => {
    for (let attempt = 0; attempt < 64; attempt++) {
      const profile = profiles?.[index];
      const quantile = profile ? 0 : (10 - index - (.08 + metricRandom() * .77)) / 10;
      const weight = profile ? Math.min(.99, Math.max(.001, profile.weight + (attempt ? (metricRandom() - .5) * .02 : 0)))
        : rules.distribution === 'close' ? .66 + quantile * .32 : Math.pow(quantile, rules.distribution === 'concentrated' ? 2.5 : 1.35);
      const budget = choose(floor, rules.maximumTokens, floor + (rules.maximumTokens - floor) * weight);
      const share = profile ? profile.share + (attempt ? (metricRandom() - .5) * .03 : 0) : .012 + metricRandom() * .05;
      const today = choose(floor, budget, floor + (budget - floor) * share);
      const weights = Array.from({ length: 93 }, () => profile ? .005 + Math.pow(metricRandom(), 3) : .02 + metricRandom());
      const denominator = weights.reduce((sum, value) => sum + value, 0);
      let remaining = budget - today;
      const values = Object.fromEntries(PERIODS.map((period) => [period, { tokens: 0, requests: 0 }]));
      const days = [];
      for (let day = 0; day <= 93; day++) {
        const localDay = shiftDay(date, -day);
        const tokens = day === 0 ? today : day === 93 ? remaining : Math.min(remaining, Math.floor((budget - today) * weights[day - 1] / denominator));
        if (day > 0) remaining -= tokens;
        const requests = tokens > 0 ? Math.max(1, Math.round(tokens / (1800 + metricRandom() * 22200))) : 0;
        if (captureDays) days.push({ date: localDay, tokens, requests });
        for (const period of PERIODS) {
          if (period === 'today' && day !== 0 || period === 'week' && localDay < weekStart || period === 'month' && localDay < monthStart) continue;
          values[period].tokens += tokens;
          values[period].requests += requests;
        }
      }
      if (PERIODS.some((period) => !fractional(values[period].tokens) || values[period].tokens < rules.minimumTokens || values[period].tokens > rules.maximumTokens || used[period].has((values[period].tokens / 1e6).toFixed(2)))) continue;
      PERIODS.forEach((period) => used[period].add((values[period].tokens / 1e6).toFixed(2)));
      captureDays?.(identity.key, days);
      return { ...identity, values };
    }
    throw invalidRange();
  });
  return { version: 1, seed, generatedAt: now.toISOString(), timezone, date, rules, rows };
}

function generateBoundedSimulation(input, options = {}) {
  const result = rulesSchema.safeParse(input);
  if (!result.success) throw new AppError('INVALID_REQUEST', '单人及榜单 Token 范围须为 1M～1B，上限大于下限，且两个范围须有交集', 400);
  const rules = result.data;
  const generated = generateLegacySimulation({
    minimumTokens: Math.max(rules.minimumTokens, rules.boardMinimumTokens),
    maximumTokens: Math.min(rules.maximumTokens, rules.boardMaximumTokens),
    distribution: rules.distribution
  }, options);
  return { ...generated, version: 2, rules };
}

function historyConflict() {
  return new AppError('SIMULATION_HISTORY_CONFLICT', '当前区间无法容纳保留身份的历史及新增用量；请扩大区间，或取消保留身份后生成新的示例名单', 400);
}

function generateSnapshot(input, options = {}) {
  const result = rulesSchema.safeParse(input);
  if (!result.success) throw new AppError('INVALID_REQUEST', '单人及榜单 Token 范围须为 1M～1B，上限大于下限，且两个范围须有交集', 400);
  const rules = result.data;
  const now = options.now || new Date();
  const timezone = options.timezone || 'Asia/Shanghai';
  const previous = options.previous ? validateCandidate(options.previous, timezone) : null;
  if (previous && previous.rules.distribution !== rules.distribution) {
    throw new AppError('SIMULATION_HISTORY_CONFLICT', '保留身份时不会改写历史分布；修改分布请取消保留身份，生成新的示例名单', 400);
  }
  const roster = previous ? previous.rows.map(({ key, name, avatar }) => ({ key, name, avatar })) : options.roster;
  const seed = previous?.seed || options.seed || crypto.randomBytes(16).toString('hex');
  const initialRules = previous?.rules || rules;
  const origin = previous?.origin || options.origin || { generatedAt: previous?.generatedAt || now.toISOString(), ...(previous ? {} : { distributionVersion: 2 }), rules: {
    ...initialRules, boardMinimumTokens: initialRules.boardMinimumTokens ?? initialRules.minimumTokens,
    boardMaximumTokens: initialRules.boardMaximumTokens ?? initialRules.maximumTokens
  } };
  const history = new Map();
  const baseline = generateBoundedSimulation(origin.rules, { now: new Date(origin.generatedAt), timezone, seed, roster,
    distributionVersion: origin.distributionVersion,
    captureDays: (key, days) => history.set(key, days) });
  const date = calendarDate(now, timezone);
  const elapsed = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${baseline.date}T00:00:00Z`)) / 86400000);
  const minimum = Math.max(rules.minimumTokens, rules.boardMinimumTokens);
  const maximum = Math.min(rules.maximumTokens, rules.boardMaximumTokens);
  const dailyMinimum = Math.max(origin.rules.minimumTokens, origin.rules.boardMinimumTokens);
  // This bound also keeps replay work finite without storing a growing daily ledger.
  if (now < new Date(origin.generatedAt) || elapsed < 0 || baseline.rows.some((row) => row.values.all.tokens + elapsed * dailyMinimum > maximum)) throw historyConflict();
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const starts = { today: date, week: shiftDay(date, -((weekday + 6) % 7)), month: `${date.slice(0, 7)}-01` };
  const rows = baseline.rows.map((row) => {
    const days = history.get(row.key);
    const dailyAverage = (row.values.all.tokens - row.values.today.tokens) / 93;
    for (let offset = 1; offset <= elapsed; offset++) {
      const localDay = shiftDay(baseline.date, offset);
      const random = randomSource(`${seed}:daily:${row.key}:${localDay}`);
      const tokens = Math.max(dailyMinimum, Math.round(dailyAverage * (.5 + random())));
      const requests = Math.max(1, Math.round(tokens / (1800 + random() * 22200)));
      days.push({ date: localDay, tokens, requests });
    }
    const values = Object.fromEntries(PERIODS.map((period) => [period, { tokens: 0, requests: 0 }]));
    for (const day of days) for (const period of PERIODS) {
      if (period !== 'all' && day.date < starts[period]) continue;
      values[period].tokens += day.tokens;
      values[period].requests += day.requests;
    }
    if (PERIODS.some((period) => values[period].tokens < minimum || values[period].tokens > maximum)) throw historyConflict();
    options.captureDays?.(row.key, days);
    return { key: row.key, name: row.name, avatar: row.avatar, values };
  });
  return { version: 3, seed, generatedAt: now.toISOString(), timezone, date, rules, origin, rows };
}

function advanceSimulation(candidate, now) {
  if (candidate.version !== 4) return candidate;
  const baseline = candidate.origin;
  const history = new Map();
  generateSnapshot(baseline.rules, { now: new Date(baseline.generatedAt), timezone: baseline.timezone,
    seed: baseline.seed, origin: baseline.origin, roster: baseline.rows.map(({ key, name, avatar }) => ({ key, name, avatar })),
    captureDays: (key, days) => history.set(key, days) });
  return { ...candidate, ...evolveTimeline(baseline, history, now) };
}

function generateSimulation(input, options = {}) {
  const result = rulesSchema.safeParse(input);
  if (!result.success) throw new AppError('INVALID_REQUEST', '单人及榜单 Token 范围须为 1M～1B，上限大于下限，且两个范围须有交集', 400);
  const rules = result.data;
  const now = options.now || new Date();
  const timezone = options.timezone || 'Asia/Shanghai';
  const previous = options.previous ? validateCandidate(options.previous, timezone) : null;
  let origin = options.origin;
  if (previous?.version === 4) {
    origin = previous.origin;
    if (now < new Date(previous.generatedAt)) throw historyConflict();
  }
  origin ||= generateSnapshot(rules, { ...options, now, timezone, previous });
  if (now < new Date(origin.generatedAt) || rules.distribution !== origin.rules.distribution ||
    Math.max(rules.minimumTokens, rules.boardMinimumTokens) > Math.max(origin.rules.minimumTokens, origin.rules.boardMinimumTokens) ||
    Math.min(rules.maximumTokens, rules.boardMaximumTokens) < Math.min(origin.rules.maximumTokens, origin.rules.boardMaximumTokens)) throw historyConflict();
  const candidate = { version: 4, seed: origin.seed, generatedAt: now.toISOString(), timezone,
    date: calendarDate(now, timezone), rules, origin, rows: origin.rows };
  return { ...candidate, rows: advanceSimulation(candidate, now).rows };
}

function validateCandidate(value, timezone) {
  const parsed = z.discriminatedUnion('version', [candidateSchema, currentCandidateSchema, seriesCandidateSchema, liveCandidateSchema]).safeParse(value);
  if (!parsed.success || parsed.data.timezone !== timezone) throw new AppError('SIMULATION_INVALID', '模拟数据无效，请重新生成', 400);
  const candidate = parsed.data;
  let replay;
  try {
    if (candidate.version === 4) validateCandidate(candidate.origin, timezone);
    replay = (candidate.version === 1 ? generateLegacySimulation : candidate.version === 2 ? generateBoundedSimulation : candidate.version === 3 ? generateSnapshot : generateSimulation)(candidate.rules,
      { now: new Date(candidate.generatedAt), timezone, seed: candidate.seed, origin: candidate.origin,
        roster: candidate.rows.map(({ key, name, avatar }) => ({ key, name, avatar })) });
  } catch { throw new AppError('SIMULATION_INVALID', '模拟历史无法重放，请重新生成', 400); }
  if (!isDeepStrictEqual(candidate, replay) || new Set(candidate.rows.map((row) => row.key)).size !== 10 || new Set(candidate.rows.map((row) => row.name)).size !== 10) {
    throw new AppError('SIMULATION_INVALID', '模拟数据校验失败，请重新生成', 400);
  }
  return candidate;
}

function projectSimulation(board, candidate, version) {
  const bounded = candidate.version >= 2;
  const realEntries = (board.qualifiedEntries || []).filter((entry) => !bounded ||
    entry.tokens >= candidate.rules.boardMinimumTokens).slice(0, 10);
  const randomKey = (key, purpose) => crypto.createHash('sha256').update(`${candidate.seed}:${candidate.version >= 3 ? '' : board.period}:${purpose}:${key}`).digest('hex');
  const tieOrder = (a, b) => bounded ? randomKey(a.key, 'tie').localeCompare(randomKey(b.key, 'tie')) || a.key.localeCompare(b.key)
    : Number(a.source === 'simulation') - Number(b.source === 'simulation') || a.key.localeCompare(b.key);
  const realKeys = new Set(realEntries.map((entry) => entry.key));
  if (realEntries.length >= 10) {
    return { ...board, display: { mode: 'real', realCount: board.entries.length, simulatedCount: 0, version } };
  }
  const names = new Set([...realEntries, ...board.entries].map((entry) => entry.name));
  let replacementNames;
  const simulated = candidate.rows.map((row) => {
    let name = row.name;
    if (names.has(name)) {
      replacementNames ||= createSimulationNames(randomSource(`${candidate.seed}:collision-names`),
        new Set([...names, ...candidate.rows.map((entry) => entry.name)]));
      name = replacementNames.shift();
    }
    names.add(name);
    return { key: row.key, name, avatar: null, ...row.values[board.period], source: 'simulation' };
  }).sort((a, b) => bounded ? randomKey(a.key, 'fill').localeCompare(randomKey(b.key, 'fill')) || a.key.localeCompare(b.key)
    : b[board.metric] - a[board.metric] || a.key.localeCompare(b.key)).slice(0, 10 - realEntries.length);
  const order = (a, b) => b[board.metric] - a[board.metric] || tieOrder(a, b);
  const filled = [...realEntries.map((entry) => ({ ...entry, source: 'real' })), ...simulated].sort(order);
  // The Token floor must not exclude a real caller who beats the displayed cutoff.
  const cutoff = filled.at(-1)?.[board.metric] ?? 0;
  const contenders = board.entries.filter((entry) => !realKeys.has(entry.key) && entry[board.metric] > cutoff);
  const entries = [...filled, ...contenders.map((entry) => ({ ...entry, source: 'real' }))].sort(order).slice(0, 10);
  const simulatedCount = entries.filter((entry) => entry.source === 'simulation').length;
  if (!simulatedCount) {
    return { ...board, display: { mode: 'real', realCount: board.entries.length, simulatedCount: 0, version } };
  }
  let rank = 0;
  entries.forEach((entry, index) => { if (index === 0 || entry[board.metric] !== entries[index - 1][board.metric]) rank = index + 1;
    entry.rank = rank; entry.comparisonAvailable = false; entry.change = null; entry.newEntry = false; entry.growth = null; });
  return { ...board, entries, comparisonAvailable: false,
    summary: { tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0), requests: entries.reduce((sum, entry) => sum + entry.requests, 0), active: entries.length, deltas: null },
    display: { ...(bounded ? { rangeApplied: true } : {}), ...(candidate.version === 4 ? { dynamic: true, intervalSeconds: TICK_MS / 1000 } : {}), mode: simulatedCount < entries.length ? 'mixed' : 'simulation', realCount: entries.length - simulatedCount, simulatedCount, version, snapshotAt: candidate.generatedAt, date: candidate.date } };
}

module.exports = { DEFAULT_RULES, rulesSchema, calendarDate, generateSimulation, generateSnapshot, advanceSimulation, validateCandidate, projectSimulation };
