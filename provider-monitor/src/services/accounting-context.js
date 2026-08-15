const { nowIso, parseJson, stringifyJson } = require('../db');

function positive(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function providerValuationContext(db, connectionId) {
  const row = db.prepare(`
    SELECT detected_multiplier, manual_multiplier, paid_currency,
      balance_currency, detection_source, status, checked_at
    FROM provider_recharge_rates WHERE connection_id = ?
  `).get(connectionId) || {};
  const manual = positive(row.manual_multiplier);
  const detected = positive(row.detected_multiplier);
  return {
    multiplier: manual || detected || 1,
    source: manual ? 'manual' : detected ? row.detection_source || 'detected' : 'default',
    status: manual ? 'manual' : detected ? row.status || 'detected' : 'default',
    cashCurrency: row.paid_currency || row.balance_currency || null,
    balanceCurrency: row.balance_currency || null,
    observedAt: row.checked_at || null
  };
}

function baseValuationContext(db) {
  const row = db.prepare(`
    SELECT base_recharge_multiplier, updated_at
    FROM sub2api_account_monitor_settings WHERE id = 1
  `).get() || {};
  return {
    multiplier: positive(row.base_recharge_multiplier, 1),
    source: 'base_settings',
    cashCurrency: 'USD',
    observedAt: row.updated_at || null
  };
}

function recordBaseGroupRates(db, groups, observedAt = nowIso()) {
  const current = db.prepare(`
    SELECT * FROM sub2api_group_rate_history WHERE group_id = ? AND valid_to IS NULL
  `);
  const close = db.prepare(`
    UPDATE sub2api_group_rate_history SET valid_to = ?
    WHERE group_id = ? AND valid_to IS NULL
  `);
  const insert = db.prepare(`
    INSERT INTO sub2api_group_rate_history(
      group_id, name, rate, status, valid_from, observed_at, context_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let changes = 0;
  for (const group of groups || []) {
    const groupId = Number(group?.id);
    if (!Number.isFinite(groupId)) continue;
    const next = {
      name: String(group.name || `Group ${groupId}`),
      rate: positive(
        group.effectiveRate ?? group.rateMultiplier ?? group.defaultRate ?? group.rate,
        null
      ),
      status: String(group.status || 'active')
    };
    const previous = current.get(groupId);
    if (
      previous && previous.name === next.name && previous.rate === next.rate &&
      previous.status === next.status
    ) continue;
    if (previous) close.run(observedAt, groupId);
    insert.run(
      groupId, next.name, next.rate, next.status, observedAt, observedAt,
      stringifyJson({ source: 'base_group_sync' })
    );
    changes += 1;
  }
  return changes;
}

function recordMappingRateVersions(db, states) {
  const current = db.prepare(`
    SELECT * FROM sub2api_mapping_history
    WHERE mapping_id = ? AND valid_to IS NULL
  `);
  const mapping = db.prepare('SELECT * FROM sub2api_mappings WHERE id = ?');
  const close = db.prepare(`
    UPDATE sub2api_mapping_history SET valid_to = ?
    WHERE mapping_id = ? AND valid_to IS NULL
  `);
  const updateSameInstant = db.prepare(`
    UPDATE sub2api_mapping_history SET
      provider_group_ref = ?, provider_group_name = ?, provider_rate = ?,
      base_group_name = ?, base_group_rate = ?, source = 'rate_sync',
      observed_at = ?, context_json = ?
    WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO sub2api_mapping_history(
      mapping_id, connection_id, key_id, account_id, group_id, role, enabled,
      provider_group_ref, provider_group_name, provider_rate,
      base_group_name, base_group_rate, source, valid_from, observed_at, context_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rate_sync', ?, ?, ?)
  `);
  let changes = 0;
  const mappingIds = [];
  for (const state of states || []) {
    const mappingId = String(state.mappingId || '');
    if (!mappingId) continue;
    const previous = current.get(mappingId);
    const next = {
      providerGroupRef: state.providerGroupRef ?? null,
      providerGroupName: state.providerGroupName ?? null,
      providerRate: Number.isFinite(Number(state.providerRate)) ? Number(state.providerRate) : null,
      baseGroupName: state.baseGroupName ?? null,
      baseGroupRate: Number.isFinite(Number(state.baseGroupRate)) ? Number(state.baseGroupRate) : null
    };
    if (
      previous && previous.provider_group_ref === next.providerGroupRef &&
      previous.provider_group_name === next.providerGroupName &&
      previous.provider_rate === next.providerRate &&
      previous.base_group_name === next.baseGroupName &&
      previous.base_group_rate === next.baseGroupRate
    ) continue;
    const row = mapping.get(mappingId);
    if (!row) continue;
    const changedAt = state.checkedAt || nowIso();
    const context = stringifyJson(state.details || {});
    const uninitialized = previous && previous.provider_rate == null &&
      previous.base_group_rate == null && previous.source !== 'rate_sync';
    if (previous && (uninitialized || Date.parse(previous.valid_from) >= Date.parse(changedAt))) {
      updateSameInstant.run(
        next.providerGroupRef, next.providerGroupName, next.providerRate,
        next.baseGroupName, next.baseGroupRate, changedAt, context, previous.id
      );
    } else {
      if (previous) close.run(changedAt, mappingId);
      insert.run(
        row.id, row.connection_id, row.key_id, String(row.account_id), row.group_id,
        row.role, row.enabled, next.providerGroupRef, next.providerGroupName,
        next.providerRate, next.baseGroupName, next.baseGroupRate,
        changedAt, changedAt, context
      );
    }
    changes += 1;
    mappingIds.push(mappingId);
  }
  return { changes, mappingIds };
}

function rebuildProviderCostRollups(db, connectionId, keyIdentities = null) {
  const identities = keyIdentities == null
    ? db.prepare(`
        SELECT DISTINCT key_identity FROM provider_cost_ledger WHERE connection_id = ?
      `).all(connectionId).map((row) => row.key_identity)
    : [...new Set([...keyIdentities].map(String).filter(Boolean))];
  const removeRaw = db.prepare(`
    DELETE FROM provider_cost_rollups WHERE connection_id = ? AND key_identity = ?
  `);
  const insertRaw = db.prepare(`
    INSERT INTO provider_cost_rollups(
      connection_id, key_id, key_identity, currency, request_count,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost, cost_sample_count, first_at, last_at, updated_at
    )
    SELECT connection_id, MAX(key_id), key_identity, currency,
      SUM(CASE WHEN status = 'success' THEN request_count ELSE 0 END),
      SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END),
      SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END),
      SUM(CASE WHEN status = 'success' THEN cache_creation_tokens ELSE 0 END),
      SUM(CASE WHEN status = 'success' THEN cache_read_tokens ELSE 0 END),
      SUM(COALESCE(cost, 0)),
      SUM(CASE WHEN cost IS NULL THEN 0 ELSE request_count END),
      MIN(occurred_at), MAX(occurred_at), MAX(updated_at)
    FROM provider_cost_ledger
    WHERE connection_id = ? AND key_identity = ?
    GROUP BY connection_id, key_identity, currency
  `);
  const removeCash = db.prepare(`
    DELETE FROM provider_cost_cash_rollups WHERE connection_id = ? AND key_identity = ?
  `);
  const insertCash = db.prepare(`
    INSERT INTO provider_cost_cash_rollups(
      connection_id, key_id, key_identity, cash_currency, cash_cost,
      cost_sample_count, first_at, last_at, updated_at
    )
    SELECT connection_id, MAX(key_id), key_identity,
      COALESCE(cash_currency, currency, 'USD'),
      SUM(COALESCE(cash_cost, CASE WHEN cost IS NULL THEN 0 ELSE cost / recharge_multiplier END)),
      SUM(CASE WHEN cost IS NULL THEN 0 ELSE request_count END),
      MIN(occurred_at), MAX(occurred_at), MAX(updated_at)
    FROM provider_cost_ledger
    WHERE connection_id = ? AND key_identity = ?
    GROUP BY connection_id, key_identity, COALESCE(cash_currency, currency, 'USD')
  `);
  for (const identity of identities) {
    removeRaw.run(connectionId, identity);
    insertRaw.run(connectionId, identity);
    removeCash.run(connectionId, identity);
    insertCash.run(connectionId, identity);
  }
}

function backfillMissingValuations(db) {
  const capturedAt = nowIso();
  const providerRows = db.prepare(`
    SELECT DISTINCT connection_id FROM provider_cost_ledger
    WHERE cash_cost IS NULL AND first_observed_at IS NULL
  `).all();
  const baseRows = db.prepare(`
    SELECT DISTINCT account_id FROM sub2api_account_cost_ledger
    WHERE cash_revenue IS NULL AND first_observed_at IS NULL
  `).all();
  db.transaction(() => {
    for (const row of providerRows) {
      const context = providerValuationContext(db, row.connection_id);
      db.prepare(`
        UPDATE provider_cost_ledger SET
          recharge_multiplier = ?, recharge_source = ?,
          cash_currency = COALESCE(cash_currency, ?, currency, 'USD'),
          cash_cost = CASE WHEN cost IS NULL THEN NULL ELSE cost / ? END,
          valuation_status = 'legacy_snapshot',
          first_observed_at = COALESCE(first_observed_at, ingested_at),
          last_observed_at = COALESCE(last_observed_at, updated_at, ?)
        WHERE connection_id = ? AND cash_cost IS NULL AND first_observed_at IS NULL
      `).run(
        context.multiplier, context.source, context.cashCurrency,
        context.multiplier, capturedAt, row.connection_id
      );
    }
    if (baseRows.length > 0) {
      const context = baseValuationContext(db);
      db.prepare(`
        UPDATE sub2api_account_cost_ledger SET
          recharge_multiplier = ?, recharge_source = ?,
          cash_currency = COALESCE(cash_currency, ?, currency, 'USD'),
          cash_revenue = CASE WHEN cost IS NULL THEN NULL ELSE cost / ? END,
          valuation_status = 'legacy_snapshot',
          first_observed_at = COALESCE(first_observed_at, ingested_at),
          last_observed_at = COALESCE(last_observed_at, updated_at, ?)
        WHERE cash_revenue IS NULL AND first_observed_at IS NULL
      `).run(
        context.multiplier, context.source, context.cashCurrency,
        context.multiplier, capturedAt
      );
    }
  })();
  for (const row of providerRows) rebuildProviderCostRollups(db, row.connection_id);
  const accountIds = baseRows.map((row) => String(row.account_id));
  rebuildBaseCostRollups(db, accountIds);
  return { providerCount: providerRows.length, accountCount: accountIds.length };
}

function refreshPendingBaseCostAttributions(db) {
  const accountIds = db.prepare(`
    SELECT DISTINCT ledger.account_id
    FROM sub2api_account_cost_ledger ledger
    WHERE ledger.attribution_status = 'unmapped'
      AND EXISTS (
        SELECT 1 FROM sub2api_mapping_history history
        WHERE history.account_id = ledger.account_id
      )
  `).all().map((row) => String(row.account_id));
  return refreshBaseCostAttributions(db, accountIds);
}

function rebuildBaseCostRollups(db, accountIds) {
  const ids = [...new Set((accountIds || []).map(String).filter(Boolean))];
  const remove = db.prepare('DELETE FROM sub2api_account_cost_rollups WHERE account_id = ?');
  const insert = db.prepare(`
    INSERT INTO sub2api_account_cost_rollups(
      account_id, currency, request_count, cost, cost_sample_count,
      first_at, last_at, updated_at
    )
    SELECT account_id, currency, SUM(request_count), SUM(COALESCE(cost, 0)),
      SUM(CASE WHEN cost IS NULL THEN 0 ELSE request_count END),
      MIN(occurred_at), MAX(occurred_at), MAX(updated_at)
    FROM sub2api_account_cost_ledger WHERE account_id = ?
    GROUP BY account_id, currency
  `);
  for (const accountId of ids) {
    remove.run(accountId);
    insert.run(accountId);
  }
}

function rebuildAttributedCostRollups(db, accountIds) {
  const ids = [...new Set((accountIds || []).map(String).filter(Boolean))];
  const remove = db.prepare('DELETE FROM sub2api_attributed_cost_rollups WHERE account_id = ?');
  const insert = db.prepare(`
    INSERT INTO sub2api_attributed_cost_rollups(
      connection_id, key_id, account_id, cash_currency, request_count,
      raw_cost, cash_revenue, cost_sample_count, first_at, last_at, updated_at
    )
    SELECT connection_id, key_id, account_id,
      COALESCE(cash_currency, currency, 'USD'), SUM(request_count),
      SUM(COALESCE(cost, 0)), SUM(COALESCE(cash_revenue, 0)),
      SUM(CASE WHEN cash_revenue IS NULL THEN 0 ELSE request_count END),
      MIN(occurred_at), MAX(occurred_at), MAX(updated_at)
    FROM sub2api_account_cost_ledger
    WHERE account_id = ? AND connection_id IS NOT NULL AND key_id IS NOT NULL
      AND attribution_status IN ('attributed', 'attributed_multi_group')
    GROUP BY connection_id, key_id, account_id,
      COALESCE(cash_currency, currency, 'USD')
  `);
  for (const accountId of ids) {
    remove.run(accountId);
    insert.run(accountId);
  }
}

function refreshBaseCostAttributions(db, accountIds = null) {
  const ids = accountIds == null
    ? db.prepare('SELECT DISTINCT account_id FROM sub2api_account_cost_ledger').all()
      .map((row) => String(row.account_id))
    : [...new Set(accountIds.map(String).filter(Boolean))];
  if (ids.length === 0) return { accountCount: 0, entryCount: 0, attributed: 0, ambiguous: 0 };
  const histories = db.prepare(`
    SELECT * FROM sub2api_mapping_history
    WHERE account_id = ? ORDER BY valid_from, id
  `);
  const entries = db.prepare(`
    SELECT source_log_id, account_id, occurred_at, context_json,
      connection_id, key_id, mapping_id, mapping_version_id, group_id,
      base_group_rate, provider_group_rate, attribution_status
    FROM sub2api_account_cost_ledger WHERE account_id = ?
  `);
  const update = db.prepare(`
    UPDATE sub2api_account_cost_ledger SET
      connection_id = ?, key_id = ?, mapping_id = ?, mapping_version_id = ?,
      group_id = ?, base_group_rate = ?, provider_group_rate = ?,
      attribution_status = ?, context_json = ?, updated_at = ?
    WHERE source_log_id = ?
  `);
  let entryCount = 0;
  let attributed = 0;
  let ambiguous = 0;
  let updated = 0;
  const changedAccountIds = new Set();
  const updatedAt = nowIso();
  db.transaction(() => {
    for (const accountId of ids) {
      const versions = histories.all(accountId);
      for (const entry of entries.all(accountId)) {
        entryCount += 1;
        const occurred = Date.parse(entry.occurred_at);
        const active = versions.filter((version) => {
          const from = Date.parse(version.valid_from);
          const to = Date.parse(version.valid_to || '9999-12-31T23:59:59.999Z');
          return version.enabled && version.role === 'primary' && version.key_id &&
            Number.isFinite(occurred) && occurred >= from && occurred < to;
        });
        const byTarget = new Map();
        for (const version of active) {
          const target = `${version.connection_id}\u0000${version.key_id}`;
          const values = byTarget.get(target) || [];
          values.push(version);
          byTarget.set(target, values);
        }
        let selected = null;
        let status = 'unmapped';
        if (byTarget.size === 1) {
          const candidates = [...byTarget.values()][0].sort((left, right) =>
            Date.parse(right.valid_from) - Date.parse(left.valid_from) || right.id - left.id
          );
          selected = candidates[0];
          status = candidates.length > 1 ? 'attributed_multi_group' : 'attributed';
          attributed += 1;
        } else if (byTarget.size > 1) {
          status = 'ambiguous';
          ambiguous += 1;
        }
        const context = parseJson(entry.context_json, {});
        context.attribution = selected ? {
          mappingId: selected.mapping_id,
          mappingVersionId: selected.id,
          source: selected.source,
          validFrom: selected.valid_from,
          validTo: selected.valid_to
        } : { status };
        const nextContext = stringifyJson(context);
        const unchanged =
          (entry.connection_id ?? null) === (selected?.connection_id ?? null) &&
          (entry.key_id ?? null) === (selected?.key_id ?? null) &&
          (entry.mapping_id ?? null) === (selected?.mapping_id ?? null) &&
          (entry.mapping_version_id ?? null) === (selected?.id ?? null) &&
          (entry.group_id ?? null) === (selected?.group_id ?? null) &&
          (entry.base_group_rate ?? null) === (selected?.base_group_rate ?? null) &&
          (entry.provider_group_rate ?? null) === (selected?.provider_rate ?? null) &&
          entry.attribution_status === status && entry.context_json === nextContext;
        if (unchanged) continue;
        update.run(
          selected?.connection_id || null,
          selected?.key_id || null,
          selected?.mapping_id || null,
          selected?.id || null,
          selected?.group_id ?? null,
          selected?.base_group_rate ?? null,
          selected?.provider_rate ?? null,
          status,
          nextContext,
          updatedAt,
          entry.source_log_id
        );
        updated += 1;
        changedAccountIds.add(accountId);
      }
    }
  })();
  rebuildAttributedCostRollups(db, [...changedAccountIds]);
  return { accountCount: ids.length, entryCount, attributed, ambiguous, updated };
}

module.exports = {
  backfillMissingValuations,
  baseValuationContext,
  providerValuationContext,
  recordBaseGroupRates,
  recordMappingRateVersions,
  rebuildProviderCostRollups,
  rebuildBaseCostRollups,
  rebuildAttributedCostRollups,
  refreshBaseCostAttributions,
  refreshPendingBaseCostAttributions
};
