'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BillingRecoveryService } = require('../src/services/billing-recovery-service');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { AuthService } = require('../src/auth');

const id = '00000000-0000-4000-8000-000000000001';
function fixture(overrides = {}) {
 const calls = [];
 const sub2api = { persistentCredentialsConfigured: () => true, raw: async (path, options) => {
  calls.push({ path, options }); return { code: 0, data: path.includes('?') ? { items: [] } : {} };
 } };
 return { calls, service: new BillingRecoveryService({ config: {}, sub2api, providerMonitor: {}, ...overrides }) };
}

test('recovery retries persisted pending work and coalesces overlapping runs', async () => {
 let resolve; const settled = [];
 const first = fixture();
 first.service.list = async (query) => {
  assert.equal(query.state, 'pending'); await new Promise((done) => { resolve = done; });
  return { items: [{ id, version: 3, next_retry_at: '2020-01-01' }, { id: 'second', version: 1 }] };
 };
 first.service.settle = async (caseId) => { settled.push(caseId); if (caseId === 'second') throw new Error('database unavailable'); };
 const a = first.service.retryPending(); const b = first.service.retryPending(); resolve();
 assert.deepEqual(await a, { settled: 1, failed: 1, checked: 0, unresolved: 0 }); assert.deepEqual(await b, await a);
 assert.deepEqual(settled, [id, 'second']); assert.equal(first.service.running, null);
 // A fresh process has no memory of work; it reads the same durable queue again.
 const restarted = fixture().service; let query;
 restarted.list = async (value) => { query = value; return { items: [] }; };
 await restarted.retryPending(); assert.equal(query.state, 'pending');
});

test('lookup requires unique request ID and historical account mapping', async () => {
 let payload = { items: [] };
 const { service } = fixture({ providerMonitor: { getLatencySamples: async () => payload } });
 service.detail = async () => ({ case: { account_id: 3, upstream_request_id: 'upstream-1', created_at: '2026-10-22T00:00:00Z' } });
 const row = { request_id: 'upstream-1', mappingScope: 'history', model: 'test' };
 payload = { items: [row], billingCoverageComplete: true }; assert.equal((await service.lookup(id)).status, 'exact');
 payload = { items: [row, row] }; assert.equal((await service.lookup(id)).exact, null);
 payload = { items: [row], truncated: true }; assert.equal((await service.lookup(id)).exact, null);
 payload = { items: [{ ...row, mappingScope: 'current_unverified' }] }; assert.equal((await service.lookup(id)).exact, null);
 payload = { items: [{ model: 'test', input_tokens: 100 }] }; assert.equal((await service.lookup(id)).exact, null);
 payload = { items: [row], billingCoverageComplete: false }; assert.equal((await service.lookup(id)).exact, null);
});

test('supplement proxy rejects balance deltas and requires record and evidence', async () => {
 const { service, calls } = fixture();
 await assert.rejects(service.restore(id, { version: 1, evidence: 'verified evidence', balance: 1 }), { code: 'INVALID_REQUEST' });
 await assert.rejects(service.review(id, { version: 1, state: 'prepared', evidence: '' }), { code: 'INVALID_REQUEST' });
 assert.equal(calls.length, 0);
 await service.restore(id, { version: 1, evidence: 'verified evidence', usage_record: { Model: 'gpt-test', TotalCost: 0.5 } }, 'admin-token');
 assert.ok(calls[0].path.endsWith('/usage')); assert.equal(calls[0].options.headers.authorization, 'Bearer admin-token');
 assert.equal(JSON.parse(calls[0].options.body).usage_record.TotalCost, 0.5);
});

test('recovery API enforces administrator sessions and CSRF', async (t) => {
 const config = loadConfig({ NODE_ENV: 'test', OPERATIONS_CENTER_ADMIN_PASSWORD: 'test-password-123' });
 const auth = new AuthService(config); t.after(() => auth.close()); let changes = 0;
 const app = createApp({ config, auth, database: {}, billingRecovery: { status: () => ({}),
  review: async () => { changes++; return { ok: true }; } } });
 const server = app.listen(0, '127.0.0.1'); await new Promise((done) => server.once('listening', done));
 t.after(() => new Promise((done) => server.close(done)));
 const base = `http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(`${base}/api/billing-recovery/status`)).status, 401);
 const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password-123' }) });
 const session = await login.json(); const headers = { authorization: `Session ${session.sessionToken}`, 'content-type': 'application/json' };
 assert.equal((await fetch(`${base}/api/billing-recovery/status`, { headers })).status, 200);
 assert.equal((await fetch(`${base}/api/billing-recovery/${id}/review`, { method: 'POST', headers, body: '{}' })).status, 403);
 headers['x-csrf-token'] = session.csrfToken;
 assert.equal((await fetch(`${base}/api/billing-recovery/${id}/review`, { method: 'POST', headers, body: '{}' })).status, 200);
 assert.equal(changes, 1);
});
