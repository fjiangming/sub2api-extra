'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');
const { AppError } = require('../src/errors');
const { fixture, USER } = require('./fixtures');

async function httpFixture(t) {
  const f = fixture(t);
  const roles = new Map([['user','user'],['admin','admin'],['other','user']]);
  f.core.me = async token => {
    if (!roles.has(token)) throw new AppError('AUTH_REJECTED','登录无效',401);
    return { ...USER,id: token === 'other' ? '99' : token === 'admin' ? '1' : '42',role: roles.get(token) };
  };
  const auth = new AuthService(f.config,f.core,f.now);
  const app = createApp({ config: f.config,auth,store: f.store,lottery: f.lottery });
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}`; f.config.publicUrl = base;
  t.after(async () => { auth.close(); await new Promise(resolve => server.close(resolve)); });
  const call = (url,session,body,headers = {}) => fetch(`${base}/api/${url}`,{
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'user-agent': 'activity-test',origin: base,...(session ? { authorization: `Session ${session.sessionToken}`,'x-csrf-token': session.csrfToken } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),...headers }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const login = async token => {
    const response = await call('auth/sso',null,{}, { authorization: `Bearer ${token}` }); assert.equal(response.status,200); return response.json();
  };
  return { ...f,auth,roles,base,call,login };
}

test('HTTP auth, same-origin SSO, CSRF, bounded input and no-cache security headers', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.call('activities')).status,401);
  assert.equal((await f.call('auth/sso',null,{}, { origin: 'https://evil.test',authorization: 'Bearer user' })).status,403);
  const session = await f.login('user');
  const registry = await f.call('activities',session);
  assert.equal(registry.headers.get('cache-control'),'no-store');
  assert.match(registry.headers.get('content-security-policy'),/object-src 'none'/);
  assert.deepEqual(Object.keys((await registry.json()).activities[0]).sort(),['enabled','id','kind','name','prizes']);
  const body = { count: 1,requestId: crypto.randomUUID() };
  assert.equal((await f.call('activities/recharge-lottery/draw',session,body,{ 'x-csrf-token': '' })).status,403);
  assert.equal((await f.call('activities/recharge-lottery/draw',session,body,{ origin: 'https://evil.test' })).status,403);
  assert.equal((await f.call('activities/recharge-lottery/draw',session,{ ...body,count: 2 })).status,400);
  assert.equal((await f.call('activities/recharge-lottery/draw',session,{ ...body,amount: 5000 })).status,400);
  assert.equal(f.store.used(USER.id),0);
  assert.equal((await f.call('activities/recharge-lottery/draw',session,body)).status,200);
  await f.lottery.kick();
  assert.equal((await f.call('rewards?page=-1',session)).status,400);
  const vendor = await fetch(`${f.base}/vendor/lucide.js`); assert.equal(vendor.status,200);
  assert.equal((await fetch(`${f.base}/views/ledger.html`)).status,404);
  assert.equal((await fetch(`${f.base}/src/prizes.js`)).status,404);
});

test('ordinary users cannot access admin shell, totals, detail, retries or another user batch', async t => {
  const f = await httpFixture(t); const user = await f.login('user'); const other = await f.login('other');
  const response = await f.call('activities/recharge-lottery/draw',user,{ count: 1,requestId: crypto.randomUUID() });
  const batch = await response.json(); await f.lottery.kick();
  for (const endpoint of ['admin/view','admin/summary','admin/rewards',`admin/rewards/${batch.rewards[0].id}`]) assert.equal((await f.call(endpoint,user)).status,403);
  assert.equal((await f.call(`admin/rewards/${batch.rewards[0].id}/retry`,user,{})).status,403);
  assert.equal((await f.call(`activities/recharge-lottery/batches/${batch.id}`,other)).status,404);
  assert.equal((await (await f.call('rewards',other)).json()).total,0);
  const history = JSON.stringify(await (await f.call('rewards',user)).json());
  assert.doesNotMatch(history,/receipt|AC-|email|weight|minimum|recharge_minor|attempts|audit|requiredMinor|rechargeMinor/);
  const admin = await f.login('admin');
  assert.equal((await f.call('admin/view',admin)).status,200);
  const summary = await (await f.call('admin/summary',admin)).json(); assert.equal(summary.totalMinor,50);
  const detail = await (await f.call(`admin/rewards/${batch.rewards[0].id}`,admin)).json(); assert.equal(detail.receipt.userId,'42');
  assert.equal((await f.call('admin/rewards?from=2026-02-30',admin)).status,400);
  assert.equal((await f.call('admin/rewards?from=2026-11-17&to=2026-11-01',admin)).status,400);
});

test('only admins can inspect and filter threshold violations while customer responses remain private', async t => {
  const f = await httpFixture(t); const user = await f.login('user'); const admin = await f.login('admin');
  const batch = f.store.reserve(USER,crypto.randomUUID(),1,5000);
  const id = batch.rewards[0].id;
  f.store.db.prepare("UPDATE rewards SET amount_minor=1000,required_recharge_minor=100000,status='failed' WHERE id=?").run(id);
  const before = f.store.db.prepare('SELECT * FROM rewards WHERE id=?').get(id);
  const summary = await (await f.call('admin/summary',admin)).json();
  assert.equal(summary.audit.violationCount,1); assert.equal(summary.audit.violationUsers,1);
  assert.equal(summary.audit.violationMinor,1000); assert.equal(summary.audit.violationPaidMinor,0);
  const response = await f.call('admin/rewards?audit=violation&status=failed',admin);
  assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
  const rows = await response.json(); assert.equal(rows.total,1);
  assert.deepEqual(rows.rows[0].audit,{ status: 'violation',requiredMinor: 100000,rechargeMinor: 5000 });
  const detail = await (await f.call(`admin/rewards/${id}`,admin)).json();
  assert.deepEqual(detail.audit,rows.rows[0].audit);
  assert.equal((await (await f.call('admin/rewards?audit=passed',admin)).json()).total,0);
  assert.equal((await f.call('admin/rewards?audit=unknown',admin)).status,400);
  assert.equal((await f.call('admin/rewards?audit=violation',user)).status,403);
  assert.equal((await f.call('rewards?audit=violation',user)).status,400);
  for (const endpoint of ['rewards','activities/recharge-lottery',`activities/recharge-lottery/batches/${batch.id}`]) {
    assert.doesNotMatch(JSON.stringify(await (await f.call(endpoint,user)).json()),/audit|requiredMinor|rechargeMinor|100000/);
  }
  const shell = await (await f.call('admin/view',admin)).text();
  assert.match(shell,/id="audit-summary"/);
  assert.doesNotMatch(await (await fetch(f.base)).text(),/audit-summary|audit-heading|充值门槛/);
  f.roles.set('admin','user');
  assert.equal((await f.call('admin/rewards?audit=violation',admin)).status,403);
  assert.equal((await f.call('admin/summary',admin)).status,403);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM rewards WHERE id=?').get(id),before);
});

test('admin role revocation and account disablement take effect before sensitive requests', async t => {
  const f = await httpFixture(t); const admin = await f.login('admin'); const user = await f.login('user');
  f.roles.set('admin','user'); assert.equal((await f.call('admin/summary',admin)).status,403);
  f.roles.delete('user');
  assert.equal((await f.call('activities/recharge-lottery/draw',user,{ count: 1,requestId: crypto.randomUUID() })).status,401);
  assert.equal(f.store.used(USER.id),0);
});

test('admin recovery requires both CSRF and origin and cannot alter the original award', async t => {
  const f = await httpFixture(t); const user = await f.login('user'); const admin = await f.login('admin');
  const batch = f.store.reserve(USER,crypto.randomUUID(),1,5000);
  const id = batch.rewards[0].id;
  f.store.db.prepare("UPDATE rewards SET status='failed' WHERE id=?").run(id);
  assert.equal((await f.call(`admin/rewards/${id}/retry`,admin,{}, { 'x-csrf-token': '' })).status,403);
  assert.equal((await f.call(`admin/rewards/${id}/retry`,admin,{}, { origin: 'https://evil.test' })).status,403);
  assert.equal(f.store.detail(id).status,'failed'); assert.equal(f.store.detail(id).retries.length,0);
  assert.equal((await f.call(`admin/rewards/${id}/retry`,admin,{})).status,200);
  await f.lottery.kick();
  assert.equal(f.store.detail(id).status,'paid'); assert.equal(f.store.used(USER.id),1);
  assert.equal(f.store.detail(id).retries.length,1);
  assert.equal((await f.call('rewards?user_id=1',user)).status,400);
});

test('recharge lottery rules are admin-only, validate percentages and persist thresholds', async t => {
  const f = await httpFixture(t); const user = await f.login('user'); const admin = await f.login('admin');
  assert.equal((await f.call('admin/lottery-config',user)).status,403);
  const initial = await (await f.call('admin/lottery-config',admin)).json();
  assert.equal(initial.version,1); assert.equal(initial.prizes.find(row => row.amountMinor === 1000).minimumMinor,100000);
  const prizes = initial.prizes.map(row => row.amountMinor === 1000 ? { ...row,weight: 700,minimumMinor: 120000 } : row.amountMinor === 50 ? { ...row,weight: 5000 } : row);
  assert.equal((await f.call('admin/lottery-config',admin,{ prizes },{ 'x-csrf-token': '' })).status,403);
  assert.equal((await f.call('admin/lottery-config',admin,{ prizes },{ origin:'https://evil.test' })).status,403);
  const saved = await f.call('admin/lottery-config',admin,{ prizes });
  assert.equal(saved.status,200); const config = await saved.json(); assert.equal(config.version,2);
  assert.equal(config.prizes.find(row => row.amountMinor === 50).weight,5000);
  assert.equal(config.prizes.find(row => row.amountMinor === 1000).minimumMinor,120000);
  assert.equal((await f.call('admin/lottery-config',admin,{ prizes: prizes.map(row => row.amountMinor === 50 ? { ...row,weight: 4999 } : row) })).status,400);
  assert.doesNotMatch(JSON.stringify(await (await f.call('activities/recharge-lottery',user)).json()),/weight|minimum|120000/);
});

test('compensation management is admin-only, keeps independent profiles and supports multi-user grants', async t => {
  const f = await httpFixture(t); const user = await f.login('user'); const admin = await f.login('admin');
  for (const endpoint of ['admin/compensation/view','admin/compensation/summary','admin/compensation/profiles','admin/compensation/grants']) assert.equal((await f.call(endpoint,user)).status,403);
  const initial = await (await f.call('admin/compensation/profiles',admin)).json(); assert.equal(initial.profiles.length,1);
  const weights = [50,100,200,300,500,1000,2000,5000].map((amountMinor,index) => ({ amountMinor,weight: index === 0 ? 6000 : index === 1 ? 2000 : index === 2 ? 1000 : index === 3 ? 500 : index === 4 ? 300 : index === 5 ? 100 : index === 6 ? 70 : 30 }));
  const profileResponse = await f.call('admin/compensation/profiles',admin,{ name:'HTTP 补偿方案',status:'enabled',weights });
  assert.equal(profileResponse.status,201); const created = await profileResponse.json(); assert.equal(created.name,'HTTP 补偿方案');
  assert.equal((await f.call('admin/compensation/profiles',admin,{}, { 'x-csrf-token': '' })).status,403);
  const grantResponse = await f.call('admin/compensation/grants',admin,{ audience:'selected',userIds:['42','99','42'],chanceCount:3,profileId:created.id,startsAt:new Date(f.now()).toISOString(),expiresAt:null,reason:'接口补偿测试' });
  assert.equal(grantResponse.status,201); const grant = await grantResponse.json(); assert.equal(grant.selectedUsers,2); assert.equal(grant.chanceCount,3);
  const rows = await (await f.call('admin/compensation/grants?page=1',admin)).json(); assert.equal(rows.total,1); assert.equal(rows.rows[0].usedCount,0);
  assert.equal((await f.call(`admin/compensation/grants/${grant.id}/disable`,admin,{}, { origin:'https://evil.test' })).status,403);
  const disabled = await (await f.call(`admin/compensation/grants/${grant.id}/disable`,admin,{})).json(); assert.equal(disabled.status,'disabled');
  const audit = await (await f.call('admin/compensation/audit',admin)).json(); assert.ok(audit.rows.some(row => row.action === 'grant_created')); assert.ok(audit.rows.some(row => row.action === 'grant_disabled'));
  assert.match(await (await f.call('admin/compensation/view',admin)).text(),/compensation-grant-form/);
});

test('logout and expiry cannot be undone by late upstream identity verification', async t => {
  const f = await httpFixture(t); const user = await f.login('user');
  const session = f.auth.sessions.get(user.sessionToken);
  let release; const hold = new Promise(resolve => { release = resolve; });
  f.core.me = async () => { await hold; return { ...USER }; };
  const req = { ip: '127.0.0.1',get: name => name === 'user-agent' ? 'activity-test' : null };
  const refresh = f.auth.refresh(session,req);
  f.auth.sessions.delete(session.id); release();
  await assert.rejects(refresh,{ code: 'AUTH_REQUIRED' });
  assert.equal(f.auth.sessions.size,0);
  assert.equal((await f.call('rewards',user)).status,401);
});
