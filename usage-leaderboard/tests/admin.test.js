'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../src/auth');
const { SettingsStore } = require('../src/settings');
const { AppError } = require('../src/errors');
const { createApp } = require('../src/app');
const { DEFAULT_RULES } = require('../src/simulation');
const { memoryDatabase, insertUsers, insertLogs, service } = require('./helpers');

test('admin APIs require live upstream admin role, exact origin and CSRF, and keep drafts and secrets out of public responses', async (t) => {
  const database = await memoryDatabase();
  await insertUsers(database, [{ id: 1, role: 'admin', email: 'admin@example.com' }, { id: 2, email: 'reader@example.com' }]);
  await insertLogs(database, [{ user_id: 2, created_at: '2026-10-13T02:00Z', input_tokens: 2000123 }]);
  const dependencies = service(database);
  const settings = new SettingsStore(dependencies.config, { now: () => new Date('2026-10-13T03:30:00Z') });
  dependencies.leaderboard.settings = settings;
  settings.onPublish = () => dependencies.leaderboard.invalidate();
  let adminRole = 'admin';
  let failUpstream = false;
  let validations = 0;
  const auth = new AuthService(dependencies.config, { async me(token) {
    validations++;
    if (failUpstream) throw new AppError('AUTH_UNAVAILABLE', '认证暂不可用', 503);
    return token === 'administrator' ? { id: '1', role: adminRole, email: 'admin@example.com' } : { id: '2', role: 'user', email: 'reader@example.com' };
  } });
  const server = createApp({ ...dependencies, database, settings, auth }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    auth.close(); await database.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoints = [
    ['GET', 'session'], ['GET', 'settings'], ['GET', 'view'], ['GET', 'leaderboard/preview?period=month&metric=tokens&source=real'],
    ['POST', 'simulation/preview'], ['PUT', 'settings/draft'], ['POST', 'leaderboard/publish'],
    ['POST', 'leaderboard/restore-real'], ['POST', 'leaderboard/rollback']
  ];
  for (const [method, path] of endpoints) assert.equal((await fetch(`${base}/api/admin/${path}`, { method })).status, 401);
  async function login(token) {
    return (await fetch(`${base}/api/auth/sso`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json();
  }
  const forged = `header.${Buffer.from(JSON.stringify({ sub: 1, role: 'admin' })).toString('base64url')}.signature`;
  const reader = await login(forged);
  assert.equal(reader.capabilities, undefined);
  assert.equal(reader.csrfToken, undefined);
  for (const [method, path] of endpoints) assert.equal((await fetch(`${base}/api/admin/${path}`, { method, headers: { authorization: `Session ${reader.sessionToken}` } })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/settings?role=admin&user_id=1`, { headers: { authorization: `Session ${reader.sessionToken}` } })).status, 403);
  assert.equal((await fetch(`${base}/views/admin.html`)).status, 404);
  assert.ok(!(await (await fetch(base)).text()).includes('id="a-form"'));
  const administrator = await login('administrator');
  assert.equal(administrator.capabilities, undefined);
  assert.equal(administrator.csrfToken, undefined);
  const headers = { authorization: `Session ${administrator.sessionToken}`, 'content-type': 'application/json', origin: base };
  const call = (path, body, method = 'POST', overrides = {}) => fetch(`${base}/api/admin/${path}`, { method, headers: { ...headers, ...overrides }, ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) });
  const adminSession = await (await call('session', null, 'GET')).json();
  assert.equal(typeof adminSession.csrfToken, 'string');
  headers['x-csrf-token'] = adminSession.csrfToken;
  assert.equal((await call('settings', null, 'GET')).headers.get('cache-control'), 'no-store');
  assert.ok((await (await call('view', null, 'GET')).json()).html.includes('id="a-form"'));
  for (const overrides of [{ origin: 'https://evil.example' }, { origin: `${base.replace('http:', 'https:')}` }, { origin: 'invalid' }, { 'x-csrf-token': '' }, { 'x-csrf-token': 'forged' }]) {
    assert.equal((await call('leaderboard/restore-real', { revision: 0 }, 'POST', overrides)).status, 403);
  }
  assert.equal((await call('simulation/preview', { revision: 0, rules: DEFAULT_RULES, rows: [] })).status, 400);
  assert.equal((await call('simulation/preview', { revision: 0, rules: { ...DEFAULT_RULES, maximumTokens: 1000000001 } })).status, 400);
  const generated = await (await call('simulation/preview', { revision: 0, rules: DEFAULT_RULES })).json();
  assert.equal(generated.revision, 1);
  assert.equal(settings.active(), null);
  const preview = await (await call('leaderboard/preview?period=month&metric=tokens&source=simulation', null, 'GET')).json();
  assert.equal(preview.display.realCount, 1);
  assert.equal(preview.entries.length, 10);
  assert.equal(preview.me, undefined);
  const draft = await (await call('settings/draft', { revision: generated.revision, source: 'simulation' }, 'PUT')).json();
  const readerHeaders = { authorization: `Session ${reader.sessionToken}` };
  const realBoard = await (await fetch(`${base}/api/leaderboard`, { headers: readerHeaders })).json();
  assert.equal(realBoard.display, undefined);
  assert.equal((await call('leaderboard/publish', { revision: draft.revision, source: 'simulation', actor: 'forged' })).status, 400);
  const live = await (await call('leaderboard/publish', { revision: draft.revision, source: 'simulation' })).json();
  assert.equal(live.published.actor, 'ad***@example.com');
  assert.equal((await call('leaderboard/publish', { revision: draft.revision, source: 'real' })).status, 409);
  const mixed = await (await fetch(`${base}/api/leaderboard`, { headers: readerHeaders })).json();
  assert.equal(mixed.display, undefined);
  assert.equal(mixed.entries.length, 10);
  assert.equal(mixed.me.key, reader.user.key);
  assert.equal(mixed.me.tokens, realBoard.me.tokens);
  assert.deepEqual(mixed.me.models, realBoard.me.models);
  assert.deepEqual(Object.keys(mixed), Object.keys(realBoard));
  assert.deepEqual(Object.keys(mixed.me), Object.keys(realBoard.me));
  const rawKeys = new Set(generated.draft.candidate.rows.map((row) => row.key));
  const publicKeys = new Map();
  for (const period of ['today', 'week', 'month', 'all']) {
    const board = await (await fetch(`${base}/api/leaderboard?period=${period}`, { headers: readerHeaders })).json();
    assert.equal(board.entries.length, 10);
    assert.ok(!/admin@example.com|reader@example.com|sim_|simulation|"(?:source|display|seed|draft|csrfToken|rules|realCount|simulatedCount|rangeApplied|snapshotAt|dynamic|rankingAvailable|boardRank)"/.test(JSON.stringify(board)));
    for (const entry of board.entries) {
      assert.match(entry.key, /^[a-f0-9]{16}$/);
      assert.ok(!rawKeys.has(entry.key));
      assert.deepEqual(Object.keys(entry), Object.keys(realBoard.entries[0]));
      if (publicKeys.has(entry.name)) assert.equal(entry.key, publicKeys.get(entry.name));
      publicKeys.set(entry.name, entry.key);
    }
    const ownEntry = board.entries.find((entry) => entry.key === board.me.key);
    assert.equal(ownEntry.tokens, board.me.tokens);
    assert.equal(ownEntry.requests, board.me.requests);
  }
  assert.equal(preview.display.mode, 'mixed');
  assert.ok(preview.entries.some((entry) => entry.source === 'simulation' && rawKeys.has(entry.key)));
  const before = settings.snapshot();
  adminRole = 'user';
  assert.equal((await call('session', null, 'GET')).status, 403);
  assert.equal((await call('settings', null, 'GET')).status, 403);
  assert.equal((await call('leaderboard/restore-real', { revision: before.revision })).status, 403);
  assert.deepEqual(settings.snapshot(), before);
  adminRole = 'admin'; failUpstream = true;
  assert.equal((await call('leaderboard/restore-real', { revision: before.revision })).status, 503);
  assert.deepEqual(settings.snapshot(), before);
  failUpstream = false;
  const restored = await (await call('leaderboard/restore-real', { revision: before.revision })).json();
  assert.equal(settings.active(), null);
  assert.equal((await call('leaderboard/rollback', { revision: restored.revision })).status, 200);
  assert.equal(settings.active().source, 'simulation');
  assert.ok(validations >= 20);
});
