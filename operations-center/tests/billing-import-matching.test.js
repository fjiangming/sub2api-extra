'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSources, reconcileBillingRows, matchBillingRows } = require('../src/services/billing-import-source');
const { buildLogCandidates, enrichErrorsFromLogs } = require('../src/services/billing-import-logs');

const at = Date.parse('2026-10-22T01:00:00Z');
const options = { accountMappings: { key: 9 }, timeKind: 'start', toleranceSeconds: 5, clockOffsetSeconds: 0 };
const tokens = input => ({ InputTokens: input, OutputTokens: 13000, CacheReadTokens: 120, CacheCreationTokens: 45 });
const row = (number = 2, extra = {}) => ({ number, key: 'key', model: 'test', tokens: tokens(number), durationMs: 210000,
  time: new Date(at + 210000).toISOString(), startedAt: new Date(at + 210000).toISOString(), ...extra });
const usage = (id = 2, extra = {}) => ({ id, user_id: 3, api_key_id: 4, group_id: 5, account_id: 9, model: 'test',
  created_at: new Date(at + 210000).toISOString(), duration_ms: 210000, request_id: `native-${id}`, actual_cost: 0.2,
  input_tokens: id, output_tokens: 13000, cache_read_tokens: 120, cache_creation_tokens: 45, billing_dedup: true, ...extra });
const intent = (id, extra = {}) => ({ id, user_id: 3, api_key_id: 4, group_id: 5, account_id: 9, model: 'test',
  created_at: new Date(at).toISOString(), updated_at: new Date(at + 125000).toISOString(), state: 'unknown', version: 1, ...extra });

test('unique full native tokens exclude paid rows even with the wrong timestamp convention and unrelated pending candidates', () => {
  const sources = normalizeSources([], [usage()], [intent('other', { created_at: row().time })]);
  const match = matchBillingRows([row()], sources, options)[0];
  assert.equal(match.status, 'already_recorded'); assert.equal(match.method, 'tokens_time'); assert.equal(match.selected, null);
  assert.equal(match.candidates[0].usageId, '2'); assert.equal(match.candidates[0].billingEvidence.dedup, true);
});

test('repeated token tuples are narrowed by their own CSV times before paid exclusion and calibration', () => {
  const rows = [0, 1, 2].map((hour, index) => row(index + 2, { tokens: tokens(2),
    time: new Date(at + hour * 3600000 + 210000).toISOString() }));
  const sources = normalizeSources([], [0, 1, 2].map(hour => usage(hour + 2, { input_tokens: 2,
    created_at: new Date(at + hour * 3600000 + 210000).toISOString() })),
  [intent('unrelated', { created_at: rows[0].time })]);
  const wrong = reconcileBillingRows(rows, sources, options);
  assert.deepEqual(wrong.matches.map(match => match.status), Array(3).fill('already_recorded'));
  assert.equal(wrong.diagnostics.clocks[0].detected, 'end');
  const automatic = reconcileBillingRows(rows, sources, { ...options, timeKind: 'auto' });
  assert.equal(automatic.diagnostics.clocks[0].end, 3);
  assert.equal(automatic.records[0].matchedEndedAt, rows[0].time);
  assert.deepEqual(automatic.matches.map(match => match.candidates[0].usageId), ['2', '3', '4']);
});

test('paid one-to-one assignment resolves only forced edges and cannot count one bill twice', () => {
  const rows = [row(2), row(3, { tokens: tokens(2), time: new Date(at + 214000).toISOString() })];
  const sources = normalizeSources([], [usage(), usage(3, { input_tokens: 2, created_at: new Date(at + 218000).toISOString() })], []);
  const matches = matchBillingRows(rows, sources, options);
  assert.deepEqual(matches.map(match => match.status), ['already_recorded', 'already_recorded']);
  assert.deepEqual(matches.map(match => match.candidates[0].usageId), ['2', '3']);
  assert.match(matches[1].batchAssignment, /^[a-f0-9]{64}$/);
  const insufficient = matchBillingRows([...rows, row(4, { tokens: tokens(2), time: new Date(at + 214001).toISOString() })], sources, options);
  assert.ok(insufficient.every(match => match.status === 'recorded_conflict' && !match.selected));
});

test('multiple CSV rows pointing to the same native request cannot supply independent clock votes', () => {
  const rows = [0, 1, 2].map((ms, index) => row(index + 2, { tokens: tokens(2),
    time: new Date(at + 210000 + ms).toISOString() }));
  const result = reconcileBillingRows(rows, normalizeSources([], [usage()], []), { ...options, timeKind: 'auto' });
  assert.equal(result.diagnostics.clocks[0].end, 0);
  assert.equal(result.diagnostics.clocks[0].detected, null);
  assert.ok(result.matches.every(match => match.status === 'recorded_conflict'));
});

test('automatic calibration detects end timestamps and maps the unbilled 210s request to its original dispatch', () => {
  const rows = [row(2), row(3), row(4), row(5)];
  const sources = normalizeSources([], [usage(2), usage(3), usage(4)], [intent('missing')]);
  const result = reconcileBillingRows(rows, sources, { ...options, timeKind: 'auto' });
  assert.equal(result.diagnostics.clocks[0].detected, 'end'); assert.equal(result.diagnostics.clocks[0].end, 3);
  assert.equal(result.matches[3].status, 'time_candidate'); assert.equal(result.matches[3].selected, 'case:missing');
  assert.equal(Date.parse(result.records[3].startedAt), at);
  const wrong = reconcileBillingRows(rows, sources, options);
  assert.equal(wrong.matches[3].status, 'time_uncertain'); assert.match(wrong.matches[3].reason, /冲突/);
  assert.equal(rows[3].startedAt, row(5).startedAt, 'Do not mutate supplier identity or original records');
});

test('automatic timestamps need independent calibration, with zero duration and shared token signatures excluded from votes', () => {
  let result = reconcileBillingRows([row()], normalizeSources([], [], [intent('missing')]), { ...options, timeKind: 'auto' });
  assert.equal(result.matches[0].status, 'time_uncertain'); assert.equal(result.matches[0].selected, null);
  result = reconcileBillingRows([row()], normalizeSources([], [usage(2), usage(20, { input_tokens: 2 })], []), { ...options, timeKind: 'auto' });
  assert.equal(result.diagnostics.clocks[0].end, 0);
});

test('dedup, archive and native settled state are evidence; nonzero cost or prepared usage alone are not', () => {
  for (const source of [usage(2, { billing_dedup: false, actual_cost: 0 }), usage(2, { billing_dedup: null }), usage(2, { billing_dedup: false })]) {
    const match = matchBillingRows([row()], normalizeSources([], [source], []), options)[0];
    assert.equal(match.status, 'billing_unresolved'); assert.equal(match.selected, null);
  }
  assert.equal(matchBillingRows([row()], normalizeSources([], [usage(2, { billing_dedup: false, billing_archived: true })], []), options)[0].status, 'already_recorded');
  const recorded = intent('pending', { state: 'prepared', usage_record: { ...tokens(2), RequestID: 'native-2' } });
  assert.equal(matchBillingRows([row(2, { time: new Date(at).toISOString() })], normalizeSources([], [], [recorded]), options)[0].status, 'billing_unresolved');
});

test('uncertain four-hour intervals do not overwhelm precise candidates and cannot authorize time-only previews', () => {
  const errors = Array.from({ length: 40 }, (_, id) => ({ ...usage(id), request_id: `error-${id}`, response_latency_ms: null }));
  const current = row(2, { time: new Date(at).toISOString(), startedAt: new Date(at).toISOString() });
  const precise = matchBillingRows([current], normalizeSources(errors, [], [intent('known')]), options)[0];
  assert.equal(precise.status, 'time_candidate'); assert.equal(precise.totalCandidates, 1);
  const unknown = matchBillingRows([current], normalizeSources(errors, [], []), options)[0];
  assert.equal(unknown.status, 'time_uncertain'); assert.equal(unknown.selected, null);
});

test('multiple dispatches can share user ownership without arbitrarily selecting a request; keys and groups remain distinct', () => {
  const current = row(2, { time: new Date(at).toISOString(), startedAt: new Date(at).toISOString() });
  let match = matchBillingRows([current], normalizeSources([], [], [intent('one'), intent('two')]), options)[0];
  assert.equal(match.status, 'owner_candidate'); assert.equal(match.owner.userId, '3'); assert.equal(match.selected, null);
  match = matchBillingRows([current], normalizeSources([], [], [intent('one'), intent('two', { api_key_id: 8 })]), options)[0];
  assert.equal(match.status, 'ambiguous'); assert.equal(match.owner, undefined);
  match = matchBillingRows([current], normalizeSources([], [], [intent('one'), intent('two', { group_id: 8 })]), options)[0];
  assert.equal(match.status, 'ambiguous');
});

test('batch one-to-one constraints resolve a forced request without choosing the nearest candidate', () => {
  const rows = [row(2, { time: new Date(at).toISOString() }), row(3, { time: new Date(at + 4000).toISOString() })];
  const source = normalizeSources([], [], [intent('one'), intent('two', { created_at: new Date(at + 8000).toISOString(), user_id: 9 })]);
  const matches = matchBillingRows(rows, source, options);
  assert.equal(matches[0].selected, 'case:one');
  assert.equal(matches[1].selected, 'case:two'); assert.equal(matches[1].status, 'time_candidate');
  assert.match(matches[1].batchAssignment, /^[a-f0-9]{64}$/);
  const ambiguous = matchBillingRows([rows[1]], source, options)[0];
  assert.equal(ambiguous.selected, null); assert.equal(ambiguous.status, 'ambiguous');
  const insufficient = matchBillingRows([...rows, row(4, { time: rows[1].time })], source, options);
  assert.ok(insufficient.every(match => !match.batchAssignment));
});

test('one paid local request cannot exclude two distinct supplier rows and request-ID conflicts stay blocked', () => {
  const rows = [row(2), row(3, { tokens: tokens(2), time: new Date(at + 210100).toISOString() })];
  const matches = matchBillingRows(rows, normalizeSources([], [usage()], []), options);
  assert.deepEqual(matches.map(match => match.status), ['recorded_conflict', 'recorded_conflict']);
  const source = normalizeSources([], [usage()], [intent('other', { upstream_request_id: 'up-new' })]);
  const conflict = matchBillingRows([row(2, { requestId: 'up-new' })], source, options)[0];
  assert.equal(conflict.status, 'recorded_conflict'); assert.equal(conflict.selected, null);
});

test('missing cache dimensions and token differences do not get labeled as verified full native billing', () => {
  const source = normalizeSources([], [usage()], []);
  const end = { ...options, timeKind: 'end' };
  assert.equal(matchBillingRows([row(2, { tokens: { ...tokens(2), CacheReadTokens: null } })], source, end)[0].status, 'billing_unresolved');
  assert.equal(matchBillingRows([row(2, { tokens: tokens(99) })], source, end)[0].status, 'usage_difference');
});

test('requested and upstream model aliases preserve attribution, and known cache TTL differences require review', () => {
  const source = normalizeSources([], [usage(2, { model: 'internal-billing-model', requested_model: 'test', upstream_model: 'supplier-model',
    cache_creation_5m_tokens: 45, cache_creation_1h_tokens: 0 })], []);
  assert.equal(matchBillingRows([row()], source, options)[0].status, 'already_recorded');
  assert.equal(matchBillingRows([row(2, { model: 'supplier-model' })], source, options)[0].status, 'already_recorded');
  const different = row(2, { tokens: { ...tokens(2), CacheCreation5mTokens: 0, CacheCreation1hTokens: 45 } });
  assert.equal(matchBillingRows([different], source, options)[0].status, 'usage_difference');
});

const events = (id = 'req-a', extra = {}) => [
  { request_id: id, component: 'gateway', ts: new Date(at).toISOString(), user_id: 3, api_key_id: 4, group_id: 5 },
  { request_id: id, component: 'gateway', ts: new Date(at).toISOString(), selected_account_id: 9, model: 'test', stream: false },
  { request_id: id, component: 'http.access', ts: new Date(at + 125000).toISOString(), completed_at: new Date(at + 125000).toISOString(),
    account_id: 9, status_code: 499, latency_ms: 125000, ...extra }
];
const range = { from: new Date(at - 10000).toISOString(), to: new Date(at + 300000).toISOString(), accounts: ['9'] };

test('complete file-only cancellations carry auditable attribution for native import review', () => {
  const logs = buildLogCandidates(events(), range);
  assert.equal(logs.length, 1); assert.equal(logs[0].userId, '3'); assert.equal(logs[0].startMs, at);
  const match = matchBillingRows([row()], normalizeSources([], [], [], logs), { ...options, timeKind: 'end' })[0];
  assert.equal(match.status, 'time_candidate'); assert.equal(match.selected, 'log:req-a');
  assert.match(match.candidates[0].logSource.digest, /^[a-f0-9]{64}$/);
  assert.equal(match.candidates[0].logSource.request_id, 'req-a');
  assert.equal(match.candidates[0].logSource.latency_ms, 125000);
});

test('log joins reject reused internal IDs, multiple account selections, conflicting identities, or wrong accounts', () => {
  assert.equal(buildLogCandidates([...events(), ...events()], range).length, 0);
  assert.equal(buildLogCandidates([...events(), { ...events()[0], user_id: 7 }], range).length, 0);
  assert.equal(buildLogCandidates(events('req', { account_id: 10 }), range).length, 0);
  assert.equal(buildLogCandidates([...events(), { ...events()[1], selected_account_id: 10 }], range).length, 0);
  assert.equal(buildLogCandidates(events('req', { latency_ms: 40000 }), range).length, 0);
  assert.equal(buildLogCandidates([...events('one', { client_request_id: 'reused' }), ...events('two', { client_request_id: 'reused' })], range).length, 2);
});

test('file correlation enriches only the same native owner and preserves separate dispatch attempts', () => {
  const logs = buildLogCandidates(events(), range);
  const error = { ...usage(), request_id: 'req-a', response_latency_ms: null, created_at: new Date(at + 125000).toISOString() };
  const enriched = enrichErrorsFromLogs([error, { ...error, api_key_id: 7 }], logs);
  assert.equal(enriched[0].log_start_ms, at); assert.equal(enriched[1].log_start_ms, undefined);
  const sources = normalizeSources([enriched[0]], [], [], logs);
  assert.equal(sources.length, 1); assert.equal(sources[0].kind, 'error'); assert.equal(sources[0].startUncertain, false);
  const attempts = normalizeSources([{ ...enriched[0], upstream_errors: [{ account_id: 9 }, { account_id: 9 }] }], [], [], logs);
  assert.equal(attempts.length, 2); assert.ok(attempts.every(item => item.startUncertain));
});

test('shared server or upstream IDs correlate evidence without merging separate dispatch intents', () => {
  const logs = buildLogCandidates(events(), range);
  const error = { ...usage(), request_id: 'req-a', response_latency_ms: 125000, created_at: new Date(at + 125000).toISOString() };
  const cases = [intent('one', { request_snapshot: { request_id: 'req-a' } })];
  let sources = normalizeSources([error], [], cases, logs);
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].sourceEvidence.map(item => item.kind), ['case', 'error', 'log']);
  assert.match(sources[0].sourceEvidence[2].digest, /^[a-f0-9]{64}$/);
  sources = normalizeSources([error], [], [...cases, intent('two', { request_snapshot: { request_id: 'req-a' } })], logs);
  assert.equal(sources.length, 2); assert.ok(sources.every(item => item.kind === 'case'));
  assert.ok(sources.every(item => item.sourceEvidence.length === 3));
  sources = normalizeSources([{ ...error, request_id: 'different-server', upstream_errors: [{ account_id: 9, upstream_request_id: 'up-1' }] }], [],
    [intent('upstream', { upstream_request_id: 'up-1' })]);
  assert.equal(sources.length, 1); assert.equal(sources[0].sourceEvidence[1].kind, 'error');
  sources = normalizeSources([{ ...error, upstream_errors: [{ account_id: 9 }, { account_id: 9 }] }], [], cases);
  assert.equal(sources.length, 3, 'Repeated same-account attempts cannot be attached to one intent without a per-attempt ID');
});

test('reused client IDs and close timestamps never collapse unrelated request evidence', () => {
  const error = { ...usage(), request_id: 'other-server', client_request_id: 'reused', response_latency_ms: 125000,
    created_at: new Date(at + 125000).toISOString() };
  const cases = [intent('one', { request_snapshot: { request_id: 'original-server', client_request_id: 'reused' } })];
  assert.equal(normalizeSources([error], [], cases).length, 2);
  assert.equal(normalizeSources([{ ...error, request_id: 'original-server', group_id: 6 }], [], cases).length, 2);
  const sources = normalizeSources([error], [], [intent('no-ids')]);
  const match = matchBillingRows([row(2, { time: new Date(at).toISOString() })], sources, options)[0];
  assert.equal(match.status, 'owner_candidate'); assert.equal(match.selected, null);
  assert.equal(match.candidateGroup.unlinkedCases, true);
  assert.match(match.candidateGroup.reason, /共同关联 ID/);
});

test('final observed tokens disambiguate concurrent requests and participate in batch assignment', () => {
  const rows = [row(2, { time: new Date(at).toISOString() }), row(3, { time: new Date(at).toISOString() })];
  const sources = normalizeSources([], [], [2, 3].map(number => intent(`observed-${number}`, { observed_usage: {
    input_tokens: number, output_tokens: 13000, cache_read_input_tokens: 120, cache_creation_input_tokens: 45,
    _recovery: { complete: true } } })));
  const result = reconcileBillingRows(rows, sources, options);
  assert.deepEqual(result.matches.map(match => match.selected), ['case:observed-2', 'case:observed-3']);
  assert.ok(result.matches.every(match => match.status === 'time_candidate' && match.usageConstraints.excluded === 1));
  assert.equal(result.diagnostics.observedUsageExclusions, 2);
});

test('partial observations constrain lower bounds while unknown or invalid usage never becomes final proof', () => {
  const current = row(2, { time: new Date(at).toISOString() });
  const sources = normalizeSources([], [], [intent('partial', { observed_usage: { output_tokens: 10000 } }),
    intent('too-large', { observed_usage: { output_tokens: 14000 } })]);
  assert.equal(matchBillingRows([current], sources, options)[0].selected, 'case:partial');
  for (const observed_usage of [{}, { output_tokens: 14000, _recovery: { invalid_usage: true } }]) {
    const uncertain = normalizeSources([], [], [intent('one'), intent('unknown', { observed_usage })]);
    assert.equal(matchBillingRows([current], uncertain, options)[0].status, 'owner_candidate');
  }
  const exact = normalizeSources([], [], [intent('exact', { upstream_request_id: 'upstream-one', observed_usage: { output_tokens: 14000 } })]);
  const conflict = matchBillingRows([{ ...current, requestId: 'upstream-one' }], exact, options)[0];
  assert.equal(conflict.status, 'needs_review'); assert.equal(conflict.selected, null); assert.match(conflict.reason, /Token.*冲突/);
  const inclusive = normalizeSources([], [], [intent('inclusive', { observed_usage: { prompt_tokens: 100,
    output_tokens: 13000, _recovery: { complete: true } } })]);
  assert.equal(inclusive[0].usageEvidence.tokens.InputTokens, null, 'Unknown cache counts cannot be assumed zero when converting inclusive input');
  assert.equal(matchBillingRows([current], inclusive, options)[0].selected, 'case:inclusive');
});

test('automatic group analysis distinguishes same-owner complete allocations from mixed owners and missing sources', () => {
  const rows = [row(2, { time: new Date(at).toISOString() }), row(3, { time: new Date(at).toISOString() })];
  const sources = normalizeSources([], [], [intent('one'), intent('two')]);
  const result = reconcileBillingRows(rows, sources, options);
  assert.ok(result.matches.every(match => match.status === 'owner_candidate' && !match.selected));
  const group = result.matches[0].candidateGroup;
  assert.deepEqual(result.matches[1].candidateGroup, group);
  assert.equal(group.status, 'sameOwner'); assert.equal(group.balanced, true); assert.equal(group.allocationExists, true);
  assert.equal(group.rows, 2); assert.equal(group.sources, 2); assert.deepEqual(group.rowNumbers, [2, 3]);
  assert.equal(result.diagnostics.candidateGroups.sameOwner, 1);
  const different = matchBillingRows(rows, normalizeSources([], [], [intent('one'), intent('two', { user_id: 8 })]), options);
  assert.ok(different.every(match => match.candidateGroup.status === 'mixedOwners' && !match.selected));
  const short = matchBillingRows([...rows, row(4, { time: new Date(at).toISOString() })], sources, options);
  assert.ok(short.every(match => match.candidateGroup.status === 'incomplete' && !match.selected));
});
