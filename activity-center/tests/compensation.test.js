'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, USER } = require('./fixtures');

const profile = f => f.store.compensationProfiles().find(item => item.status === 'enabled');
const starts = f => new Date(f.now()).toISOString();
const weights = amount => [50,100,200,300,500,1000,2000,5000].map(value => ({ amountMinor: value, weight: value === amount ? 10000 : 0 }));

test('selected compensation grants are shared by multiple users and consumed before recharge chances', async t => {
  const f = fixture(t); const standard = profile(f);
  const grant = f.store.createCompensationGrant({ audience: 'selected',userIds: ['42','99','42'],chanceCount: 1,profileId: standard.id,startsAt: starts(f),reason: '服务波动补偿' },'1');
  assert.equal(grant.selectedUsers,2); assert.equal(f.store.compensationAvailable(USER.id),1); assert.equal(f.store.compensationAvailable('99'),1);
  f.source.value = 50000;
  const batch = await f.lottery.draw(USER,crypto.randomUUID(),10);
  assert.equal(f.source.calls,1); assert.equal(batch.rewards.length,10); assert.ok(batch.rewards.every(row => row.amountMinor === 50));
  const rows = f.store.db.prepare('SELECT chance_source,grant_id FROM rewards WHERE batch_id=? ORDER BY sequence').all(batch.id);
  assert.equal(rows[0].chance_source,'compensation'); assert.equal(rows[0].grant_id,grant.id); assert.equal(rows[1].chance_source,'recharge'); assert.equal(rows[1].grant_id,null);
  assert.equal(f.store.used(USER.id),9); assert.equal(f.store.compensationAvailable(USER.id),0); assert.equal(f.store.summary(USER.id,50000).available,1);
  await f.lottery.kick(); assert.equal(f.store.detail(batch.rewards[0].id).chanceSource,'compensation');
});

test('all-user compensation grants do not require recharge history for a covered draw', async t => {
  const f = fixture(t); const standard = profile(f);
  f.source.error = new Error('recharge database unavailable');
  const grant = f.store.createCompensationGrant({ audience: 'all',chanceCount: 2,profileId: standard.id,startsAt: starts(f),reason: '系统维护补偿' },'1');
  assert.equal(f.store.compensationAvailable(USER.id),2);
  assert.equal((await f.lottery.summary(USER.id)).available,2);
  const first = await f.lottery.draw(USER,crypto.randomUUID(),1); const second = await f.lottery.draw(USER,crypto.randomUUID(),1);
  assert.equal(f.source.calls,1); assert.equal(f.store.used(USER.id),0); assert.equal(f.store.compensationAvailable(USER.id),0);
  assert.ok(first.rewards.every(row => row.amountMinor === 50)); assert.ok(second.rewards.every(row => row.amountMinor === 50));
  await f.lottery.kick(); assert.equal(f.store.compensationSummary().usedChances,2); assert.equal(f.store.compensationGrant(grant.id).usedUsers,1);
});

test('compensation profiles use their own probabilities and never trigger threshold audit', async t => {
  const f = fixture(t); const created = f.store.createCompensationProfile({ name: '全额补偿测试',status: 'enabled',weights: weights(5000) },'1');
  const grant = f.store.createCompensationGrant({ audience: 'selected',userIds: [USER.id],chanceCount: 1,profileId: created.id,startsAt: starts(f),reason: '测试补偿' },'1');
  const batch = await f.lottery.draw(USER,crypto.randomUUID(),1); await f.lottery.kick();
  assert.equal(batch.rewards[0].amountMinor,5000);
  const row = f.store.detail(batch.rewards[0].id);
  assert.equal(row.chanceSource,'compensation'); assert.equal(row.grantId,grant.id); assert.equal(row.audit.status,'not_required');
  assert.match(f.attempts[0].credit_notes,/source=compensation/); assert.match(f.attempts[0].credit_notes,/grant=/);
});

test('disabled and expired compensation grants stop unused chances without changing rewards', t => {
  const f = fixture(t); const standard = profile(f);
  const expired = f.store.createCompensationGrant({ audience: 'selected',userIds: [USER.id],chanceCount: 2,profileId: standard.id,startsAt: new Date(f.now()-1000).toISOString(),expiresAt: new Date(f.now()-1).toISOString(),reason: '已过期' },'1');
  assert.equal(f.store.compensationAvailable(USER.id),0);
  const active = f.store.createCompensationGrant({ audience: 'selected',userIds: [USER.id],chanceCount: 2,profileId: standard.id,startsAt: starts(f),reason: '可停用' },'1');
  assert.equal(f.store.compensationAvailable(USER.id),2); f.store.disableCompensationGrant(active.id,'1'); assert.equal(f.store.compensationAvailable(USER.id),0);
  assert.equal(f.store.compensationGrant(expired.id).status,'active');
});

test('invalid compensation profiles and grants fail before creating records', t => {
  const f = fixture(t); const standard = profile(f);
  assert.throws(() => f.store.createCompensationProfile({ name: 'bad',weights: weights(50).slice(1) },'1'),{ code: 'INVALID_PROFILE' });
  assert.throws(() => f.store.createCompensationGrant({ audience: 'selected',userIds: [],chanceCount: 1,profileId: standard.id,startsAt: starts(f),reason: '缺少用户' },'1'),{ code: 'INVALID_GRANT' });
  assert.throws(() => f.store.createCompensationGrant({ audience: 'selected',userIds: ['not-an-id'],chanceCount: 1,profileId: standard.id,startsAt: starts(f),reason: '无效用户' },'1'),{ code: 'INVALID_GRANT' });
  assert.equal(f.store.compensationSummary().grantCount,0);
});
