'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { fixture, event } = require('./conversation-logs-fixture');
const { s3Receiver } = require('./conversation-s3-fixture');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationJsonlStore } = require('../src/conversation-jsonl-store');
const { ConversationPushService } = require('../src/services/conversation-push-service');
const { publicPolicy, targetHash, targets, defaultStorageRates } = require('../src/services/conversation-push-policy');
const { amountMicros } = require('../src/conversation-storage-billing-store');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');

function setup(t) {
  let at = Date.now();
  const f = fixture({ now: () => at });
  f.store.configure({ ...f.store.policy(), mode: 'original', retention: 0 });
  const push = new ConversationPushStore(f.store, { now: () => at }).initialize();
  const service = new ConversationPushService(push);
  t.after(async () => { await service.stop(); f.close(); });
  return { ...f, push, service, jsonl: service.jsonl.store, advance: () => { at += 31000; } };
}
function configure(f, first = 'https://storage.example', second = first, options = {}) {
  const current = f.push.policy(), billing = { enabled: true, rates: defaultStorageRates };
  const s3 = { ...current.s3, enabled: true, name: 'Primary', endpoint: first, bucket: 'test-bucket', prefix: '',
    accessKeyId: 'fictional-key', secretAccessKey: 'fictional-secret', billing,
    jsonl: { ...current.s3.jsonl, uploadMiBPerSecond: 64 } };
  return f.push.configure({ ...current, enabled: true, source: 'original', allowPrivateNetwork: first.startsWith('http:'),
    s3, platforms: [{ ...s3, id: 'replica', type: 's3', name: 'Replica', endpoint: second }], ...options });
}
function enqueue(f, destinations = ['s3', 'replica'], filter = {}) {
  const input = { filter, destinations }, preview = f.push.preview(input);
  return f.push.enqueue({ ...input, previewToken: preview.previewToken, batchId: crypto.randomUUID() });
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function publicInput(policy) {
  const value = publicPolicy(policy);
  for (const row of [value.s3, value.webhook, ...value.platforms]) {
    delete row.credentialsConfigured; delete row.sessionTokenConfigured; delete row.tokenConfigured;
  }
  return value;
}
function usage(f, id, extra = {}) {
  return f.push.billing.record({ id, platformId: 's3', model: 'gpt-6.2-sol', bytes: 10 ** 12,
    deliveryId: id, sha256: sha(id), logDate: '2026-11-20', ...extra });
}
function priceAll(f, input = {}) {
  f.push.pricing.request(input);
  let batches = 0;
  while (f.push.pricing.pending()) {
    assert(++batches < 100); f.push.pricing.step(); f.advance();
  }
  return f.push.pricing.status();
}

test('platform policy preserves legacy identities, credentials and omitted targets; prices are validated and versioned independently', t => {
  const f = setup(t); configure(f);
  const policy = f.push.policy(), hash = targetHash(policy, 's3');
  assert.equal(policy.s3.billing.rates.length, 9);
  assert.equal(policy.platforms[0].billing.version, 1);
  const safe = publicPolicy(policy), serialized = JSON.stringify(safe);
  assert(!serialized.includes('fictional-key')); assert(!serialized.includes('fictional-secret'));
  assert(safe.platforms[0].credentialsConfigured);
  const input = publicInput(policy); input.s3.billing.rates.push({ model: 'custom/model', price: '0.2500' });
  const updated = f.push.configure(input);
  assert.equal(updated.s3.billing.version, policy.s3.billing.version + 1);
  assert.equal(updated.platforms[0].billing.version, 1);
  assert.equal(updated.s3.billing.rates.find(row => row.model === 'custom/model').price, '0.25');
  assert.equal(targetHash(f.push.policy(), 's3'), hash);
  const oldClient = publicInput(f.push.policy()); delete oldClient.platforms;
  f.push.configure(oldClient);
  assert.equal(f.push.policy().platforms[0].secretAccessKey, 'fictional-secret');
  assert.equal(f.push.policy().platforms[0].billing.version, 1);
  for (const price of ['-1', '1e5', 'NaN', '1.00001', '1000000000']) {
    const input = publicInput(f.push.policy()); input.s3.billing.rates = [{ model: 'custom', price }];
    assert.throws(() => f.push.configure(input), { code: 'CONVERSATION_PUSH_INVALID' });
  }
  const duplicate = publicInput(f.push.policy()); duplicate.platforms[0].id = 's3';
  assert.throws(() => f.push.configure(duplicate));
  duplicate.platforms[0].id = 'replica'; duplicate.s3.billing.rates = [{ model: 'same', price: '0' }, { model: ' same ', price: '1' }];
  assert.throws(() => f.push.configure(duplicate));
});

test('two S3 platforms upload independent exact JSONL files and retain accounting after whole-batch cleanup', async t => {
  const a = await s3Receiver(), b = await s3Receiver(); t.after(() => a.close()); t.after(() => b.close());
  const f = setup(t); configure(f, a.url, b.url, { deleteAfterPush: true });
  const rows = ['gpt-6.2-sol', 'fable-5-2'].map((model, i) => event('multi-' + i, { model }));
  for (const row of rows) f.store.ingest(row);
  enqueue(f); await f.service.jsonl.tick();
  assert.equal(f.push.billing.report().summary.files, 1);
  assert.equal(f.push.cleanup.step().deleted, false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_records').get().n, 2);
  for (let i = 0; i < 3; i++) await f.service.jsonl.tick();
  const report = f.push.billing.report(); assert.equal(report.summary.files, 4);
  assert.equal(report.summary.bytes, [...a.completed, ...b.completed].reduce((sum, row) => sum + row.body.length, 0));
  assert.equal(a.completed.length, 2); assert.equal(b.completed.length, 2);
  for (const row of report.items) {
    const receiver = row.platform_id === 's3' ? a : b;
    const received = receiver.completed.find(item => item.path.endsWith(row.object_key));
    assert(received); assert.equal(row.bytes, received.body.length); assert.equal(row.sha256, sha(received.body));
    assert.equal(row.terabytes, '0.' + String(row.bytes).padStart(12, '0'));
    assert.equal(row.rate, row.model === 'gpt-6.2-sol' ? '40000' : '100000');
    assert.deepEqual(Object.keys(JSON.parse(received.body.toString().trim())), ['request_id', 'request', 'response']);
  }
  f.advance(); assert(f.push.cleanup.step().deleted); assert(f.push.cleanup.step().deleted);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cl_records').get().n, 0);
  assert.deepEqual(f.push.billing.report(), report);
  const reopened = new ConversationPushStore(f.store).initialize(); new ConversationJsonlStore(reopened).initialize();
  assert.deepEqual(reopened.billing.report(), report);
});

test('failed Complete never bills or cleans; disabling the target still permits retry and bills once', async t => {
  let reject = true;
  const a = await s3Receiver(), b = await s3Receiver({ beforeRequest(entry, res) {
    if (reject && entry.method === 'POST' && entry.query.has('uploadId')) {
      res.writeHead(403, { 'content-type': 'application/xml' }); res.end('<Error><Code>AccessDenied</Code></Error>'); return false;
    }
  } }); t.after(() => a.close()); t.after(() => b.close());
  const f = setup(t); configure(f, a.url, b.url, { deleteAfterPush: true });
  f.store.ingest(event('complete-failure', { model: 'gpt-6.2-sol' })); enqueue(f);
  await f.service.jsonl.tick(); await f.service.jsonl.tick();
  const file = f.jsonl.list().files.find(row => row.status === 'failed'); assert(file);
  assert.equal(file.destination, 'replica'); assert.equal(f.push.billing.report().summary.files, 1);
  assert.equal(f.push.cleanup.step().deleted, false);
  assert.throws(() => f.push.configure({ ...f.push.policy(), platforms: [] }), { code: 'CONVERSATION_PUSH_PLATFORM_BUSY' });
  const policy = f.push.policy(); policy.platforms[0].enabled = false; f.push.configure(policy);
  const confirmed = f.jsonl.parts(f.jsonl.get(file.id)); assert(confirmed.length);
  const puts = b.requests.filter(row => row.method === 'PUT').length;
  reject = false; f.jsonl.retry(file.id); await f.service.jsonl.tick();
  assert.equal(b.requests.filter(row => row.method === 'PUT').length, puts);
  assert.equal(a.completed.length, 1); assert.equal(b.completed.length, 1);
  assert.equal(f.push.billing.report().summary.files, 2);
  assert.equal(f.push.billing.recordFile(f.jsonl.get(file.id)), 0);
  assert.equal(f.push.billing.backfill(), 0);
  f.advance(); assert(f.push.cleanup.step().deleted);
});

test('identical endpoints still create separate open files and survive schema reopen', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close());
  const f = setup(t); configure(f, receiver.url, receiver.url, { automatic: true });
  f.store.ingest(event('same-target', { model: 'gpt-6.2-sol' })); assert.equal(f.push.scanAutomatic().created, 2);
  assert(f.jsonl.assignOne()); assert(f.jsonl.assignOne());
  const files = f.jsonl.list().files; assert.equal(files.length, 2); assert(files.every(row => row.status === 'open'));
  assert.notEqual(files[0].object_key, files[1].object_key);
  const reopened = new ConversationPushStore(f.store).initialize(), jsonl = new ConversationJsonlStore(reopened).initialize();
  assert.equal(jsonl.list().files.length, 2);
  f.jsonl.flush(); await f.service.jsonl.tick(); await f.service.jsonl.tick();
  assert.equal(receiver.completed.length, 2); assert.equal(f.push.billing.report().summary.files, 2);
  assert.deepEqual(receiver.completed[0].body, receiver.completed[1].body);
});

test('automatic fanout excludes disabled platforms for new data while existing jobs remain valid', t => {
  const f = setup(t); configure(f, undefined, undefined, { automatic: true });
  f.store.ingest(event('before-disable')); assert.equal(f.push.scanAutomatic().created, 2);
  const policy = f.push.policy(); policy.platforms[0].enabled = false; f.push.configure(policy);
  const old = f.push.db.prepare("SELECT * FROM cl_push_jobs WHERE destination='replica'").get();
  assert(!f.push.validJob(old).paused); assert(!f.push.validJob(old).cancel);
  f.store.ingest(event('after-disable')); assert.equal(f.push.scanAutomatic().created, 1);
  assert.equal(f.push.db.prepare("SELECT COUNT(*) n FROM cl_push_jobs WHERE destination='replica'").get().n, 1);
  assert.throws(() => f.push.preview({ filter: {}, destinations: ['replica'] }));
});

test('removing a completed platform preserves its fees and lets the remaining batch finish cleanup', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t); configure(f, receiver.url);
  const policy = f.push.policy(); policy.s3.format = 'json'; policy.platforms[0].format = 'json'; policy.deleteAfterPush = true; f.push.configure(policy);
  f.store.ingest(event('removed-complete', { model: 'gpt-6.2-sol' })); enqueue(f);
  f.push.db.prepare("UPDATE cl_push_jobs SET next_at=? WHERE destination='s3'").run(Date.now() + 60000);
  await f.service.tick(); assert.equal(f.push.list({ status: 'sent' }).items[0].destination, 'replica');
  assert.equal(f.push.cleanup.step().deleted, false);
  f.push.configure({ ...f.push.policy(), platforms: [] });
  f.push.db.prepare("UPDATE cl_push_jobs SET next_at=0 WHERE destination='s3'").run(); await f.service.tick();
  f.advance(); assert(f.push.cleanup.step().deleted);
  assert.equal(f.push.billing.report({ platform: 'replica' }).summary.files, 1);
  assert.equal(f.push.billing.report().summary.files, 2);
});

test('JSON and Webhook count exact serialized successful payload bytes with separate platform rates', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t);
  configure(f, receiver.url, receiver.url);
  const policy = f.push.policy(); policy.s3.format = 'json'; policy.platforms[0].format = 'json';
  policy.platforms[0].billing.rates = [{ model: 'custom', price: '80000' }];
  policy.s3.billing.rates = [{ model: 'custom', price: '40000' }];
  policy.platforms.push({ id: 'callback', type: 'webhook', name: 'Callback', enabled: true, url: receiver.url + '/logs',
    billing: { enabled: true, rates: [{ model: 'custom', price: '0' }] } }); f.push.configure(policy);
  f.store.ingest(event('three-json', { model: 'custom' })); enqueue(f, ['s3', 'replica', 'callback']);
  for (let i = 0; i < 3; i++) await f.service.tick();
  const report = f.push.billing.report(); assert.equal(report.summary.files, 3); assert.equal(report.summary.pricedFiles, 3);
  const bytes = receiver.completed[0].body.length; assert(report.items.every(row => row.bytes === bytes));
  assert.equal(report.summary.bytes, bytes * 3);
  assert.equal(report.items.find(row => row.platform_id === 'callback').amount, '0.000000');
  assert.equal(report.items.find(row => row.platform_id === 'replica').rate, '80000');
  await f.service.test('callback'); assert.equal(f.push.billing.report().summary.files, 3);
});

test('integer billing uses decimal TB, free prices and micro-CNY rounding without float drift', () => {
  assert.equal(amountMicros(10 ** 12, '40000'), 40000000000n);
  assert.equal(amountMicros(500000000000, '80000'), 40000000000n);
  assert.equal(amountMicros(10 ** 12, '0.1234'), 123400n);
  assert.equal(amountMicros(1, '40000'), 0n);
  assert.equal(amountMicros(13, '40000'), 1n);
  assert.equal(amountMicros(10 ** 12, '0'), 0n);
});

test('price changes only affect later delivery; pending pricing is explicit, filterable and idempotent', t => {
  const f = setup(t); configure(f); usage(f, 'old'); usage(f, 'old-replica', { platformId: 'replica' });
  const before = f.push.billing.report().items.find(row => row.id === 'old');
  const policy = f.push.policy(); policy.s3.billing.rates = [{ model: 'gpt-6.2-sol', price: '60000' }, { model: 'free', price: '0' }]; f.push.configure(policy);
  usage(f, 'new'); usage(f, 'free', { model: 'free' }); usage(f, 'missing', { model: 'custom' });
  assert.equal(usage(f, 'new'), 0);
  let report = f.push.billing.report(); assert.equal(report.summary.files, 5); assert.equal(report.summary.pendingFiles, 1);
  assert.deepEqual(report.items.find(row => row.id === 'old'), before);
  assert.equal(report.items.find(row => row.id === 'new').amount, '60000.000000');
  assert.equal(report.items.find(row => row.id === 'free').amount, '0.000000');
  assert.equal(priceAll(f).updated, 0);
  const current = f.push.policy(); current.s3.billing.rates.push({ model: 'custom', price: '1.2345' }); f.push.configure(current);
  assert.equal(f.push.billing.report().items.find(row => row.id === 'missing').amount, null);
  assert.equal(priceAll(f, { platform: 'replica' }).updated, 0);
  assert.equal(priceAll(f, { platform: 's3', model: 'custom', start: '2026-11-20', end: '2026-11-20' }).updated, 1);
  report = f.push.billing.report(); assert.equal(report.summary.pendingFiles, 0);
  assert.equal(report.items.find(row => row.id === 'missing').amount, '1.234500');
  assert.deepEqual(report.items.find(row => row.id === 'old'), before); assert.equal(priceAll(f).updated, 0);
  assert.equal(report.summary.amount, '140001.234500');
  assert.equal(f.push.billing.report({ platform: 'replica' }).summary.amount, '40000.000000');
  assert.doesNotThrow(() => JSON.stringify(report));
  assert.throws(() => f.push.billing.report({ start: '2026-11-21', end: '2026-11-20' }));
  assert.throws(() => f.push.billing.report({ platform: "s3' OR 1=1" }));
});

test('automatic pricing skips unpriceable models and completes all batches while preserving historical rates', t => {
  const f = setup(t); configure(f);
  for (let i = 0; i < 520; i++) usage(f, 'unknown-' + i, { model: 'unknown', historical: true });
  for (let i = 0; i < 505; i++) usage(f, 'priceable-' + i, { historical: true });
  assert.equal(priceAll(f, { platform: 's3' }).updated, 505);
  assert.equal(priceAll(f).updated, 0);
  const report = f.push.billing.report(); assert.equal(report.summary.pendingFiles, 520);
  assert.equal(report.summary.amount, '20200000.000000'); assert.equal(report.items.length, 20); assert.equal(report.pages, 52);
  assert.equal(f.push.billing.report({ page: 52 }).items.length, 5);
});

test('verified historical JSONL backfill never invents a past price and rejects incomplete receipts', async t => {
  const receiver = await s3Receiver(); t.after(() => receiver.close()); const f = setup(t); configure(f, receiver.url);
  f.store.ingest(event('backfill', { model: 'gpt-6.2-sol' })); enqueue(f); await f.service.jsonl.tick(); await f.service.jsonl.tick();
  const file = f.jsonl.get(f.jsonl.list().files[0].id); assert.equal(f.push.billing.report().summary.files, 2);
  f.push.db.prepare('DELETE FROM cl_push_storage_usage').run();
  assert.equal(f.push.billing.recordFile({ ...file, uploaded_bytes: file.bytes - 1 }), 0);
  assert.equal(f.push.billing.recordFile({ ...file, http_status: 0 }), 0);
  assert.equal(f.push.billing.recordFile({ ...file, sha256: 'x'.repeat(64) }), 0);
  assert.equal(f.push.billing.backfill(), 2); assert.equal(f.push.billing.backfill(), 0);
  const report = f.push.billing.report(); assert(report.items.every(row => row.amount === null));
  assert.equal(priceAll(f).updated, 2);
});

test('billing endpoints require admin auth and CSRF, reject collectors, and never expose bodies or secrets', async t => {
  const f = setup(t); configure(f); usage(f, 'api');
  const auth = new AuthService(f.config); t.after(() => auth.close());
  const app = createApp({ config: f.config, auth, database: {}, conversations: f.store, conversationPush: f.service,
    messages: f.messages, settings: { getStatus: () => ({ setupRequired: false }) } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/';
  const request = (path, method = 'GET', headers = {}, body) => fetch(base + path, { method,
    headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  for (const headers of [{}, { authorization: 'Bearer ' + f.token }]) {
    assert.equal((await request('conversation-logs/push/billing', 'GET', headers)).status, 401);
    assert.equal((await request('conversation-logs/push/billing/price', 'POST', headers, {})).status, 401);
    assert.equal((await request('conversation-logs/push/billing/price', 'GET', headers)).status, 401);
    assert.equal((await request('conversation-logs/push/billing/price/' + crypto.randomUUID() + '/cancel', 'POST', headers, {})).status, 401);
  }
  const login = await (await request('auth/login', 'POST', {}, { username: 'admin', password: f.config.adminPassword })).json();
  const headers = { authorization: 'Session ' + login.sessionToken };
  assert.equal((await request('conversation-logs/push/billing/price', 'POST', headers, {})).status, 403);
  const response = await request('conversation-logs/push/billing', 'GET', headers), body = await response.text();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert(!body.includes('fictional-secret')); assert(!body.includes('alice@example.com'));
  assert.equal(JSON.parse(body).summary.amount, '40000.000000');
  const submitted = await request('conversation-logs/push/billing/price', 'POST', { ...headers, 'x-csrf-token': login.csrfToken }, {});
  assert.equal(submitted.status, 202); const pricing = await submitted.json(); assert(pricing.job.id);
  const progress = await request('conversation-logs/push/billing/price', 'GET', headers);
  assert.equal(progress.headers.get('cache-control'), 'no-store'); assert.equal((await progress.json()).job.id, pricing.job.id);
  const cancelPath = 'conversation-logs/push/billing/price/' + pricing.job.id + '/cancel';
  assert.equal((await request(cancelPath, 'POST', headers, {})).status, 403);
  assert.equal((await request(cancelPath, 'POST', { ...headers, 'x-csrf-token': login.csrfToken }, {})).status, 200);
  const writer = new Database(f.store.db.pragma('database_list').find(row => row.name === 'main').file);
  writer.exec('BEGIN IMMEDIATE');
  try {
    const began = performance.now();
    const [busy, health] = await Promise.all([
      request('conversation-logs/push/billing/price', 'POST', { ...headers, 'x-csrf-token': login.csrfToken }, {}),
      fetch(base.replace(/api\/$/, 'healthz'))
    ]);
    assert.equal(busy.status, 503); assert.equal(health.status, 200);
    assert(performance.now() - began < 500, 'pricing contention must not block unrelated HTTP requests');
    assert.equal((await busy.json()).error.code, 'CONVERSATION_STORAGE_PRICING_BUSY');
  } finally { writer.exec('ROLLBACK'); writer.close(); }
  const policy = f.push.policy();
  for (const row of [policy.s3, ...policy.platforms]) row.billing.rates = Array.from({ length: 200 }, (_, i) => ({ model: 'custom-' + i + '-'.repeat(145), price: '1.2345' }));
  assert(Buffer.byteLength(JSON.stringify(policy)) > 65536);
  assert.equal((await request('conversation-logs/push/policy', 'PUT', { ...headers, 'x-csrf-token': login.csrfToken }, policy)).status, 200);
});
