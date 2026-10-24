'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseBillingCSV, describeBillingCSV } = require('../src/services/billing-import-csv');
const { normalizeSources, matchBillingRows, reconcileBillingRows } = require('../src/services/billing-import-source');
const { BillingRecoveryStore } = require('../src/billing-recovery-store');
const { BillingImportStore } = require('../src/billing-import-store');
const { BillingImportService, optionsSchema, manualUsage } = require('../src/services/billing-import-service');
const { AppError } = require('../src/errors');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { AuthService } = require('../src/auth');

const caseId = '00000000-0000-4000-8000-000000000001';
const at = '2026-10-22T01:08:08.000Z';
const header = 'Time,API Key Name,Model,Input Tokens,Output Tokens,Cache Read Tokens,Cache Creation Tokens,Duration (ms),Billed Cost,Type,Billing Mode,Request ID';
const csvRow = (overrides = {}) => ({ Time: '2026-10-22T09:08:08+08:00', 'API Key Name': 'ccmax-key', Model: 'claude-opus-5-5',
  'Input Tokens': '4964', 'Output Tokens': '13212', 'Cache Read Tokens': '0', 'Cache Creation Tokens': '0',
  'Duration (ms)': '174000', 'Billed Cost': '0.224436', Type: 'Sync', 'Billing Mode': '按量', 'Request ID': '', ...overrides });
const csv = (overrides = [{}]) => `${header}\n${overrides.map(override => Object.values(csvRow(override)).map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')}`;
const options = (extra = {}) => optionsSchema.parse({ timeKind: 'start', accountMappings: { 'ccmax-key': 356 }, ...extra });
const nativeCase = (extra = {}) => ({ id: caseId, user_id: 11, api_key_id: 12, account_id: 356, group_id: 15, version: 1,
  state: 'unknown', model: 'claude-opus-5-5', created_at: at, updated_at: '2026-10-22T01:10:13Z',
  request_snapshot: { user_email: 'owner@example.test', request_id: 'root-1' }, ...extra });
const nativeError = (extra = {}) => ({ id: '18', user_id: '11', api_key_id: '12', account_id: '356', group_id: '15',
  model: 'claude-opus-5-5', created_at: '2026-10-22T01:10:13Z', response_latency_ms: 125000,
  request_id: 'root-1', upstream_errors: null, ...extra });
const pricing = { input: 5, output: 25, cacheRead: 0.5, cache5m: 6.25, cache1h: 10, multiplier: 0.7, accountMultiplier: 1, cacheTTL: 'split' };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-billing-test-'));
  let now = Date.parse('2026-10-23T04:00:00Z');
  const persistent = new BillingRecoveryStore(directory, { now: () => now }); persistent.initialize();
  const store = new BillingImportStore(persistent); store.initialize();
  t.after(() => { persistent.close(); fs.rmSync(directory, { force: true, recursive: true }); });
  const entries = new Map([[caseId, nativeCase()]]), calls = [], claims = new Map();
  let charges = 0, amount = 0;
  const recovery = {
    async detail(id) { return { case: structuredClone(entries.get(id)) }; },
    async request(url, request) {
      calls.push({ url, ...structuredClone(request) });
      if (url.endsWith('/quote')) {
        return { usage_record: manualUsage({ model: 'claude-opus-5-5', stream: false }, request.body.tokens, pricing) };
      }
      if (url === '/imports/reserve') {
        const body = request.body;
        const previous = claims.get(body.bill_identity);
        if (previous && previous.payload_digest !== body.payload_digest) throw new AppError('CONFLICT', 'claim conflict', { status: 409 });
        claims.set(body.bill_identity, structuredClone(body));
        return { case_id: body.case_id || caseId };
      }
      throw new Error('unexpected request');
    },
    async restore(id, body) {
      calls.push({ restore: id }); const entry = entries.get(id);
      assert.equal(body.version, entry.version);
      Object.assign(entry, { usage_record: structuredClone(body.usage_record), state: 'review', version: entry.version + 1 });
    },
    async review(id, body) { calls.push({ review: id }); const entry = entries.get(id); assert.equal(body.version, entry.version); entry.state = body.state; entry.version++; },
    async settle(id, body) {
      calls.push({ settle: id }); const entry = entries.get(id); assert.equal(body.version, entry.version);
      if (entry.state !== 'settled') { charges++; amount += entry.usage_record.ActualCost; entry.state = 'settled'; entry.version++; }
    }
  };
  const source = { accounts: async () => [{ id: '356', name: 'Lingsu', platform: 'anthropic' }],
    load: async () => ({ candidates: normalizeSources([], [], [...entries.values()]), coreAvailable: true }) };
  const service = new BillingImportService({ store, source, recovery, now: () => now });
  return { persistent, directory, store, service, source, recovery, calls, entries,
    advance: ms => { now += ms; }, charges: () => charges, amount: () => amount };
}
async function matched(f, content = csv()) {
  const batch = await f.service.import({ fileName: 'supplier.csv', csv: content });
  return f.service.match(batch.id, options());
}
async function previewed(f, batch, extra = {}) {
  await f.service.preview(batch.id, { rowIds: batch.rows.map(row => row.id), pricing: { 'claude-opus-5-5': pricing },
    pricingEvidence: 'Historical group price and user multiplier verified', finalUsageConfirmed: true, confirmTimeMatches: true, ...extra });
  return f.service.detail(batch.id);
}
const confirmBody = batch => ({ acknowledge: true, rows: batch.rows.filter(row => row.preview).map(row => ({ id: row.id, version: row.version, previewId: row.preview.id })) });

test('CSV parser handles real export headers, quoted names, BOM and explicit timezone offsets', () => {
  const parsed = parseBillingCSV(`\uFEFF${csv([{ 'API Key Name': 'Key, "special"' }])}`, options());
  assert.equal(parsed.rows[0].key, 'Key, "special"'); assert.equal(parsed.rows[0].startedAt, at);
  assert.equal(parsed.columns.duration, 'Duration (ms)'); assert.equal(parsed.rows[0].tokens.InputTokens, 4964);
  assert.equal(parsed.rows[0].cost, '0.224436'); assert.equal(parsed.rows[0].error, null);
});

test('CSV timestamp kind, timezone and clock correction do not alter immutable bill identities', () => {
  const content = csv([{ Time: '2026-10-22 09:11:02' }]);
  const normal = parseBillingCSV(content).rows[0];
  const adjusted = parseBillingCSV(content, options({ timeKind: 'end', clockOffsetSeconds: 2 })).rows[0];
  assert.equal(adjusted.startedAt, '2026-10-22T01:08:10.000Z'); assert.equal(normal.identity, adjusted.identity);
  assert.equal(parseBillingCSV(content, options({ timezone: 'UTC' })).rows[0].identity, normal.identity);
  const inclusive = csv([{ 'Input Tokens': '100', 'Cache Read Tokens': '20', 'Cache Creation Tokens': '10' }]);
  const result = parseBillingCSV(inclusive, options({ inputIncludesCache: true })).rows[0];
  assert.equal(result.tokens.InputTokens, 70);
  assert.equal(result.identity, parseBillingCSV(inclusive).rows[0].identity);
});

test('CSV refuses invalid counts, malformed dates, inconsistent columns and oversized records', () => {
  for (const value of ['-1', '1.2', '1e3', 'true', '2147483648', '']) {
    assert.match(parseBillingCSV(csv([{ 'Output Tokens': value }])).rows[0].error, /非负整数/);
  }
  assert.match(parseBillingCSV(csv([{ Time: 'not a date' }])).rows[0].error, /时间/);
  assert.throws(() => describeBillingCSV('Time,time\n1,2'), /重复/);
  assert.throws(() => describeBillingCSV('Time,Model\n1'), /CSV 格式/);
  assert.throws(() => describeBillingCSV(`Time,Model\n1,${'x'.repeat(70000)}`), /CSV 格式/);
  assert.throws(() => parseBillingCSV('when,engine,in,out\n2026-10-22,test,1,2'), /字段映射/);
  const mapped = parseBillingCSV('when,engine,in,out\n2026-10-22,test,1,2', { columns: { time: 'when', model: 'engine', input: 'in', output: 'out' } });
  assert.equal(mapped.rows[0].tokens.CacheReadTokens, null);
  assert.equal(parseBillingCSV(csv(), { columns: { cacheRead: '' } }).rows[0].tokens.CacheReadTokens, null);
});

test('supplier request IDs and duplicate export rows remain stable regardless of cost', () => {
  const rows = parseBillingCSV(csv([{}, {}, { 'Request ID': 'upstream-1' }, { 'Request ID': 'upstream-1', 'Billed Cost': '99' }])).rows;
  assert.equal(rows[1].duplicateOf, 2); assert.equal(rows[3].duplicateOf, 4);
  assert.notEqual(rows[0].identity, rows[2].identity);
  const precise = parseBillingCSV(csv([{ Time: '2026-10-22T09:08:08.123456+08:00' }, { Time: '2026-10-22T09:08:08.123457+08:00' }])).rows;
  assert.notEqual(precise[0].identity, precise[1].identity); assert.equal(precise[1].duplicateOf, undefined);
  assert.equal(parseBillingCSV(csv([{ Time: '2026-10-22T01:08:08.123456Z' }])).rows[0].identity, precise[0].identity);
});

test('legacy errors without native correlation are candidates but cannot authorize a second charge', () => {
  const candidates = normalizeSources([nativeError({ request_id: '', client_request_id: '', upstream_errors: null })], [], []);
  const result = matchBillingRows(parseBillingCSV(csv([{ 'Request ID': 'csv-id-alone' }])).rows, candidates, options())[0];
  assert.equal(result.status, 'needs_review'); assert.equal(result.selected, null);
  assert.match(result.reason, /关联 ID/);
});

test('time matching uses the original 125s error start even when supplier billed 174s', () => {
  const sources = normalizeSources([nativeError()], [], []);
  const match = matchBillingRows(parseBillingCSV(csv()).rows, sources, options())[0];
  assert.equal(match.status, 'time_candidate'); assert.equal(match.candidates[0].userId, '11');
  assert.equal(match.candidates[0].timeDifferenceMs, 0);
  assert.equal(match.candidates[0].reference, 'error:18:-1');
});

test('simultaneous users and multiple upstream attempts remain ambiguous', () => {
  const sources = normalizeSources([nativeError(), nativeError({ id: '19', user_id: '20', api_key_id: '21' })], [], []);
  let result = matchBillingRows(parseBillingCSV(csv()).rows, sources, options())[0];
  assert.equal(result.status, 'ambiguous'); assert.equal(result.selected, null);
  const attempts = normalizeSources([nativeError({ upstream_errors: [{ account_id: 356 }, { account_id: 356 }] })], [], []);
  result = matchBillingRows(parseBillingCSV(csv()).rows, attempts, options())[0];
  assert.equal(result.totalCandidates, 2); assert.equal(result.candidates[0].startUncertain, true);
});

test('missing duration keeps an uncertain interval and exact IDs never cross accounts or models', () => {
  const sources = normalizeSources([nativeError({ response_latency_ms: null, upstream_errors: [{ account_id: 356, upstream_request_id: 'up-1' }] })], [], []);
  let match = matchBillingRows(parseBillingCSV(csv()).rows, sources, options())[0];
  assert.equal(match.status, 'time_uncertain'); assert.equal(match.selected, null); assert.equal(match.candidates[0].startUncertain, true);
  match = matchBillingRows(parseBillingCSV(csv([{ 'Request ID': 'up-1', Time: '2026-10-21T00:00:00Z' }])).rows, sources, options())[0];
  assert.equal(match.status, 'exact');
  assert.equal(matchBillingRows(parseBillingCSV(csv()).rows, sources, options({ accountMappings: { 'ccmax-key': 1 } }))[0].status, 'unmatched');
  assert.equal(matchBillingRows(parseBillingCSV(csv([{ Model: 'different' }])).rows, sources, options())[0].status, 'unmatched');
});

test('durable dispatch and its legacy error and native usage are not counted as three requests', () => {
  const usage = { RequestID: 'dispatch:one', InputTokens: 4964, OutputTokens: 13212, CacheReadTokens: 0, CacheCreationTokens: 0 };
  const sources = normalizeSources([nativeError()], [{ ...nativeError(), id: '5', request_id: 'dispatch:one', duration_ms: 174000 }],
    [nativeCase({ state: 'settled', usage_record: usage })]);
  assert.equal(sources.length, 1);
  assert.equal(matchBillingRows(parseBillingCSV(csv()).rows, sources, options())[0].status, 'already_recorded');
  const different = parseBillingCSV(csv([{ 'Output Tokens': '15000' }])).rows;
  assert.equal(matchBillingRows(different, sources, options())[0].status, 'usage_difference');
});

test('native billed requests normalize end timestamps back to the start and cannot be charged again', () => {
  const sources = normalizeSources([], [{ ...nativeError(), duration_ms: 125000, billing_dedup: true, input_tokens: 4964, output_tokens: 13212, cache_read_tokens: 0, cache_creation_tokens: 0 }], []);
  const result = matchBillingRows(parseBillingCSV(csv()).rows, sources, options())[0];
  assert.equal(result.status, 'already_recorded'); assert.equal(result.selected, null);
});

test('two supplier bills cannot independently auto-assign the same local request', () => {
  const matches = matchBillingRows(parseBillingCSV(csv([{}, { 'Output Tokens': '13213' }])).rows, normalizeSources([], [], [nativeCase()]), options());
  assert.deepEqual(matches.map(row => row.status), ['assignment_conflict', 'assignment_conflict']);
  assert.ok(matches.every(row => row.selected === null));
});

test('reimport resumes saved batch and previews never reserve, write usage or charge', async t => {
  const f = fixture(t); const batch = await matched(f);
  const preview = await previewed(f, batch);
  const again = await f.service.import({ fileName: 'another-name.csv', csv: csv() });
  assert.equal(again.id, batch.id); assert.equal(again.rows[0].preview.id, preview.rows[0].preview.id);
  assert.equal(f.calls.length, 0); assert.equal(f.charges(), 0);
  assert.equal(preview.rows[0].preview.userId, '11'); assert.equal(preview.rows[0].preview.billingType, 'balance');
  assert.equal(preview.rows[0].preview.usage.ActualCost, 0.248584);
  assert.notEqual(preview.rows[0].preview.usage.ActualCost, Number(csvRow()['Billed Cost']));
});

test('preview comparisons use actual CSV USD cost and preserve signed differences and unknown amounts', async t => {
  const f = fixture(t);
  for (const [cost, supplierCost, balanceDifference] of [
    ['0.30', '0.30000000', '0.05141600'], ['0.224436', '0.22443600', '-0.02414800'],
    ['0.248584', '0.24858400', '0.00000000'], ['0', '0.00000000', '-0.24858400'],
    ['$0.30', '0.30000000', '0.05141600'], ['USD 1,000.00000001', '1000.00000001', '999.75141601'],
    ['0.300000005', '0.30000001', '0.05141601'],
    ...['', '-', 'NaN', '-1', 'CNY 1.00', '0.30 USD CNY', '0x10', '1,23.4'].map(value => [value, null, null])
  ]) {
    const batch = await previewed(f, await matched(f, csv([{ 'Billed Cost': cost }])));
    assert.deepEqual(batch.rows[0].costComparison, { supplierCost, localCost: '0.24858400', balanceDifference }, cost);
    assert.equal(batch.rows[0].preview.usage.AccountRateMultiplier, 1);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.charges(), 0);
});

test('preview cost comparisons are read-only, survive reload and never change native settlement', async t => {
  const f = fixture(t); let batch = await matched(f);
  assert.equal(batch.rows[0].costComparison, null);
  batch = await previewed(f, batch);
  const frozen = f.store.get(batch.rows[0].id);
  assert.equal(Object.hasOwn(frozen.preview, 'costComparison'), false);
  f.persistent.close(); f.persistent.initialize(); f.store.initialize();
  const reloaded = f.service.detail(batch.id);
  assert.deepEqual(reloaded.rows[0].costComparison, batch.rows[0].costComparison);
  assert.deepEqual(f.store.get(batch.rows[0].id), frozen);
  await f.service.confirm(reloaded.id, confirmBody(reloaded));
  assert.equal(f.charges(), 1); assert.equal(f.amount(), 0.248584);
});

test('subscription previews show upstream costs without claiming a user balance difference', async t => {
  const f = fixture(t); f.entries.get(caseId).subscription_id = 7;
  const batch = await previewed(f, await matched(f, csv([{ 'Billed Cost': '0.30' }])));
  assert.equal(batch.rows[0].preview.billingType, 'subscription');
  assert.deepEqual(batch.rows[0].costComparison, { supplierCost: '0.30000000', localCost: '0.24858400', balanceDifference: null });
  assert.equal(f.charges(), 0);
});

test('time ownership, final usage, historical prices, missing cache and TTL each require verification', async t => {
  const f = fixture(t); const batch = await matched(f);
  let result = await previewed(f, batch, { confirmTimeMatches: false }); assert.equal(result.rows[0].status, 'needs_review');
  await assert.rejects(previewed(f, result, { finalUsageConfirmed: false }), { code: 'INVALID_REQUEST' });
  result = await previewed(f, result, { pricing: {} }); assert.match(result.rows[0].result.error, /历史售卖/);
  result = await previewed(f, result, { pricingEvidence: '' }).catch(error => error); assert.equal(result.code, 'INVALID_REQUEST');
  const missing = await matched(f, csv([{ 'Cache Read Tokens': '', 'Cache Creation Tokens': '10' }]));
  result = await previewed(f, missing); assert.match(result.rows[0].result.error, /缓存明细/);
  result = await previewed(f, result, { missingCacheIsZero: true }); assert.match(result.rows[0].result.error, /归属/);
  result = await previewed(f, result, { missingCacheIsZero: true, pricing: { 'claude-opus-5-5': { ...pricing, cacheTTL: '5m' } } });
  assert.equal(result.rows[0].status, 'preview'); assert.equal(result.rows[0].preview.usage.CacheCreation5mTokens, 10);
  assert.equal(f.calls.length, 0);
});

test('ambiguous matches require an explicit candidate and recorded ownership evidence', async t => {
  const f = fixture(t);
  f.entries.set('00000000-0000-4000-8000-000000000002', nativeCase({ id: '00000000-0000-4000-8000-000000000002', user_id: 20 }));
  let batch = await matched(f);
  assert.equal(batch.rows[0].status, 'ambiguous');
  batch = await previewed(f, batch); assert.equal(batch.rows[0].status, 'needs_review');
  batch = await previewed(f, batch, { assignments: { [batch.rows[0].id]: `case:${caseId}` } });
  assert.match(batch.rows[0].result.error, /归属核对依据/);
  batch = await previewed(f, batch, { assignments: { [batch.rows[0].id]: `case:${caseId}` }, assignmentEvidence: 'Request trace confirms downstream user 11' });
  assert.equal(batch.rows[0].status, 'preview'); assert.equal(batch.rows[0].preview.userId, '11');
});

test('frozen core pricing is preferred and conflicting final observed usage cannot be previewed', async t => {
  const f = fixture(t); f.entries.get(caseId).request_snapshot.pricing = { eligible: true };
  let batch = await matched(f); batch = await previewed(f, batch, { pricing: {} });
  assert.equal(batch.rows[0].preview.pricingSource, 'immutable_dispatch_snapshot');
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /quote$/);
  f.entries.get(caseId).observed_usage = { input_tokens: 4964, output_tokens: 14000, _recovery: { complete: true } };
  batch = await previewed(f, batch, { pricing: {} });
  assert.equal(batch.rows[0].status, 'needs_review'); assert.match(batch.rows[0].result.error, /观察用量冲突/);
  f.entries.get(caseId).observed_usage = {};
  f.entries.get(caseId).request_snapshot.pricing.eligible = false;
  batch = await previewed(f, batch);
  assert.equal(batch.rows[0].status, 'needs_review'); assert.match(batch.rows[0].result.error, /原生维度与历史价格/);
  assert.equal(f.charges(), 0);
});

test('preview amount exactly follows native float64-then-decimal settlement quantization', async t => {
  const tokens = { InputTokens: 1, OutputTokens: 0, CacheReadTokens: 0, CacheCreationTokens: 0, CacheCreation5mTokens: 0, CacheCreation1hTokens: 0 };
  const usage = manualUsage({ model: 'test', stream: false }, tokens, { ...pricing, input: 0.03, multiplier: 1.5 });
  assert.equal(usage.TotalCost, 0.00000003); assert.equal(usage.ActualCost, 0.00000004);
  const f = fixture(t); f.entries.get(caseId).request_snapshot.pricing = { eligible: true };
  const request = f.recovery.request;
  f.recovery.request = async (...args) => args[0].endsWith('/quote') ? { usage_record: { ...usage, Model: 'claude-opus-5-5', ActualCost: 4.499999999999999e-8 } } : request(...args);
  const batch = await previewed(f, await matched(f));
  assert.equal(batch.rows[0].preview.usage.ActualCost, 0.00000004);
});

test('result filters hide settled pages without losing saved receipts', async t => {
  const f = fixture(t); const batch = await previewed(f, await matched(f));
  assert.equal(f.service.detail(batch.id, { filter: 'actionable' }).filteredTotal, 1);
  await f.service.confirm(batch.id, confirmBody(batch));
  assert.equal(f.service.detail(batch.id, { filter: 'actionable', page: 10 }).rows.length, 0);
  assert.equal(f.service.detail(batch.id, { filter: 'settled' }).rows[0].result.caseId, caseId);
});

test('confirmed preview restores usage then uses native approval and settlement exactly once', async t => {
  const f = fixture(t); const batch = await previewed(f, await matched(f));
  const result = await f.service.confirm(batch.id, confirmBody(batch));
  assert.equal(result.results[0].status, 'settled'); assert.equal(f.charges(), 1); assert.equal(f.amount(), 0.248584);
  assert.deepEqual(f.calls.map(call => call.url || Object.keys(call)[0]), ['/imports/reserve', 'restore', 'review', 'settle']);
  await f.service.confirm(batch.id, confirmBody(batch)); assert.equal(f.charges(), 1);
  await assert.rejects(f.service.match(batch.id, options()), { code: 'IMPORT_LOCKED' });
});

test('lost native settlement response is recovered by reading persisted state without charging again', async t => {
  const f = fixture(t); const settle = f.recovery.settle;
  f.recovery.settle = async (...args) => { await settle(...args); throw new Error('connection reset after commit'); };
  const batch = await previewed(f, await matched(f));
  const result = await f.service.confirm(batch.id, confirmBody(batch));
  assert.equal(result.results[0].status, 'settled'); assert.equal(f.charges(), 1);
});

test('concurrent operator confirmations reserve one lease and charge one native request', async t => {
  const f = fixture(t); const batch = await previewed(f, await matched(f));
  const request = f.recovery.request; let release;
  f.recovery.request = async (...args) => {
    if (args[0] === '/imports/reserve') await new Promise(resolve => { release = resolve; });
    return request(...args);
  };
  const first = f.service.confirm(batch.id, confirmBody(batch));
  try { await assert.rejects(f.service.confirm(batch.id, confirmBody(batch)), { code: 'PREVIEW_CONFLICT' }); }
  finally { release(); }
  assert.equal((await first).results[0].status, 'settled'); assert.equal(f.charges(), 1);
});

test('interrupted confirmation keeps its frozen preview across restart and cannot be rematched', async t => {
  const f = fixture(t); const restore = f.recovery.restore;
  f.recovery.restore = async (...args) => { await restore(...args); throw new Error('lost restore response'); };
  let batch = await previewed(f, await matched(f));
  let result = await f.service.confirm(batch.id, confirmBody(batch)); assert.equal(result.results[0].status, 'failed');
  await assert.rejects(f.service.match(batch.id, options({ clockOffsetSeconds: 1 })), { code: 'IMPORT_LOCKED' });
  const previewId = result.detail.rows[0].preview.id;
  f.persistent.close(); f.persistent.initialize(); f.store.initialize();
  batch = f.service.detail(batch.id); assert.equal(batch.rows[0].preview.id, previewId);
  f.recovery.restore = restore;
  result = await f.service.confirm(batch.id, confirmBody(batch));
  assert.equal(result.results[0].status, 'settled'); assert.equal(f.charges(), 1);
  assert.equal(f.calls.filter(call => call.restore).length, 1);
});

test('expired previews, stale versions, overlapping confirmations and changed core usage cannot charge', async t => {
  const f = fixture(t); let batch = await previewed(f, await matched(f));
  const old = confirmBody(batch); f.advance(3600001);
  await assert.rejects(f.service.confirm(batch.id, old), /过期/); assert.equal(f.charges(), 0);
  batch = await previewed(f, batch);
  await assert.rejects(f.service.confirm(batch.id, old), /预览不属于/);
  const lease = f.store.claim(batch.rows[0].id, batch.rows[0].version, batch.rows[0].preview.id);
  await assert.rejects(f.service.confirm(batch.id, confirmBody(batch)), { code: 'PREVIEW_CONFLICT' });
  f.advance(300001); batch = f.service.detail(batch.id);
  f.entries.get(caseId).usage_record = { ...batch.rows[0].preview.usage, ActualCost: 999 };
  const result = await f.service.confirm(batch.id, confirmBody(batch));
  assert.equal(result.results[0].status, 'failed'); assert.match(result.results[0].error, /与预览不一致/);
  assert.equal(f.charges(), 0); assert.equal(lease.status, 'confirming');
});

test('a native bill appearing after matching or after preview blocks CSV charging on a fresh read', async t => {
  const f = fixture(t); let batch = await matched(f);
  const nativeLoad = f.source.load;
  const billed = normalizeSources([], [{ id: 100, user_id: 11, api_key_id: 12, account_id: 356, group_id: 15,
    model: 'claude-opus-5-5', created_at: '2026-10-22T01:11:02Z', duration_ms: 174000, request_id: 'native-new', billing_dedup: true,
    input_tokens: 4964, output_tokens: 13212, cache_read_tokens: 0, cache_creation_tokens: 0 }], []);
  f.source.load = async () => ({ candidates: [...(await nativeLoad()).candidates, ...billed], coreAvailable: true });
  batch = await previewed(f, batch);
  assert.equal(batch.rows[0].status, 'needs_review'); assert.equal(batch.rows[0].preview, null);
  assert.equal(f.calls.length, 0);
  f.source.load = nativeLoad; batch = await previewed(f, await matched(f));
  f.source.load = async () => ({ candidates: [...(await nativeLoad()).candidates, ...billed], coreAvailable: true });
  await assert.rejects(f.service.confirm(batch.id, confirmBody(batch)), /停止补扣/);
  assert.equal(f.calls.length, 0); assert.equal(f.charges(), 0);
});

test('obsolete matching algorithms cannot preview or confirm an old saved charge', async t => {
  const f = fixture(t); let batch = await previewed(f, await matched(f));
  let current = batch.rows[0];
  f.store.save(current.id, { match: { ...current.match, algorithmVersion: 1 } }, current.version);
  batch = f.service.detail(batch.id);
  await assert.rejects(f.service.confirm(batch.id, confirmBody(batch)), /旧匹配逻辑/);
  batch = await previewed(f, batch);
  assert.equal(batch.rows[0].status, 'needs_review'); assert.match(batch.rows[0].result.error, /旧匹配逻辑/);
  assert.equal(f.charges(), 0); assert.equal(f.calls.length, 0);
});

test('new concurrent candidates appearing after a preview require renewed ownership review', async t => {
  const f = fixture(t); const batch = await previewed(f, await matched(f));
  f.entries.set('new-intent', nativeCase({ id: 'new-intent', user_id: 20 }));
  await assert.rejects(f.service.confirm(batch.id, confirmBody(batch)), /停止补扣/);
  assert.equal(f.charges(), 0); assert.equal(f.calls.length, 0);
});

test('owner-only file evidence remains visible and cannot be converted to a native reservation by selecting it', async t => {
  const f = fixture(t);
  const log = { reference: 'log:legacy', kind: 'log', state: 'legacy_log', recorded: false,
    userId: '11', apiKeyId: '12', accountId: '356', groupId: '15', models: ['claude-opus-5-5'], ids: [],
    startMs: Date.parse(at), endMs: Date.parse(at) + 125000, blockedReason: '仅文件日志归属', startUncertain: false };
  f.source.load = async () => ({ candidates: [log], coreAvailable: true });
  let batch = await matched(f);
  assert.equal(batch.rows[0].status, 'owner_candidate'); assert.equal(batch.rows[0].match.owner.userId, '11');
  assert.equal(f.service.detail(batch.id, { filter: 'owners' }).filteredTotal, 1);
  assert.equal(f.service.detail(batch.id, { filter: 'actionable' }).filteredTotal, 0);
  batch = await previewed(f, batch, { assignments: { [batch.rows[0].id]: 'log:legacy' } });
  assert.equal(batch.rows[0].status, 'needs_review'); assert.equal(f.calls.length, 0);
});

test('CSV endpoints enforce admin authentication and CSRF before parsing large upload bodies', async t => {
  const config = loadConfig({ NODE_ENV: 'test', OPERATIONS_CENTER_ADMIN_PASSWORD: 'test-password-123' });
  const auth = new AuthService(config); t.after(() => auth.close()); const changes = [];
  const billingImports = Object.fromEntries(['options', 'inspect', 'import', 'detail', 'match', 'preview', 'confirm'].map(name => [name, async () => { changes.push(name); return {}; }]));
  // The real detail/inspect methods are synchronous.
  billingImports.detail = () => ({}); billingImports.inspect = () => { changes.push('inspect'); return {}; };
  const app = createApp({ config, auth, database: {}, billingImports });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const big = JSON.stringify({ csv: 'x'.repeat(100000) });
  assert.equal((await fetch(`${base}/api/billing-imports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password-123' }) });
  const session = await login.json(); const headers = { authorization: `Session ${session.sessionToken}`, 'content-type': 'application/json' };
  for (const url of ['', '/inspect', `/${caseId}/match`, `/${caseId}/preview`, `/${caseId}/confirm`]) {
    assert.equal((await fetch(`${base}/api/billing-imports${url}`, { method: 'POST', headers, body: url === '' || url === '/inspect' ? big : '{}' })).status, 403);
  }
  assert.equal(changes.length, 0); headers['x-csrf-token'] = session.csrfToken;
  for (const url of ['', '/inspect', `/${caseId}/match`, `/${caseId}/preview`, `/${caseId}/confirm`]) {
    assert.equal((await fetch(`${base}/api/billing-imports${url}`, { method: 'POST', headers, body: url === '' || url === '/inspect' ? big : '{}' })).status, 200);
  }
  assert.deepEqual(changes, ['import', 'inspect', 'match', 'preview', 'confirm']);
});
