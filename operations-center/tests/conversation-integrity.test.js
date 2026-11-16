'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, event } = require('./conversation-logs-fixture');
const { bodyDigest } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');

test('binary-length integrity vector is shared with the Go collector; reordered frames change it', () => {
  const raw = { request: Buffer.from('request\n'), response: Buffer.from([0,255,13,10]), frames: [
    { direction: 'out', at: 12, binary: false, body: Buffer.from('hi') }, { direction: 'in', at: 20, binary: true, body: Buffer.from([0,255]) }
  ] };
  assert.equal(bodyDigest(raw), '3c5432745365d3316265a82af5cf5899adda7fdf53ba8f201d24b4a6d93a1d47');
  assert.notEqual(bodyDigest(raw), bodyDigest({ ...raw, frames: raw.frames.toReversed() }));
});

test('collector v2 verifies bytes before insert and acknowledges idempotent exact copies only', t => {
  const f = fixture(); t.after(() => f.close());
  const row = event('digest', { capture_version: 2 });
  row.body_sha256 = bodyDigest({ request: Buffer.from(row.request,'base64'), response: Buffer.from(row.response,'base64'), frames: [] });
  const expected = { accepted: true, id: row.id, body_sha256: row.body_sha256 };
  assert.equal(f.store.collectorPolicy(4,'2').capture_version, 2); assert.equal(f.store.status().collectorVersion, 2);
  assert.throws(() => f.store.ingest({ ...row, body_sha256: '0'.repeat(64) }), { code: 'CONVERSATION_INTEGRITY_FAILED' });
  assert.equal(f.store.status().records, 0);
  assert.deepEqual(f.store.ingest(row), expected); assert.deepEqual(f.store.ingest(row), { ...expected, duplicate: true });
  assert.equal(f.store.detail(row.id).body_sha256, row.body_sha256);
});

test('legacy retries keep their original fingerprint and saving policies still requires an explicit version', t => {
  const f = fixture(); t.after(() => f.close()); const row = event('legacy-fingerprint'); f.store.ingest(row);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
  f.store.db.prepare('UPDATE cl_records SET fingerprint=? WHERE id=?').run(fingerprint,row.id);
  assert(f.store.ingest(row).duplicate);
  assert.throws(() => f.store.configure({}));
  assert.throws(() => f.store.configure({ ...f.store.policy(), version: undefined }));
});

test('a real SQLite write refusal returns no success acknowledgment and leaves no body or index', t => {
  const f = fixture(); t.after(() => f.close());
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => {
    if (sql.startsWith('INSERT INTO cl_records')) throw Object.assign(new Error('synthetic disk full'), { code: 'SQLITE_FULL' });
    return prepare(sql);
  };
  assert.deepEqual(f.store.ingest(event('write-refused')), { accepted: false, reason: 'storage_failed' });
  assert.equal(f.store.status().records,0); assert.equal(f.store.status().lastError,'storage_failed');
});

test('large complete bodies pass all former per-string, aggregate and HTTP-envelope limits without conversion', async t => {
  const f = fixture(); t.after(() => f.close());
  const p = f.store.configure({ ...f.store.policy(), mode: 'original', maxBodyBytes: 65536 });
  const request = '{\n"model":"example-model", "text":"' + 'r'.repeat(26 * 1024 * 1024) + '","decimal":1.2300}\n';
  const response = 's'.repeat(12 * 1024 * 1024) + '\nEND_OF_FULL_RESPONSE';
  const row = event('large-wire', { policy_version: p.version, capture_version: 2, request: Buffer.from(request).toString('base64'), response: Buffer.from(response).toString('base64') });
  row.body_sha256 = bodyDigest({ request: Buffer.from(request), response: Buffer.from(response), frames: [] });
  const auth = new AuthService(f.config); t.after(() => auth.close());
  const app = createApp({ config: f.config, auth, database: {}, conversations: f.store, messages: f.messages });
  const server = await new Promise(resolve => { const value = app.listen(0,'127.0.0.1',() => resolve(value)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const result = await fetch('http://127.0.0.1:' + server.address().port + '/api/conversation-logs/ingest', {
    method: 'POST', headers: { authorization: 'Bearer ' + f.token, 'content-type': 'application/json' }, body: JSON.stringify(row)
  });
  assert.equal(result.status,200); assert.equal((await result.json()).body_sha256,row.body_sha256);
  assert(f.store.detail(row.id).complete);
  assert.equal(f.store.payload(row.id,'original','request').body.toString(), request);
  assert.equal(f.store.payload(row.id,'original','response').body.toString(), response);
});

test('permanent retention preserves history, capacity refuses a whole new record and never evicts old data', t => {
  let now = Date.now(), free = 100 * 1024 ** 3;
  const f = fixture({ now: () => now, freeBytes: () => free }); t.after(() => f.close());
  const p = f.store.configure({ ...f.store.policy(), retention: 0, reserve: 1, overflow: 'evict' });
  assert.equal(p.overflow,'stop');
  const row = event('history-permanent', { policy_version: p.version }); f.store.ingest(row);
  const before = f.store.db.prepare('SELECT original,masked FROM cl_records WHERE id=?').get(row.id);
  now += 400 * 86400000; assert.equal(f.store.prune(),0);
  free = 2048;
  const next = event('capacity-no-prefix', { policy_version: p.version, at: now });
  assert.deepEqual(f.store.ingest(next), { accepted: false, reason: 'capacity' });
  assert.equal(f.store.status().records,1); assert.equal(f.store.collectorPolicy().enabled,false);
  assert.deepEqual(f.store.db.prepare('SELECT original,masked FROM cl_records WHERE id=?').get(row.id),before);
  free = 100 * 1024 ** 3; assert.equal(f.store.collectorPolicy().enabled,true);
  assert(f.store.ingest(next).accepted);
});

test('partial records and outdated masked copies cannot enter automatic/manual delivery or escape a queued recheck', t => {
  const f = fixture(); t.after(() => f.close());
  const push = new ConversationPushStore(f.store).initialize();
  push.configure({ ...push.policy(), enabled: true, automatic: true, webhook: { enabled: true, url: 'https://receiver.example/logs' } });
  const complete = event('ready'), partial = event('partial', { complete: false, reason: 'read_error' }), stale = event('outdated');
  for (const row of [complete,partial,stale]) f.store.ingest(row);
  f.store.db.prepare('UPDATE cl_records SET redaction_version=0 WHERE id=?').run(stale.id);
  const selected = push.preview({ filter: {}, destinations: ['webhook'] });
  assert.equal(selected.eligible,1); assert.equal(selected.unavailable,2); assert.equal(push.scanAutomatic().created,1);
  f.store.configure({ ...f.store.policy(), identity: false });
  assert.equal(push.claim(),null); assert.equal(push.list().items[0].error_code,'REDACTION_OUTDATED');
  push.configure({ ...push.policy(), source: 'original' });
  assert.equal(push.preview({ filter: {}, destinations: ['webhook'] }).eligible,2);
  assert.equal(push.preview({ filter: { capture: 'partial' }, destinations: ['webhook'] }).eligible,0);
});
