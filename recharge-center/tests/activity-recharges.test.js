'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { installActivityRecharges } = require('../src/activity-recharges');
const { errorResponse } = require('../src/errors');
const { loadConfig } = require('../src/config');

test('activity integration returns only verified completed personal cash, with independent read-only auth', async t => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE recharge_orders(user_id integer,currency text,status text,payment_mode text,verified_at text,trade_hash text,completed_at text,alipay_paid_at text,payable_amount_minor integer);
    INSERT INTO recharge_orders VALUES
      (42,'CNY','completed','personal_manual','yes','trade1','yes','2026-11-02T00:00:00.000Z',5001),
      (42,'CNY','completed','personal_accountlog_static','yes','trade2','yes','2026-11-02T00:00:00.000Z',4999),
      (42,'CNY','completed','sub2api_official','yes','trade3','yes','2026-11-02T00:00:00.000Z',999999),
      (42,'CNY','needs_attention','personal_manual','yes','trade4',null,'2026-11-02T00:00:00.000Z',999999),
      (42,'CNY','completed','personal_manual',null,null,'yes','2026-11-02T00:00:00.000Z',999999),
      (42,'CNY','completed','personal_manual','yes','trade5','yes','2026-10-02T00:00:00.000Z',999999),
      (99,'CNY','completed','personal_manual','yes','trade6','yes','2026-11-02T00:00:00.000Z',999999);`);
  const app = express(); const config = { activityIntegrationToken: 't'.repeat(32) };
  installActivityRecharges(app,{ config,db },(_req,_res,next) => next());
  app.use((error,_req,res,_next) => res.status(error.status || 500).json(errorResponse(error)));
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/integrations/activity-center/recharges?user_id=42&since=2026-11-01T00:00:00.000Z`;
  assert.equal((await fetch(endpoint)).status,401);
  const response = await fetch(endpoint,{ headers: { authorization: `Bearer ${config.activityIntegrationToken}` } });
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ version: 1,userId: '42',since: '2026-11-01T00:00:00.000Z',currency: 'CNY',totalMinor: '10000' });
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(endpoint+'&extra=true',{ headers: { authorization: `Bearer ${config.activityIntegrationToken}` } })).status,400);
  config.activityIntegrationToken = null;
  assert.equal((await fetch(endpoint,{ headers: { authorization: `Bearer ${'t'.repeat(32)}` } })).status,401);
});

test('activity integration token is optional and rejects accidentally short secrets', () => {
  const env = { NODE_ENV: 'test',RECHARGE_CENTER_PAYMENT_MODE: 'personal_manual',RECHARGE_CENTER_SECRET: 's'.repeat(32),SUB2API_BASE_URL: 'http://localhost:8080' };
  assert.equal(loadConfig(env).activityIntegrationToken,null);
  assert.throws(() => loadConfig({ ...env,RECHARGE_CENTER_ACTIVITY_INTEGRATION_TOKEN: 'short' }));
});
