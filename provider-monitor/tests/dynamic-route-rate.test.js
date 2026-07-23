const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDynamicRouteConfig,
  summarizeDynamicRouteObservations
} = require('../src/services/dynamic-route-rate');

test('dynamic route statistics select configured percentiles and token-weighted rates', () => {
  const observations = [
    {
      requestAt: '2026-07-20T00:00:00.000Z', model: 'model-a', channelId: 1,
      channelName: 'Low', multiplier: 0.1, promptTokens: 100
    },
    {
      requestAt: '2026-07-21T00:00:00.000Z', model: 'model-a', channelId: 2,
      channelName: 'Middle', multiplier: 0.2, promptTokens: 300
    },
    {
      requestAt: '2026-07-22T00:00:00.000Z', model: 'model-b', channelId: 3,
      channelName: 'High', multiplier: 0.4, promptTokens: 100
    }
  ];
  const median = summarizeDynamicRouteObservations(observations, {
    enabled: true, statistic: 'median', minimumSamples: 3
  });
  assert.equal(median.selectedMultiplier, 0.2);
  assert.ok(Math.abs(median.p90Multiplier - 0.36) < 1e-12);
  assert.ok(Math.abs(median.weightedAverageMultiplier - 0.22) < 1e-12);
  assert.equal(median.latestMultiplier, 0.4);
  assert.equal(median.latest.channelName, 'High');
  assert.equal(median.models.length, 2);
  assert.equal(median.channels.length, 3);
  assert.equal(median.status, 'detected');

  const weighted = summarizeDynamicRouteObservations(observations, {
    enabled: true, statistic: 'weighted_average', minimumSamples: 4
  });
  assert.ok(Math.abs(weighted.selectedMultiplier - 0.22) < 1e-12);
  assert.equal(weighted.status, 'low_confidence');
});

test('dynamic route configuration applies bounded operational defaults', () => {
  assert.deepEqual(normalizeDynamicRouteConfig(true), {
    enabled: true,
    statistic: 'median',
    lookbackDays: 30,
    minimumSamples: 3,
    maxRecords: 5000
  });
  assert.deepEqual(normalizeDynamicRouteConfig({
    enabled: true, statistic: 'unknown', lookbackDays: 500,
    minimumSamples: 0, maxRecords: 2
  }), {
    enabled: true,
    statistic: 'median',
    lookbackDays: 90,
    minimumSamples: 1,
    maxRecords: 100
  });
});
