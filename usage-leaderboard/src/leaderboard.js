'use strict';

const { BoundedCache } = require('./cache');
const { publicIdentity } = require('./identity');
const { calendarDate, projectSimulation, advanceSimulation } = require('./simulation');
const { AppError } = require('./errors');

const amount = (value) => Number(value || 0);
const numeric = (row) => ({ tokens: amount(row.tokens), requests: amount(row.requests) });
const percentChange = (current, previous) => previous > 0 ? Math.round((current / previous - 1) * 1000) / 10 : null;

function comparison(window, period) {
  return period !== 'all' && Boolean(window.retainedFrom && window.previousStart &&
    new Date(window.retainedFrom) <= new Date(window.previousStart));
}

class LeaderboardService {
  constructor(repository, inspector, config, { now = () => new Date(), settings = null } = {}) {
    this.repository = repository;
    this.inspector = inspector;
    this.config = config;
    this.now = now;
    this.settings = settings;
    this.generation = 0;
    this.boardCache = new BoundedCache({ ttlMs: config.cacheTtlMs, maxEntries: 8 });
    this.personalCache = new BoundedCache({ ttlMs: config.cacheTtlMs, maxEntries: config.personalCacheEntries });
  }

  entry(row, metric, compare) {
    const previousRank = row.previous_rank == null ? null : amount(row.previous_rank);
    const rank = row.rank == null ? null : amount(row.rank);
    return {
      ...publicIdentity(row.id, row.email, row.avatar_url, this.config.sub2apiPublicUrl), ...numeric(row), rank, source: 'real',
      comparisonAvailable: compare,
      change: compare && previousRank !== null && rank !== null ? previousRank - rank : null,
      newEntry: compare && rank !== null && rank <= 10 && (previousRank === null || previousRank > 10),
      growth: compare ? percentChange(amount(row[metric]), amount(row.previous_value)) : null
    };
  }

  async board(period, metric, publication = null, userId = null) {
    const schema = await this.inspector.inspect();
    const now = this.now();
    const calendarDay = calendarDate(now, this.config.timezone);
    const rules = publication?.candidate.rules;
    const bounded = publication?.candidate.version >= 2;
    const range = rules ? { minimumTokens: bounded ? rules.boardMinimumTokens : rules.minimumTokens } : null;
    return this.boardCache.getOrLoad(`${this.generation}:${period}:${metric}:${calendarDay}:${JSON.stringify(range)}`, async () => {
      const anchor = now.toISOString();
      const raw = await this.repository.board(period, metric, anchor, range, schema, userId);
      const compare = comparison(raw.window, period);
      const summary = { ...numeric(raw.summary), active: amount(raw.summary.active) };
      const previous = { ...numeric(raw.previous_summary), active: amount(raw.previous_summary.active) };
      return {
        period, metric, generatedAt: anchor, timezone: this.config.timezone, window: raw.window,
        comparisonAvailable: compare,
        summary: { ...summary, deltas: compare ? {
          tokens: percentChange(summary.tokens, previous.tokens),
          requests: percentChange(summary.requests, previous.requests),
          active: percentChange(summary.active, previous.active)
        } : null },
        entries: raw.entries.map((row) => this.entry(row, metric, compare)),
        qualifiedEntries: (raw.qualified_entries || []).map((row) => this.entry(row, metric, false)),
        personal: userId ? { userId, value: raw.personal } : null
      };
    });
  }

  view(board, publication) {
    const candidate = publication?.candidate;
    const projected = candidate && (candidate.version === 4 || calendarDate(new Date(board.generatedAt), this.config.timezone) === candidate.date)
      ? projectSimulation(board, advanceSimulation(candidate, this.now()), publication.version) : { ...board, display: { mode: 'real', realCount: board.entries.length, simulatedCount: 0 } };
    const { qualifiedEntries: _private, personal: _personal, ...result } = projected;
    return result;
  }

  async preview(candidate, period, metric) {
    const publication = candidate ? { candidate, version: 'draft' } : null;
    const board = await this.board(period, metric, publication);
    if (candidate && candidate.version !== 4 && candidate.date !== calendarDate(this.now(), this.config.timezone)) throw new AppError('SIMULATION_EXPIRED', '模拟候选已跨天，请重新生成', 400);
    return this.view(board, publication);
  }

  async get(period, metric, userId, attempt = 0) {
    const generation = this.generation;
    const date = calendarDate(this.now(), this.config.timezone);
    const schema = await this.inspector.inspect();
    const publication = this.settings?.active();
    const board = await this.board(period, metric, publication, userId);
    const personal = await this.personalCache.getOrLoad(`${generation}:${userId}:${period}:${metric}:${board.generatedAt}`, async () => {
      const raw = board.personal?.userId === userId ? board.personal.value
        : await this.repository.personal(period, metric, board.generatedAt, userId, schema);
      if (!raw) throw new AppError('ACCOUNT_UNAVAILABLE', '当前账号不可用，请重新登录', 401);
      const detail = await this.repository.details(period, board.generatedAt, userId, schema);
      const me = this.entry({ ...raw.me, rank: raw.rank, previous_rank: raw.previous_rank }, metric, board.comparisonAvailable);
      const trend = detail.trend.map((day) => ({ date: day.date, tokens: amount(day.tokens) }));
      const modelRows = detail.models.map((model) => ({ name: Array.from(model.name).slice(0, 120).join(''), ...numeric(model) }));
      const totalTokens = modelRows.reduce((sum, model) => sum + model.tokens, 0);
      const totalRequests = modelRows.reduce((sum, model) => sum + model.requests, 0);
      const modelMetric = totalTokens > 0 ? 'tokens' : 'requests';
      const denominator = modelMetric === 'tokens' ? totalTokens : totalRequests;
      return {
        ...me, eligible: raw.me.eligible,
        percentile: me.rank && board.summary.active ? Math.round(amount(raw.beaten) / board.summary.active * 1000) / 10 : null,
        next: raw.me.eligible && raw.next ? {
          rank: amount(raw.next.rank), gap: Math.max(0, amount(raw.next.value) - me[metric]),
          progress: amount(raw.next.value) > 0 ? Math.min(100, me[metric] / amount(raw.next.value) * 100) : 0
        } : null,
        trend, trendTotal: trend.reduce((sum, day) => sum + day.tokens, 0),
        trendGrowth: board.window.retainedFrom && new Date(board.window.retainedFrom) <= new Date(detail.previous_trend_start)
          ? percentChange(trend.reduce((sum, day) => sum + day.tokens, 0), amount(detail.previous_trend_tokens)) : null,
        modelMetric,
        snapshotConsistent: me.tokens === totalTokens && me.requests === totalRequests,
        models: modelRows.map((model) => ({ ...model, percent: denominator > 0 ? model[modelMetric] / denominator * 100 : 0 }))
      };
    });
    const { snapshotConsistent, ...me } = personal;
    // A late log can arrive between the cached board and the personal queries.
    const known = [...board.entries, ...board.qualifiedEntries].find((entry) => entry.key === me.key);
    const missingFrom = (entries) => !entries.some((entry) => entry.key === me.key) &&
      (entries.length < 10 || me[metric] > entries.at(-1)[metric]);
    const floor = publication?.candidate.rules.boardMinimumTokens ?? publication?.candidate.rules.minimumTokens;
    const inconsistent = !snapshotConsistent || Boolean(known && (!me.eligible ||
      known.tokens !== me.tokens || known.requests !== me.requests || known.rank !== me.rank)) ||
      me.eligible && me.requests > 0 && (missingFrom(board.entries) ||
        floor != null && me.tokens >= floor && missingFrom(board.qualifiedEntries));
    if (inconsistent || generation !== this.generation || date !== calendarDate(this.now(), this.config.timezone)) {
      if (attempt >= 2) throw new AppError('SERVICE_BUSY', '榜单正在更新，请稍后重试', 503);
      if (inconsistent && generation === this.generation) this.invalidate();
      return this.get(period, metric, userId, attempt + 1);
    }
    const view = this.view(board, publication);
    const rankingAvailable = view.display.mode === 'real';
    const ownEntry = view.entries.find((entry) => entry.key === me.key);
    const membership = { inLeaderboard: Boolean(ownEntry), boardRank: ownEntry?.rank ?? null };
    return { ...view, me: rankingAvailable ? { ...me, ...membership, rankingAvailable } : { ...me, ...membership, rankingAvailable,
      rank: null, percentile: null, next: null, change: null, growth: null, newEntry: false, comparisonAvailable: false } };
  }

  invalidate() { this.generation++; this.boardCache.clear(); this.personalCache.clear(); }
  close() { this.invalidate(); }
}

module.exports = { LeaderboardService, comparison, percentChange };
