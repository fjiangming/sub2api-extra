'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, event } = require('./conversation-logs-fixture');
const { bodyDigest } = require('../src/conversation-log-store');
const { ConversationPushStore } = require('../src/conversation-push-store');
const { ConversationJsonlStore } = require('../src/conversation-jsonl-store');
const { deliveryBody } = require('../src/services/conversation-envelope');
const { jsonlBytes } = require('../src/services/conversation-jsonl-format');

function setup(t) {
  const f = fixture(); t.after(() => f.close());
  f.store.configure({ ...f.store.policy(), mode: 'original', retention: 0 });
  f.push = new ConversationPushStore(f.store).initialize();
  const policy = f.push.policy();
  f.push.configure({ ...policy, enabled: true, source: 'original', captureScope: 'all', s3: { ...policy.s3, enabled: true,
    endpoint: 'https://storage.example', bucket: 'fictional-planning', accessKeyId: 'fictional-id', secretAccessKey: 'fictional-secret' } });
  f.jsonl = new ConversationJsonlStore(f.push).initialize();
  f.enqueue = row => {
    assert(f.store.ingest({ ...row, policy_version: f.store.policy().version }).accepted);
    const input = { filter: {}, destinations: ['s3'] }, preview = f.push.preview(input);
    f.push.enqueue({ ...input, previewToken: preview.previewToken, batchId: crypto.randomUUID() });
    return f.push.db.prepare('SELECT * FROM cl_push_jobs WHERE record_id=?').get(row.id);
  };
  return f;
}

test('large JSONL planning and replay read each body once using header-only admission and compact metadata', async t => {
  const f = setup(t), text = 'safe example, "quoted"\n'.repeat(100000);
  const row = event('compact-large', { request: Buffer.from(JSON.stringify({ text })).toString('base64') });
  const job = f.enqueue(row), expected = deliveryBody(f.push.delivery(job));
  const prepare = f.push.db.prepare.bind(f.push.db); let payloadReads = 0, headerReads = 0, lateReads = 0;
  f.push.db.prepare = sql => {
    if (/FROM cl_records/.test(sql) && /WHERE (?:r\.)?id=\?/.test(sql)) {
      if (/ AS payload/.test(sql)) payloadReads++;
      else if (/length\(r\.original\)/.test(sql) && /LEFT JOIN cl_record_metadata/.test(sql)) headerReads++;
      else lateReads++;
    }
    return prepare(sql);
  };
  assert(f.jsonl.assignOne()); const file = f.jsonl.get(f.jsonl.list().files[0].id), output = [];
  for await (const envelope of f.jsonl.envelopes(file, () => {})) output.push(deliveryBody(envelope));
  assert.deepEqual(output, [expected]); assert.equal(file.bytes, jsonlBytes(expected));
  assert.equal(payloadReads, 2); assert.equal(headerReads, 2); assert.equal(lateReads, 0);
  assert.equal(output[0].request, Buffer.from(row.request, 'base64').toString());
});

for (const version of [1,2,3,4]) test(`compact JSONL preparation preserves v${version} output and archived transport diagnostics`, t => {
  const f = setup(t), row = event('compact-version-' + version, { capture_version: 2, complete: false, reason: 'read_error', protocol: 'SSE',
    response: Buffer.from('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n').toString('base64') });
  row.body_sha256 = bodyDigest({ request: Buffer.from(row.request, 'base64'), response: Buffer.from(row.response, 'base64'), frames: [] });
  row.transport_diagnostics = { version: 1, request: { bytes: Buffer.from(row.request, 'base64').length, expected_bytes: -1, eof: true, error: '', error_during_close: false },
    response: { bytes: Buffer.from(row.response, 'base64').length, expected_bytes: -1, eof: false, error: 'cancelled', error_during_close: true } };
  const job = { ...f.enqueue(row), envelope_version: version }, expected = f.push.delivery(job), compact = f.push.delivery(job, undefined, undefined, { compactMetadata: true });
  assert.deepEqual(deliveryBody(compact), deliveryBody(expected));
  if (version <= 2) assert.deepEqual(compact.metadata.transport_diagnostics, row.transport_diagnostics);
  assert.deepEqual(f.store.detail(row.id).transport_diagnostics, row.transport_diagnostics);
  assert.equal(f.store.detail(row.id).reason, 'read_error');
});

test('compact preparation falls back safely when a legacy metadata row is not prepared and still enforces memory and exclusions', t => {
  const f = setup(t), row = event('compact-missing'), job = f.enqueue(row);
  const expected = deliveryBody(f.push.delivery(job));
  f.push.db.prepare('DELETE FROM cl_record_metadata WHERE id=?').run(row.id);
  assert.deepEqual(deliveryBody(f.push.delivery(job, undefined, undefined, { compactMetadata: true })), expected);
  assert.throws(() => f.push.delivery(job, undefined, () => 0, { compactMetadata: true }), { code: 'EXPORT_MEMORY' });
  f.store.configure({ ...f.store.policy(), excludedUserIds: [2] });
  assert.throws(() => f.push.delivery(job, undefined, undefined, { compactMetadata: true }), { code: 'CONVERSATION_PUSH_COPY_UNAVAILABLE' });
});

test('pending JSONL selection uses the ordered partial index without sorting the whole backlog or changing due order', t => {
  const f = setup(t), row = event('ordered-planning'), job = f.enqueue(row), at = f.push.now();
  const clone = f.push.db.prepare(`INSERT INTO cl_push_jobs(id,record_id,destination,target_hash,source,content_version,batch_id,status,next_at,created_at,updated_at,envelope_version)
    VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?)`);
  f.push.db.transaction(() => {
    for (let index = 0; index < 2000; index++) clone.run('future-' + index, job.record_id, index % 2 ? 's3' : 'replica', job.target_hash,
      job.source, job.content_version, job.batch_id, at + 3600000, at - 5000 + index, at, job.envelope_version);
    clone.run('eligible-old', job.record_id, 's3', job.target_hash, job.source, job.content_version, job.batch_id, at, job.created_at - 1, at, job.envelope_version);
  }).immediate();
  const prepare = f.push.db.prepare.bind(f.push.db); let plan;
  f.push.db.prepare = sql => {
    if (/ORDER BY created_at,id LIMIT 1/.test(sql)) plan = prepare('EXPLAIN QUERY PLAN ' + sql).all('s3', f.push.now());
    return prepare(sql);
  };
  assert(f.jsonl.assignOne());
  assert.equal(f.push.db.prepare('SELECT status FROM cl_push_jobs WHERE id=?').get('eligible-old').status, 'buffered');
  assert.equal(f.push.db.prepare('SELECT status FROM cl_push_jobs WHERE id=?').get(job.id).status, 'pending');
  assert(plan.some(row => row.detail.includes('cl_push_jsonl_pending'))); assert(!plan.some(row => /TEMP B-TREE/i.test(row.detail)));
  assert.equal(f.push.db.prepare("SELECT COUNT(*) n FROM cl_push_jobs WHERE id LIKE 'future-%' AND status='pending'").get().n, 2000);
});
