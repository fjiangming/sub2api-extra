'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { SchemaInspector } = require('../src/schema-inspector');
const { BillingImportSource } = require('../src/services/billing-import-source');
const { optionsSchema } = require('../src/services/billing-import-service');
const { AppError } = require('../src/errors');

const record = { number: 2, key: 'vendor-key', model: 'claude-test', startedAt: '2026-10-22T01:08:08Z' };
const options = optionsSchema.parse({ accountMappings: { 'vendor-key': 356 } });

test('source reads original native logs with array, SQL NULL, JSON null and scalar upstream errors', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE users(id bigint,email text);
    CREATE TABLE groups(id bigint,name text,subscription_type text);
    CREATE TABLE accounts(id bigint,name text,platform text,deleted_at timestamptz);
    CREATE TABLE usage_logs(id bigint,user_id bigint,api_key_id bigint,account_id bigint,group_id bigint,
      created_at timestamptz,model text,request_id text,duration_ms bigint,input_tokens integer,output_tokens integer,
      cache_creation_tokens integer,cache_read_tokens integer,actual_cost numeric);
    CREATE TABLE ops_error_logs(id bigint,user_id bigint,api_key_id bigint,account_id bigint,group_id bigint,
      created_at timestamptz,model text,request_id text,upstream_model text,upstream_errors jsonb,response_latency_ms bigint);
    INSERT INTO users VALUES(11,'user@example.test'); INSERT INTO groups VALUES(15,'CC Max','standard');
    INSERT INTO accounts VALUES(356,'Lingsu','anthropic',NULL),(357,'deleted','anthropic',NOW());
    INSERT INTO ops_error_logs VALUES
      (1,11,12,356,15,'2026-10-22T01:10:13Z','claude-test','root-1',NULL,NULL,125000),
      (2,11,12,356,15,'2026-10-22T01:10:14Z','claude-test','root-2',NULL,'null',125000),
      (3,11,12,356,15,'2026-10-22T01:10:15Z','claude-test','root-3',NULL,'{}',125000),
      (4,11,12,999,15,'2026-10-22T01:10:16Z','claude-test','root-4',NULL,'[{"account_id":356,"upstream_request_id":"up-1"}]',125000),
      (5,11,12,999,15,'2026-10-22T01:10:17Z','claude-test','root-5',NULL,'[]',125000);
    INSERT INTO usage_logs VALUES(1,11,12,356,15,'2026-10-22T01:11:02Z','claude-test','billed-1',174000,4964,13212,0,0,0.2);`);
  const coreCalls = [];
  const source = new BillingImportSource({ pool: db, inspector: new SchemaInspector(db), recovery: { list: async query => {
    coreCalls.push(query); return { items: [], total: 0 };
  } } });
  assert.deepEqual((await source.accounts()).map(row => row.id), ['356']);
  const result = await source.load([record], options, 'browser-jwt');
  assert.equal(result.coreAvailable, true); assert.equal(result.candidates.length, 5);
  assert.equal(result.candidates.filter(row => row.kind === 'error').length, 4);
  assert.equal(result.candidates.find(row => row.kind === 'usage').startMs, Date.parse(record.startedAt));
  assert.equal(result.candidates.find(row => row.errorId === 4).accountId, '356');
  assert.deepEqual(result.candidates.find(row => row.errorId === 4).ids, ['up-1']);
  assert.equal(result.candidates[0].userEmail, 'user@example.test');
  assert.equal(coreCalls[0].account_id, '356'); assert.ok(coreCalls[0].from < record.startedAt);
});

test('source supports original core without recovery API and rejects truncated or invalid source lists', async () => {
  const schema = { tables: { usage_logs: { columns: ['id'] } } };
  const pool = { query: async () => ({ rows: [] }) };
  const source = new BillingImportSource({ pool, inspector: { inspect: async () => schema }, recovery: {
    list: async () => { throw new AppError('SUB2API_FAILED', 'not available', { status: 502, details: { upstreamStatus: 404 } }); }
  } });
  assert.equal((await source.load([record], options)).coreAvailable, false);
  source.recovery.list = async () => ({ total: 20001, items: [] });
  await assert.rejects(source.load([record], options), { code: 'SOURCE_TRUNCATED' });
  source.recovery.list = async () => ({ items: [] });
  await assert.rejects(source.load([record], options), { code: 'SOURCE_INVALID' });
  pool.query = async () => ({ rows: Array.from({ length: 20001 }, () => ({})) });
  await assert.rejects(source.load([record], options), { code: 'SOURCE_TRUNCATED' });
  await assert.rejects(source.load([record, { ...record, startedAt: '2026-08-01Z' }], options), { code: 'IMPORT_RANGE' });
});
