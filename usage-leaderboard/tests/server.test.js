'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../src/auth');
const { createApp } = require('../src/app');
const { AppError } = require('../src/errors');
const { publicIdentity } = require('../src/identity');
const { memoryDatabase, insertUsers, insertLogs, service } = require('./helpers');

test('HTTP authenticates ordinary users, isolates personal data, rejects forged selectors, and sets iframe security headers', async (t) => {
  const db = await memoryDatabase();
  await insertUsers(db, [{ id: 2, username: '普通用户', email: 'reader@gmail.com' },
    { id: 3, username: '<img src=x onerror=alert(1)>', email: 'another@163.com' }]);
  await insertLogs(db, [
    { user_id: 2, created_at: '2026-10-12T18:00Z', input_tokens: 10, actual_cost: 1.25 },
    { user_id: 3, created_at: '2026-10-12T18:00Z', input_tokens: 100, actual_cost: 99.99 }
  ]);
  const dependencies = service(db);
  const auth = new AuthService(dependencies.config, {
    async me(token) {
      if (!['user-two', 'user-three'].includes(token)) throw new AppError('AUTH_FAILED', '无效令牌', 401);
      return token === 'user-two' ? { id: '2', email: 'reader@gmail.com' } : { id: '3', email: 'another@163.com' };
    }
  });
  const app = createApp({ ...dependencies, auth, database: db });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    auth.close(); await db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const anonymous = await fetch(`${base}/api/leaderboard`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/api/auth/sso`, { method: 'POST', headers: { authorization: 'Bearer bad' } })).status, 401);
  const blocked = await fetch(`${base}/api/auth/sso`, { method: 'POST', headers: { authorization: 'Bearer user-two', origin: 'https://attacker.example' } });
  assert.equal(blocked.status, 403);
  async function login(token) {
    const response = await fetch(`${base}/api/auth/sso`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 999 }) });
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(session.user.name, token === 'user-two' ? 're***@gmail.com' : 'an***@163.com');
    assert.ok(!/reader@gmail\.com|another@163\.com/.test(JSON.stringify(session)));
    return { authorization: `Session ${session.sessionToken}` };
  }
  const user2 = await login('user-two');
  const user3 = await login('user-three');
  const data2 = await (await fetch(`${base}/api/leaderboard`, { headers: user2 })).json();
  const data3 = await (await fetch(`${base}/api/leaderboard?period=today&metric=tokens`, { headers: user3 })).json();
  assert.equal(data2.period, 'today');
  assert.equal(data2.me.tokens, 10);
  assert.equal(data3.me.tokens, 100);
  assert.equal(data2.me.name, 're***@gmail.com');
  assert.equal(data3.me.name, 'an***@163.com');
  for (const [userId, data] of [[2, data2], [3, data3]]) {
    assert.match(data.me.key, /^[a-f0-9]{16}$/);
    assert.notEqual(data.me.key, publicIdentity(userId).key);
    assert.equal(data.entries.find((entry) => entry.name === data.me.name).key, data.me.key);
  }
  assert.deepEqual(data2.entries.map((user) => user.name), ['an***@163.com', 're***@gmail.com']);
  assert.ok(!/reader@gmail\.com|another@163\.com|onerror|普通用户/.test(JSON.stringify(data2)));
  assert.ok(!/"(?:cost|actual_cost|email|username)":/.test(JSON.stringify(data2)));
  const current = await (await fetch(`${base}/api/auth/me`, { headers: user2 })).json();
  assert.equal(current.user.name, data2.me.name);
  assert.equal(current.user.key, data2.me.key);
  assert.ok(!JSON.stringify(current).includes('reader@gmail.com'));
  const byRequests = await (await fetch(`${base}/api/leaderboard?period=today&metric=requests`, { headers: user2 })).json();
  assert.deepEqual(byRequests.entries.map((user) => user.rank), [1, 1]);
  assert.notEqual(data2.me.key, data3.me.key);
  assert.equal((await fetch(`${base}/api/leaderboard?user_id=3`, { headers: user2 })).status, 400);
  assert.equal((await fetch(`${base}/api/leaderboard?period=today&period=all`, { headers: user2 })).status, 400);
  assert.equal((await fetch(`${base}/api/leaderboard?metric=bad`, { headers: user2 })).status, 400);
  assert.equal((await fetch(`${base}/api/leaderboard?metric=cost`, { headers: user2 })).status, 400);
  const page = await fetch(`${base}/?token=should-never-be-reflected`);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self' http:\/\/127\.0\.0\.1:8080/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), null);
  const html = await page.text();
  assert.ok(!html.includes('should-never-be-reflected'));
  assert.ok(!html.includes('设计预览'));
  assert.ok(!html.includes('排行设置'));
  assert.ok(!html.includes('admin.js'));
  assert.ok(!html.includes('admin.css'));
  assert.ok(!html.includes('admin-content'));
  assert.ok(!/user-dialog|data-user-key|data-ranking-user|row-detail|locate-me|personal-ranking|personal-next|my-percentile/.test(html));
  assert.match(html, /id="personal-title">我的实际用量/);
  assert.ok(!/消费金额|USD|cost-heading|value="cost"/.test(html));
  const displayScript = await (await fetch(`${base}/app.js`)).text();
  assert.doesNotMatch(displayScript, /UsageAdmin|settings-link|admin-content|admin\/|canManage|csrfToken/);
  assert.doesNotMatch(displayScript, /simulation|simulated|realCount|rangeApplied|snapshotAt|rankingAvailable|boardRank|showUser|data-user-key|data-ranking-user/);
  const avatarScript = await (await fetch(`${base}/avatars.js`)).text();
  assert.doesNotMatch(avatarScript, /simulation|user\.source/);
  for (const settingsPath of ['/settings', '/settings/']) {
    const settingsPage = await fetch(`${base}${settingsPath}?token=should-never-be-reflected`);
    assert.equal(settingsPage.status, 200);
    assert.equal(settingsPage.headers.get('cache-control'), 'no-store');
    const settingsHtml = await settingsPage.text();
    assert.match(settingsHtml, /src="\/settings\.js/);
    assert.match(settingsHtml, /admin-content/);
    assert.ok(!settingsHtml.includes('usage-content'));
    assert.ok(!settingsHtml.includes('should-never-be-reflected'));
    assert.ok(!settingsHtml.includes('id="a-form"'));
  }
  assert.equal((await fetch(`${base}/settings.js`)).status, 200);
  assert.equal((await fetch(`${base}/admin.css`)).status, 200);
  assert.equal((await fetch(`${base}/assets/lucide.min.js`)).status, 200);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: user2 })).status, 200);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: user2 })).status, 401);
});

test('missing database reports readiness failure and public errors omit internal credentials', async (t) => {
  const { createRuntime } = require('../src/server');
  const { loadConfig } = require('../src/config');
  const runtime = createRuntime(loadConfig({ NODE_ENV: 'test' }), { client: { me: async () => ({ id: '2', email: 'user2@example.com' }) } });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await runtime.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  const auth = await (await fetch(`${base}/api/auth/sso`, { method: 'POST', headers: { authorization: 'Bearer test' } })).json();
  const response = await fetch(`${base}/api/leaderboard`, { headers: { authorization: `Session ${auth.sessionToken}` } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DATABASE_NOT_CONFIGURED');
});
