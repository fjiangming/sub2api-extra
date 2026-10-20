'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { profileFixture } = require('./profile-fixture');
const { LatencyService, matchUpstream, compareTimings, parseQuery, observedUpstreamRequest } = require('../src/services/latency-service');

test('slow request SQL respects effort, streaming nulls, admin exclusion, errors and pagination', async (t) => {
  const fixture = await profileFixture({ now: '2026-10-20T10:00:00Z' });
  t.after(() => fixture.database.close());
  await fixture.database.engine.exec(`ALTER TABLE usage_logs ADD duration_ms integer, ADD first_token_ms integer,
    ADD stream boolean DEFAULT true, ADD reasoning_effort text, ADD request_id text, ADD upstream_request_id text;
    CREATE TABLE ops_error_logs (id bigserial, user_id bigint, account_id bigint, created_at timestamptz,
      model text, duration_ms integer, stream boolean, time_to_first_token_ms bigint, status_code integer);
    INSERT INTO usage_logs (user_id, account_id, model, created_at, duration_ms, first_token_ms, reasoning_effort, stream)
      VALUES (1, 270, 'gpt', '2026-10-20T01:00Z', 900000, 800000, 'max', true),
      (2, 270, 'gpt', '2026-10-20T01:01Z', 150748, 139499, 'medium', true),
      (2, 270, 'gpt', '2026-10-20T01:02Z', 110000, 90000, 'max', true),
      (2, 270, 'gpt', '2026-10-20T01:03Z', 220000, 200000, 'max', true),
      (2, 271, 'claude', '2026-10-20T01:04Z', 500000, NULL, NULL, false),
      (2, 271, 'claude', '2026-10-20T01:05Z', 10000, 0, NULL, true);
    INSERT INTO ops_error_logs (user_id, account_id, model, created_at, duration_ms, stream, status_code)
      VALUES (2, 270, 'gpt', '2026-10-20T01:06Z', 327800, true, 524);`);
  const service = new LatencyService({ pool: fixture.database, inspector: fixture.inspector,
    config: fixture.config, now: () => new Date('2026-10-20T10:00Z') });
  const report = await service.report({ pageSize: 2 });
  assert.equal(report.summary.records, 6);
  assert.equal(report.summary.slow_records, 4);
  assert.equal(report.summary.error_records, 1);
  assert.equal(report.summary.ttft_samples, 3);
  assert.equal(report.pagination.total, 4);
  assert.equal(report.items.length, 2);
  assert.equal(report.pagination.hasNext, true);
  assert.equal(report.items[0].source, 'error');
  const max = await service.report({ effort: 'max' });
  assert.equal(max.summary.records, 2);
  assert.equal(max.summary.slow_records, 1);
  assert.equal(max.items.length, 1);
  const nonStreaming = await service.report({ accountId: '271', kind: 'all' });
  assert.equal(nonStreaming.summary.ttft_p95_ms, null);
  assert.equal(nonStreaming.summary.ttft_samples, 0);
  assert.equal(nonStreaming.items.length, 2);
});

const base = { model: 'gpt', upstream_model: 'gpt-mapped', request_id: 'local-1', upstream_request_id: 'remote-1',
  created_at: '2026-10-20T01:00:00Z', stream: true, first_token_ms: 139499, duration_ms: 150748,
  input_tokens: 244, output_tokens: 384, cache_creation_tokens: 0, cache_read_tokens: 237400 };
const remote = { ...base, request_id: 'remote-1', first_token_ms: 21610, duration_ms: 32940 };

test('pairing requires unique IDs and never promotes token fingerprints to confirmed requests', () => {
  assert.equal(matchUpstream(base, [remote]).status, 'matched');
  assert.equal(matchUpstream(base, [remote, { ...remote }]).status, 'ambiguous');
  const fingerprint = { ...remote, request_id: 'another-id' };
  const result = matchUpstream(base, [fingerprint]);
  assert.equal(result.status, 'candidate');
  assert.equal(result.selected, null);
  assert.equal(matchUpstream(base, [fingerprint], { fingerprintUnique: false }).status, 'ambiguous');
  assert.equal(matchUpstream(base, [{ ...fingerprint, cache_read_tokens: null }]).status, 'unmatched');
  assert.equal(matchUpstream(base, [{ ...fingerprint, created_at: '2026-10-20T02:00Z' }]).status, 'unmatched');
});

test('comparison preserves missing and negative values and describes the 118 second gap without assigning fault', () => {
  const result = compareTimings(base, remote);
  assert.equal(result.firstTokenDeltaMs, 117889);
  assert.equal(result.durationDeltaMs, 117808);
  assert.equal(result.observation, 'similar_waiting_gap');
  assert.equal(result.semanticsVerified, false);
  assert.equal(compareTimings({ ...base, stream: false }, remote).firstTokenDeltaMs, null);
  assert.equal(compareTimings(base, { ...remote, first_token_ms: 200000 }).firstTokenDeltaMs, -60501);
});

test('query rejects expired ranges, unsafe IDs and invalid threshold values', () => {
  const config = { sub2apiTimezone: 'Asia/Shanghai', retention: { usageLogsDays: 30 } };
  const now = new Date('2026-10-20T10:00Z');
  assert.throws(() => parseQuery({ accountId: '1 OR 1=1' }, config, now));
  assert.throws(() => parseQuery({ userId: '9223372036854775808' }, config, now));
  assert.throws(() => parseQuery({ firstTokenSeconds: -1 }, config, now));
  assert.throws(() => parseQuery({ start: '2026-08-01', end: '2026-08-02' }, config, now));
});

test('detail reads the retained record, scopes upstream lookup, and degrades without losing local evidence', async (t) => {
  const fixture = await profileFixture({ now: '2026-10-20T10:00:00Z' });
  t.after(() => fixture.database.close());
  await fixture.database.engine.exec(`ALTER TABLE usage_logs ADD duration_ms integer, ADD first_token_ms integer,
    ADD stream boolean DEFAULT true, ADD reasoning_effort text, ADD request_id text, ADD upstream_request_id text;
    CREATE TABLE ops_error_logs (id bigserial, user_id bigint, account_id bigint, created_at timestamptz,
      model text, duration_ms integer, stream boolean, time_to_first_token_ms bigint, status_code integer, request_id text);
    INSERT INTO ops_error_logs (user_id, account_id, model, created_at, duration_ms, stream, status_code, request_id)
      VALUES (2, 270, 'gpt', '2026-10-20T01:00Z', 327800, true, 524, 'error-root');`);
  const inserted = await fixture.database.engine.query(`INSERT INTO usage_logs
    (user_id, account_id, model, created_at, duration_ms, first_token_ms, stream, request_id, upstream_request_id,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens) VALUES
    (2, 270, 'gpt', '2026-10-20T01:00Z', 150748, 139499, true, 'local-1', 'remote-1', 244, 384, 0, 237400),
    (1, 270, 'gpt', '2026-10-20T01:00Z', 150748, 139499, true, 'admin', NULL, 244, 384, 0, 237400),
    (2, NULL, 'gpt', '2026-10-20T01:00Z', 1000, 100, true, 'no-account', NULL, 1, 1, 0, 0)
    RETURNING id`);
  const [retained, admin, noAccount] = inserted.rows.map((row) => `usage:${row.id}`);
  const calls = [], lookups = [];
  let payload = { items: [remote], mappings: [], truncated: false }, unavailable = false;
  const service = new LatencyService({ pool: fixture.database, inspector: fixture.inspector, config: fixture.config,
    now: () => new Date('2026-10-20T10:00Z'),
    telemetry: { find: (ids) => { lookups.push(ids); return [{ requestId: 'root-1' }]; } },
    providerMonitor: { getLatencySamples: async (query, token) => {
      calls.push({ query, token }); if (unavailable) throw new Error('sync unavailable'); return payload;
    } }
  });
  const exact = await service.detail(retained, 'admin-session-token');
  assert.equal(exact.upstream.status, 'matched');
  assert.equal(exact.comparison.firstTokenDeltaMs, 117889);
  assert.equal(exact.comparison.durationDeltaMs, 117808);
  assert.equal(calls[0].query.accountId, '270');
  assert.equal(calls[0].query.from, '2026-10-20T00:42:29.252Z');
  assert.equal(calls[0].token, 'admin-session-token');
  assert.deepEqual(lookups[0], ['local-1', 'remote-1']);
  payload = { ...payload, truncated: true };
  const incomplete = await service.detail(retained);
  assert.equal(incomplete.upstream.status, 'candidate');
  assert.equal(incomplete.comparison, null);
  await assert.rejects(() => service.detail(admin), (error) => error.code === 'REQUEST_NOT_FOUND');
  assert.equal((await service.detail(noAccount)).upstreamError.code, 'ACCOUNT_MISSING');
  unavailable = true;
  const offline = await service.detail(retained);
  assert.equal(offline.base.request_id, 'local-1');
  assert.equal(offline.traces.length, 1);
  assert.equal(offline.upstreamError.message, 'sync unavailable');
  const errorRecord = await service.detail('error:1');
  assert.equal(errorRecord.base.source, 'error');
  assert.equal(errorRecord.base.status_code, 524);
  assert.equal(errorRecord.base.first_token_ms, null);
});

test('only a completed HTTP attempt for the same account can supply an observed upstream ID', () => {
  const record = { ...base, source: 'usage', account_id: '270', request_id: 'client:client-id', upstream_request_id: null };
  const trace = { events: [
    { attemptId: '1', sequence: 0, name: 'attempt_start', attributes: { accountId: '270' } },
    { attemptId: '1', sequence: 1, name: 'response_headers', attributes: { statusCode: 502, upstreamRequestId: 'failed-id' } },
    { attemptId: '1', sequence: 2, name: 'attempt_end', attributes: { outcome: 'completed' } },
    { attemptId: '2', sequence: 3, name: 'attempt_start', attributes: { accountId: '270' } },
    { attemptId: '2', sequence: 4, name: 'response_headers', attributes: { statusCode: 200, upstreamRequestId: 'remote-1' } },
    { attemptId: '2', sequence: 5, name: 'attempt_end', attributes: { outcome: 'completed' } }
  ] };
  const observed = observedUpstreamRequest(record, [trace]);
  assert.deepEqual(observed, { attemptId: '2', requestId: 'remote-1' });
  assert.equal(matchUpstream(record, [remote], { observedRequestId: observed.requestId }).status, 'matched');
  assert.equal(observedUpstreamRequest({ ...record, account_id: '271' }, [trace]), null);
  assert.equal(observedUpstreamRequest({ ...record, source: 'error' }, [trace]), null);
  assert.equal(observedUpstreamRequest(record, [trace, trace]), null);
  assert.equal(observedUpstreamRequest(record, [{ events: trace.events.slice(0, -1) }]), null);
  assert.equal(observedUpstreamRequest(record, [{ events: [...trace.events,
    { attemptId: '3', sequence: 6, name: 'attempt_start', attributes: { accountId: '270' } }
  ] }]), null, 'an earlier successful attempt must not replace the unfinished final attempt');
});
