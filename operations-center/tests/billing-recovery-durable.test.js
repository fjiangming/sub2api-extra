'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BillingRecoveryStore } = require('../src/billing-recovery-store');
const { BillingRecoveryService } = require('../src/services/billing-recovery-service');
const { observedTokens, requestIds } = require('../src/services/billing-recovery-usage');
const { ProviderMonitorClient } = require('../src/provider-monitor-client');

const id = '00000000-0000-4000-8000-000000000002';
function entry() {
  return { id, user_id: 11, api_key_id: 12, account_id: 13, state: 'unknown', version: 2,
    created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:01:00Z',
    request_snapshot: { user_email: 'owner@example.com', pricing: { eligible: true } },
    observed_usage: { input_tokens: 30, output_tokens: 40, _recovery: { complete: true, protocol: 'anthropic' } } };
}

test('reconciliation survives restart with ownership, tokens, evidence, cursor and bounded backoff', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-recovery-test-'));
  let store;
  t.after(() => { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let now = Date.parse('2026-10-23T00:00:00Z');
  store = new BillingRecoveryStore(dir, { now: () => now }); store.initialize();
  store.observe(entry()); assert.equal(store.due().length, 1);
  assert.equal(store.claim(id), true); assert.equal(store.claim(id), false);
  store.checked(id, { status: 'unresolved', observedTokens: observedTokens(entry()), candidates: 0 });
  store.cursor(3); store.cursor(4, 'review');
  const checkedAt = store.get(id).next_check_at;
  store.close(); store = new BillingRecoveryStore(dir, { now: () => now }); store.initialize();
  const saved = store.get(id);
  assert.equal(saved.snapshot.user_id, 11); assert.equal(saved.snapshot.api_key_id, 12);
  assert.equal(saved.snapshot.account_id, 13); assert.equal(saved.lookup.observedTokens.output_tokens, 40);
  assert.equal(store.cursor(), 3); assert.equal(store.cursor(undefined, 'review'), 4);
  assert.equal(store.due().length, 0); now = checkedAt + 1; assert.equal(store.due().length, 1);
  for (let i = 0; i < 20; i++) store.checked(id, null, 'RATE_LIMITED');
  assert.ok(store.get(id).next_check_at - now <= 6 * 3600000);
  assert.equal(store.get(id).last_error, 'RATE_LIMITED');
  store.observe({ ...entry(), state: 'settled' }); assert.equal(store.due().length, 0);
});

test('token normalization preserves unknown versus zero and native provider cache/reasoning semantics', () => {
  const final = (usage, protocol) => observedTokens({ observed_usage: { ...usage, _recovery: { complete: true, protocol } } });
  assert.equal(observedTokens({}).input_tokens, null);
  assert.equal(final({ input_tokens: 0, output_tokens: 0 }, 'anthropic').complete, true);
  assert.equal(final({ input_tokens: 10 }, 'anthropic').complete, false);
  assert.equal(final({ input_tokens: -1, output_tokens: 5 }, 'anthropic').complete, false);
  assert.equal(final({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 'unknown' }, 'anthropic').complete, false);
  assert.equal(final({ input_tokens: 10, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 0.5 } }, 'anthropic').complete, false);
  const chat = final({ prompt_tokens: 100, completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } }, 'chat');
  assert.equal(chat.input_tokens, 60); assert.equal(chat.cache_read_tokens, 30); assert.equal(chat.cache_creation_tokens, 10);
  const anthropic = final({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 }, 'anthropic');
  assert.equal(anthropic.input_tokens, 100);
  const responses = final({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 }, 'responses');
  assert.equal(responses.input_tokens, 70);
  const gemini = final({ promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 30 }, 'gemini');
  assert.equal(gemini.input_tokens, 70); assert.equal(gemini.output_tokens, 25);
  const xai = final({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 125,
    completion_tokens_details: { reasoning_tokens: 5 } }, 'chat');
  assert.equal(xai.output_tokens, 25);
  assert.equal(final({ input_tokens: 100, output_tokens: 20, output_tokens_details: { image_tokens: 5 } }, 'responses').supported, false);
  assert.equal(final({ input_tokens: 100, output_tokens: 20, server_tool_use: { web_search_requests: 1 } }, 'anthropic').supported, false);
});

test('correlation trusts unique dispatch IDs and captures upstream client-ID namespace', () => {
  const ids = requestIds({ upstream_request_id: 'response', request_snapshot: { dispatch_correlation_id: 'dispatch',
    sent_request_ids: { 'x-request-id': 'caller-reused', 'x-client-request-id': 'dispatch' } },
  observed_usage: { _recovery: { response_request_ids: { 'x-client-request-id': 'provider-client' } } } });
  assert.equal(ids.has('caller-reused'), false); assert.equal(ids.has('client:dispatch'), true);
  assert.equal(ids.has('response'), true); assert.equal(ids.has('client:provider-client'), true);
  const echoed = requestIds({ upstream_request_id: 'caller-reused', request_snapshot: {
    dispatch_correlation_id: 'dispatch', sent_request_ids: { 'x-client-request-id': 'caller-reused' } },
  observed_usage: { _recovery: { response_request_ids: { 'x-client-request-id': 'caller-reused' } } } });
  assert.equal(echoed.size, 0, 'an echoed caller ID cannot uniquely identify one paid dispatch');
});

test('updated core evidence reopens a verified partial bill without losing previous lookup evidence', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-recovery-evidence-'));
  const store = new BillingRecoveryStore(dir); store.initialize();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const record = { ...entry(), state: 'settled', usage_record: { OutputTokens: 10 },
    observed_usage: { input_tokens: 30, output_tokens: 10, _recovery: { complete: false, phase: 'interrupted' } } };
  store.observe(record); store.checked(id, { status: 'verified', exact: { identity: 'vendor:bill' } });
  assert.equal(store.due().length, 0);
  store.observe(record); assert.equal(store.due().length, 0);
  store.observe({ ...record, version: record.version + 1, usage_record: { OutputTokens: 5 } });
  assert.equal(store.due().length, 1); assert.equal(store.get(id).lookup_status, 'not_checked');
  assert.equal(store.get(id).lookup.exact.identity, 'vendor:bill');
});

test('verified final usage produces a review record even while provider monitor is unavailable; never settles it', async () => {
  const calls = []; const record = entry();
  const service = new BillingRecoveryService({ config: {}, providerMonitor: {}, sub2api: {} });
  service.detail = async () => ({ case: record });
  service.lookup = async () => { throw Object.assign(new Error('offline'), { code: 'PROVIDER_OFFLINE' }); };
  service.request = async (url, options) => { calls.push({ url, body: options.body }); return { usage_record: { UserID: 11, InputTokens: 30, OutputTokens: 40, ActualCost: 0.12 } }; };
  service.restore = async (caseId, body) => { calls.push({ restore: caseId, body }); return { case_id: id }; };
  const result = await service.draftVerifiedUsage(id);
  assert.equal(result.status, 'review_ready'); assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/quote')); assert.equal(calls[0].body.tokens.InputTokens, 30);
  assert.equal(calls[1].body.usage_record.UserID, 11);
  assert.equal(JSON.parse(calls[1].body.evidence).source, 'persisted_terminal_usage');
  record.observed_usage._recovery.complete = false;
  assert.equal((await service.draftVerifiedUsage(id, null, { exact: null })).status, 'final_usage_missing');
  assert.equal(calls.length, 2);
});

test('conflicting cache totals, partial bills and missing historical prices cannot create recovery charges', async () => {
  const record = entry(); let writes = 0;
  const service = new BillingRecoveryService({ config: {}, providerMonitor: {}, sub2api: {} });
  service.detail = async () => ({ case: record }); service.restore = async () => { writes++; };
  const bill = { input_tokens: 30, output_tokens: 40, cache_read_tokens: 9, usage_complete: 1 };
  assert.equal((await service.draftVerifiedUsage(id, null, { exact: bill })).status, 'usage_conflict');
  record.observed_usage._recovery.complete = false;
  assert.equal((await service.draftVerifiedUsage(id, null, { exact: { ...bill, usage_complete: null } })).status, 'final_usage_missing');
  record.request_snapshot.pricing = null;
  assert.equal((await service.draftVerifiedUsage(id, null, { exact: bill })).status, 'historical_price_missing');
  assert.equal(writes, 0);
});

test('provider refresh uses integration auth or the SSO session CSRF token', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/auth/sso') ? { sessionToken: 'session', csrfToken: 'csrf' } : { results: [] }));
  };
  const config = { providerMonitorBaseUrl: 'http://monitor.test', providerMonitorRequestTimeoutMs: 1000 };
  const client = new ProviderMonitorClient(config, fetch);
  await client.refreshBillingSamples({ accountId: '13' }, 'jwt');
  assert.equal(calls[1].options.headers['x-csrf-token'], 'csrf');
  assert.equal(calls[1].options.headers.authorization, 'Session session');
  calls.length = 0;
  await new ProviderMonitorClient({ ...config, providerMonitorIntegrationToken: 'integration' }, fetch).refreshBillingSamples({ accountId: '13' });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.headers.authorization, 'Bearer integration');
});

test('background discovery covers unknown, review and partially settled cases without approving charges', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-recovery-queue-'));
  const store = new BillingRecoveryStore(dir); store.initialize();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const records = [entry(), { ...entry(), id: '00000000-0000-4000-8000-000000000003', state: 'review', usage_record: { OutputTokens: 40 } },
    { ...entry(), id: '00000000-0000-4000-8000-000000000004', state: 'settled', usage_record: { OutputTokens: 10 },
      observed_usage: { input_tokens: 30, output_tokens: 10, _recovery: { complete: false, phase: 'interrupted' } } }];
  const service = new BillingRecoveryService({ config: {}, sub2api: {}, providerMonitor: {}, store });
  const discovery = [], drafts = [];
  service.list = async ({ state }) => {
    discovery.push(state);
    const items = records.filter(row => state === 'incomplete' ? row.state === 'settled' : row.state === state);
    items.forEach(row => store.observe(row)); return { items, total: items.length };
  };
  service.detail = async caseId => ({ case: records.find(row => row.id === caseId) });
  service.lookup = async caseId => ({ exact: { request_id: `upstream:${caseId}` }, comparison: [{ field: 'output_tokens', difference: 30 }] });
  service.draftVerifiedUsage = async caseId => { drafts.push(caseId); return { status: 'review_ready' }; };
  const result = await service.reconcileUnknown();
  assert.deepEqual(discovery, ['unknown', 'review', 'incomplete']); assert.deepEqual(drafts, [id]);
  assert.equal(result.checked, 2); assert.equal(store.get(records[2].id).lookup_status, 'usage_difference');
  assert.equal(store.get(records[1].id).lookup_status, 'review_ready');
});
