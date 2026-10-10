'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const { decrypt } = require('../src/security');
const { AppError } = require('../src/errors');
const { money } = require('../src/money');

async function due(f) { await f.db.query("UPDATE video_adapter.jobs SET next_poll_at=NOW()-INTERVAL '1 second'"); }

test('worker settles without customer polling; repeated observations do not charge twice',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  await f.processOne(); await due(f); await f.processOne();
  const finished = (await f.db.query('SELECT * FROM video_adapter.jobs WHERE id=$1',[job.id])).rows[0];
  assert.equal(finished.funds_state,'captured');
  const balance = (await f.db.query('SELECT balance,frozen_balance FROM users WHERE id=1')).rows[0];
  assert.deepEqual(balance,{ balance:'99.50000000',frozen_balance:'0.00000000' });
  await f.store.settle(job.id,{ charge:job.hold_usd,supplierCost:'0.1' });
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM usage_logs')).rows[0].count,1);
  const usage = (await f.db.query('SELECT actual_cost,account_stats_cost,video_duration_seconds FROM usage_logs')).rows[0];
  assert.equal(usage.actual_cost,'0.5000000000');
  assert.equal(usage.account_stats_cost,'0.1000000000');
});
test('confirmed supplier release refunds all held balance and key quota',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  f.registry.status = async () => ({ id:'mock_'+job.id,status:'failed',failed:true,funds:'released',amount:'0.1' });
  await f.processOne(); await due(f); await f.processOne();
  assert.deepEqual((await f.db.query('SELECT balance,frozen_balance FROM users WHERE id=1')).rows[0],{ balance:'100.00000000',frozen_balance:'0.00000000' });
  assert.equal(money((await f.db.query('SELECT quota_used FROM api_keys WHERE id=1')).rows[0].quota_used),'0.00000000');
});
test('failed without financial refund proof keeps funds and enters review',async t => {
  const f = await fixture(t);
  await f.reserve(); await f.processOne();
  f.registry.status = async () => ({ status:'failed',failed:true,funds:'reserved' });
  await due(f); await f.processOne();
  const job = (await f.db.query('SELECT state,funds_state FROM video_adapter.jobs')).rows[0];
  assert.deepEqual(job,{ state:'review',funds_state:'held' });
});
test('non-idempotent ambiguous creation is never retried or failed over',async t => {
  const f = await fixture(t);
  f.catalog.providers[0].idempotentCreate = false;
  await f.reserve();
  let calls = 0;
  f.registry.create = async () => { calls++; throw new Error('transport timeout'); };
  await f.processOne(); await due(f); await f.processOne();
  assert.equal(calls,1);
  assert.equal((await f.db.query('SELECT state FROM video_adapter.jobs')).rows[0].state,'review');
});
test('idempotent creation reuses exact body, key and provider credential after lost receipt',async t => {
  const f = await fixture(t);
  f.catalog.providers[0].apiKey = 'original-credential';
  await f.reserve();
  const calls = [];
  f.registry.create = async (provider,body,key) => {
    calls.push({ body,key,credential:provider.apiKey });
    if (calls.length===1) throw new Error('timeout');
    return { id:'recovered-task',status:'queued',funds:'reserved' };
  };
  await f.processOne();
  f.catalog.providers[0].apiKey = 'rotated-credential';
  await due(f); await f.processOne();
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0],calls[1]);
  assert.equal(calls[1].credential,'original-credential');
});
test('crash after submission marker cannot duplicate a non-idempotent paid task',async t => {
  const f = await fixture(t);
  f.catalog.providers[0].idempotentCreate = false;
  const job = await f.reserve();
  await f.db.query("UPDATE video_adapter.jobs SET state='submitting',attempts=1,lease_until=NOW()-INTERVAL '1 second' WHERE id=$1",[job.id]);
  let calls = 0; f.registry.create = async () => { calls++; };
  await f.processOne();
  assert.equal(calls,0);
  assert.equal((await f.db.query('SELECT state FROM video_adapter.jobs')).rows[0].state,'review');
});
test('overrun quote pauses provider and blocks future spending',async t => {
  const f = await fixture(t);
  await f.reserve();
  f.registry.create = async () => ({ id:'price-overrun',status:'queued',funds:'reserved',amount:'10' });
  await f.processOne();
  assert.equal((await f.db.query('SELECT paused FROM video_adapter.provider_controls')).rows[0].paused,true);
  await assert.rejects(f.reserve('another-operation'),{ code:'PROVIDER_PAUSED' });
});
test('price changes after creation do not reprice already-frozen tasks',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  await f.db.query('UPDATE groups SET video_rate_multiplier=99 WHERE id=1');
  await f.processOne(); await due(f); await f.processOne();
  assert.equal((await f.db.query('SELECT charged_usd FROM video_adapter.jobs WHERE id=$1',[job.id])).rows[0].charged_usd,'0.50000000');
});
test('timeout and 404 are not supplier refund evidence',async t => {
  const f = await fixture(t);
  await f.reserve(); await f.processOne();
  f.registry.status = async () => { const error = new AppError('UPSTREAM_HTTP_ERROR','missing',502); error.upstreamStatus=404; throw error; };
  await due(f); await f.processOne();
  assert.equal((await f.db.query('SELECT funds_state FROM video_adapter.jobs')).rows[0].funds_state,'held');
});
test('settlement cannot create a loss, exceed a hold or release charged supplier cost',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  await assert.rejects(f.store.settle(job.id,{ charge:'0',supplierCost:'0.01' }),{ code:'LOSS_REFUND_DENIED' });
  await assert.rejects(f.store.settle(job.id,{ charge:'1',supplierCost:'0.1' }),{ code:'SETTLEMENT_EXCEEDS_HOLD' });
  await assert.rejects(f.store.settle(job.id,{ charge:'0.5',supplierCost:'1' }),{ code:'SUPPLIER_COST_OVERRUN' });
});
test('lost worker leases cannot mutate or capture task funds',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  const claimed = await f.store.claim('old-worker');
  await f.db.query("UPDATE video_adapter.jobs SET lease_owner='new-worker',lease_until=NOW()+INTERVAL '1 minute' WHERE id=$1",[job.id]);
  await assert.rejects(f.store.update(claimed,{ state:'running' }),{ code:'LEASE_LOST' });
  await assert.rejects(f.store.settle(job.id,{ charge:'0.5',supplierCost:'0.1',owner:'old-worker' }),{ code:'LEASE_LOST' });
});
test('zero remaining balance and exhausted keys can still read and download settled tasks',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  await f.processOne(); await due(f); await f.processOne();
  await f.db.query('UPDATE users SET balance=0 WHERE id=1');
  await f.db.query("UPDATE api_keys SET status='quota_exhausted' WHERE id=1");
  assert.equal((await f.api(`/v1/videos/${job.id}`)).body.status,'done');
  const downloaded = await f.api(`/v1/videos/${job.id}/content`);
  assert.equal(downloaded.status,200);
  assert.equal(downloaded.body,'mock-video-fixture');
  await f.db.query("UPDATE api_keys SET status='disabled' WHERE id=1");
  assert.equal((await f.api(`/v1/videos/${job.id}`)).status,403);
});
test('a later confirmed supplier refund credits the customer once and preserves audit history',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  await f.processOne(); await due(f); await f.processOne();
  f.registry.status = async () => ({ id:'mock_'+job.id,status:'completed',completed:true,funds:'refunded',amount:'0.1' });
  await due(f); await f.processOne();
  assert.equal((await f.db.query('SELECT balance FROM users WHERE id=1')).rows[0].balance,'100.00000000');
  assert.equal((await f.db.query('SELECT funds_state FROM video_adapter.jobs')).rows[0].funds_state,'refunded');
  await f.store.refundCaptured(job.id,{ funds:'refunded' });
  assert.equal((await f.db.query('SELECT balance FROM users WHERE id=1')).rows[0].balance,'100.00000000');
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM usage_logs')).rows[0].count,1);
  assert.equal((await f.db.query("SELECT count(*)::int AS count FROM video_adapter.events WHERE kind='captured_refunded'")).rows[0].count,1);
});
test('a cost card expiring before first submission releases funds without calling supplier',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  const snapshot = decrypt(job.secret_snapshot,f.config.encryptionKey);
  snapshot.model.cost.expiresAt = new Date(Date.now()-1000).toISOString();
  const { encrypt } = require('../src/security');
  await f.db.query('UPDATE video_adapter.jobs SET secret_snapshot=$1 WHERE id=$2',[encrypt(snapshot,f.config.encryptionKey),job.id]);
  let calls = 0; f.registry.create = async () => { calls++; };
  await f.processOne();
  assert.equal(calls,0);
  assert.equal((await f.db.query('SELECT funds_state FROM video_adapter.jobs')).rows[0].funds_state,'released');
});
test('expired cost verification does not authorize a potentially new retry of an unknown creation',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  const snapshot = decrypt(job.secret_snapshot,f.config.encryptionKey);
  snapshot.model.cost.expiresAt = new Date(Date.now()-1000).toISOString();
  const { encrypt } = require('../src/security');
  await f.db.query("UPDATE video_adapter.jobs SET secret_snapshot=$1,state='unknown',attempts=1 WHERE id=$2",[encrypt(snapshot,f.config.encryptionKey),job.id]);
  let calls = 0; f.registry.create = async () => { calls++; };
  await f.processOne();
  assert.equal(calls,0);
  assert.equal((await f.db.query('SELECT funds_state FROM video_adapter.jobs')).rows[0].funds_state,'held');
});
test('administrator reconciliation requires authentication, evidence and current version',async t => {
  const f = await fixture(t);
  const job = await f.reserve();
  await f.db.query("UPDATE video_adapter.jobs SET state='review' WHERE id=$1",[job.id]);
  const body = { version:999,outcome:'released',note:'Supplier confirmed zero cost for this exact task',evidence:'Ticket REF-2026-0001' };
  assert.equal((await f.api(`/admin/jobs/${job.id}/reconcile`,{ body })).status,401);
  assert.equal((await f.api(`/admin/jobs/${job.id}/reconcile`,{ body,token:f.config.adminToken })).status,409);
  body.version = job.version;
  assert.equal((await f.api(`/admin/jobs/${job.id}/reconcile`,{ body,token:f.config.adminToken })).status,200);
  assert.equal((await f.db.query('SELECT balance FROM users WHERE id=1')).rows[0].balance,'100.00000000');
});

test('disabling a provider releases only never-submitted tasks and preserves uncertain funding',async t => {
  const f = await fixture(t);
  const first = await f.reserve('disabled-queued-task');
  const second = await f.reserve('disabled-unknown-task');
  await f.db.query("UPDATE video_adapter.jobs SET state='unknown',attempts=1 WHERE id=$1",[second.id]);
  f.catalog.providers[0].enabled = false;
  let calls = 0; f.registry.create = async () => { calls++; };
  await f.processOne(); await f.processOne();
  assert.equal(calls,0);
  const queued = (await f.db.query('SELECT * FROM video_adapter.jobs WHERE id=$1',[first.id])).rows[0];
  const unknown = (await f.db.query('SELECT * FROM video_adapter.jobs WHERE id=$1',[second.id])).rows[0];
  assert.equal(queued.funds_state,'released');
  assert.equal(unknown.funds_state,'held');
  assert.equal(unknown.state,'review');
});

test('download allowance includes failed requests, excludes HEAD and cancels rejected bodies',async t => {
  const f = await fixture(t,{ maxDownloadsPerJob:2 });
  const job = await f.reserve();
  await f.processOne(); await due(f); await f.processOne();
  assert.equal((await f.api(`/v1/videos/${job.id}/content`,{ method:'HEAD' })).status,200);
  let cancelled = 0;
  f.registry.content = async () => ({ status:200,headers:new Headers({ 'content-type':'application/json' }),body:{ cancel:async () => { cancelled++; } } });
  assert.equal((await f.api(`/v1/videos/${job.id}/content`)).body.error.code,'INVALID_VIDEO_CONTENT');
  assert.equal((await f.api(`/v1/videos/${job.id}/content`)).body.error.code,'INVALID_VIDEO_CONTENT');
  assert.equal(cancelled,2);
  assert.equal((await f.api(`/v1/videos/${job.id}/content`)).body.error.code,'DOWNLOAD_BUDGET_EXCEEDED');
  assert.equal((await f.db.query('SELECT download_requests FROM video_adapter.jobs WHERE id=$1',[job.id])).rows[0].download_requests,2);
});

test('native usage records and holds cover all thirty seconds of the accepted video',async t => {
  const f = await fixture(t);
  const job = await f.reserve('full-duration-operation',{ duration:30 });
  assert.equal(job.hold_usd,'3.00000000');
  await f.processOne(); await due(f); await f.processOne();
  const log = (await f.db.query('SELECT actual_cost,video_duration_seconds,billing_mode FROM usage_logs')).rows[0];
  assert.equal(log.actual_cost,'3.0000000000');
  assert.equal(log.video_duration_seconds,30);
  assert.equal(log.billing_mode,'video');
});

test('unknown creation retries must fit completely inside verified supplier idempotency retention',async t => {
  const f = await fixture(t);
  f.catalog.providers[0].idempotencyRetentionSeconds = 60;
  let calls = 0; f.registry.create = async () => { calls++; };
  for (const age of [61,40]) {
    const job = await f.reserve('retention-case-'+age);
    await f.db.query("UPDATE video_adapter.jobs SET state='unknown',attempts=1,created_at=NOW()-($2::text||' seconds')::interval WHERE id=$1",[job.id,age]);
    await f.processOne();
    const retained = (await f.db.query('SELECT state,funds_state,last_code FROM video_adapter.jobs WHERE id=$1',[job.id])).rows[0];
    assert.deepEqual(retained,{ state:'review',funds_state:'held',last_code:'IDEMPOTENCY_RETENTION_EXPIRED' });
  }
  assert.equal(calls,0);
});
