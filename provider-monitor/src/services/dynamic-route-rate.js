const DYNAMIC_ROUTE_STATISTICS = new Set(['median', 'p90', 'weighted_average', 'latest']);

function finitePositive(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNonnegative(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeDynamicRouteConfig(value = {}) {
  const input = value === true ? { enabled: true } : value || {};
  const statistic = DYNAMIC_ROUTE_STATISTICS.has(input.statistic) ? input.statistic : 'median';
  return {
    enabled: input.enabled === true,
    statistic,
    lookbackDays: boundedInteger(input.lookbackDays, 30, 1, 90),
    minimumSamples: boundedInteger(input.minimumSamples, 3, 1, 1000),
    maxRecords: boundedInteger(input.maxRecords, 5000, 100, 10000)
  };
}

function quantile(sorted, percentile) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function observationWeight(observation) {
  const promptTokens = Math.max(0, Number(observation.promptTokens) || 0);
  const completionTokens = Math.max(0, Number(observation.completionTokens) || 0);
  const cacheTokens = Math.min(promptTokens, Math.max(0, Number(observation.cacheTokens) || 0));
  const completionRatio = finitePositive(observation.completionRatio) ?? 1;
  const cacheRatio = finiteNonnegative(observation.cacheRatio) ?? 1;
  const weightedTokens = (promptTokens - cacheTokens) +
    (cacheTokens * cacheRatio) +
    (completionTokens * completionRatio);
  return weightedTokens > 0 ? weightedTokens : 1;
}

function valueStats(observations) {
  const values = observations
    .map((item) => finitePositive(item.multiplier))
    .filter((item) => item != null)
    .sort((left, right) => left - right);
  if (values.length === 0) {
    return {
      sampleCount: 0,
      minMultiplier: null,
      medianMultiplier: null,
      p90Multiplier: null,
      maxMultiplier: null,
      weightedAverageMultiplier: null,
      latestMultiplier: null
    };
  }
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const observation of observations) {
    const multiplier = finitePositive(observation.multiplier);
    if (multiplier == null) continue;
    const weight = observationWeight(observation);
    weightedTotal += multiplier * weight;
    totalWeight += weight;
  }
  const latest = [...observations]
    .filter((item) => finitePositive(item.multiplier) != null)
    .sort((left, right) => Date.parse(right.requestAt || 0) - Date.parse(left.requestAt || 0))[0];
  return {
    sampleCount: values.length,
    minMultiplier: values[0],
    medianMultiplier: quantile(values, 0.5),
    p90Multiplier: quantile(values, 0.9),
    maxMultiplier: values[values.length - 1],
    weightedAverageMultiplier: totalWeight > 0 ? weightedTotal / totalWeight : null,
    latestMultiplier: finitePositive(latest?.multiplier)
  };
}

function selectedMultiplier(stats, statistic) {
  if (statistic === 'p90') return stats.p90Multiplier;
  if (statistic === 'weighted_average') return stats.weightedAverageMultiplier;
  if (statistic === 'latest') return stats.latestMultiplier;
  return stats.medianMultiplier;
}

function groupedStats(observations, keyFor, labelFor) {
  const groups = new Map();
  for (const observation of observations) {
    const key = String(keyFor(observation) || '').trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  return [...groups.entries()].map(([key, items]) => {
    const latest = [...items].sort((left, right) =>
      Date.parse(right.requestAt || 0) - Date.parse(left.requestAt || 0)
    )[0];
    return {
      id: key,
      name: String(labelFor(latest) || key),
      ...valueStats(items),
      latestRequestAt: latest?.requestAt || null
    };
  }).sort((left, right) => right.sampleCount - left.sampleCount || left.name.localeCompare(right.name));
}

function summarizeDynamicRouteObservations(observations, configValue = {}) {
  const config = normalizeDynamicRouteConfig(configValue);
  const usable = observations.filter((item) => finitePositive(item.multiplier) != null);
  const stats = valueStats(usable);
  const ordered = [...usable].sort((left, right) =>
    Date.parse(right.requestAt || 0) - Date.parse(left.requestAt || 0)
  );
  const latest = ordered[0] || null;
  const selected = selectedMultiplier(stats, config.statistic);
  return {
    ...stats,
    selectedMultiplier: selected,
    statistic: config.statistic,
    status: stats.sampleCount === 0
      ? 'no_samples'
      : stats.sampleCount < config.minimumSamples ? 'low_confidence' : 'detected',
    observedFrom: ordered.at(-1)?.requestAt || null,
    observedTo: latest?.requestAt || null,
    latest: latest ? {
      requestAt: latest.requestAt,
      model: latest.model || null,
      channelId: latest.channelId == null ? null : String(latest.channelId),
      channelName: latest.channelName || null,
      multiplier: finitePositive(latest.multiplier)
    } : null,
    models: groupedStats(usable, (item) => item.model, (item) => item.model),
    channels: groupedStats(
      usable,
      (item) => item.channelId ?? item.channelName,
      (item) => item.channelName || item.channelId
    )
  };
}

module.exports = {
  DYNAMIC_ROUTE_STATISTICS,
  finiteNonnegative,
  finitePositive,
  normalizeDynamicRouteConfig,
  quantile,
  observationWeight,
  summarizeDynamicRouteObservations
};
