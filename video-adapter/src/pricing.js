'use strict';

const { ensure } = require('./errors');
const { decimal, money } = require('./money');

function matchPrice(entries, model) {
  const name = model.trim().toLowerCase();
  let wildcard;
  for (const entry of entries || []) {
    for (const raw of entry.models || []) {
      const pattern = raw.trim().toLowerCase();
      if (name === pattern) return entry;
      if (!wildcard && pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) wildcard = entry;
    }
  }
  return wildcard;
}

function priceFamily(model) {
  const name = model.toLowerCase().replace(/^(xai|x-ai|grok)\//, '');
  if (['grok-imagine-video-1.5', 'grok-imagine-video-1.5-preview', 'grok-video-1.5'].includes(name)) return 'grok-imagine-video-1.5';
  if (['grok-imagine-video', 'grok-imagine-video-preview', 'grok-video', 'grok-video-latest'].includes(name)) return 'grok-imagine-video';
  return name;
}

function configuredPrice(entry, resolution) {
  ensure(['video', 'per_request', 'image'].includes(entry.billing_mode), 'BILLING_MODE_UNSUPPORTED', 'Token billing cannot price a video', 409);
  ensure(!entry.time_pricing?.periods?.length, 'TIME_PRICING_UNSUPPORTED', 'Use a dedicated video card without channel token time pricing', 409);
  const tiers = entry.intervals || [];
  const match = tiers.find(t => String(t.tier_label || '') === resolution && t.per_request_price != null);
  const fallback = tiers.find(t => !t.tier_label && (t.min_tokens ?? 0) === 0 && t.max_tokens == null && t.per_request_price != null);
  const unit = match?.per_request_price ?? fallback?.per_request_price ?? entry.per_request_price;
  ensure(unit != null, 'SELL_PRICE_MISSING', 'An explicit selling price for this tier is required', 409);
  return { unit, mode: entry.billing_mode === 'video' ? 'per_second' : 'per_request' };
}

function peakMultiplier(group, timezone, now) {
  if (!group.peak_rate_enabled) return '1';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const at = `${parts.find(p => p.type === 'hour').value}:${parts.find(p => p.type === 'minute').value}`;
  ensure(/^\d{2}:\d{2}$/.test(group.peak_start) && /^\d{2}:\d{2}$/.test(group.peak_end) && group.peak_start < group.peak_end, 'INVALID_PEAK_RATE', 'Invalid Sub2API peak pricing configuration', 409);
  return at >= group.peak_start && at < group.peak_end ? group.peak_rate_multiplier : '1';
}

function resolveSellingPrice(group, userRate, channelEntries, request, config, now = new Date()) {
  const groupEntry = matchPrice(group.model_pricing, request.model);
  const familyPrice = group.video_model_prices?.[priceFamily(request.model)]?.[request.resolution];
  const defaultPrice = group[`video_price_${request.resolution}`];
  let chosen;
  let source;
  // Mirrors the core Grok video precedence; absence never falls back to xAI prices.
  if (groupEntry?.billing_mode === 'video') {
    chosen = configuredPrice(groupEntry, request.resolution); source = 'group.model_pricing';
  } else if (familyPrice != null || defaultPrice != null) {
    chosen = { unit: familyPrice ?? defaultPrice, mode: 'per_second' }; source = familyPrice != null ? 'group.video_model_prices' : 'group.video_price';
  } else {
    ensure(!groupEntry, 'BILLING_MODE_UNSUPPORTED', 'A group model card shadows channel pricing; use video mode or remove it', 409);
    const entry = matchPrice(channelEntries, request.model);
    ensure(entry, 'SELL_PRICE_MISSING', 'Configure an explicit Sub2API group or channel selling price', 409);
    chosen = configuredPrice(entry, request.resolution); source = 'channel';
  }
  const resolved = userRate ?? group.rate_multiplier;
  const multiplier = group.video_rate_independent ? group.video_rate_multiplier : decimal(resolved).mul(decimal(peakMultiplier(group, config.timezone, now))).toString();
  const baseUsd = money(decimal(chosen.unit).mul(chosen.mode === 'per_second' ? request.duration : 1));
  const saleUsd = money(decimal(baseUsd).mul(decimal(multiplier)));
  ensure(decimal(saleUsd).gt(0), 'FREE_VIDEO_DENIED', 'Free video generation is disabled', 409);
  return { source, mode: chosen.mode, unitUsd: money(chosen.unit), multiplier: money(multiplier), baseUsd, saleUsd, duration: request.duration, resolution: request.resolution, pricedAt: now.toISOString() };
}

module.exports = { matchPrice, priceFamily, peakMultiplier, resolveSellingPrice };
