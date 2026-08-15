const { parseJson, stringifyJson } = require('../db');
const {
  providerValuationContext,
  rebuildProviderCostRollups
} = require('./accounting-context');

const COUNTER_FIELDS = [
  ['cost', 'last_cost', 'lifetime_cost_offset'],
  ['requestCount', 'last_request_count', 'lifetime_request_offset'],
  ['inputTokens', 'last_input_tokens', 'lifetime_input_offset'],
  ['outputTokens', 'last_output_tokens', 'lifetime_output_offset'],
  ['cacheCreationTokens', 'last_cache_creation_tokens', 'lifetime_cache_creation_offset'],
  ['cacheReadTokens', 'last_cache_read_tokens', 'lifetime_cache_read_offset']
];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = finite(value);
  return number == null ? null : Math.round(number);
}

function counterValue(item, name) {
  if (name === 'cost') return finite(item.cost);
  if (name === 'requestCount') return integer(item.requests ?? item.requestCount);
  return integer(item[name]);
}

function normalizedCounters(item) {
  return Object.fromEntries(COUNTER_FIELDS.map(([name]) => [name, counterValue(item, name)]));
}

function decreased(previous, current, name) {
  if (previous == null || current == null) return false;
  const tolerance = name === 'cost' ? Math.max(1e-9, Math.abs(previous) * 1e-10) : 0;
  return current < previous - tolerance;
}

function resetLikely(previous, current, decreasedFields) {
  if (decreasedFields.length === 0) return false;
  const primaryDrops = ['cost', 'requestCount'].filter((name) => decreasedFields.includes(name));
  if (primaryDrops.length === 2) return true;
  const substantialDrops = decreasedFields.filter((name) => {
    const before = Math.abs(Number(previous[name] || 0));
    const after = Math.abs(Number(current[name] || 0));
    return before > 0 && after <= before * 0.5;
  });
  return primaryDrops.length === 1 && substantialDrops.length >= 2;
}

function counterDelta(previous, current, reset) {
  const values = {};
  for (const [name] of COUNTER_FIELDS) {
    const before = previous[name];
    const after = current[name];
    if (after == null) {
      values[name] = null;
    } else if (before == null || reset) {
      values[name] = after;
    } else {
      values[name] = after - before;
    }
  }
  return values;
}

function hasDelta(values) {
  return COUNTER_FIELDS.some(([name]) => {
    const value = values[name];
    return value != null && Math.abs(value) > (name === 'cost' ? 1e-10 : 0);
  });
}

function requestLogCoverage(result, keys) {
  const complete = new Set();
  const incomplete = new Set();
  const byKey = new Map();
  if (!result?.ok) return { complete, incomplete, byKey };
  const supplied = Array.isArray(result.value?.keyCoverage)
    ? result.value.keyCoverage
    : [];
  const rows = supplied.length > 0
    ? supplied
    : (keys || []).map((key) => ({
        remoteKeyId: String(key.remoteId),
        status: 'succeeded',
        truncated: Boolean(result.value?.truncated),
        coverageFrom: result.value?.coverageFrom || null,
        coverageTo: result.value?.coverageTo || null
      }));
  for (const row of rows) {
    const remoteKeyId = String(row.remoteKeyId || '');
    if (!remoteKeyId || row.status !== 'succeeded') continue;
    byKey.set(remoteKeyId, row);
    (row.truncated ? incomplete : complete).add(remoteKeyId);
  }
  return { complete, incomplete, byKey };
}

function mappingContextAt(db, connectionId, keyId, intervalStart, intervalEnd) {
  const endMs = Date.parse(intervalEnd);
  const startMs = Date.parse(intervalStart || intervalEnd);
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) {
    return { status: 'unmapped', accountId: null };
  }
  const versions = db.prepare(`
    SELECT * FROM sub2api_mapping_history
    WHERE connection_id = ? AND key_id = ? AND enabled = 1 AND role = 'primary'
      AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
    ORDER BY valid_from, id
  `).all(connectionId, keyId, intervalEnd, intervalStart || intervalEnd);
  if (versions.length === 0) return { status: 'unmapped', accountId: null };
  const accounts = new Set(versions.map((row) => String(row.account_id || '')).filter(Boolean));
  if (accounts.size !== 1) {
    const intervals = versions.map((row) => ({
      accountId: String(row.account_id || ''),
      from: Math.max(startMs, Date.parse(row.valid_from)),
      to: Math.min(endMs, Date.parse(row.valid_to || intervalEnd))
    })).filter((row) => (
      row.accountId && Number.isFinite(row.from) && Number.isFinite(row.to) && row.to >= row.from
    ));
    const overlapsDifferentAccounts = intervals.some((left, index) => (
      intervals.slice(index + 1).some((right) => (
        left.accountId !== right.accountId &&
        Math.max(left.from, right.from) < Math.min(left.to, right.to)
      ))
    ));
    return {
      status: accounts.size > 1
        ? overlapsDifferentAccounts ? 'shared_key' : 'mapping_transition'
        : 'unmapped',
      accountId: null
    };
  }
  const accountId = [...accounts][0];
  const intervals = versions.map((row) => ({
    from: Math.max(startMs, Date.parse(row.valid_from)),
    to: Math.min(endMs, Date.parse(row.valid_to || intervalEnd))
  })).filter((row) => Number.isFinite(row.from) && Number.isFinite(row.to) && row.to >= row.from)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  let coveredTo = startMs;
  for (const interval of intervals) {
    if (interval.from > coveredTo + 1) {
      return { status: 'mapping_transition', accountId: null };
    }
    coveredTo = Math.max(coveredTo, interval.to);
  }
  if (coveredTo + 1 < endMs) return { status: 'mapping_transition', accountId: null };
  const activeAtEnd = versions.filter((row) => {
    const from = Date.parse(row.valid_from);
    const to = Date.parse(row.valid_to || '9999-12-31T23:59:59.999Z');
    return from <= endMs && to > endMs;
  });
  const candidates = (activeAtEnd.length > 0 ? activeAtEnd : versions)
    .sort((left, right) => Date.parse(right.valid_from) - Date.parse(left.valid_from) || right.id - left.id);
  const selected = candidates[0];
  const rateSignatures = new Set(versions.map((row) => JSON.stringify([
    row.provider_group_ref ?? null,
    finite(row.provider_rate),
    finite(row.base_group_rate)
  ])));
  return {
    status: rateSignatures.size > 1
      ? 'attributed_rate_transition'
      : candidates.length > 1 ? 'attributed_multi_group' : 'attributed',
    accountId,
    mappingId: selected.mapping_id,
    mappingVersionId: selected.id,
    baseGroupRate: finite(selected.base_group_rate),
    providerGroupRate: finite(selected.provider_rate),
    validFrom: selected.valid_from,
    validTo: selected.valid_to
  };
}

function keyContexts(db, connectionId) {
  return db.prepare(`
    SELECT key.id, key.remote_id,
      COALESCE(
        NULLIF(json_extract(key.metadata_json, '$.identityHash'), ''),
        NULLIF(key.remote_id, ''), key.id
      ) AS key_identity,
      key.primary_group_ref,
      (
        SELECT provider_group.ratio FROM remote_groups provider_group
        WHERE provider_group.connection_id = key.connection_id
          AND (
            provider_group.id = key.primary_group_ref OR
            provider_group.remote_id = key.primary_group_ref OR
            provider_group.name = key.primary_group_ref
          )
        ORDER BY CASE WHEN provider_group.status = 'missing' THEN 1 ELSE 0 END,
          provider_group.last_seen_at DESC
        LIMIT 1
      ) AS provider_group_rate
    FROM remote_keys key WHERE key.connection_id = ?
  `).all(connectionId).reduce((map, row) => map.set(String(row.remote_id), {
    keyId: String(row.id),
    keyIdentity: String(row.key_identity),
    groupRef: row.primary_group_ref || null,
    groupRate: finite(row.provider_group_rate)
  }), new Map());
}

function stateCounters(row) {
  return Object.fromEntries(COUNTER_FIELDS.map(([name, stateColumn]) => [
    name,
    finite(row?.[stateColumn])
  ]));
}

function stateOffsets(row, reset, previous) {
  return Object.fromEntries(COUNTER_FIELDS.map(([name, , offsetColumn]) => {
    const existing = finite(row?.[offsetColumn]) || 0;
    const offset = reset ? finite(previous[name]) || 0 : 0;
    return [offsetColumn, existing + offset];
  }));
}

function insertLedgerEntry({
  db, connectionId, remoteKeyId, key, keyIdentity, currency, capturedAt,
  intervalStart, epoch, counters, entryKind, comparable, valuation, attribution,
  resetFields = [], correctionFields = []
}) {
  const precisionSeconds = intervalStart
    ? Math.max(0, Math.round((Date.parse(capturedAt) - Date.parse(intervalStart)) / 1000))
    : null;
  const cost = finite(counters.cost);
  const sourceLogId = `counter:${entryKind}:${epoch}:${capturedAt}`;
  const context = {
    source: 'provider_cumulative_usage',
    interval: { from: intervalStart || null, to: capturedAt, precisionSeconds },
    counter: {
      epoch,
      resetFields,
      correctionFields,
      values: counters
    },
    recharge: {
      status: valuation.status,
      confirmed: valuation.confirmed,
      observedAt: valuation.observedAt
    },
    providerGroup: {
      ref: key.groupRef,
      rate: key.groupRate
    },
    attribution
  };
  const result = db.prepare(`
    INSERT OR IGNORE INTO provider_cost_ledger(
      connection_id, key_id, remote_key_id, key_identity, source_log_id, status,
      currency, cost, request_count, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, occurred_at, ingested_at, updated_at,
      recharge_multiplier, recharge_source, cash_currency, cash_cost,
      provider_group_ref, provider_group_rate, valuation_status, context_json,
      revision, first_observed_at, last_observed_at, source_type, entry_kind,
      accounting_status, interval_start, counter_epoch, precision_seconds, comparable,
      attributed_account_id, mapping_id, mapping_version_id, base_group_rate,
      attribution_status
    ) VALUES (
      @connectionId, @keyId, @remoteKeyId, @keyIdentity, @sourceLogId, 'success',
      @currency, @cost, @requestCount, @inputTokens, @outputTokens,
      @cacheCreationTokens, @cacheReadTokens, @capturedAt, @capturedAt, @capturedAt,
      @rechargeMultiplier, @rechargeSource, @cashCurrency, @cashCost,
      @providerGroupRef, @providerGroupRate, @valuationStatus, @contextJson,
      1, @capturedAt, @capturedAt, 'usage_counter', @entryKind,
      'active', @intervalStart, @epoch, @precisionSeconds, @comparable,
      @accountId, @mappingId, @mappingVersionId, @baseGroupRate,
      @attributionStatus
    )
  `).run({
    connectionId,
    keyId: key.keyId,
    remoteKeyId,
    keyIdentity,
    sourceLogId,
    currency,
    cost,
    requestCount: integer(counters.requestCount) || 0,
    inputTokens: integer(counters.inputTokens) || 0,
    outputTokens: integer(counters.outputTokens) || 0,
    cacheCreationTokens: integer(counters.cacheCreationTokens) || 0,
    cacheReadTokens: integer(counters.cacheReadTokens) || 0,
    capturedAt,
    rechargeMultiplier: valuation.multiplier,
    rechargeSource: valuation.source,
    cashCurrency: valuation.cashCurrency || currency,
    cashCost: cost == null ? null : cost / valuation.multiplier,
    providerGroupRef: key.groupRef,
    providerGroupRate: key.groupRate,
    valuationStatus: valuation.confirmed ? 'observed' : 'unconfirmed_recharge',
    contextJson: stringifyJson(context),
    entryKind,
    intervalStart: intervalStart || null,
    epoch,
    precisionSeconds,
    comparable: comparable ? 1 : 0,
    accountId: attribution.accountId || null,
    mappingId: attribution.mappingId || null,
    mappingVersionId: attribution.mappingVersionId || null,
    baseGroupRate: attribution.baseGroupRate ?? null,
    attributionStatus: attribution.status || 'unmapped'
  });
  return result.changes;
}

function reconcileRequestLogCoverage(db, connectionId, requestLogs, keys, capturedAt) {
  if (!requestLogs?.ok) return new Set();
  const contexts = keyContexts(db, connectionId);
  const supplied = Array.isArray(requestLogs.value?.keyCoverage)
    ? requestLogs.value.keyCoverage
    : [];
  const coverage = supplied.length > 0
    ? supplied
    : (keys || []).map((key) => ({
        remoteKeyId: String(key.remoteId),
        status: 'succeeded',
        truncated: Boolean(requestLogs.value?.truncated),
        coverageFrom: requestLogs.value?.coverageFrom || null,
        coverageTo: requestLogs.value?.coverageTo || capturedAt
      }));
  const affected = new Set();
  const counterState = db.prepare(`
    SELECT MIN(last_captured_at) AS last_captured_at
    FROM provider_usage_counter_state
    WHERE connection_id = ? AND key_identity = ?
  `);
  for (const row of coverage) {
    if (row.status !== 'succeeded') continue;
    const remoteKeyId = String(row.remoteKeyId || '');
    const key = contexts.get(remoteKeyId);
    if (!key) continue;
    const state = counterState.get(connectionId, key.keyIdentity);
    const missesCounterStart = Boolean(
      state?.last_captured_at && row.coverageFrom &&
      Date.parse(row.coverageFrom) > Date.parse(state.last_captured_at)
    );
    if (row.truncated || missesCounterStart) {
      const changed = db.prepare(`
        UPDATE provider_cost_ledger SET accounting_status = 'shadow', updated_at = ?
        WHERE connection_id = ? AND key_id = ? AND source_type = 'request_log'
          AND first_observed_at = ? AND accounting_status = 'active'
      `).run(capturedAt, connectionId, key.keyId, capturedAt).changes;
      if (changed) affected.add(key.keyIdentity);
      continue;
    }
    if (!row.coverageFrom || !row.coverageTo) continue;
    const changed = db.prepare(`
      UPDATE provider_cost_ledger SET accounting_status = 'superseded', updated_at = ?
      WHERE connection_id = ? AND key_id = ? AND source_type = 'usage_counter'
        AND comparable = 1 AND accounting_status = 'active'
        AND interval_start >= ? AND occurred_at <= ?
    `).run(
      capturedAt, connectionId, key.keyId, row.coverageFrom, row.coverageTo
    ).changes;
    if (changed) affected.add(key.keyIdentity);
  }
  return affected;
}

function recordProviderUsageCounters({
  db, connectionId, usage, keys, requestLogs, capturedAt
}) {
  const cumulative = (usage || []).filter((item) => (
    item?.scope === 'key' && item.period === 'cumulative' && item.remoteSubjectId != null
  ));
  const coverage = requestLogCoverage(requestLogs, keys);
  const contexts = keyContexts(db, connectionId);
  const valuation = providerValuationContext(db, connectionId);
  const findState = db.prepare(`
    SELECT * FROM provider_usage_counter_state
    WHERE connection_id = ? AND key_identity = ? AND currency = ?
  `);
  const saveState = db.prepare(`
    INSERT INTO provider_usage_counter_state(
      connection_id, key_id, remote_key_id, key_identity, currency, epoch,
      last_cost, last_request_count, last_input_tokens, last_output_tokens,
      last_cache_creation_tokens, last_cache_read_tokens,
      lifetime_cost_offset, lifetime_request_offset, lifetime_input_offset,
      lifetime_output_offset, lifetime_cache_creation_offset,
      lifetime_cache_read_offset, reset_count, last_mode,
      counter_accounting_started_at, first_observed_at, last_captured_at,
      context_json, updated_at
    ) VALUES (
      @connectionId, @keyId, @remoteKeyId, @keyIdentity, @currency, @epoch,
      @lastCost, @lastRequestCount, @lastInputTokens, @lastOutputTokens,
      @lastCacheCreationTokens, @lastCacheReadTokens,
      @lifetimeCostOffset, @lifetimeRequestOffset, @lifetimeInputOffset,
      @lifetimeOutputOffset, @lifetimeCacheCreationOffset,
      @lifetimeCacheReadOffset, @resetCount, @lastMode,
      @counterAccountingStartedAt, @firstObservedAt, @lastCapturedAt,
      @contextJson, @updatedAt
    )
    ON CONFLICT(connection_id, key_identity, currency) DO UPDATE SET
      key_id = excluded.key_id,
      remote_key_id = excluded.remote_key_id,
      epoch = excluded.epoch,
      last_cost = excluded.last_cost,
      last_request_count = excluded.last_request_count,
      last_input_tokens = excluded.last_input_tokens,
      last_output_tokens = excluded.last_output_tokens,
      last_cache_creation_tokens = excluded.last_cache_creation_tokens,
      last_cache_read_tokens = excluded.last_cache_read_tokens,
      lifetime_cost_offset = excluded.lifetime_cost_offset,
      lifetime_request_offset = excluded.lifetime_request_offset,
      lifetime_input_offset = excluded.lifetime_input_offset,
      lifetime_output_offset = excluded.lifetime_output_offset,
      lifetime_cache_creation_offset = excluded.lifetime_cache_creation_offset,
      lifetime_cache_read_offset = excluded.lifetime_cache_read_offset,
      reset_count = excluded.reset_count,
      last_mode = excluded.last_mode,
      counter_accounting_started_at = COALESCE(
        provider_usage_counter_state.counter_accounting_started_at,
        excluded.counter_accounting_started_at
      ),
      last_captured_at = excluded.last_captured_at,
      context_json = excluded.context_json,
      updated_at = excluded.updated_at
  `);
  const affected = reconcileRequestLogCoverage(
    db, connectionId, requestLogs, keys, capturedAt
  );
  let ledgerEntryCount = 0;
  let openingEntryCount = 0;
  let resetCount = 0;
  let correctionCount = 0;

  for (const item of cumulative) {
    const remoteKeyId = String(item.remoteSubjectId);
    const key = contexts.get(remoteKeyId);
    if (!key) continue;
    const raw = item.raw && typeof item.raw === 'object' ? item.raw : {};
    const keyIdentity = String(
      raw.monitorMetrics?.credentialIdentity || key.keyIdentity || remoteKeyId
    );
    const currency = String(item.currency || 'USD').toUpperCase();
    const current = normalizedCounters(item);
    const state = findState.get(connectionId, keyIdentity, currency);
    if (state && Date.parse(state.last_captured_at) >= Date.parse(capturedAt)) continue;
    const logCoverage = coverage.byKey.get(remoteKeyId);
    const completeLogs = coverage.complete.has(remoteKeyId) && (
      !state || !logCoverage?.coverageFrom ||
      Date.parse(logCoverage.coverageFrom) <= Date.parse(state.last_captured_at)
    );
    const mode = completeLogs ? 'request_log' : 'counter';
    const previous = stateCounters(state);
    const decreasedFields = state
      ? COUNTER_FIELDS.map(([name]) => name).filter(
          (name) => decreased(previous[name], current[name], name)
        )
      : [];
    const reset = state ? resetLikely(previous, current, decreasedFields) : false;
    const correctionFields = reset ? [] : decreasedFields;
    const epoch = state ? Number(state.epoch || 1) + (reset ? 1 : 0) : 1;
    const offsets = stateOffsets(state, reset, previous);
    const intervalStart = state?.last_captured_at || null;
    const attribution = mappingContextAt(
      db, connectionId, key.keyId, intervalStart, capturedAt
    );
    let event = 'shadow_checkpoint';

    if (!state && mode === 'counter') {
      openingEntryCount += insertLedgerEntry({
        db, connectionId, remoteKeyId, key, keyIdentity, currency, capturedAt,
        intervalStart: null, epoch, counters: current,
        entryKind: 'counter_opening', comparable: false,
        valuation, attribution
      });
      event = 'opening_baseline';
      affected.add(keyIdentity);
    } else if (state && mode === 'counter') {
      const delta = counterDelta(previous, current, reset);
      if (hasDelta(delta)) {
        const entryKind = reset
          ? 'counter_reset'
          : correctionFields.length > 0 ? 'counter_correction' : 'counter_delta';
        ledgerEntryCount += insertLedgerEntry({
          db, connectionId, remoteKeyId, key, keyIdentity, currency, capturedAt,
          intervalStart, epoch, counters: delta, entryKind, comparable: true,
          valuation, attribution, resetFields: reset ? decreasedFields : [],
          correctionFields
        });
        event = entryKind;
        affected.add(keyIdentity);
        if (reset) resetCount += 1;
        if (correctionFields.length > 0) correctionCount += 1;
      } else {
        event = 'counter_unchanged';
      }
    }

    const context = {
      event,
      remoteKeyId,
      mode,
      completeRequestLogs: completeLogs,
      incompleteRequestLogs: coverage.incomplete.has(remoteKeyId),
      decreasedFields,
      attributionStatus: attribution.status,
      previousCapturedAt: intervalStart,
      capturedAt
    };
    saveState.run({
      connectionId,
      keyId: key.keyId,
      remoteKeyId,
      keyIdentity,
      currency,
      epoch,
      lastCost: current.cost,
      lastRequestCount: current.requestCount,
      lastInputTokens: current.inputTokens,
      lastOutputTokens: current.outputTokens,
      lastCacheCreationTokens: current.cacheCreationTokens,
      lastCacheReadTokens: current.cacheReadTokens,
      lifetimeCostOffset: offsets.lifetime_cost_offset,
      lifetimeRequestOffset: offsets.lifetime_request_offset,
      lifetimeInputOffset: offsets.lifetime_input_offset,
      lifetimeOutputOffset: offsets.lifetime_output_offset,
      lifetimeCacheCreationOffset: offsets.lifetime_cache_creation_offset,
      lifetimeCacheReadOffset: offsets.lifetime_cache_read_offset,
      resetCount: Number(state?.reset_count || 0) + (reset ? 1 : 0),
      lastMode: mode,
      counterAccountingStartedAt: mode === 'counter' ? capturedAt : null,
      firstObservedAt: state?.first_observed_at || capturedAt,
      lastCapturedAt: capturedAt,
      contextJson: stringifyJson(context),
      updatedAt: capturedAt
    });
  }

  for (const identity of affected) {
    rebuildProviderCostRollups(db, connectionId, [identity]);
  }
  return {
    checkpointCount: cumulative.length,
    ledgerEntryCount,
    openingEntryCount,
    resetCount,
    correctionCount
  };
}

module.exports = {
  mappingContextAt,
  recordProviderUsageCounters
};
