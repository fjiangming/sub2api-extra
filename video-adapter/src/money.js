'use strict';

const Decimal = require('decimal.js');
const { ensure } = require('./errors');

Decimal.set({ precision: 40, rounding: Decimal.ROUND_CEIL });

function decimal(value) {
  try {
    const number = new Decimal(value);
    ensure(number.isFinite() && number.gte(0), 'INVALID_MONEY', 'Amounts must be finite and nonnegative');
    return number;
  } catch {
    throw new (require('./errors').AppError)('INVALID_MONEY', 'Invalid monetary amount');
  }
}

function money(value) { return decimal(value).toDecimalPlaces(8, Decimal.ROUND_CEIL).toFixed(8); }
function add(a, b) { return money(decimal(a).plus(decimal(b))); }
function multiply(a, b) { return money(decimal(a).mul(decimal(b))); }
function costCap(card, request, config, now = new Date()) {
  ensure(new Date(card.expiresAt).getTime() > now.getTime(), 'COST_CARD_EXPIRED', 'Verified supplier cost card has expired', 503);
  ensure(new Date(card.verifiedAt).getTime() <= now.getTime(), 'COST_CARD_UNVERIFIED', 'Supplier cost verification is in the future', 503);
  const price = card.prices[request.resolution] ?? card.prices.default;
  ensure(price != null, 'COST_TIER_MISSING', 'No verified supplier cost for this resolution', 503);
  const quoted = decimal(price).mul(card.mode === 'per_second' ? request.duration : 1);
  const native = quoted.mul(decimal(card.feeMultiplier)).plus(decimal(card.fixedFee));
  const rate = card.currency === 'USD' ? '1' : card.usdPerUnit;
  ensure(rate != null, 'FX_MISSING', 'A conservative, verified currency conversion is required', 503);
  return {
    supplierAmount: money(native), quotedAmountBound: money(quoted), currency: card.currency, usdPerUnit: decimal(rate).toString(),
    feeMultiplier: card.feeMultiplier, fixedFee: card.fixedFee,
    unbufferedUsd: money(native.mul(decimal(rate))),
    capUsd: money(native.mul(decimal(rate)).mul(decimal(config.costBuffer).plus(1)))
  };
}

function enforceMargin(sale, cap, config, group = {}) {
  const margin = Decimal.max(decimal(config.minMargin), decimal(group.profit_control_enabled ? group.profit_min_margin ?? 0 : 0));
  const safety = decimal(group.profit_control_enabled ? group.profit_safety_buffer ?? 0 : 0);
  ensure(margin.plus(safety).lt(1), 'INVALID_MARGIN', 'Combined minimum margin and safety buffer must be below 1', 503);
  const revenue = decimal(sale).mul(decimal(config.revenueFactor));
  const required = decimal(cap).plus(decimal(config.overheadUsd)).div(new Decimal(1).minus(margin).minus(safety));
  ensure(revenue.gte(required), 'UNPROFITABLE_PRICE', 'Sub2API selling price does not cover the verified cost and required margin', 409);
  ensure(decimal(cap).lte(decimal(config.maxJobCostUsd)), 'JOB_COST_LIMIT', 'Supplier cost exceeds the per-job ceiling', 409);
  return { netRevenueUsd: money(revenue), minimumRevenueUsd: money(required), minMargin: margin.toString() };
}

module.exports = { Decimal, decimal, money, add, multiply, costCap, enforceMargin };
