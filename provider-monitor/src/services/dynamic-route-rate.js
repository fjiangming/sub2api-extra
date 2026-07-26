const DYNAMIC_ROUTE_STATISTICS = new Set(['median', 'p90', 'weighted_average', 'latest']);
const DYNAMIC_ROUTE_PRICE_BASES = new Set(['official_relative']);

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

function normalizeReferencePrices(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [rawKey, rawEntry] of Object.entries(value)) {
    const key = String(rawKey || '').trim().toLowerCase();
    if (!key || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const inputPerMillion = finitePositive(rawEntry.inputPerMillion ?? rawEntry.input);
    const outputPerMillion = finitePositive(rawEntry.outputPerMillion ?? rawEntry.output);
    const cacheReadPerMillion = finiteNonnegative(
      rawEntry.cacheReadPerMillion ?? rawEntry.cachedInputPerMillion ??
      rawEntry.cacheRead ?? rawEntry.cachedInput
    );
    const explicitModel = String(rawEntry.model || rawEntry.officialModel || '').trim();
    const isAlias = explicitModel && explicitModel.toLowerCase() !== key;
    if (inputPerMillion == null && outputPerMillion == null && cacheReadPerMillion == null && !isAlias) continue;
    result[key] = {
      key,
      model: explicitModel || rawKey,
      inputPerMillion,
      outputPerMillion,
      cacheReadPerMillion
    };
  }
  return result;
}

function normalizeDynamicRouteConfig(value = {}) {
  const input = value === true ? { enabled: true } : value || {};
  const statistic = DYNAMIC_ROUTE_STATISTICS.has(input.statistic) ? input.statistic : 'median';
  return {
    enabled: input.enabled === true,
    statistic,
    priceBasis: 'official_relative',
    officialModelPrices: normalizeReferencePrices(input.officialModelPrices),
    lookbackDays: boundedInteger(input.lookbackDays, 30, 1, 90),
    minimumSamples: boundedInteger(input.minimumSamples, 3, 1, 1000),
    maxRecords: boundedInteger(input.maxRecords, 5000, 100, 10000)
  };
}

function resolvedReferencePrice(prices, entry, seen = new Set()) {
  if (!entry || seen.has(entry.key)) return null;
  if (
    entry.inputPerMillion != null ||
    entry.outputPerMillion != null ||
    entry.cacheReadPerMillion != null
  ) return entry;
  seen.add(entry.key);
  const target = prices[String(entry.model || '').trim().toLowerCase()];
  return resolvedReferencePrice(prices, target, seen);
}

function referencePriceFor(
  pricesValue,
  model,
  channelId = null,
  channelName = null,
  providerId = null,
  providerName = null
) {
  const prices = pricesValue || {};
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel) return null;
  const baseCandidates = [
    channelId == null ? null : `${normalizedModel}@${String(channelId).trim().toLowerCase()}`,
    channelName ? `${normalizedModel}@${String(channelName).trim().toLowerCase()}` : null,
    normalizedModel
  ].filter(Boolean);
  const providerPrefixes = [providerId, providerName]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const candidates = [
    ...providerPrefixes.flatMap((provider) => baseCandidates.map((candidate) => `${provider}/${candidate}`)),
    ...baseCandidates,
    '*'
  ];
  for (const key of candidates) {
    const resolved = resolvedReferencePrice(prices, prices[key]);
    if (resolved) return resolved;
  }
  return null;
}

const LOG_PRICE_ALIASES = {
  input: {
    effectivePerMillion: [
      'effective_input_price_per_million', 'effectiveInputPricePerMillion',
      'billed_input_price_per_million', 'billedInputPricePerMillion'
    ],
    basePerMillion: [
      'input_price_per_million', 'inputPricePerMillion', 'input_per_million', 'inputPerMillion',
      'input_price', 'inputPrice', 'prompt_price', 'promptPrice'
    ],
    effectivePerToken: ['effective_input_price_per_token', 'effectiveInputPricePerToken'],
    basePerToken: ['input_price_per_token', 'inputPricePerToken', 'prompt_price_per_token']
  },
  output: {
    effectivePerMillion: [
      'effective_output_price_per_million', 'effectiveOutputPricePerMillion',
      'billed_output_price_per_million', 'billedOutputPricePerMillion'
    ],
    basePerMillion: [
      'output_price_per_million', 'outputPricePerMillion', 'output_per_million', 'outputPerMillion',
      'output_price', 'outputPrice', 'completion_price', 'completionPrice'
    ],
    effectivePerToken: ['effective_output_price_per_token', 'effectiveOutputPricePerToken'],
    basePerToken: ['output_price_per_token', 'outputPricePerToken', 'completion_price_per_token']
  },
  cacheRead: {
    effectivePerMillion: [
      'effective_cache_read_price_per_million', 'effectiveCacheReadPricePerMillion',
      'billed_cache_read_price_per_million', 'billedCacheReadPricePerMillion'
    ],
    basePerMillion: [
      'cache_read_price_per_million', 'cacheReadPricePerMillion',
      'cached_input_price_per_million', 'cachedInputPricePerMillion',
      'cache_read_price', 'cacheReadPrice', 'cached_input_price', 'cachedInputPrice'
    ],
    effectivePerToken: ['effective_cache_read_price_per_token', 'effectiveCacheReadPricePerToken'],
    basePerToken: ['cache_read_price_per_token', 'cacheReadPricePerToken', 'cached_input_price_per_token']
  }
};

function logPriceContainers(row = {}, other = {}) {
  const result = [];
  for (const value of [row, other]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    result.push(value);
    for (const key of ['prices', 'billing_prices', 'billingPrices', 'price_detail', 'priceDetail', 'billing']) {
      const nested = value[key];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) result.push(nested);
    }
  }
  return result;
}

function firstLogPrice(containers, aliases, { allowZero = false, scale = 1, includesGroupRatio = false } = {}) {
  for (const container of containers) {
    for (const field of aliases) {
      const value = allowZero ? finiteNonnegative(container[field]) : finitePositive(container[field]);
      if (value != null) {
        return { value: value * scale, field, includesGroupRatio };
      }
    }
  }
  return null;
}

function logPriceComponent(containers, aliases, allowZero = false) {
  return firstLogPrice(containers, aliases.effectivePerMillion, { allowZero, includesGroupRatio: true }) ||
    firstLogPrice(containers, aliases.basePerMillion, { allowZero }) ||
    firstLogPrice(containers, aliases.effectivePerToken, {
      allowZero, scale: 1000000, includesGroupRatio: true
    }) ||
    firstLogPrice(containers, aliases.basePerToken, { allowZero, scale: 1000000 });
}

function extractLoggedProviderPrices(row = {}, other = {}) {
  const containers = logPriceContainers(row, other);
  const input = logPriceComponent(containers, LOG_PRICE_ALIASES.input);
  const output = logPriceComponent(containers, LOG_PRICE_ALIASES.output);
  const cacheRead = logPriceComponent(containers, LOG_PRICE_ALIASES.cacheRead, true);
  if (!input && !output && !cacheRead) return null;
  return { input, output, cacheRead };
}

function effectiveLoggedComponent(component, groupRatio) {
  if (!component) return null;
  return {
    value: component.value * (component.includesGroupRatio ? 1 : groupRatio),
    source: 'log_explicit',
    field: component.field
  };
}

function providerPricesForObservation(observation, quotaPerUnit) {
  const modelRatio = finitePositive(observation.modelRatio);
  const groupRatio = finitePositive(observation.groupRatio) ?? 1;
  const divisor = finitePositive(observation.quotaPerUnit) ?? finitePositive(quotaPerUnit);
  const completionRatio = finitePositive(observation.completionRatio);
  const cacheRatio = finiteNonnegative(observation.cacheRatio);
  const logged = observation.loggedProviderPrices || null;
  const loggedInput = effectiveLoggedComponent(logged?.input, groupRatio);
  const loggedOutput = effectiveLoggedComponent(logged?.output, groupRatio);
  const loggedCacheRead = effectiveLoggedComponent(logged?.cacheRead, groupRatio);
  const ratioInput = modelRatio != null && divisor != null
    ? { value: modelRatio * groupRatio * (1000000 / divisor), source: 'log_ratio' }
    : null;
  const input = loggedInput || ratioInput;
  const output = loggedOutput || (loggedInput && completionRatio != null ? {
    value: loggedInput.value * completionRatio, source: 'log_explicit_ratio'
  } : null) || (ratioInput ? {
    value: ratioInput.value * (completionRatio ?? 1), source: 'log_ratio'
  } : null);
  const cacheRead = loggedCacheRead || (loggedInput && cacheRatio != null ? {
    value: loggedInput.value * cacheRatio, source: 'log_explicit_ratio'
  } : null) || (ratioInput ? {
    value: ratioInput.value * (cacheRatio ?? 1), source: 'log_ratio'
  } : null);
  const components = { input, output, cacheRead };
  const promptTokens = Math.max(0, Number(observation.promptTokens) || 0);
  const completionTokens = Math.max(0, Number(observation.completionTokens) || 0);
  const cacheTokens = Math.min(promptTokens, Math.max(0, Number(observation.cacheTokens) || 0));
  const usedComponentNames = [];
  if (promptTokens - cacheTokens > 0) usedComponentNames.push('input');
  if (completionTokens > 0) usedComponentNames.push('output');
  if (cacheTokens > 0) usedComponentNames.push('cacheRead');
  if (usedComponentNames.length === 0) usedComponentNames.push('input');
  const sourceFamilies = [...new Set(usedComponentNames.map((key) => components[key]).filter(Boolean).map((item) => {
    if (item.source.startsWith('log_explicit')) return 'log_explicit';
    return item.source;
  }))];
  return {
    inputPerMillion: input?.value ?? null,
    outputPerMillion: output?.value ?? null,
    cacheReadPerMillion: cacheRead?.value ?? null,
    source: sourceFamilies.length === 1 ? sourceFamilies[0] : sourceFamilies.length > 1 ? 'mixed' : null,
    sources: Object.fromEntries(Object.entries(components).map(([key, item]) => [key, item?.source || null])),
    fields: Object.fromEntries(Object.entries(components).map(([key, item]) => [key, item?.field || null]))
  };
}

function officialRelativeObservation(
  observation,
  referencePrice,
  quotaPerUnit = 500000
) {
  const providerPrice = providerPricesForObservation(observation, quotaPerUnit);
  const providerPriceDetails = {
    providerPriceSource: providerPrice.source,
    providerPriceSources: providerPrice.sources,
    providerPriceFields: providerPrice.fields,
    providerInputPerMillion: providerPrice.inputPerMillion,
    providerOutputPerMillion: providerPrice.outputPerMillion,
    providerCacheReadPerMillion: providerPrice.cacheReadPerMillion
  };
  if (!referencePrice) {
    return {
      ...observation,
      ...providerPriceDetails,
      multiplier: null,
      referenceMissing: true,
      referenceMissingReason: 'model'
    };
  }

  const promptTokens = Math.max(0, Number(observation.promptTokens) || 0);
  const completionTokens = Math.max(0, Number(observation.completionTokens) || 0);
  const cacheTokens = Math.min(promptTokens, Math.max(0, Number(observation.cacheTokens) || 0));
  const uncachedInputTokens = promptTokens - cacheTokens;
  const providerInputPerMillion = providerPrice.inputPerMillion;
  const providerOutputPerMillion = providerPrice.outputPerMillion;
  const providerCacheReadPerMillion = providerPrice.cacheReadPerMillion;

  const missingProviderInput = uncachedInputTokens > 0 && providerInputPerMillion == null;
  const missingProviderOutput = completionTokens > 0 && providerOutputPerMillion == null;
  const missingProviderCache = cacheTokens > 0 && providerCacheReadPerMillion == null;
  if (missingProviderInput || missingProviderOutput || missingProviderCache) {
    return {
      ...observation,
      ...providerPriceDetails,
      multiplier: null,
      referenceMissing: false,
      providerPriceMissing: true,
      providerPriceMissingReason: missingProviderInput ? 'input' : missingProviderOutput ? 'output' : 'cache_read',
      referenceModel: referencePrice.model
    };
  }

  const missingInput = uncachedInputTokens > 0 && referencePrice.inputPerMillion == null;
  const missingOutput = completionTokens > 0 && referencePrice.outputPerMillion == null;
  const missingCache = cacheTokens > 0 && referencePrice.cacheReadPerMillion == null;
  if (missingInput || missingOutput || missingCache) {
    return {
      ...observation,
      ...providerPriceDetails,
      multiplier: null,
      referenceMissing: true,
      referenceMissingReason: missingInput ? 'input' : missingOutput ? 'output' : 'cache_read',
      referenceModel: referencePrice.model
    };
  }

  let providerCostUnits =
    (uncachedInputTokens * providerInputPerMillion) +
    (cacheTokens * providerCacheReadPerMillion) +
    (completionTokens * providerOutputPerMillion);
  let referenceCostUnits =
    (uncachedInputTokens * Number(referencePrice.inputPerMillion || 0)) +
    (cacheTokens * Number(referencePrice.cacheReadPerMillion || 0)) +
    (completionTokens * Number(referencePrice.outputPerMillion || 0));

  // Logs without token counts can still provide a stable input-price ratio.
  if (providerCostUnits <= 0 && referenceCostUnits <= 0 && referencePrice.inputPerMillion != null) {
    providerCostUnits = providerInputPerMillion;
    referenceCostUnits = referencePrice.inputPerMillion;
  }
  const multiplier = referenceCostUnits > 0 ? providerCostUnits / referenceCostUnits : null;
  if (finitePositive(multiplier) == null) {
    return {
      ...observation,
      ...providerPriceDetails,
      multiplier: null,
      referenceMissing: false,
      providerPriceMissing: true,
      providerPriceMissingReason: 'usable_cost',
      referenceModel: referencePrice.model
    };
  }
  return {
    ...observation,
    ...providerPriceDetails,
    multiplier,
    referenceMissing: false,
    providerPriceMissing: false,
    referenceModel: referencePrice.model,
    referenceCostWeight: referenceCostUnits,
    providerCost: providerCostUnits / 1000000,
    referenceCost: referenceCostUnits / 1000000,
    referenceInputPerMillion: referencePrice.inputPerMillion,
    referenceOutputPerMillion: referencePrice.outputPerMillion,
    referenceCacheReadPerMillion: referencePrice.cacheReadPerMillion
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
  const referenceCostWeight = finitePositive(observation.referenceCostWeight);
  if (referenceCostWeight != null) return referenceCostWeight;
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
      referenceMissingCount: items.filter((item) => item.referenceMissing).length,
      latestRequestAt: latest?.requestAt || null
    };
  }).sort((left, right) => right.sampleCount - left.sampleCount || left.name.localeCompare(right.name));
}

function summarizeDynamicRouteObservations(observations, configValue = {}) {
  const config = normalizeDynamicRouteConfig(configValue);
  const usable = observations.filter((item) => finitePositive(item.multiplier) != null);
  const stats = valueStats(usable);
  const orderedAll = [...observations].sort((left, right) =>
    Date.parse(right.requestAt || 0) - Date.parse(left.requestAt || 0)
  );
  const ordered = orderedAll.filter((item) => finitePositive(item.multiplier) != null);
  const latest = ordered[0] || null;
  const latestObserved = orderedAll[0] || null;
  const referenceMissing = observations.filter((item) => item.referenceMissing);
  const providerPriceMissing = observations.filter((item) => item.providerPriceMissing);
  const selected = selectedMultiplier(stats, config.statistic);
  let status;
  if (stats.sampleCount === 0 && providerPriceMissing.length > 0) status = 'missing_provider_price';
  else if (stats.sampleCount === 0 && referenceMissing.length > 0) status = 'missing_reference_price';
  else if (stats.sampleCount === 0) status = 'no_samples';
  else if (
    config.priceBasis === 'official_relative' &&
    providerPriceMissing.length > 0
  ) status = 'partial_provider_price';
  else if (
    config.priceBasis === 'official_relative' &&
    referenceMissing.length > 0
  ) status = 'partial_reference_price';
  else if (stats.sampleCount < config.minimumSamples) status = 'low_confidence';
  else status = 'detected';
  return {
    ...stats,
    selectedMultiplier: selected,
    statistic: config.statistic,
    priceBasis: config.priceBasis,
    status,
    totalObservationCount: observations.length,
    providerPriceMissingCount: providerPriceMissing.length,
    providerPriceMissingModels: [...new Set(providerPriceMissing.map((item) => item.model).filter(Boolean))],
    referenceMissingCount: referenceMissing.length,
    referenceMissingModels: [...new Set(referenceMissing
      .map((item) => item.officialLookupModel || item.model)
      .filter(Boolean))],
    observedFrom: orderedAll.at(-1)?.requestAt || null,
    observedTo: latestObserved?.requestAt || null,
    latest: latest ? {
      requestAt: latest.requestAt,
      model: latest.model || null,
      officialLookupModel: latest.officialLookupModel || null,
      channelId: latest.channelId == null ? null : String(latest.channelId),
      channelName: latest.channelName || null,
      multiplier: finitePositive(latest.multiplier),
      providerPriceSource: latest.providerPriceSource || null,
      providerPriceSources: latest.providerPriceSources || null,
      providerPriceFields: latest.providerPriceFields || null,
      referenceModel: latest.referenceModel || null,
      providerCost: finitePositive(latest.providerCost),
      referenceCost: finitePositive(latest.referenceCost),
      providerInputPerMillion: finitePositive(latest.providerInputPerMillion),
      providerOutputPerMillion: finitePositive(latest.providerOutputPerMillion),
      providerCacheReadPerMillion: finitePositive(latest.providerCacheReadPerMillion),
      referenceInputPerMillion: finitePositive(latest.referenceInputPerMillion),
      referenceOutputPerMillion: finitePositive(latest.referenceOutputPerMillion),
      referenceCacheReadPerMillion: finitePositive(latest.referenceCacheReadPerMillion)
    } : null,
    latestObserved: latestObserved ? {
      requestAt: latestObserved.requestAt,
      model: latestObserved.model || null,
      officialLookupModel: latestObserved.officialLookupModel || null,
      channelId: latestObserved.channelId == null ? null : String(latestObserved.channelId),
      channelName: latestObserved.channelName || null,
      providerPriceSource: latestObserved.providerPriceSource || null,
      providerPriceMissing: latestObserved.providerPriceMissing === true,
      providerPriceMissingReason: latestObserved.providerPriceMissingReason || null,
      referenceMissing: latestObserved.referenceMissing === true,
      referenceMissingReason: latestObserved.referenceMissingReason || null
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
  DYNAMIC_ROUTE_PRICE_BASES,
  DYNAMIC_ROUTE_STATISTICS,
  finiteNonnegative,
  finitePositive,
  normalizeDynamicRouteConfig,
  normalizeReferencePrices,
  extractLoggedProviderPrices,
  officialRelativeObservation,
  providerPricesForObservation,
  quantile,
  referencePriceFor,
  observationWeight,
  summarizeDynamicRouteObservations
};
