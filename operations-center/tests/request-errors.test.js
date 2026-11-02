'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestErrorsFixture } = require('./request-errors-fixture');
const { classifyRequests, failureType } = require('../src/services/request-errors-classifier');
const { RequestErrorsService } = require('../src/services/request-errors-service');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');
const { loadConfig } = require('../src/config');
const { RequestErrorsSource, MAX_ROWS } = require('../src/services/request-errors-source');

test('read-only SQL and classification: default today, 12 failure types, retries, Key overlap and independent user totals', async t => {
  const f = await requestErrorsFixture(); t.after(() => f.close());
  assert.equal(f.service.options().defaultRange.start, f.today);
  const r = await f.service.report({});
  assert.equal(r.summary.failed, 300); assert.equal(r.summary.recovered, 1);
  assert.equal(r.summary.disconnected, 1); assert.equal(r.summary.unknown, 1); assert.equal(r.summary.unlinked, 1);
  assert.equal(r.summary.affectedUsers, 25, 'administrator traffic is included');
  assert.equal(r.failureTypes.length, 12); assert.equal(r.failureTypes.reduce((sum, c) => sum + c.count, 0), r.summary.failed);
  assert(r.failureTypes.every(c => c.count === 25 && c.users === 25));
  assert(r.groups.some(g => g.keys.reduce((sum, k) => sum + k.summary.failed, 0) > g.summary.failed));
  const selected = await f.service.report({ failureType: 'provider_balance' });
  assert.equal(selected.failureTypes[0].denominator, 300); assert.equal(selected.failureTypes[0].share, 25 / 300);
  assert.equal(selected.matrix.find(c => c.cause === 'reject').recovered, 1, 'comparison ignores result/type filters');
  const users = await f.service.report({ view: 'users', pageSize: '20' });
  assert.equal(users.items.length, 20); assert.equal(users.pagination.total, 25);
  assert.equal((await f.service.report({ view: 'users', page: '2', pageSize: '20' })).items.length, 5);
  const supplier = await f.service.report({ providerId: 'b' });
  assert(supplier.summary.failedAttempts < r.summary.failedAttempts);
  assert(supplier.groups.every(g => g.keys.every(k => k.providerId === 'b')));
  assert(!JSON.stringify(r).includes('SECRET PROMPT')); assert(!JSON.stringify(r).includes('PRIVATE ERROR BODY'));
  assert(f.queries.some(sql => sql.includes('READ ONLY'))); assert(!f.queries.some(sql => /\b(INSERT|UPDATE|DELETE|CREATE)\b/.test(sql)));
});

test('identity and final proof are mandatory; resolved, HTTP 200, request aliases, and incomplete upstream do not imply recovery', () => {
  const row = { id: '1', request_id: 'root', client_request_id: 'client-shared', user_id: '2', api_key_id: '3', created_at: '2026-11-02T01:00:00Z', status_code: 200,
    error_body: '{"error":{"code":"insufficient_balance"}}', resolved: true, error_owner: 'provider', upstream_status_code: 403 };
  const trace = { requestId: 'root', startedAt: row.created_at, metadata: { userId: '2', apiKeyId: '3' }, events: [
    { sequence: 0, name: 'request_end', attributes: { outcome: 'completed', statusCode: 200 } }
  ] };
  const classify = (rows = [row], traces = [trace]) => classifyRequests(rows, traces, 'Asia/Shanghai');
  assert.equal(classify()[0].outcome, 'unknown');
  assert.equal(classify([row], [{ ...trace, requestId: 'client-shared' }])[0].linked, false);
  assert.equal(classify([row], [{ ...trace, metadata: { userId: '4', apiKeyId: '3' } }])[0].linked, false);
  const two = classify([row, { ...row, id: '2', request_id: 'root2' }], []);
  assert.equal(two.length, 2); assert(two.every(r => !r.linked));
  const conflict = classify([row, { ...row, id: '2', group_id: '9' }]);
  assert.equal(conflict[0].outcome, 'unknown'); assert.equal(conflict[0].evidence.conflict, true);
});

test('final cause wins, stream timeout differs from connection timeout, known failure differs from unknown', async t => {
  const f = await requestErrorsFixture(); t.after(() => f.close());
  const rows = await f.service.report({ view: 'requests', pageSize: '50', userId: '3' });
  const route = rows.items.find(r => r.failureType === 'no_account'); assert.equal(route.wire, 503); assert(route.attempts.every(a => a.status === 502));
  const stream = rows.items.find(r => r.failureType === 'stream_truncated'); assert.equal(stream.delivery, 'incomplete_close'); assert.equal(stream.outcome, 'stream');
  const timeout = rows.items.find(r => r.failureType === 'stream_timeout'); assert.equal(timeout.wire, 200); assert.equal(timeout.outputState, 'partial');
  assert.equal(rows.items.find(r => r.failureType === 'connect_timeout').outputState, 'none');
  assert.equal(rows.items.find(r => r.failureType === 'unclassified').outcome, 'http');
  assert.equal(failureType({ errorCode: 'insufficient_balance', owner: 'client', phase: 'request' }), 'request_rejected');
});

test('cross-midnight completion, duplicate log rows, conflicting endings, missing mapping and bounded source are explicit', async t => {
  const f = await requestErrorsFixture(); t.after(() => f.close());
  const added = await f.insert({ recovered: true, duplicate: true });
  added.trace.startedAt = '2026-11-01T15:59:59.000Z';
  added.trace.events.at(-1).elapsedMs = Date.parse(`${f.today}T01:00:00Z`) - Date.parse(added.trace.startedAt) + 3600000;
  const r = await f.service.report({ start: '2026-11-01', end: '2026-11-02', day: '2026-11-01', outcome: 'recovered', view: 'requests', refresh: '1' });
  const request = r.items.find(row => row.requestId === added.requestId);
  assert(request); assert.equal(request.sourceRows, 2); assert.equal(request.dayBasis, 'request_start');
  assert.equal(request.day, '2026-11-01');
  added.trace.events.push({ sequence: 99, name: 'request_end', attributes: {} });
  f.service.cache.clear();
  assert.equal((await f.service.detail(request.id, { start: '2026-11-01', end: '2026-11-02' })).request.outcome, 'unknown');
  f.providerMonitor.getRequestErrorMappings = async () => { throw new Error('unavailable'); };
  const unmapped = await f.service.report({}); assert(unmapped.warnings.some(s => s.includes('映射暂不可用')));
  assert(unmapped.groups.every(g => g.keys.every(k => !k.verified)));
  const truncated = new RequestErrorsService({ config: f.config, source: { read: async () => ({ rows: [], traces: [], coverage: { truncated: true } }) }, now: () => f.now });
  assert.equal((await truncated.report({})).coverage.complete, false);
  await assert.rejects(f.service.report({ start: '2026-02-30', end: '2026-03-01' }), /日期/);
  await assert.rejects(f.service.report({ start: '2026-01-01', end: '2026-11-02' }), /31/);
  await assert.rejects(f.service.report({ day: '2026-11-01' }), /范围/);
  await assert.rejects(f.service.detail('trace:../secrets', {}), /标识/);
});

test('error analysis API requires administrator authentication, is no-store, validates queries and exposes no write route', async t => {
  const f = await requestErrorsFixture(); t.after(() => f.close());
  const config = loadConfig({ NODE_ENV: 'test', OPERATIONS_CENTER_ADMIN_PASSWORD: 'test-password-123' });
  const auth = new AuthService(config); t.after(() => auth.close());
  const app = createApp({ config, auth, database: {}, requestErrors: f.service });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/request-errors/report`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password-123' }) });
  const session = await login.json(), headers = { authorization: `Session ${session.sessionToken}` };
  const response = await fetch(`${base}/api/request-errors/report`, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).summary.failed, 300);
  assert.equal((await fetch(`${base}/api/request-errors/report?groupId=1%3BDELETE`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/request-errors/report`, { method: 'POST', headers })).status, 404);
});

test('legacy direct roots prove only observed HTTP failures; recovery requires every attempt and final delivery', () => {
  const at = '2026-11-02T01:00:00Z';
  const row = { id: '1', request_id: 'root', user_id: '2', api_key_id: '3', created_at: at, stream: true };
  const trace = { requestId: 'root', startedAt: at, metadata: { userId: '2' }, events: [
    { sequence: 0, name: 'downstream_write', attributes: {} },
    { sequence: 1, name: 'request_end', attributes: { outcome: 'error', statusCode: 502 } }
  ] };
  const classify = () => classifyRequests([row], [trace], 'Asia/Shanghai')[0];
  assert.equal(classify().outcome, 'http', 'old collectors lack API key metadata but their direct root and user are authoritative');
  trace.events.at(-1).attributes.errorCode = 'PANIC'; assert.equal(classify().outcome, 'unknown');
  trace.events = [
    { sequence: 0, attemptId: 'a', name: 'attempt_end', attributes: { outcome: 'error' } },
    { sequence: 1, attemptId: 'b', name: 'attempt_end', attributes: { outcome: 'completed' } },
    { sequence: 2, name: 'request_end', attributes: { resultVersion: 1, wireStatusCode: 200, downstreamComplete: true,
      terminalSeen: true, upstreamAttemptCount: 2, deliveryKind: 'complete', errorWritten: false } }
  ];
  assert.equal(classify().outcome, 'recovered');
  const result = trace.events.at(-1).attributes;
  result.upstreamAttemptCount = 3; assert.equal(classify().outcome, 'unknown', 'missing attempt must not imply recovery');
  result.upstreamAttemptCount = 2; result.terminalSeen = false; assert.equal(classify().outcome, 'unknown');
  row.stream = false; assert.equal(classify().outcome, 'recovered', 'complete nonstream response needs no SSE terminal');
  result.errorWritten = true; assert.equal(classify().outcome, 'unknown', 'contradictory delivery stays unresolved');
  result.errorWritten = false; trace.events[0].attributes.userId = '9'; assert.equal(classify().outcome, 'unknown');
});

test('attempt-time Key mapping survives changes and ambiguous intervals; supplier attempts stay correctly attributed', async t => {
  const f = await requestErrorsFixture(); t.after(() => f.close());
  const added = await f.insert({ recovered: true });
  const events = added.trace.events.filter(e => e.attemptId);
  const change = new Date(Date.parse(added.trace.startedAt) + 1000).toISOString();
  for (const event of events) { event.attributes.accountId = '356'; event.at = event.attemptId === 'a0' ? added.trace.startedAt : change; }
  f.providerMonitor.getRequestErrorMappings = async () => ({ items: [
    { accountId: '356', providerId: 'a', keyId: 'before', scope: 'history', validFrom: '2026-01-01T00:00:00Z', validTo: change },
    { accountId: '356', providerId: 'b', keyId: 'after', scope: 'history', validFrom: change, validTo: null }
  ] });
  const detail = (await f.service.detail(`trace:${added.requestId}`, {})).request;
  assert.deepEqual(detail.keys.map(k => k.id), ['key:a:before', 'key:b:after']);
  assert.deepEqual(detail.attempts.map(a => a.providerId), ['a', 'b']);
  const selected = await f.service.report({ outcome: 'recovered', providerId: 'b', search: added.requestId });
  assert.equal(selected.selected.recovered, 1); assert.equal(selected.selected.failedAttempts, 0);
  f.providerMonitor.getRequestErrorMappings = async () => ({ items: [
    { accountId: '356', providerId: 'a', keyId: 'one', scope: 'history', validFrom: '2026-01-01T00:00:00Z' },
    { accountId: '356', providerId: 'b', keyId: 'two', scope: 'history', validFrom: '2026-01-01T00:00:00Z' }
  ] });
  assert((await f.service.detail(`trace:${added.requestId}`, {})).request.keys.every(k => !k.verified));
});

test('source follows late errors back to their original day and recovers after local telemetry failures', async t => {
  const f = await requestErrorsFixture(); t.after(() => f.close());
  const added = await f.insert({ recovered: true });
  added.trace.startedAt = '2026-11-01T15:59:59.000Z';
  const later = '2026-11-02T16:10:00.000Z';
  await f.engine.query('UPDATE ops_error_logs SET created_at=$1 WHERE id=$2', [later, added.sourceId]);
  added.trace.events.at(-1).elapsedMs = Date.parse(later) - Date.parse(added.trace.startedAt);
  const data = await f.service.report({ start: '2026-11-01', end: '2026-11-01', view: 'requests', outcome: 'recovered' });
  assert(data.items.some(r => r.requestId === added.requestId && r.day === '2026-11-01'));
  const original = f.telemetry.requestErrorTraces;
  f.telemetry.requestErrorTraces = () => { throw new Error('local store unavailable'); };
  const degraded = await f.service.report({ refresh: '1' });
  assert.equal(degraded.coverage.complete, false); assert(degraded.summary.unlinked > 0);
  assert(degraded.warnings.some(w => w.includes('采集暂不可用')));
  f.telemetry.requestErrorTraces = original;
  assert.equal((await f.service.report({ refresh: '1' })).summary.failed, 300);
});

test('missing tables and bounded SQL never report complete zero; omitted sensitive fields stay outside the read query', async () => {
  const inspector = { inspect: async () => ({ tables: {} }) };
  const source = new RequestErrorsSource({ inspector, pool: {} });
  await assert.rejects(source.read({ start: '2026-11-02', endExclusive: '2026-11-03' }, 'Asia/Shanghai'), { code: 'ERROR_LOGS_UNAVAILABLE' });
  inspector.inspect = async () => ({ tables: { ops_error_logs: { columns: ['id', 'created_at'] } } });
  const queries = [];
  source.pool = { connect: async () => ({ query: async sql => {
    queries.push(sql);
    return { rows: sql.startsWith('SELECT') ? Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ id: String(i + 1), created_at: '2026-11-02T01:00:00Z' })) : [] };
  }, release() {} }) };
  const bounded = await source.read({ start: '2026-11-02', endExclusive: '2026-11-03' }, 'Asia/Shanghai');
  assert.equal(bounded.coverage.truncated, true); assert.equal(bounded.rows.length, MAX_ROWS);
  assert(queries.some(sql => sql.includes('READ ONLY')));
  assert(queries.every(sql => !/request_body|authorization|api_key_prefix/.test(sql)));
});

test('single-flight reads reject old database responses and never cache a failed source', async () => {
  let finish, calls = 0;
  const pool = { pool: {} }, config = { sub2apiTimezone: 'Asia/Shanghai' };
  const payload = { rows: [], traces: [], coverage: {} };
  const source = { read: () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
  const service = new RequestErrorsService({ config, pool, source, now: () => new Date('2026-11-02T00:00:00Z') });
  const first = service.data(service.parse({})), second = service.data(service.parse({}));
  assert.equal(calls, 1);
  const rejected = [assert.rejects(first, { code: 'SOURCE_CHANGED' }), assert.rejects(second, { code: 'SOURCE_CHANGED' })];
  pool.pool = {}; finish(payload); await Promise.all(rejected);
  source.read = async () => { throw new Error('source offline'); };
  await assert.rejects(service.report({}), /source offline/);
  source.read = async () => payload;
  assert.equal((await service.report({})).summary.total, 0);
});

test('downstream telemetry alone retains proven failure even when the gateway error table has no record', async t => {
  const f = await requestErrorsFixture(); t.after(() => f.close());
  const root = await f.insert({ type: f.definitions.find(d => d[0] === 'stream_truncated') });
  await f.engine.query('DELETE FROM ops_error_logs WHERE id=$1', [root.sourceId]);
  const request = (await f.service.detail(`trace:${root.requestId}`, {})).request;
  assert.equal(request.outcome, 'stream'); assert.equal(request.failureType, 'stream_truncated');
  assert.equal(request.sourceRows, 0); assert.deepEqual(request.sourceIds, []);
  assert.equal(request.userId, '2'); assert(request.linked);
  const report = await f.service.report({}); assert.equal(report.summary.failed, 301);
  assert.equal(report.summary.sourceRows, 304, 'only actual error-table rows contribute to log record counts');
});
