'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture,event } = require('./conversation-logs-fixture');
const { ConversationLogStore } = require('../src/conversation-log-store');
const { ConversationRepairStore } = require('../src/conversation-repair-store');

function history(f) {
  const row = event('analysis-race',{policy_version:f.store.policy().version,protocol:'SSE',complete:false,reason:'read_error',
    response:Buffer.from('data: {"type":"response.completed","response":{"object":"response","status":"completed","output":[]}}\n\n').toString('base64')});
  f.store.ingest(row);f.store.db.prepare("UPDATE cl_records SET completion_version=0,upstream_status='unknown',completion_source='',archived_at=0 WHERE id=?").run(row.id);
  return row;
}

test('cancellation during masked-only analysis rolls back derived evidence and progress', t => {
  const f = fixture();t.after(() => f.close());f.store.configure({...f.store.policy(),mode:'masked'});
  const row = history(f),store = new ConversationRepairStore(f.store).initialize(),job = store.request({policy_version:f.store.policy().version});
  const before = f.store.db.prepare('SELECT masked,complete,reason,processed_at FROM cl_records WHERE id=?').get(row.id);
  f.store.processingLimits = () => {store.cancel(job.id);return {};};store.step();
  assert.equal(store.latest().status,'cancelled');assert.equal(store.latest().analyzed,0);assert.equal(f.store.detail(row.id).completion_version,0);
  assert.deepEqual(f.store.db.prepare('SELECT masked,complete,reason,processed_at FROM cl_records WHERE id=?').get(row.id),before);
});

test('busy history writes roll back data and counters and resume after the writer yields', t => {
  const f = fixture(),other = new ConversationLogStore(f.directory).initialize();t.after(() => {other.close();f.close();});f.store.db.pragma('busy_timeout = 1');
  const row = history(f);f.store.db.prepare('UPDATE cl_records SET redaction_version=3 WHERE id=?').run(row.id);
  const store = new ConversationRepairStore(f.store).initialize();store.request({policy_version:f.store.policy().version});
  const before = f.store.db.prepare('SELECT original,masked,complete,reason,processed_at FROM cl_records WHERE id=?').get(row.id);
  f.store.processingLimits = () => {other.db.exec('BEGIN IMMEDIATE');return {};};
  assert.throws(() => store.step(),error => error.code.startsWith('SQLITE_BUSY'));other.db.exec('ROLLBACK');
  assert.equal(store.latest().scanned,0);assert.deepEqual(f.store.db.prepare('SELECT original,masked,complete,reason,processed_at FROM cl_records WHERE id=?').get(row.id),before);
  f.store.processingLimits = () => ({});store.step();assert.equal(store.latest().repaired,1);assert.equal(f.store.detail(row.id).upstream_status,'completed');
});
