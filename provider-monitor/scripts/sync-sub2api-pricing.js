#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { Sub2ApiAdminClient } = require('../src/services/sub2api-admin-client');

const TOKEN_PRICE_FIELDS = [
  ['input', 'input_price'],
  ['output', 'output_price'],
  ['cache_write', 'cache_write_price'],
  ['cache_write_1h', 'cache_write_1h_price'],
  ['cache_read', 'cache_read_price'],
  ['image_input', 'image_input_price'],
  ['image_output', 'image_output_price']
];
const NON_TOKEN_PRICE_FIELDS = [['per_request', 'per_request_price']];
const ALL_PRICE_FIELDS = [...TOKEN_PRICE_FIELDS, ...NON_TOKEN_PRICE_FIELDS];
const RULE_MULTIPLIER_FIELDS = [
  ['fast', 'fast_multiplier'],
  ['flex', 'flex_multiplier'],
  ['max_reasoning_effort', 'max_reasoning_effort_multiplier']
];
const INTERVAL_MULTIPLIER_FIELDS = [
  ['input_multiplier', 'input_multiplier'],
  ['output_multiplier', 'output_multiplier'],
  ['cache_write_multiplier', 'cache_write_multiplier'],
  ['cache_read_multiplier', 'cache_read_multiplier']
];
const BILLING_MODES = new Set(['token', 'per_request', 'image']);
const BILLING_MODEL_SOURCES = new Set(['requested', 'upstream', 'channel_mapped', 'response_model']);

function usage() {
  return `Usage:
  npm run pricing:sync -- --file pricing-template.json
  npm run pricing:sync -- --file pricing-template.json --mode replace --apply

Options:
  --file <path>                 Channel pricing JSON template
  --mode merge|replace         Override template pricing_mode
  --group-mode merge|replace   Override channel.groups.mode
  --apply                       Create/update the channel; default is dry-run
  --help                        Show this message
`;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function parseArgs(argv) {
  const options = { apply: false, mode: '', groupMode: '', file: '' };
  const valueOptions = new Set(['--file', '--mode', '--group-mode']);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    const equalIndex = argument.indexOf('=');
    const name = equalIndex >= 0 ? argument.slice(0, equalIndex) : argument;
    if (!valueOptions.has(name)) throw new Error(`Unknown option: ${argument}`);
    const value = equalIndex >= 0 ? argument.slice(equalIndex + 1) : argv[++index];
    if (value == null || value === '') throw new Error(`${name} requires a value`);
    switch (name) {
      case '--file': options.file = value; break;
      case '--mode': options.mode = value.trim().toLowerCase(); break;
      case '--group-mode': options.groupMode = value.trim().toLowerCase(); break;
      default: break;
    }
  }

  if (options.help) return options;
  if (!options.file) throw new Error('--file is required');
  for (const [name, value] of [['--mode', options.mode], ['--group-mode', options.groupMode]]) {
    if (value && !['merge', 'replace'].includes(value)) {
      throw new Error(`${name} must be merge or replace`);
    }
  }
  return options;
}

function numberValue(value, field, { divideByMillion = false, positive = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (positive ? number <= 0 : number < 0)) {
    throw new Error(`${field} must be a ${positive ? 'positive' : 'non-negative'} number`);
  }
  return divideByMillion ? number / 1_000_000 : number;
}

function integerValue(value, field, { minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${field} must be an integer greater than or equal to ${minimum}`);
  }
  return number;
}

function readAliasedValue(object, name, apiName) {
  if (hasOwn(object, name)) return object[name];
  if (hasOwn(object, apiName)) return object[apiName];
  return undefined;
}

function normalizeModelPattern(value) {
  let pattern = String(value || '').trim().toLowerCase();
  if (pattern.startsWith('claude-')) pattern = pattern.replaceAll('.', '-');
  return pattern;
}

function patternParts(value) {
  const normalized = normalizeModelPattern(value);
  return {
    prefix: normalized.endsWith('*') ? normalized.slice(0, -1) : normalized,
    wildcard: normalized.endsWith('*')
  };
}

function patternsOverlap(left, right) {
  const a = patternParts(left);
  const b = patternParts(right);
  if (!a.prefix || !b.prefix) return true;
  if (!a.wildcard && !b.wildcard) return a.prefix === b.prefix;
  if (a.wildcard && !b.wildcard) return b.prefix.startsWith(a.prefix);
  if (!a.wildcard && b.wildcard) return a.prefix.startsWith(b.prefix);
  return a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix);
}

function validateNoConflicts(rules, label) {
  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      const left = rules[leftIndex];
      const right = rules[rightIndex];
      if (left.platform !== right.platform) continue;
      for (const leftModel of left.models) {
        for (const rightModel of right.models) {
          if (patternsOverlap(leftModel, rightModel)) {
            throw new Error(`${label} has overlapping models ${leftModel} and ${rightModel} on platform ${left.platform}`);
          }
        }
      }
    }
  }
}

function normalizeClock(value, field) {
  const text = String(value == null ? '' : value).trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(text)) {
    throw new Error(`${field} must use HH:MM or HH:MM:SS format`);
  }
  return text;
}

function clockSeconds(value, isEnd = false) {
  if (isEnd && (value === '00:00' || value === '00:00:00')) return 24 * 60 * 60;
  const [hours, minutes, seconds = 0] = value.split(':').map(Number);
  return hours * 60 * 60 + minutes * 60 + seconds;
}

function normalizeTimePricing(value, ruleIndex) {
  const field = `rules[${ruleIndex}].time_pricing`;
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object or null`);
  }
  const periods = value.periods;
  if (!Array.isArray(periods)) throw new Error(`${field}.periods must be an array`);
  if (!periods.length) return null;

  const timezone = String(value.timezone || '').trim();
  if (!timezone || timezone === 'Local') throw new Error(`${field}.timezone must be an IANA timezone`);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`${field}.timezone must be an IANA timezone`);
  }
  if (hasOwn(value, 'weekdays_only') && typeof value.weekdays_only !== 'boolean') {
    throw new Error(`${field}.weekdays_only must be a boolean`);
  }

  const normalizedPeriods = periods.map((period, periodIndex) => {
    if (!period || typeof period !== 'object' || Array.isArray(period)) {
      throw new Error(`${field}.periods[${periodIndex}] must be an object`);
    }
    const startValue = hasOwn(period, 'start_time') ? period.start_time : period.start;
    const endValue = hasOwn(period, 'end_time') ? period.end_time : period.end;
    const start = normalizeClock(startValue, `${field}.periods[${periodIndex}].start_time`);
    const end = normalizeClock(endValue, `${field}.periods[${periodIndex}].end_time`);
    const multiplier = numberValue(period.multiplier, `${field}.periods[${periodIndex}].multiplier`, { positive: true });
    if (multiplier < 0.01 || Math.abs(multiplier * 100 - Math.round(multiplier * 100)) > 1e-9) {
      throw new Error(`${field}.periods[${periodIndex}].multiplier must be at least 0.01 with at most two decimal places`);
    }
    const startSeconds = clockSeconds(start);
    const endSeconds = clockSeconds(end, true);
    if (start === end || startSeconds >= endSeconds) {
      throw new Error(`${field}.periods[${periodIndex}] start must be before end; split cross-midnight ranges at 00:00`);
    }
    return { start_time: start, end_time: end, multiplier, startSeconds, endSeconds };
  }).sort((left, right) => left.startSeconds - right.startSeconds);

  for (let index = 1; index < normalizedPeriods.length; index += 1) {
    if (normalizedPeriods[index].startSeconds < normalizedPeriods[index - 1].endSeconds) {
      throw new Error(`${field}.periods must not overlap`);
    }
  }

  return {
    timezone,
    weekdays_only: value.weekdays_only === true,
    periods: normalizedPeriods.map(({ startSeconds, endSeconds, ...period }) => period)
  };
}

function normalizePriceFields(source, target, fieldPrefix, unit) {
  for (const [name, apiName] of ALL_PRICE_FIELDS) {
    const value = readAliasedValue(source, name, apiName);
    if (value === undefined || value === null || value === '') continue;
    target[apiName] = numberValue(value, `${fieldPrefix}.${name}`, {
      divideByMillion: unit === 'usd_per_1m_tokens' && !NON_TOKEN_PRICE_FIELDS.some(([, api]) => api === apiName)
    });
  }
}

function normalizeMultipliers(source, target, fieldPrefix, fields) {
  for (const [name, apiName] of fields) {
    const value = readAliasedValue(source, name, apiName);
    if (value === undefined || value === null || value === '') continue;
    target[apiName] = numberValue(value, `${fieldPrefix}.${name}`, { positive: true });
  }
}

function normalizeInterval(interval, ruleIndex, intervalIndex, unit) {
  const field = `rules[${ruleIndex}].intervals[${intervalIndex}]`;
  if (!interval || typeof interval !== 'object' || Array.isArray(interval)) {
    throw new Error(`${field} must be an object`);
  }
  const minTokens = integerValue(interval.min_tokens ?? 0, `${field}.min_tokens`);
  let maxTokens = null;
  if (hasOwn(interval, 'max_tokens') && interval.max_tokens != null && interval.max_tokens !== '') {
    maxTokens = integerValue(interval.max_tokens, `${field}.max_tokens`, { minimum: 1 });
    if (maxTokens <= minTokens) throw new Error(`${field}.max_tokens must be greater than min_tokens`);
  }
  const output = {
    min_tokens: minTokens,
    max_tokens: maxTokens,
    tier_label: String(interval.tier_label || '').trim(),
    sort_order: hasOwn(interval, 'sort_order')
      ? integerValue(interval.sort_order, `${field}.sort_order`)
      : intervalIndex
  };
  normalizePriceFields(interval, output, field, unit);
  normalizeMultipliers(interval, output, field, INTERVAL_MULTIPLIER_FIELDS);
  const configured = [...ALL_PRICE_FIELDS, ...INTERVAL_MULTIPLIER_FIELDS]
    .some(([, apiName]) => hasOwn(output, apiName));
  if (!configured) throw new Error(`${field} must configure at least one price or multiplier`);
  return output;
}

function validateTokenIntervals(intervals, ruleIndex) {
  const sorted = [...intervals].sort((left, right) => left.min_tokens - right.min_tokens);
  for (let index = 0; index < sorted.length; index += 1) {
    const interval = sorted[index];
    if (interval.max_tokens == null && index < sorted.length - 1) {
      throw new Error(`rules[${ruleIndex}].intervals has an unbounded interval before the final tier`);
    }
    if (index > 0) {
      const previous = sorted[index - 1];
      if (previous.max_tokens == null || previous.max_tokens > interval.min_tokens) {
        throw new Error(`rules[${ruleIndex}].intervals must not overlap`);
      }
    }
  }
  return sorted.map((interval, index) => ({ ...interval, sort_order: index }));
}

function normalizeRule(rule, unit, ruleIndex) {
  const field = `rules[${ruleIndex}]`;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`${field} must be an object`);
  }
  const sourceModels = Array.isArray(rule.models) ? rule.models : (rule.model ? [rule.model] : []);
  const models = [...new Set(sourceModels.map(normalizeModelPattern).filter(Boolean))];
  if (!models.length) throw new Error(`${field}.models must not be empty`);
  if (models.some((model) => model.includes('*') && model.indexOf('*') !== model.length - 1)) {
    throw new Error(`${field}.models supports only a single trailing * wildcard`);
  }
  const platform = String(rule.platform || '').trim().toLowerCase();
  if (!platform) throw new Error(`${field}.platform is required`);
  const billingMode = String(rule.billing_mode || 'token').trim().toLowerCase();
  if (!BILLING_MODES.has(billingMode)) throw new Error(`${field}.billing_mode is invalid`);

  const output = { platform, models, billing_mode: billingMode };
  normalizePriceFields(rule, output, field, unit);
  normalizeMultipliers(rule, output, field, RULE_MULTIPLIER_FIELDS);

  if (hasOwn(rule, 'intervals') && hasOwn(rule, 'long_context_tiers')) {
    throw new Error(`${field} cannot define both intervals and long_context_tiers`);
  }
  const rawIntervals = hasOwn(rule, 'intervals') ? rule.intervals : rule.long_context_tiers;
  if (rawIntervals !== undefined) {
    if (!Array.isArray(rawIntervals)) throw new Error(`${field}.intervals must be an array`);
    const intervals = rawIntervals.map((interval, index) => normalizeInterval(interval, ruleIndex, index, unit));
    output.intervals = billingMode === 'token' ? validateTokenIntervals(intervals, ruleIndex) : intervals;
  }

  if ((billingMode === 'per_request' || billingMode === 'image') &&
      !hasOwn(output, 'per_request_price') && !(output.intervals || []).length) {
    throw new Error(`${field} requires per_request or intervals for ${billingMode} billing`);
  }

  if (hasOwn(rule, 'time_pricing') && hasOwn(rule, 'peak_valley')) {
    throw new Error(`${field} cannot define both time_pricing and peak_valley`);
  }
  if (hasOwn(rule, 'time_pricing') || hasOwn(rule, 'peak_valley')) {
    if (billingMode !== 'token') throw new Error(`${field}.time_pricing only supports token billing`);
    output.time_pricing = normalizeTimePricing(
      hasOwn(rule, 'time_pricing') ? rule.time_pricing : rule.peak_valley,
      ruleIndex
    );
  }
  return output;
}

function arrayValue(value, field) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    const normalized = String(item).trim();
    if (!normalized) throw new Error(`${field} must not contain empty values`);
    return normalized;
  });
}

function normalizeGroupConfig(value) {
  if (Array.isArray(value)) value = { ids: value };
  if (!value || typeof value !== 'object') throw new Error('channel.groups must be an object or ID array');
  const mode = String(value.mode || 'merge').trim().toLowerCase();
  if (!['merge', 'replace'].includes(mode)) throw new Error('channel.groups.mode must be merge or replace');
  if (hasOwn(value, 'all') && typeof value.all !== 'boolean') throw new Error('channel.groups.all must be a boolean');
  if (hasOwn(value, 'include_inactive') && typeof value.include_inactive !== 'boolean') {
    throw new Error('channel.groups.include_inactive must be a boolean');
  }
  const ids = arrayValue(value.ids, 'channel.groups.ids').map((id) =>
    integerValue(id, 'channel.groups.ids', { minimum: 1 }));
  return {
    mode,
    ids: [...new Set(ids)],
    names: [...new Set(arrayValue(value.names, 'channel.groups.names').map((name) => name.toLowerCase()))],
    nameContains: [...new Set(arrayValue(value.name_contains, 'channel.groups.name_contains').map((name) => name.toLowerCase()))],
    platforms: [...new Set(arrayValue(value.platforms, 'channel.groups.platforms').map((platform) => platform.toLowerCase()))],
    all: value.all === true,
    includeInactive: value.include_inactive !== false
  };
}

function normalizeChannelConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('template channel must be an object');
  }
  const name = String(value.name || '').trim();
  if (!name) throw new Error('channel.name is required');
  if (name.length > 100) throw new Error('channel.name must not exceed 100 characters');
  if (hasOwn(value, 'groups') && hasOwn(value, 'group_ids')) {
    throw new Error('channel cannot define both groups and group_ids');
  }
  const output = {
    name,
    groups: hasOwn(value, 'groups')
      ? normalizeGroupConfig(value.groups)
      : (hasOwn(value, 'group_ids') ? normalizeGroupConfig(value.group_ids) : null)
  };
  if (hasOwn(value, 'description')) output.description = String(value.description ?? '');
  if (hasOwn(value, 'status')) {
    output.status = String(value.status || '').trim().toLowerCase();
    if (!['active', 'disabled'].includes(output.status)) throw new Error('channel.status must be active or disabled');
  }
  if (hasOwn(value, 'billing_model_source')) {
    output.billing_model_source = String(value.billing_model_source || '').trim().toLowerCase();
    if (!BILLING_MODEL_SOURCES.has(output.billing_model_source)) {
      throw new Error('channel.billing_model_source is invalid');
    }
  }
  if (hasOwn(value, 'restrict_models')) {
    if (typeof value.restrict_models !== 'boolean') throw new Error('channel.restrict_models must be a boolean');
    output.restrict_models = value.restrict_models;
  }
  return output;
}

function normalizeTemplate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('pricing template must be a JSON object');
  }
  if (hasOwn(input, 'peak_rate')) {
    throw new Error('top-level peak_rate was a group-pricing option; move peak/valley periods into each rule.time_pricing');
  }
  const unit = String(input.unit || 'usd_per_1m_tokens').trim().toLowerCase();
  if (!['usd_per_1m_tokens', 'usd_per_token'].includes(unit)) {
    throw new Error('template unit must be usd_per_1m_tokens or usd_per_token');
  }
  const pricingMode = String(input.pricing_mode || 'merge').trim().toLowerCase();
  if (!['merge', 'replace'].includes(pricingMode)) throw new Error('pricing_mode must be merge or replace');
  if (!Array.isArray(input.rules) || !input.rules.length) {
    throw new Error('pricing template rules must be a non-empty array');
  }
  const rules = input.rules.map((rule, index) => normalizeRule(rule, unit, index));
  validateNoConflicts(rules, 'pricing template');
  return { unit, pricingMode, channel: normalizeChannelConfig(input.channel), rules };
}

function cloneRule(rule) {
  const cloned = JSON.parse(JSON.stringify(rule || {}));
  delete cloned.id;
  delete cloned.channel_id;
  delete cloned.created_at;
  delete cloned.updated_at;
  cloned.platform = String(cloned.platform || 'anthropic').trim().toLowerCase();
  cloned.models = Array.isArray(cloned.models)
    ? [...new Set(cloned.models.map(normalizeModelPattern).filter(Boolean))]
    : [];
  cloned.billing_mode = String(cloned.billing_mode || 'token').trim().toLowerCase();
  if (Array.isArray(cloned.intervals)) {
    cloned.intervals = cloned.intervals.map((interval) => {
      const clean = { ...interval };
      delete clean.id;
      delete clean.pricing_id;
      delete clean.created_at;
      delete clean.updated_at;
      return clean;
    });
  }
  return cloned;
}

function mergePricing(existing, incoming, mode) {
  const incomingRules = incoming.map(cloneRule);
  validateNoConflicts(incomingRules, 'incoming pricing');
  if (mode === 'replace') return incomingRules;

  const retained = [];
  for (const source of Array.isArray(existing) ? existing : []) {
    const oldRule = cloneRule(source);
    const remainingModels = oldRule.models.filter((oldModel) => !incomingRules.some((newRule) =>
      newRule.platform === oldRule.platform && newRule.models.some((newModel) => patternsOverlap(oldModel, newModel))));
    if (remainingModels.length) retained.push({ ...oldRule, models: remainingModels });
  }
  const merged = [...incomingRules, ...retained];
  validateNoConflicts(merged, 'merged pricing');
  return merged;
}

function readGroupsPayload(payload) {
  const groups = Array.isArray(payload) ? payload : payload?.items || payload?.groups;
  if (!Array.isArray(groups)) throw new Error('Sub2API group response did not contain an array');
  return groups;
}

function selectGroups(groups, config) {
  if (!config) return [];
  const available = groups.filter((group) => config.includeInactive || String(group.status || '').toLowerCase() === 'active');
  const availableIds = new Set(available.map((group) => Number(group.id)));
  for (const id of config.ids) {
    if (!availableIds.has(id)) throw new Error(`channel.groups.ids contains unavailable group ${id}`);
  }
  for (const name of config.names) {
    if (!available.some((group) => String(group.name || '').trim().toLowerCase() === name)) {
      throw new Error(`channel.groups.names did not match ${name}`);
    }
  }
  const hasSelectors = config.all || config.ids.length || config.names.length ||
    config.nameContains.length || config.platforms.length;
  if (!hasSelectors) return [];
  const ids = new Set(config.ids);
  return available.filter((group) => {
    const name = String(group.name || '').trim().toLowerCase();
    const platform = String(group.platform || '').trim().toLowerCase();
    return config.all || ids.has(Number(group.id)) || config.names.includes(name) ||
      config.nameContains.some((fragment) => name.includes(fragment)) || config.platforms.includes(platform);
  });
}

function uniqueSortedIds(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function resolveGroupIDs(existing, selected, config, modeOverride = '') {
  const current = uniqueSortedIds(existing?.group_ids || []);
  if (!config) return current;
  const selectedIds = uniqueSortedIds(selected.map((group) => group.id));
  const mode = modeOverride || config.mode;
  return mode === 'replace' ? selectedIds : uniqueSortedIds([...current, ...selectedIds]);
}

function findGroupConflicts(channels, targetChannel, groupIDs) {
  const wanted = new Set(groupIDs);
  const conflicts = [];
  for (const channel of channels) {
    if (targetChannel && Number(channel.id) === Number(targetChannel.id)) continue;
    for (const groupID of channel.group_ids || []) {
      if (wanted.has(Number(groupID))) {
        conflicts.push({ group_id: Number(groupID), channel_id: channel.id, channel_name: channel.name });
      }
    }
  }
  return conflicts.sort((left, right) => left.group_id - right.group_id);
}

function findChannel(channels, name) {
  const exact = channels.find((channel) => String(channel.name || '').trim() === name);
  if (exact) return exact;
  const caseInsensitive = channels.filter((channel) =>
    String(channel.name || '').trim().toLowerCase() === name.toLowerCase());
  if (caseInsensitive.length > 1) throw new Error(`multiple channels match name ${name} case-insensitively`);
  return caseInsensitive[0] || null;
}

function configuredChannelFields(channelConfig) {
  const fields = {};
  for (const key of ['description', 'status', 'billing_model_source', 'restrict_models']) {
    if (hasOwn(channelConfig, key)) fields[key] = channelConfig[key];
  }
  return fields;
}

function groupOverrideSummary(groups, groupIDs) {
  const wanted = new Set(groupIDs);
  return groups
    .filter((group) => wanted.has(Number(group.id)) && Array.isArray(group.model_pricing) && group.model_pricing.length)
    .map((group) => ({
      id: Number(group.id),
      name: group.name,
      platform: group.platform,
      pricing_rules: group.model_pricing.length
    }));
}

function configFromEnvironment(env = process.env) {
  const baseUrl = String(env.SUB2API_BASE_URL || 'http://localhost:8080').trim().replace(/\/+$/, '');
  return {
    sub2apiBaseUrl: baseUrl,
    sub2apiAdminApiKey: String(env.SUB2API_ADMIN_API_KEY || ''),
    sub2apiAdminToken: String(env.SUB2API_ADMIN_TOKEN || ''),
    adminEmail: String(env.ADMIN_EMAIL || ''),
    adminPassword: String(env.ADMIN_PASSWORD || ''),
    queryTimeoutMs: Number(env.PROVIDER_MONITOR_QUERY_TIMEOUT_MS || env.SUB2API_QUERY_TIMEOUT_MS || 15000),
    maxResponseBytes: Number(env.PROVIDER_MONITOR_MAX_RESPONSE_BYTES || 2 * 1024 * 1024)
  };
}

async function syncPricing({ client, template, options, logger = console }) {
  const normalized = normalizeTemplate(template);
  if (options.groupMode && !normalized.channel.groups) {
    throw new Error('--group-mode requires channel.groups in the template');
  }
  const [channelResult, groupsPayload] = await Promise.all([
    client.listAll('/api/v1/admin/channels', {}, { maxItems: 50000 }),
    client.data('/api/v1/admin/groups/all', { query: { include_inactive: true } })
  ]);
  const channels = channelResult?.items;
  if (!Array.isArray(channels)) throw new Error('Sub2API channel response did not contain an items array');
  if (channelResult.truncated) throw new Error('Sub2API channel list was truncated; refusing an ambiguous upsert');
  const groups = readGroupsPayload(groupsPayload);
  const existing = findChannel(channels, normalized.channel.name);
  const selectedGroups = selectGroups(groups, normalized.channel.groups);
  const groupMode = options.groupMode || normalized.channel.groups?.mode || null;
  const nextGroupIDs = resolveGroupIDs(existing, selectedGroups, normalized.channel.groups, options.groupMode);
  const conflicts = findGroupConflicts(channels, existing, nextGroupIDs);
  if (conflicts.length) {
    const details = conflicts.map((conflict) =>
      `group ${conflict.group_id} already belongs to channel ${conflict.channel_name} (${conflict.channel_id})`).join('; ');
    throw new Error(`cannot associate channel groups: ${details}`);
  }

  const pricingMode = options.mode || normalized.pricingMode;
  const existingPricing = Array.isArray(existing?.model_pricing) ? existing.model_pricing : [];
  const nextPricing = mergePricing(existingPricing, normalized.rules, pricingMode);
  const summary = {
    action: existing ? 'update' : 'create',
    id: existing?.id ?? null,
    name: normalized.channel.name,
    pricing_mode: pricingMode,
    pricing_before: existingPricing.length,
    pricing_incoming: normalized.rules.length,
    pricing_after: nextPricing.length,
    group_mode: normalized.channel.groups ? groupMode : 'preserve',
    groups_before: uniqueSortedIds(existing?.group_ids || []),
    groups_selected: uniqueSortedIds(selectedGroups.map((group) => group.id)),
    groups_selected_detail: selectedGroups.map((group) => ({
      id: Number(group.id),
      name: group.name,
      platform: group.platform,
      status: group.status
    })),
    groups_after: nextGroupIDs,
    group_pricing_overrides: groupOverrideSummary(groups, nextGroupIDs),
    channel_fields: configuredChannelFields(normalized.channel),
    model_pricing: nextPricing,
    applied: false
  };

  if (options.apply) {
    if (existing) {
      const body = {
        name: normalized.channel.name,
        model_pricing: nextPricing,
        ...configuredChannelFields(normalized.channel)
      };
      if (normalized.channel.groups) body.group_ids = nextGroupIDs;
      await client.data(`/api/v1/admin/channels/${existing.id}`, { method: 'PUT', body });
    } else {
      const fields = configuredChannelFields(normalized.channel);
      delete fields.status;
      const created = await client.data('/api/v1/admin/channels', {
        method: 'POST',
        body: {
          name: normalized.channel.name,
          group_ids: nextGroupIDs,
          model_pricing: nextPricing,
          ...fields
        }
      });
      summary.id = created?.id ?? null;
      if (!summary.id) throw new Error('Sub2API channel create response did not contain an ID');
      if (normalized.channel.status === 'disabled') {
        await client.data(`/api/v1/admin/channels/${summary.id}`, {
          method: 'PUT',
          body: { status: 'disabled' }
        });
      }
    }
    summary.applied = true;
  }

  logger.log(JSON.stringify({ dry_run: !options.apply, channel: summary }, null, 2));
  return summary;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  const filePath = path.resolve(process.cwd(), options.file);
  const template = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const client = new Sub2ApiAdminClient(configFromEnvironment(env));
  return syncPricing({ client, template, options });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`pricing:sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALL_PRICE_FIELDS,
  configFromEnvironment,
  findGroupConflicts,
  mergePricing,
  normalizeTemplate,
  normalizeTimePricing,
  parseArgs,
  patternsOverlap,
  resolveGroupIDs,
  selectGroups,
  syncPricing
};
