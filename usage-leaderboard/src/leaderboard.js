'use strict';

const { BoundedCache } = require('./cache');
const { publicIdentity } = require('./identity');

const amount = (value) => Number(value || 0);
const numeric = (row) => ({ tokens: amount(row.tokens), requests: amount(row.requests) });
const percentChange = (current, previous) => previous > 0 ? Math.round((current / previous - 1) * 1000) / 10 : null;

function comparison(window, period) {
  return period !== 'all' && Boolean(window.retainedFrom && window.previousStart &&
    new Date(window.retainedFrom) <= new Date(window.previousStart));
}

class LeaderboardService {
  constructor(repository, inspector, config, { now = () => new Date() } = {}) {
    this.repository = repository;
    this.inspector = inspector;
    this.config = config;
    this.now = now;
    this.boardCache = new BoundedCache({ ttlMs: config.cacheTtlMs, maxEntries: 8 });
    this.personalCache = new BoundedCache({ ttlMs: config.cacheTtlMs, maxEntries: config.personalCacheEntries });
  }

  entry(row, metric, compare) {
    const previousRank = row.previous_rank == null ? null : amount(row.previous_rank);
    const rank = row.rank == null ? null : amount(row.rank);
    return {
      ...publicIdentity(row.id, row.email), ...numeric(row), rank,
      comparisonAvailable: compare,
      change: compare && previousRank !== null && rank !== null ? previousRank - rank : null,
      newEntry: compare && rank !== null && rank <= 10 && (previousRank === null || previousRank > 10),
      growth: compare ? percentChange(amount(row[metric]), amount(row.previous_value)) : null
    };
  }

  async get(period, metric, userId) {
    const schema = await this.inspector.inspect();
    const now = this.now();
    const calendarDay = new Intl.DateTimeFormat('sv-SE', { timeZone: this.config.timezone }).format(now);
    const board = await this.boardCache.getOrLoad(`${period}:${metric}:${calendarDay}`, async () => {
      const anchor = now.toISOString();
      const raw = await this.repository.board(period, metric, anchor);
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
        entries: raw.entries.map((row) => this.entry(row, metric, compare))
      };
    });
    const personal = await this.personalCache.getOrLoad(`${userId}:${period}:${metric}:${board.generatedAt}`, async () => {
      const raw = await this.repository.personal(period, metric, board.generatedAt, userId);
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
        models: modelRows.map((model) => ({ ...model, percent: denominator > 0 ? model[modelMetric] / denominator * 100 : 0 }))
      };
    });
    return { ...board, me: personal };
  }

  close() { this.boardCache.clear(); this.personalCache.clear(); }
}

module.exports = { LeaderboardService, comparison, percentChange };
