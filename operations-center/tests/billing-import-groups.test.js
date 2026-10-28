'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BillingRecoveryStore } = require('../src/billing-recovery-store');
const { BillingImportStore } = require('../src/billing-import-store');
const { BillingImportService, optionsSchema, manualUsage } = require('../src/services/billing-import-service');
const { normalizeSources, reconcileBillingRows } = require('../src/services/billing-import-source');
const { parseBillingCSV } = require('../src/services/billing-import-csv');

const at = '2026-10-22T01:00:00.000Z';
const options = optionsSchema.parse({ accountMappings: { key: 9 }, timeKind: 'start' });
const header = 'Time,API Key Name,Model,Input Tokens,Output Tokens,Cache Read Tokens,Cache Creation Tokens,Duration (ms),Billed Cost';
const csv = (count = 2) => header + '\n' + Array.from({ length: count }, (_, i) => `${at},key,test,${100 + i},200,0,0,210000,0.01`).join('\n');
const errors = (count = 2) => Array.from({ length: count }, (_, i) => ({ id: i + 1, user_id: 3, api_key_id: 4, account_id: 9, group_id: 5,
  model: 'test', created_at: '2026-10-22T01:02:05.000Z', response_latency_ms: 125000, request_id: `server-${i}` }));
const pricing = { input: 5, output: 25, cacheRead: 0.5, cache5m: 6.25, cache1h: 10, multiplier: 0.9, accountMultiplier: 0.79 };
const confirmBody = batch => ({ acknowledge: true, rows: [...new Map([...batch.rows, ...(batch.relatedRows || [])].filter(row => row.preview)
  .map(row => [row.id, { id: row.id, version: row.version, previewId: row.preview.id }])).values()] });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-group-test-'));
  let now = Date.parse('2026-10-25T04:00:00Z');
  const persistent = new BillingRecoveryStore(directory, { now: () => now }); persistent.initialize();
  const store = new BillingImportStore(persistent); store.initialize();
  t.after(() => { persistent.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const entries = new Map(), reservations = new Map(), calls = [], charges = new Set(), claims = [];
  const recovery = {
    detail: async id => ({ case: structuredClone(entries.get(id)) }),
    async request(url, { body }) {
      calls.push({ url, body: structuredClone(body) });
      if (url === '/imports/quote') return { pricing_source: 'current_sub2api_prices', pricing_at: '2026-10-25T04:00:00Z',
        usage_record: { ...manualUsage({ model: 'test', stream: false }, body.tokens, pricing), UserID: 3, APIKeyID: 4, AccountID: 9, GroupID: 5 } };
      assert.equal(url, '/imports/reserve-group');
      const previous = reservations.get(body.identity);
      if (previous) { assert.equal(previous.digest, body.payload_digest); return { claims: structuredClone(previous.claims) }; }
      const receipt = body.members.map((member, i) => {
        const source = member.source, id = `reserved-${i}`;
        const claim = { account_id: 9, bill_identity: source.bill_identity, local_reference: `error:${source.error_id}:${source.event_index}`,
          case_id: id, state: 'review', user_id: 3, api_key_id: 4, group_id: 5 };
        entries.set(id, { id, state: 'review', version: 1, user_id: 3, api_key_id: 4, account_id: 9, group_id: 5 });
        claims.push(claim); return claim;
      });
      reservations.set(body.identity, { digest: body.payload_digest, claims: receipt });
      return { claims: structuredClone(receipt) };
    },
    async restore(id, body) { const entry = entries.get(id); assert.equal(entry.version, body.version); entry.usage_record = body.usage_record; entry.version++; },
    async review(id, body) { const entry = entries.get(id); assert.equal(entry.version, body.version); entry.state = body.state; entry.version++; },
    async settle(id, body) {
      const entry = entries.get(id); assert.equal(entry.version, body.version);
      if (entry.state !== 'settled') { charges.add(id); entry.state = 'settled'; entry.version++; claims.find(claim => claim.case_id === id).state = 'settled'; }
    }
  };
  const source = { accounts: async () => [], load: async () => ({ candidates: normalizeSources(errors(), [], []),
    claims: structuredClone(claims), coreAvailable: true, diagnostics: { claimsAvailable: true } }) };
  const service = new BillingImportService({ store, source, recovery, now: () => now });
  return { directory, persistent, store, service, source, recovery, entries, calls, charges, claims,
    advance: ms => { now += ms; }, async match(content = csv()) {
      const batch = await service.import({ fileName: 'group.csv', csv: content }); return service.match(batch.id, options);
    }, async preview(batch) {
      await service.preview(batch.id, { rowIds: [batch.rows.at(-1).id] }); return service.detail(batch.id);
    } };
}

test('closed same-owner legacy groups use stable allocations, while missing coverage and billing evidence block them', () => {
  const records = parseBillingCSV(csv(), options).rows, candidates = normalizeSources(errors(), [], []);
  const result = reconcileBillingRows(records, candidates, options);
  assert.deepEqual(result.matches.map(row => row.status), ['group_candidate', 'group_candidate']);
  assert.ok(result.matches.every(row => row.selected === null));
  const group = result.matches[0].candidateGroup;
  const reordered = reconcileBillingRows(records.slice().reverse(), candidates.slice().reverse(), options);
  assert.equal(group.id, reordered.matches[0].candidateGroup.id);
  assert.deepEqual(group.allocations, reordered.matches[0].candidateGroup.allocations);
  for (const modified of [candidates.concat(normalizeSources([], [], [{ id: 'hidden', user_id: 3, api_key_id: 4, account_id: 9,
    group_id: 5, model: 'test', state: 'unknown', created_at: at }])),
  candidates.map(item => ({ ...item, billingType: 'subscription' })),
  candidates.map(item => ({ ...item, billingType: 'unknown' }))]) {
    assert.ok(reconcileBillingRows(records, modified, options).matches.every(row => row.status !== 'group_candidate'));
  }
  assert.equal(reconcileBillingRows(records, candidates, { ...options, groupClaimsAvailable: false }).diagnostics.candidateGroups.auditable, 0);
  const incomplete = records.map(row => ({ ...row, tokens: { ...row.tokens, CacheCreationTokens: 20 } }));
  assert.equal(reconcileBillingRows(incomplete, candidates, options).diagnostics.candidateGroups.auditable, 0);
  assert.equal(reconcileBillingRows(parseBillingCSV(csv(21), options).rows, normalizeSources(errors(21), [], []), options).diagnostics.candidateGroups.auditable, 0);
});

test('native bill and source claims exclude reimports including linked aliases', () => {
  const records = parseBillingCSV(csv(), options).rows, candidates = normalizeSources(errors(), [], []);
  const claim = { account_id: 9, bill_identity: records[0].identity, local_reference: candidates[0].reference, case_id: 'prior', state: 'settled' };
  const result = reconcileBillingRows(records, candidates, options, [claim]);
  assert.equal(result.matches[0].status, 'already_imported'); assert.equal(result.matches[0].selected, null);
  assert.equal(result.matches[1].status, 'needs_review'); assert.equal(result.matches[1].selected, null);
  const alias = { ...candidates[1], sourceEvidence: [{ reference: claim.local_reference }] };
  assert.equal(reconcileBillingRows([records[1]], [alias], options, [claim]).matches[0].status, 'needs_review');
  assert.equal(reconcileBillingRows(records, candidates, options, [{ ...claim, state: 'review' }]).matches[0].status, 'import_pending');
});

test('group preview quotes every possible edge without reserving and requires explicit full-group confirmation', async t => {
  const f = fixture(t); let batch = await f.match(); batch = await f.preview(batch);
  assert.equal(f.calls.length, 4); assert.ok(f.calls.every(call => call.url === '/imports/quote'));
  assert.equal(f.claims.length, 0); assert.equal(f.charges.size, 0);
  assert.ok(batch.rows.every(row => row.status === 'preview' && row.preview.group.count === 2));
  const body = confirmBody(batch);
  await assert.rejects(f.service.confirm(batch.id, { ...body, rows: body.rows.slice(0, 1) }), /整组须完整/);
  assert.equal(f.claims.length, 0);
  const result = await f.service.confirm(batch.id, body);
  assert.ok(result.results.every(row => row.status === 'settled')); assert.equal(f.charges.size, 2);
  const reserve = f.calls.find(call => call.url === '/imports/reserve-group');
  assert.equal(reserve.body.members.length, 2);
  assert.ok(reserve.body.members.every(member => JSON.parse(member.source.evidence).allocation === 'financial_equivalence_only'));
  await f.service.confirm(batch.id, confirmBody(f.service.detail(batch.id)));
  assert.equal(f.charges.size, 2);
});

test('any unequal edge quote, quota-bearing quote or manual-price bypass blocks the whole group', async t => {
  for (const failure of ['prices', 'quota', 'manual']) {
    const f = fixture(t), batch = await f.match(), request = f.recovery.request;
    f.recovery.request = async (...args) => {
      const quote = await request(...args);
      if (failure === 'prices' && args[1].body.source.error_id === 2) quote.usage_record.ActualCost += 0.01;
      if (failure === 'quota') quote.group_audit_blocked = 'rolling quota requires exact time';
      return quote;
    };
    await f.service.preview(batch.id, { rowIds: [batch.rows[0].id], ...(failure === 'manual' ? { pricingMode: 'manual', pricing: { test: pricing } } : {}) });
    assert.ok(f.service.detail(batch.id).rows.every(row => row.status === 'needs_review' && row.preview === null));
    assert.equal(f.claims.length, 0); assert.equal(f.charges.size, 0);
  }
});

test('off-page members are quoted, disclosed and confirmed together', async t => {
  const f = fixture(t);
  const content = header + '\n' + Array.from({ length: 19 }, () => 'invalid,key,test,1,2,0,0,1000,0.01').join('\n') + '\n' + csv().split('\n').slice(1).join('\n');
  let batch = await f.match(content); batch = await f.preview(batch);
  assert.equal(batch.rows.length, 20); assert.equal(batch.relatedRows.length, 2);
  assert.equal(batch.rows.at(-1).preview.group.count, 2);
  const selected = f.service.selectedRows(batch.id, { rowIds: [batch.rows.at(-1).id] });
  assert.equal(selected.rows.length, 1); assert.equal(selected.relatedRows.length, 2);
  assert.ok(selected.relatedRows.every(row => row.preview.group.identity === selected.rows[0].preview.group.identity));
  assert.equal(f.charges.size, 0, 'refreshing a cross-page group must not charge');
  const result = await f.service.confirm(batch.id, confirmBody(batch));
  assert.equal(result.results.length, 2); assert.equal(f.charges.size, 2);
});

test('lost group reservation response resumes the same mapping after a service restart', async t => {
  const f = fixture(t); let batch = await f.preview(await f.match()); const request = f.recovery.request; let lost = true;
  f.recovery.request = async (...args) => { const result = await request(...args); if (args[0] === '/imports/reserve-group' && lost) {
    lost = false; throw new Error('connection lost after commit');
  } return result; };
  await f.service.confirm(batch.id, confirmBody(batch));
  assert.equal(f.charges.size, 0); assert.equal(f.claims.length, 2);
  assert.ok(f.service.detail(batch.id).rows.every(row => row.status === 'failed'));
  const restarted = new BillingImportService({ store: f.store, source: f.source, recovery: f.recovery });
  batch = restarted.detail(batch.id);
  await restarted.confirm(batch.id, confirmBody(batch));
  assert.equal(f.charges.size, 2); assert.equal(f.claims.length, 2);
  assert.ok(restarted.detail(batch.id).rows.every(row => row.status === 'settled'));
});

test('partial settlement preserves successful members and retries only the remaining original cases', async t => {
  const f = fixture(t); let batch = await f.preview(await f.match()); const settle = f.recovery.settle; let fail = true;
  f.recovery.settle = async (id, ...args) => { if (id === 'reserved-1' && fail) { fail = false; throw new Error('temporary failure'); } return settle(id, ...args); };
  await f.service.confirm(batch.id, confirmBody(batch));
  batch = f.service.detail(batch.id); assert.deepEqual(batch.rows.map(row => row.status).sort(), ['failed', 'settled']);
  const original = batch.rows.map(row => row.case_id);
  await f.service.confirm(batch.id, confirmBody(batch));
  assert.equal(f.charges.size, 2); assert.deepEqual(f.service.detail(batch.id).rows.map(row => row.case_id), original);
  const imported = await f.service.import({ fileName: 'reordered.csv', csv: header + '\n' + csv().split('\n').slice(1).reverse().join('\n') });
  const rematched = await f.service.match(imported.id, options);
  assert.ok(rematched.rows.every(row => row.status === 'already_imported'));
});

test('concurrent administrators cannot lease the same group, and stale evidence stops before any reservation', async t => {
  const f = fixture(t); let batch = await f.preview(await f.match());
  const first = f.service.confirm(batch.id, confirmBody(batch));
  const second = f.service.confirm(batch.id, confirmBody(batch));
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(f.charges.size, 2);
  const g = fixture(t); batch = await g.preview(await g.match());
  const load = g.source.load;
  g.source.load = async () => { const data = await load(); data.candidates[0].userId = '99'; return data; };
  await assert.rejects(g.service.confirm(batch.id, confirmBody(batch)), /证据或账单已变化/);
  assert.equal(g.claims.length, 0);
});

test('a failed attempt without a committed reservation must revalidate evidence on retry', async t => {
  const f = fixture(t); let batch = await f.preview(await f.match());
  const request = f.recovery.request;
  f.recovery.request = async (url, ...args) => { if (url === '/imports/reserve-group') throw new Error('offline before commit'); return request(url, ...args); };
  await f.service.confirm(batch.id, confirmBody(batch));
  assert.equal(f.claims.length, 0);
  f.recovery.request = request;
  const load = f.source.load;
  f.source.load = async () => { const data = await load(); data.candidates[0].startMs += 1000; return data; };
  batch = f.service.detail(batch.id);
  await assert.rejects(f.service.confirm(batch.id, confirmBody(batch)), /证据或账单已变化/);
  assert.equal(f.claims.length, 0); assert.equal(f.charges.size, 0);
});
