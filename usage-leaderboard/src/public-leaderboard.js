'use strict';

const crypto = require('node:crypto');

const identitySecret = crypto.randomBytes(32);

function publicProfile(user) {
  const key = crypto.createHmac('sha256', identitySecret).update(user.key).digest('hex').slice(0, 16);
  const anonymous = user.name === `创造者 ${user.key.slice(0, 6).toUpperCase()}` ||
    /@(?:[^@]+\.)?example\.(?:com|net|org)$/i.test(user.name);
  return {
    key,
    name: anonymous ? `创造者 ${key.slice(0, 6).toUpperCase()}` : user.name,
    avatar: user.avatar ?? null
  };
}

// Keep internal publication and provenance fields out of the display API.
function publicLeaderboard(board) {
  return {
    period: board.period,
    metric: board.metric,
    generatedAt: board.generatedAt,
    timezone: board.timezone,
    window: {
      start: board.window.start ?? null,
      end: board.window.end,
      retainedFrom: board.window.retainedFrom ?? null
    },
    entries: board.entries.map((user) => ({
      ...publicProfile(user),
      tokens: user.tokens,
      requests: user.requests,
      rank: user.rank,
      comparisonAvailable: user.comparisonAvailable === true,
      change: user.change ?? null,
      newEntry: user.newEntry === true,
      growth: user.growth ?? null
    })),
    me: {
      ...publicProfile(board.me),
      tokens: board.me.tokens,
      requests: board.me.requests,
      trend: board.me.trend.map((day) => ({ date: day.date, tokens: day.tokens })),
      trendTotal: board.me.trendTotal,
      trendGrowth: board.me.trendGrowth,
      models: board.me.models.map((model) => ({ name: model.name, tokens: model.tokens, requests: model.requests }))
    }
  };
}

module.exports = { publicProfile, publicLeaderboard };
