'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../src/store');
const { fixture, config, USER } = require('./fixtures');

function seed(store, { amount = 1000, recharge = 5000, status = 'paid', user = USER } = {}) {
  const batch = store.reserve(user,crypto.randomUUID(),1,500000);
  const id = batch.rewards[0].id;
  store.db.prepare('UPDATE rewards SET amount_minor=?,status=? WHERE id=?').run(amount,status,id);
  store.db.prepare('UPDATE batches SET recharge_minor=? WHERE id=?').run(recharge,batch.id);
  return { id,batchId: batch.id };
}

function snapshot(store) {
  return ['campaign','accounts','batches','rewards','retry_audit'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test('audit checks all three prize thresholds exactly, counts every status and never mutates rewards', t => {
  const f = fixture(t);
  const checks = [];
  for (const [amount,minimum,status] of [[1000,100000,'paid'],[2000,200000,'pending'],[5000,500000,'failed']]) {
    for (const delta of [-1,0,1]) checks.push({ ...seed(f.store,{ amount,recharge: minimum+delta,status }),minimum,delta });
  }
  const before = snapshot(f.store);
  f.source.error = new Error('current recharge must not be consulted for historical eligibility');
  for (const row of checks) {
    assert.deepEqual(f.store.detail(row.id).audit,{ status: row.delta < 0 ? 'violation' : 'passed',requiredMinor: row.minimum,rechargeMinor: row.minimum+row.delta });
  }
  assert.deepEqual(f.store.auditSummary(),{ totalCount: 9,passedCount: 6,violationCount: 3,violationUsers: 1,violationMinor: 8000,violationPaidMinor: 1000,unverifiableCount: 0 });
  assert.equal(f.store.list({ audit: 'violation',status: 'failed' }).total,1);
  assert.equal(f.store.list({ audit: 'passed' }).total,6);
  assert.deepEqual(snapshot(f.store),before);
});

test('audit separates invalid, missing and mismatched recharge snapshots from actual violations', t => {
  const f = fixture(t);
  const ids = [-1,1.5,'invalid',Number.MAX_SAFE_INTEGER+1].map(recharge => seed(f.store,{ recharge }).id);
  const mismatch = seed(f.store,{ recharge: 500000 });
  f.store.db.prepare('UPDATE batches SET user_id=? WHERE id=?').run('99',mismatch.batchId); ids.push(mismatch.id);
  const missing = seed(f.store,{ recharge: 500000 });
  f.store.db.pragma('foreign_keys=OFF');
  f.store.db.prepare('DELETE FROM batches WHERE id=?').run(missing.batchId);
  f.store.db.pragma('foreign_keys=ON'); ids.push(missing.id);
  for (const id of ids) assert.deepEqual(f.store.detail(id).audit,{ status: 'unverifiable',requiredMinor: 100000,rechargeMinor: null });
  const before = snapshot(f.store);
  const summary = f.store.auditSummary();
  assert.equal(summary.unverifiableCount,6); assert.equal(summary.violationCount,0); assert.equal(summary.passedCount,0);
  assert.equal(f.store.list({ audit: 'unverifiable' }).total,6);
  assert.deepEqual(snapshot(f.store),before);
});

test('audit summaries cover all users and pages independently of ledger filters', t => {
  const f = fixture(t);
  seed(f.store,{ status: 'paid' });
  seed(f.store,{ amount: 2000,status: 'pending',user: { ...USER,id: '99',email: 'other@example.test' } });
  seed(f.store,{ amount: 5000,status: 'failed' });
  seed(f.store,{ recharge: 100000,status: 'paid' });
  seed(f.store,{ amount: 50,recharge: 5000 });
  const pages = [1,2,3].map(page => f.store.list({ audit: 'violation',page,pageSize: 1 }));
  assert.ok(pages.every(page => page.total === 3 && page.rows.length === 1));
  assert.equal(new Set(pages.flatMap(page => page.rows.map(row => row.id))).size,3);
  assert.equal(f.store.list({ audit: 'violation',query: 'other@example.test' }).total,1);
  assert.equal(f.store.list({ audit: 'violation',from: '2026-11-17' }).total,0);
  assert.equal(f.store.list({ audit: 'not_required' }).total,1);
  assert.deepEqual(f.store.auditSummary(),{ totalCount: 4,passedCount: 1,violationCount: 3,violationUsers: 2,violationMinor: 8000,violationPaidMinor: 1000,unverifiableCount: 0 });
  const personal = JSON.stringify(f.store.list({ userId: USER.id }));
  assert.doesNotMatch(personal,/audit|requiredMinor|rechargeMinor|100000/);
});

test('historical audit survives restart with the original cutoff, chances and immutable records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'activity-audit-'));
  const filename = path.join(directory,'test.sqlite');
  let store;
  try {
    store = new Store(config(),{ filename,now: () => Date.parse('2026-11-01T00:00:00Z'),rng: () => 0 });
    const violation = seed(store), passed = seed(store,{ amount: 5000,recharge: 500000 });
    const before = snapshot(store), summary = store.auditSummary();
    store.close();
    store = new Store(config(),{ filename,now: () => Date.parse('2026-11-17T00:00:00Z') });
    assert.deepEqual(store.auditSummary(),summary);
    assert.equal(store.detail(violation.id).audit.status,'violation');
    assert.equal(store.detail(passed.id).audit.status,'passed');
    assert.equal(store.used(USER.id),2);
    assert.equal(store.campaign.start_at,'2026-11-01T00:00:00.000Z');
    assert.deepEqual(snapshot(store),before);
  } finally { store?.close(); fs.rmSync(directory,{ recursive: true,force: true }); }
});

test('empty audit and prizes without a recharge threshold are not false positives', t => {
  const f = fixture(t);
  assert.deepEqual(f.store.auditSummary(),{ totalCount: 0,passedCount: 0,violationCount: 0,violationUsers: 0,violationMinor: 0,violationPaidMinor: 0,unverifiableCount: 0 });
  for (const amount of [50,100,200,300,500]) {
    const row = seed(f.store,{ amount,recharge: 5000 });
    assert.deepEqual(f.store.detail(row.id).audit,{ status: 'not_required',requiredMinor: 0,rechargeMinor: 5000 });
  }
  assert.equal(f.store.auditSummary().totalCount,0);
  assert.equal(f.store.list({ audit: 'not_required' }).total,5);
});
