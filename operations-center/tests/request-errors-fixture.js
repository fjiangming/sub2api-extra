'use strict';

const { PGlite } = require('@electric-sql/pglite');
const { SchemaInspector } = require('../src/schema-inspector');
const { RequestErrorsService } = require('../src/services/request-errors-service');
const { dateInTimezone, addUtcDays } = require('../src/services/metrics-service');

async function requestErrorsFixture({ now = new Date('2026-11-02T05:00:00Z') } = {}) {
  const engine = new PGlite(), queries = [], traces = [], today = dateInTimezone('Asia/Shanghai', now);
  await engine.exec(`CREATE TABLE users(id bigint PRIMARY KEY, username text);
    CREATE TABLE groups(id bigint PRIMARY KEY, name text);
    CREATE TABLE ops_error_logs(id bigserial PRIMARY KEY, request_id text, client_request_id text, user_id bigint,
      api_key_id bigint, group_id bigint, account_id bigint, model text, stream boolean, status_code integer,
      upstream_status_code integer, error_type text, error_owner text, error_phase text, error_source text,
      provider_error_code text, error_body text, request_body text, upstream_errors jsonb, duration_ms integer, created_at timestamptz);
    INSERT INTO groups VALUES(1,'cc max 满血高缓'),(2,'GPT 标准线路'),(3,'Gemini 高速线路');`);
  for (let i = 1; i <= 25; i++) await engine.query('INSERT INTO users VALUES($1,$2)', [i, i === 1 ? '管理员测试流量' : i === 2 ? '<img src=x onerror=alert(1)>' : `用户 ${i}`]);
  const pool = { async connect() { return { query: (sql, values) => { queries.push(sql); return engine.query(sql, values); }, release() {} }; },
    query: (sql, values) => { queries.push(sql); return engine.query(sql, values); } };
  const inspector = new SchemaInspector(pool);
  const definitions = [
    ['provider_balance','insufficient_balance','provider','upstream',403,502,'http_error',false,3],
    ['provider_auth','invalid_api_key','provider','upstream',401,502,'http_error',false,1],
    ['rate_limit','rate_limit_exceeded','provider','upstream',429,429,'http_error',false,2],
    ['upstream_5xx','upstream_error','provider','upstream',502,502,'http_error',false,2],
    ['no_account','no_available_accounts','platform','routing',502,503,'http_error',false,2],
    ['connect_timeout','connect_timeout','platform','network',null,504,'http_error',false,2],
    ['request_rejected','invalid_request_error','client','request',null,400,'http_error',false,0],
    ['stream_error','upstream_error','provider','upstream',200,200,'response_failed',true,1],
    ['stream_timeout','stream_timeout','platform','network',200,200,'sse_error',true,1],
    ['stream_truncated','incomplete_response','provider','upstream',200,200,'incomplete_close',true,1],
    ['gateway_error','response_conversion_error','platform','internal',200,500,'http_error',false,1],
    ['unclassified','unclassified_error','platform','other',null,500,'http_error',false,0]
  ];
  let index = 0;
  async function insert({ day = today, type = definitions[0], userId = 2, recovered = false, unknown = false, unlinked = false, disconnected = false, duplicate = false } = {}) {
    const [expectedType, errorCode, owner, phase, upstreamStatus, wireStatus, deliveryKind, outputStarted, attemptCount] = type;
    const requestId = `root-${++index}`, at = `${day}T01:${String(index % 60).padStart(2, '0')}:00.000Z`;
    const result = { resultVersion: 1, userId: String(userId), apiKeyId: String(userId + 100), groupId: String(index % 3 + 1),
      wireStatusCode: recovered || disconnected ? 200 : wireStatus, downstreamComplete: recovered, terminalSeen: recovered,
      errorWritten: !recovered && !unknown && !disconnected && deliveryKind !== 'incomplete_close',
      clientDisconnected: disconnected, outputStarted, upstreamAttemptCount: recovered ? 2 : attemptCount,
      retryExhausted: !recovered && attemptCount > 1 && expectedType !== 'no_account',
      deliveryKind: recovered ? 'complete' : deliveryKind, errorCode, errorOwner: owner, failureStage: phase };
    if (unknown) { delete result.resultVersion; delete result.errorWritten; delete result.downstreamComplete; delete result.terminalSeen; }
    const events = [{ requestId, sequence: 0, name: 'request_start', attributes: { userId: String(userId), apiKeyId: String(userId + 100) } }];
    for (let i = 0; i < (recovered ? 2 : attemptCount); i++) {
      const accountId = i === 0 ? '356' : '357';
      events.push({ requestId, sequence: events.length, attemptId: `a${i}`, name: 'response_headers', attributes: { accountId, statusCode: recovered && i === 1 ? 200 : upstreamStatus || 504 } });
      events.push({ requestId, sequence: events.length, attemptId: `a${i}`, name: 'attempt_end', attributes: { accountId, outcome: recovered && i === 1 ? 'completed' : 'error' } });
    }
    events.push({ requestId, sequence: events.length, name: 'request_end', elapsedMs: 1500, attributes: result });
    if (!unlinked) traces.push({ requestId, startedAt: at, metadata: result, events, droppedEvents: 0 });
    const record = { requestId, clientId: `same-client-${index % 3}`, userId: String(userId), apiKeyId: String(userId + 100),
      groupId: String(index % 3 + 1), accountId: attemptCount ? '356' : null, createdAt: new Date(Date.parse(at) + 2000).toISOString(),
      code: errorCode, owner, phase, upstreamStatus, status: recovered ? 200 : wireStatus, stream: wireStatus === 200 };
    const add = () => engine.query(`INSERT INTO ops_error_logs(request_id,client_request_id,user_id,api_key_id,group_id,account_id,
      model,stream,status_code,upstream_status_code,error_type,error_owner,error_phase,error_source,error_body,request_body,created_at)
      VALUES($1,$2,$3,$4,$5,$6,'demo-model',$7,$8,$9,$10,$11,$12,'gateway',$13,'SECRET PROMPT MUST NEVER LEAVE SOURCE',$14) RETURNING id`,
    [record.requestId, record.clientId, record.userId, record.apiKeyId, record.groupId, record.accountId, record.stream,
      record.status, upstreamStatus, errorCode, owner, phase, JSON.stringify({ error: { code: errorCode, message: 'PRIVATE ERROR BODY' } }), record.createdAt]);
    const added = await add(); if (duplicate) await add(); return { requestId, trace: traces.find(t => t.requestId === requestId), sourceId: String(added.rows[0].id), expectedType };
  }
  for (let u = 1; u <= 25; u++) for (const type of definitions) await insert({ type, userId: u });
  await insert({ recovered: true }); await insert({ unknown: true }); await insert({ unlinked: true }); await insert({ disconnected: true });
  await insert({ day: addUtcDays(today, -1), recovered: true });
  const config = { sub2apiTimezone: 'Asia/Shanghai' };
  const telemetry = { requestErrorTraces: ids => traces.filter(t => ids.includes(t.requestId)), status: () => ({ enabled: true }),
    requestErrorRootIds: (from, to, limit) => {
      const roots = traces.filter(t => Date.parse(t.startedAt) >= from && Date.parse(t.startedAt) < to);
      return { ids: roots.slice(0, limit).map(t => t.requestId), truncated: roots.length > limit };
    } };
  const providerMonitor = { configured: () => true, getRequestErrorMappings: async () => ({ items: [
    { accountId: '356', providerId: 'a', providerName: '供应商 A', keyId: 'alpha', keyName: '主 Key', scope: 'history', validFrom: '2026-01-01T00:00:00Z', validTo: null },
    { accountId: '357', providerId: 'b', providerName: '供应商 B', keyId: 'beta', keyName: '备用 Key', scope: 'history', validFrom: '2026-01-01T00:00:00Z', validTo: null }
  ], truncated: false }) };
  const service = new RequestErrorsService({ pool, inspector, config, telemetry, providerMonitor, now: () => now });
  return { service, pool, engine, traces, queries, today, now, insert, definitions, inspector, telemetry, providerMonitor, config, close: () => engine.close() };
}
module.exports = { requestErrorsFixture };
