'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { setTimeout: delay } = require('node:timers/promises');
const { fixture, event } = require('./conversation-logs-fixture');
const { ConversationLogStore, bodyDigest } = require('../src/conversation-log-store');
const { ConversationArchiveService } = require('../src/services/conversation-archive-service');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');

async function waitFor(check, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!check()) { assert(Date.now() < deadline, 'archive worker did not settle'); await delay(10); }
}

async function setup(t, options) {
  const f = fixture(), auth = new AuthService(f.config), archive = new ConversationArchiveService(f.store, options);
  const app = createApp({ config: f.config, database: {}, auth, conversations: f.store, conversationArchive: archive, messages: f.messages });
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await archive.stop(); auth.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); f.close(); });
  await archive.start();
  return { ...f, archive, base: 'http://127.0.0.1:' + server.address().port,
    headers: { authorization: 'Bearer ' + f.token, 'content-type': 'application/json' } };
}

test('isolated archive worker preserves v2 bytes, encrypted fallback and authenticated reprocessing', async t => {
  const f = await setup(t), row = event('worker-exact', { capture_version: 2 });
  row.body_sha256 = bodyDigest({ request: Buffer.from(row.request, 'base64'), response: Buffer.from(row.response, 'base64'), frames: [] });
  const result = await fetch(f.base + '/api/conversation-logs/ingest', { method: 'POST', headers: f.headers, body: JSON.stringify(row) });
  assert.equal(result.status, 200); assert.equal((await result.json()).body_sha256, row.body_sha256);
  assert.equal(f.store.payload(row.id, 'original', 'request').body.toString('base64'), row.request);
  assert(!f.store.payload(row.id, 'masked', 'request').text.includes('alice@example.com'));
  await waitFor(() => !f.archive.busy);
  const bad = event('worker-retry', { response: Buffer.from('{invalid').toString('base64') });
  const failure = await fetch(f.base + '/api/conversation-logs/ingest', { method: 'POST', headers: f.headers, body: JSON.stringify(bad) });
  assert((await failure.json()).accepted); await waitFor(() => !f.archive.busy);
  assert.equal(f.store.detail(bad.id).processing_error, 'INVALID_JSON');
  const login = await fetch(f.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: f.config.adminPassword }) });
  const session = await login.json(), previous = f.store.detail(bad.id);
  const path = f.base + '/api/conversation-logs/records/' + bad.id + '/reprocess';
  const body = JSON.stringify({ policy_version: f.store.policy().version, processed_at: previous.processed_at });
  const denied = await fetch(path, { method: 'POST', headers: f.headers, body }); assert.equal(denied.status, 401);
  const retried = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Session ' + session.sessionToken, 'x-csrf-token': session.csrfToken }, body });
  assert.equal(retried.status, 200); const saved = await retried.json();
  assert(saved.processed_at > previous.processed_at); assert.equal(saved.processing_error, 'INVALID_JSON'); assert(saved.original);
});

test('slow archive input and a busy processor do not hold health or collector policy; worker death loses no partial record', async t => {
  const f = await setup(t);
  const request = http.request(f.base + '/api/conversation-logs/ingest', { method: 'POST', headers: { ...f.headers, 'content-length': 100000 } });
  const finished = new Promise(resolve => { request.on('error', resolve); request.on('response', response => { response.resume(); response.on('end', resolve); }); });
  request.write('{'); await waitFor(() => Boolean(f.archive.busy));
  const start = performance.now();
  const policy = await fetch(f.base + '/api/conversation-logs/collector-policy', { headers: f.headers });
  assert.equal(policy.status, 200); assert((await policy.json()).enabled);
  const health = await fetch(f.base + '/healthz'); assert.equal(health.status, 200); await health.text();
  const busy = await fetch(f.base + '/api/conversation-logs/ingest', { method: 'POST', headers: f.headers, body: JSON.stringify(event('busy')) });
  assert.equal(busy.status, 503); assert.equal((await busy.json()).reason, 'processor_busy');
  assert(performance.now() - start < 1000, 'light endpoints should not wait for the incomplete archive body');
  const old = f.archive.child; old.kill('SIGKILL'); await finished; request.destroy();
  assert.equal(f.store.status().records, 0);
  await waitFor(() => f.archive.port && f.archive.child !== old);
  const recovered = await fetch(f.base + '/api/conversation-logs/ingest', { method: 'POST', headers: f.headers, body: JSON.stringify(event('recovered')) });
  assert.equal(recovered.status, 200); assert((await recovered.json()).accepted);
});

test('processor memory admission refuses the whole archive without a synchronous API fallback', async t => {
  const f = await setup(t, { memoryBudgetBytes: 0 });
  const result = await fetch(f.base + '/api/conversation-logs/ingest', { method: 'POST', headers: f.headers, body: JSON.stringify(event('memory-refusal')) });
  assert.equal(result.status, 503); assert.equal((await result.json()).reason, 'processor_memory');
  assert.equal(f.store.status().records, 0);
  await waitFor(() => f.store.lastError === 'processor_memory');
  await f.archive.stop();
  const unavailable = await fetch(f.base + '/api/conversation-logs/ingest', { method: 'POST', headers: f.headers, body: JSON.stringify(event('unavailable')) });
  assert.equal(unavailable.status, 503); assert.equal(f.store.status().records, 0);
});

test('a stuck archive is killed by its background deadline without holding the API event loop', async t => {
  const f = await setup(t, { timeoutMs: 150 });
  const request = http.request(f.base + '/api/conversation-logs/ingest', { method: 'POST', headers: { ...f.headers, 'content-length': 100000 } });
  const finished = new Promise(resolve => { request.on('error', resolve); request.on('response', response => { response.resume(); response.on('end', resolve); }); });
  request.write('{'); await finished; request.destroy();
  await waitFor(() => !f.archive.child);
  assert.equal(f.store.status().records, 0); assert.equal(f.store.lastError, 'processor_failed');
});

for (const change of ['excludedUserIds', 'modelFilterEnabled', 'enabled']) test('a concurrent policy change wins final ingestion: ' + change, t => {
  const f = fixture(); const other = new ConversationLogStore(f.directory).initialize();
  t.after(() => { other.close(); f.close(); });
  f.store.processingLimits = () => {
    other.configure({ ...other.policy(), [change]: change === 'excludedUserIds' ? [2] : change === 'enabled' ? false : true, ...(change === 'modelFilterEnabled' ? { allowedModels: [] } : {}) });
    return {};
  };
  assert.deepEqual(f.store.ingest(event('policy-during-mask')), { accepted: false });
  assert.equal(f.store.status().records, 0);
});

test('reprocessing does not hold the policy write lock and a late exclusion preserves the old encrypted source', t => {
  const f = fixture(); const other = new ConversationLogStore(f.directory).initialize();
  t.after(() => { other.close(); f.close(); });
  const row = event('retry-race'); f.store.ingest(row);
  f.store.db.prepare('UPDATE cl_records SET redaction_version=0 WHERE id=?').run(row.id);
  const previous = f.store.db.prepare('SELECT original,masked,processed_at FROM cl_records WHERE id=?').get(row.id);
  const version = f.store.policy().version;
  f.store.processingLimits = () => { other.configure({ ...other.policy(), excludedUserIds: [2] }); return {}; };
  assert.throws(() => f.store.retry(row.id, { policy_version: version, processed_at: previous.processed_at }), { code: 'CONVERSATION_USER_EXCLUDED' });
  assert.deepEqual(f.store.db.prepare('SELECT original,masked,processed_at FROM cl_records WHERE id=?').get(row.id), previous);
});

test('processing memory limits retain exact source and report the failure without a partial masked copy', t => {
  const f = fixture({ processingLimits: () => ({ maxOutputBytes: 128 }) }); t.after(() => f.close());
  const raw = Buffer.from(JSON.stringify({ text: 'x'.repeat(8192) })), compressed = zlib.gzipSync(raw);
  const row = event('decode-budget', { request: Buffer.from('{}').toString('base64'), response: compressed.toString('base64'), encoding: 'gzip' });
  assert(f.store.ingest(row).accepted); const saved = f.store.detail(row.id);
  assert(saved.processing_error); assert(saved.original); assert(!saved.masked);
  assert.deepEqual(f.store.payload(row.id, 'original', 'response').body, compressed);
});

test('retention cleanup serializes policy changes and a committed permanent-retention policy preserves all history', t => {
  let now = Date.now(); const f = fixture({ now: () => now });
  const other = new ConversationLogStore(f.directory, { now: () => now }).initialize();
  t.after(() => { other.close(); f.close(); }); other.db.pragma('busy_timeout = 1');
  const policy = f.store.configure({ ...f.store.policy(), retention: 1 });
  f.store.ingest(event('expiring', { at: now, policy_version: policy.version })); now += 2 * 86400000;
  const prepare = f.store.db.prepare.bind(f.store.db); let protectedDelete = false;
  f.store.db.prepare = sql => {
    if (sql.startsWith('DELETE FROM cl_records')) {
      assert.throws(() => other.configure({ ...other.policy(), retention: 0 }), error => error.code.startsWith('SQLITE_BUSY'));
      protectedDelete = true;
    }
    return prepare(sql);
  };
  assert.equal(f.store.prune(), 1); assert(protectedDelete);
  const permanent = other.configure({ ...other.policy(), retention: 0 });
  const row = event('permanent-after-cleanup', { at: now, policy_version: permanent.version });
  assert(f.store.ingest(row).accepted); now += 400 * 86400000;
  assert.equal(f.store.prune(), 0); assert.equal(f.store.status().records, 1);
});
