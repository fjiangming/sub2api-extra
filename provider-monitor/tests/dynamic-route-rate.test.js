const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractLoggedProviderPrices,
  normalizeDynamicRouteConfig,
  officialRelativeObservation,
  referencePriceFor,
  summarizeDynamicRouteObservations
} = require('../src/services/dynamic-route-rate');

test('dynamic route statistics select configured percentiles and weighted rates', () => {
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
    priceBasis: 'official_relative',
    officialModelPrices: {},
    lookbackDays: 30,
    minimumSamples: 3,
    maxRecords: 5000
  });
  assert.deepEqual(normalizeDynamicRouteConfig({
    enabled: true, statistic: 'unknown', lookbackDays: 500,
    priceBasis: 'unknown', minimumSamples: 0, maxRecords: 2
  }), {
    enabled: true,
    statistic: 'median',
    priceBasis: 'official_relative',
    officialModelPrices: {},
    lookbackDays: 90,
    minimumSamples: 1,
    maxRecords: 100
  });
});

test('official price normalization compares the logged input, output and cache prices to a channel reference', () => {
  const config = normalizeDynamicRouteConfig({
    enabled: true,
    statistic: 'latest',
    minimumSamples: 1,
    officialModelPrices: {
      'codex-auto-review': { model: 'fallback', input: 10, output: 60, cachedInput: 1 },
      'codex-auto-review@1164': { model: 'gpt-5.6-sol', input: 5, output: 30, cachedInput: 0.5 }
    }
  });
  const reference = referencePriceFor(config.officialModelPrices, 'codex-auto-review', 1164, 'Route');
  const observation = officialRelativeObservation({
    requestAt: '2026-07-25T10:50:43.000Z',
    model: 'codex-auto-review', channelId: 1164, channelName: 'Route',
    modelRatio: 0.018, groupRatio: 1, completionRatio: 6, cacheRatio: 0.1,
    promptTokens: 1500, completionTokens: 19, cacheTokens: 0
  }, reference, 500000);

  assert.equal(reference.model, 'gpt-5.6-sol');
  assert.ok(Math.abs(observation.providerInputPerMillion - 0.036) < 1e-12);
  assert.ok(Math.abs(observation.providerOutputPerMillion - 0.216) < 1e-12);
  assert.ok(Math.abs(observation.providerCost - 0.000058104) < 1e-15);
  assert.ok(Math.abs(observation.referenceCost - 0.00807) < 1e-15);
  assert.ok(Math.abs(observation.multiplier - 0.0072) < 1e-12);
  assert.equal(observation.providerPriceSource, 'log_ratio');

  const summary = summarizeDynamicRouteObservations([observation], config);
  assert.ok(Math.abs(summary.selectedMultiplier - 0.0072) < 1e-12);
  assert.equal(summary.priceBasis, 'official_relative');
  assert.equal(summary.latest.referenceModel, 'gpt-5.6-sol');
  assert.equal(summary.status, 'detected');
});

test('official price normalization reports a missing reference instead of using the provider ratio', () => {
  const config = normalizeDynamicRouteConfig({
    enabled: true, statistic: 'latest', minimumSamples: 1
  });
  const observation = officialRelativeObservation({
    requestAt: '2026-07-25T10:50:43.000Z', model: 'supplier-alias',
    modelRatio: 0.018, groupRatio: 1, completionRatio: 6,
    promptTokens: 1500, completionTokens: 19, cacheTokens: 0
  }, null, 500000);
  const summary = summarizeDynamicRouteObservations([observation], config);

  assert.equal(summary.selectedMultiplier, null);
  assert.equal(summary.status, 'missing_reference_price');
  assert.deepEqual(summary.referenceMissingModels, ['supplier-alias']);
});

test('latest statistic uses the newest calculable log and reports newer missing aliases as partial', () => {
  const summary = summarizeDynamicRouteObservations([
    {
      requestAt: '2026-07-25T10:50:43.000Z', model: 'gpt-5.6-sol',
      multiplier: 0.0062, referenceMissing: false, providerPriceMissing: false
    },
    {
      requestAt: '2026-07-25T10:52:43.000Z', model: 'codex-auto-review',
      multiplier: null, referenceMissing: true, referenceMissingReason: 'model'
    }
  ], { enabled: true, statistic: 'latest', minimumSamples: 3 });

  assert.equal(summary.selectedMultiplier, 0.0062);
  assert.equal(summary.status, 'partial_reference_price');
  assert.equal(summary.sampleCount, 1);
  assert.equal(summary.totalObservationCount, 2);
  assert.equal(summary.latest.model, 'gpt-5.6-sol');
  assert.equal(summary.latestObserved.model, 'codex-auto-review');
  assert.deepEqual(summary.referenceMissingModels, ['codex-auto-review']);
});

test('explicit prices in request logs override model ratios', () => {
  const loggedProviderPrices = extractLoggedProviderPrices({
    input_price: 0.04,
    output_price: 0.24,
    cache_read_price_per_token: 0.000000004
  });
  const observation = officialRelativeObservation({
    requestAt: '2026-07-25T10:50:43.000Z', model: 'route-a',
    modelRatio: 0.018, groupRatio: 1, completionRatio: 6, cacheRatio: 0.1,
    loggedProviderPrices,
    promptTokens: 1500, completionTokens: 20, cacheTokens: 0
  }, {
    model: 'official-a', inputPerMillion: 5, outputPerMillion: 30, cacheReadPerMillion: 0.5
  }, 500000);

  assert.equal(loggedProviderPrices.input.field, 'input_price');
  assert.ok(Math.abs(loggedProviderPrices.cacheRead.value - 0.004) < 1e-12);
  assert.ok(Math.abs(observation.providerInputPerMillion - 0.04) < 1e-12);
  assert.ok(Math.abs(observation.providerOutputPerMillion - 0.24) < 1e-12);
  assert.ok(Math.abs(observation.multiplier - 0.008) < 1e-12);
  assert.equal(observation.providerPriceSource, 'log_explicit');
});

test('global official prices resolve provider and channel aliases without duplicating prices', () => {
  const config = normalizeDynamicRouteConfig({
    enabled: true,
    statistic: 'latest',
    minimumSamples: 1,
    officialModelPrices: {
      'official-a': { input: 5, output: 30 },
      'supplier/route-a@7': { model: 'official-a' }
    }
  });
  const reference = referencePriceFor(
    config.officialModelPrices, 'route-a', 7, null, null, 'Supplier'
  );
  const observation = officialRelativeObservation({
    requestAt: '2026-07-25T10:50:43.000Z', model: 'route-a', channelId: 7,
    modelRatio: 0.025, groupRatio: 1, completionRatio: 6,
    promptTokens: 1000, completionTokens: 10, cacheTokens: 0
  }, reference, 500000);

  assert.ok(Math.abs(observation.multiplier - 0.01) < 1e-12);
  assert.equal(observation.providerPriceSource, 'log_ratio');
  assert.equal(reference.model, 'official-a');
});

test('missing log provider prices are reported separately from official prices', () => {
  const config = normalizeDynamicRouteConfig({
    enabled: true, statistic: 'latest', minimumSamples: 1,
    officialModelPrices: { 'route-a': { input: 5, output: 30 } }
  });
  const observation = officialRelativeObservation({
    requestAt: '2026-07-25T10:50:43.000Z', model: 'route-a',
    promptTokens: 1000, completionTokens: 10
  }, referencePriceFor(config.officialModelPrices, 'route-a'));
  const summary = summarizeDynamicRouteObservations([observation], config);

  assert.equal(summary.status, 'missing_provider_price');
  assert.equal(summary.referenceMissingCount, 0);
  assert.deepEqual(summary.providerPriceMissingModels, ['route-a']);
});
