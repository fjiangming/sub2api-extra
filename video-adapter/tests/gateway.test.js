'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');

const body = { model:'demo-video',prompt:'A clear test scene',duration:5,resolution:'480p',aspect_ratio:'16:9' };

test('creation freezes the complete price, quota and windows in one transaction',async t => {
  const f = await fixture(t);
  const response = await f.api('/v1/videos',{ body,idempotencyKey:'freeze-operation' });
  assert.equal(response.status,202);
  assert.equal(response.body.quoted_price_usd,'0.50000000');
  const user = (await f.db.query('SELECT balance,frozen_balance FROM users WHERE id=1')).rows[0];
  assert.deepEqual(user,{ balance:'99.50000000',frozen_balance:'0.50000000' });
  assert.equal(String((await f.db.query('SELECT quota_used FROM api_keys WHERE id=1')).rows[0].quota_used),'0.50000000');
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM usage_logs')).rows[0].count,0);
});
test('idempotent replay does not freeze again and changed raw bytes conflict',async t => {
  const f = await fixture(t);
  const first = await f.api('/v1/videos',{ body,idempotencyKey:'same-operation' });
  const again = await f.api('/v1/videos',{ body,idempotencyKey:'same-operation' });
  assert.equal(again.status,200);
  assert.equal(again.body.id,first.body.id);
  const changed = await f.api('/v1/videos',{ rawBody:JSON.stringify(body,null,2),idempotencyKey:'same-operation' });
  assert.equal(changed.status,409);
  assert.equal((await f.db.query('SELECT frozen_balance FROM users WHERE id=1')).rows[0].frozen_balance,'0.50000000');
});
test('missing idempotency and unknown cost-affecting fields cannot create tasks',async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/v1/videos',{ body })).status,400);
  assert.equal((await f.api('/v1/videos',{ body:{ ...body,enhance:true },idempotencyKey:'unknown-option' })).status,400);
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM video_adapter.jobs')).rows[0].count,0);
});
test('insufficient balance and discounted below-cost prices roll back all holds',async t => {
  const f = await fixture(t);
  await f.db.query('UPDATE users SET balance=0.1 WHERE id=1');
  assert.equal((await f.api('/v1/videos',{ body,idempotencyKey:'low-balance-key' })).status,402);
  assert.equal((await f.db.query('SELECT quota_used FROM api_keys WHERE id=1')).rows[0].quota_used,'0');
  await f.db.query('UPDATE users SET balance=100 WHERE id=1');
  await f.db.query('UPDATE groups SET video_rate_multiplier=0.01 WHERE id=1');
  const rejected = await f.api('/v1/videos',{ body,idempotencyKey:'low-price-task' });
  assert.equal(rejected.body.error.code,'UNPROFITABLE_PRICE');
  assert.equal((await f.db.query('SELECT frozen_balance FROM users WHERE id=1')).rows[0].frozen_balance,'0.00000000');
});
test('two concurrent tasks cannot reserve beyond available balance',async t => {
  const f = await fixture(t);
  await f.db.query('UPDATE users SET balance=0.6 WHERE id=1');
  const results = await Promise.all([f.api('/v1/videos',{ body,idempotencyKey:'concurrent-task-1' }),f.api('/v1/videos',{ body,idempotencyKey:'concurrent-task-2' })]);
  assert.deepEqual(results.map(result => result.status).sort(),[202,402]);
  assert.equal((await f.db.query('SELECT balance FROM users WHERE id=1')).rows[0].balance,'0.10000000');
});
test('parallel replay creates one job and reserves once',async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.api('/v1/videos',{ body,idempotencyKey:'parallel-replay' }),f.api('/v1/videos',{ body,idempotencyKey:'parallel-replay' })]);
  assert.equal(results[0].body.id,results[1].body.id);
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM video_adapter.jobs')).rows[0].count,1);
});
test('spending limits, subscriptions, group allowlists and IP policies are enforced',async t => {
  const f = await fixture(t);
  await f.db.query('UPDATE api_keys SET quota=0.3 WHERE id=1');
  assert.equal((await f.api('/v1/videos',{ body,idempotencyKey:'quota-block-task' })).body.error.code,'KEY_QUOTA_EXCEEDED');
  await f.db.query('UPDATE api_keys SET quota=0,rate_limit_5h=0.3 WHERE id=1');
  assert.equal((await f.api('/v1/videos',{ body,idempotencyKey:'window-block-task' })).body.error.code,'KEY_WINDOW_LIMIT');
  await f.db.query('UPDATE api_keys SET rate_limit_5h=0 WHERE id=1');
  await f.db.query("UPDATE groups SET subscription_type='subscription' WHERE id=1");
  assert.equal((await f.api('/v1/videos',{ body,idempotencyKey:'subscription-task' })).body.error.code,'SUBSCRIPTION_UNSUPPORTED');
  await f.db.query("UPDATE groups SET subscription_type='standard',model_allowlist='{"+'"enabled":true,"models":["other"]' + "}' WHERE id=1");
  assert.equal((await f.api('/v1/videos',{ body,idempotencyKey:'allowlist-block' })).body.error.code,'MODEL_DENIED');
  await f.db.query("UPDATE api_keys SET ip_whitelist='[\"203.0.113.1\"]' WHERE id=1");
  assert.equal((await f.api('/v1/models')).body.error.code,'IP_DENIED');
});
test('unknown identities, another key and reassigned groups cannot access a task',async t => {
  const f = await fixture(t);
  const response = await f.api('/v1/videos',{ body,idempotencyKey:'owner-operation' });
  assert.equal((await f.api(`/v1/videos/${response.body.id}`,{ token:'sk-demo-other-local-only' })).status,404);
  assert.equal((await f.api(`/v1/videos/${response.body.id}`,{ token:'invalid' })).status,401);
});
test('supplier budget exhaustion is enforced before committing a paid request',async t => {
  const f = await fixture(t,{ dailyCostBudgetUsd:'0.15' });
  await f.reserve('budget-job-one');
  await assert.rejects(f.reserve('budget-job-two'),{ code:'COST_BUDGET_EXCEEDED' });
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM video_adapter.jobs')).rows[0].count,1);
});
test('quote produces no hold and no provider task',async t => {
  const f = await fixture(t);
  let calls = 0;
  f.registry.create = async () => { calls++; };
  assert.equal((await f.api('/v1/videos/quote',{ body })).body.price_usd,'0.50000000');
  assert.equal(calls,0);
  assert.equal((await f.db.query('SELECT balance FROM users WHERE id=1')).rows[0].balance,'100.00000000');
});
test('encrypted persistence and public/admin responses do not expose prompts or supplier secrets',async t => {
  const f = await fixture(t);
  f.catalog.providers[0].apiKey = 'supplier-secret-example';
  const response = await f.api('/v1/videos',{ body:{ ...body,prompt:'private-prompt-example' },idempotencyKey:'encrypted-task' });
  const job = (await f.db.query('SELECT * FROM video_adapter.jobs')).rows[0];
  assert.ok(!JSON.stringify(job).includes('private-prompt-example'));
  assert.ok(!JSON.stringify(job).includes('supplier-secret-example'));
  const admin = await f.api('/admin/jobs',{ token:f.config.adminToken });
  assert.ok(!JSON.stringify(admin.body).includes('secret_snapshot'));
  assert.ok(!JSON.stringify(admin.body).includes('supplier-secret-example'));
  assert.ok(!JSON.stringify(response.body).includes('private-prompt-example'));
});

test('configured native platform quotas block new spending while old task reads remain available',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  await f.db.query("INSERT INTO user_platform_quotas(user_id,platform,daily_limit_usd) VALUES(1,'grok',0)");
  const denied = await f.api('/v1/videos',{ body,idempotencyKey:'platform-quota-task' });
  assert.equal(denied.body.error.code,'PLATFORM_QUOTA_UNSUPPORTED');
  assert.equal((await f.api(`/v1/videos/${job.id}`)).status,200);
  assert.equal((await f.db.query('SELECT frozen_balance FROM users WHERE id=1')).rows[0].frozen_balance,'0.50000000');
  await f.db.query("UPDATE user_platform_quotas SET deleted_at=NOW() WHERE user_id=1");
  await f.db.query("UPDATE groups SET platform='composite' WHERE id=1");
  assert.equal((await f.api('/v1/videos',{ body,idempotencyKey:'composite-policy-task' })).body.error.code,'COMPOSITE_UNSUPPORTED');
  await f.db.query("UPDATE groups SET platform='grok' WHERE id=1");
  assert.equal((await f.api('/v1/videos',{ body,idempotencyKey:'quota-removed-task' })).status,202);
});

test('zero group RPM override preserves the native global user limit and replay consumes no RPM',async t => {
  const f = await fixture(t);
  await f.db.query('UPDATE users SET rpm_limit=1 WHERE id=1');
  await f.db.query('UPDATE groups SET rpm_limit=1 WHERE id=1');
  await f.db.query('INSERT INTO user_group_rate_multipliers(user_id,group_id,rpm_override) VALUES(1,1,0)');
  const first = await f.api('/v1/videos',{ body,idempotencyKey:'rpm-first-operation' });
  assert.equal(first.status,202);
  assert.equal((await f.api('/v1/videos',{ body,idempotencyKey:'rpm-first-operation' })).status,200);
  const denied = await f.api('/v1/videos',{ body,idempotencyKey:'rpm-second-operation' });
  assert.equal(denied.body.error.code,'USER_RPM_LIMIT');
  assert.equal((await f.db.query('SELECT frozen_balance FROM users WHERE id=1')).rows[0].frozen_balance,'0.50000000');
  assert.equal((await f.db.query('SELECT quota_used FROM api_keys WHERE id=1')).rows[0].quota_used,'0.50000000');
});
