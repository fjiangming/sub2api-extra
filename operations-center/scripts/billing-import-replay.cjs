'use strict';

// Optional offline audit. Reads externally saved evidence; never opens a DB or
// calls the core, supplier, preview, reservation or settlement endpoints.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Decimal = require('decimal.js');
const { normalizeSources, reconcileBillingRows, billingImportWindow } = require('../src/services/billing-import-source');
const { buildLogCandidates, enrichErrorsFromLogs } = require('../src/services/billing-import-logs');

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/billing-import-replay.cjs <external-audit-directory>');
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const input = read('import-rows.json'), source = read('sources.json');
const evidence = new Map(fs.readFileSync(path.join(directory, 'billing-evidence.ndjson'), 'utf8').trim().split(/\r?\n/)
  .map(line => JSON.parse(line)).filter(row => row.usage_id != null).map(row => [String(row.usage_id), row]));
const records = input.rows.map(row => row.record);
const window = billingImportWindow(records, input.batch.options);
const inWindow = row => Date.parse(row.created_at) >= Date.parse(window.from) && Date.parse(row.created_at) < Date.parse(window.to);
const usages = source.usages.filter(inWindow).map(row => ({ ...row, billing_dedup: evidence.get(String(row.id))?.dedup ?? null,
  billing_archived: evidence.get(String(row.id))?.archived ?? null }));
const logs = buildLogCandidates(read('access-events.json'), { from: window.from, to: window.to,
  accounts: Object.values(input.batch.options.accountMappings) });
// Optional inference uses only the saved cases. It is not a live group / Key
// lookup and cannot validate current prices, quotas, claims or reservability.
const savedBalanceContext = process.argv.includes('--saved-balance-context');
if (savedBalanceContext) {
  const groups = new Map();
  for (const entry of source.cases) {
    const key = String(entry.group_id), status = groups.get(key) || { count: 0, subscription: false };
    status.count++; status.subscription ||= entry.subscription_id != null; groups.set(key, status);
  }
  for (const log of logs) {
    const group = groups.get(String(log.groupId));
    if (group?.count && !group.subscription) log.billingType = 'balance';
  }
}
const candidates = normalizeSources(enrichErrorsFromLogs(source.errors.filter(inWindow), logs), usages, source.cases.filter(inWindow), logs);
const result = reconcileBillingRows(records, candidates, { ...input.batch.options, timeKind: 'auto' });
const summary = {};
const candidateByReference = new Map(candidates.map(item => [item.reference, item]));
const billedReferences = new Set();
const ownerCandidates = { onlyFileLogs: 0, includesNativeSource: 0 };
result.matches.forEach((match, index) => {
  const group = summary[match.status] ||= { count: 0, supplierCost: new Decimal(0) };
  group.count++; group.supplierCost = group.supplierCost.plus(records[index].cost || 0);
  if (match.status === 'already_recorded') {
    const candidate = candidateByReference.get(match.candidates[0].reference);
    assert.ok(candidate?.billed && candidate.recorded);
    for (const field of ['InputTokens', 'OutputTokens', 'CacheReadTokens', 'CacheCreationTokens']) {
      assert.equal(Number(candidate.tokens[field]), records[index].tokens[field], 'Paid exclusions require the same full native tokens');
    }
    assert.ok(!billedReferences.has(candidate.reference), 'A single native charge cannot cover multiple supplier bills');
    billedReferences.add(candidate.reference);
  }
  if (match.status === 'owner_candidate') {
    ownerCandidates[match.candidates.every(item => item.kind === 'log') ? 'onlyFileLogs' : 'includesNativeSource']++;
  }
});
for (const group of Object.values(summary)) group.supplierCost = group.supplierCost.toFixed(8);
const previouslyActionable = input.rows.map((row, index) => ({ row, match: result.matches[index] }))
  .filter(item => item.row.status === 'time_candidate');
assert.ok(previouslyActionable.every(item => item.match.status === 'already_recorded'), 'Previously actionable false positives must be excluded');
const tokenBaseline = read('token-matches.json').filter(row => Math.abs(row.deltaEndMs) <= 5000);
const expected = new Set(tokenBaseline.map(row => row.number));
const known = records.filter(row => expected.has(row.number) && !row.duplicateOf);
for (const row of known) assert.ok(['already_recorded', 'billing_unresolved'].includes(result.matches[records.indexOf(row)].status), 'A known native usage must not be charged as a new CSV row');
const legacyBaseline = read('legacy-log-matches.json');
const legacyByNumber = new Map(legacyBaseline.map(row => [row.number, row]));
const checkedLegacy = [], unresolvedLegacy = [];
result.matches.forEach((match, index) => {
  const baseline = legacyByNumber.get(records[index].number);
  if (!baseline) return;
  const expectedOwners = new Set(baseline.users);
  const owner = match.owner && `${match.owner.userId}:${match.owner.apiKeyId}:${match.owner.groupId}`;
  if (owner && expectedOwners.has(owner)) checkedLegacy.push(index);
  else unresolvedLegacy.push({ number: records[index].number, status: match.status });
});
assert.equal(checkedLegacy.length, legacyBaseline.length, 'Previously established file-log ownership must stay consistent');
const auditReasons = {};
for (const group of new Map(result.matches.filter(match => match.candidateGroup).map(match => [match.candidateGroup.id, match.candidateGroup])).values()) {
  const reason = group.auditReason || 'eligible_for_native_quote'; auditReasons[reason] = (auditReasons[reason] || 0) + 1;
}
console.log(JSON.stringify({ rows: records.length, billingContext: savedBalanceContext ? 'inferred_from_saved_balance_cases' : 'raw_snapshot',
  nativeGroupPricingAndReservationsVerified: false, window, clocks: result.diagnostics.clocks, logRequests: logs.length, summary,
  ownerCandidates, candidateGroups: result.diagnostics.candidateGroups,
  auditReasons,
  observedUsageExclusions: result.diagnostics.observedUsageExclusions,
  comparison: { falsePositivesExcluded: previouslyActionable.length, knownNativeRowsProtected: known.length,
    legacyBaseline: legacyBaseline.length, sameOwner: checkedLegacy.length, unresolvedLegacy } }, null, 2));
