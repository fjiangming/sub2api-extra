'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { UserMessageStore, visibleTo } = require('../src/user-message-store');
const { UserMessagesService } = require('../src/services/user-messages-service');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');
const { AppError } = require('../src/errors');
const { loadConfig } = require('../src/config');

const input = (overrides = {}) => ({
  userId: 2, title: '个人通知', content: '## 消息\n\n**Markdown** 正文', status: 'active',
  notifyMode: 'popup', startsAt: null, endsAt: null, ...overrides
});
const context = () => ({ actor: 'operator', accessToken: 'current-admin-token', requestKey: crypto.randomUUID() });

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-messages-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new UserMessageStore(directory);
  await store.initialize();
  const calls = [];
  const native = [{ id: 9, title: '原生公告', content: '原文', notify_mode: 'silent', created_at: '2025-01-01T00:00:00.000Z' }];
  const config = {
    env: 'test', authMode: 'local', trustProxy: false, adminUser: 'admin', adminPassword: 'local-test-password',
    sessionTtlMinutes: 30, cookieSecure: false, userMessagesEnabled: true,
    sub2apiBaseUrl: 'http://direct-sub2api.test', sub2apiPublicUrl: 'https://public-gateway.test',
    sub2apiResolvedBaseUrl: 'https://public-gateway.test', sub2apiRequestTimeoutMs: 1000, ...overrides
  };
  const sub2api = { raw: async (url, options, authenticated) => {
    calls.push({ url, options, authenticated });
    if (url.includes('/users?')) return { code: 0, data: { items: [{ id: 2, email: 'two@example.test', username: 'two', balance: 100, api_key: 'private' }] } };
    const id = Number(url.split('/').at(-1));
    if (id === 99) throw new AppError('SUB2API_REQUEST_FAILED', 'missing', { status: 502, details: { upstreamStatus: 404 } });
    return { code: 0, data: { id, email: `${id}@example.test`, username: `user-${id}`, balance: 100 } };
  } };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(url.startsWith(config.sub2apiAnnouncementsUpstreamUrl || config.sub2apiBaseUrl));
    const token = options.headers.authorization;
    const id = token === 'Bearer user-two' ? 2 : token === 'Bearer user-three' ? 3 : null;
    if (!id) return Response.json({ message: 'invalid token' }, { status: 401 });
    if (url.endsWith('/auth/me')) return Response.json({ code: 0, data: { id, role: 'user' } });
    if (url.includes('/announcements/')) return Response.json({ code: 0, data: { message: 'native-read' } });
    return Response.json({ code: 0, data: native });
  };
  const service = new UserMessagesService({ config, store, sub2api, fetchImpl });
  return { store, service, config, calls, directory, native };
}

test('messages are visible and readable only to the authenticated recipient; native announcements survive', async (t) => {
  const { service, store, calls } = await fixture(t);
  const message = await service.create(input(), context());
  assert.ok(message.id < 0);
  const mine = await service.listForUser('user-two', false);
  assert.deepEqual(mine.map((item) => item.id), [message.id, 9]);
  assert.equal(mine[0].notify_mode, 'popup');
  assert.equal(mine[0].content, input().content);
  assert.equal(mine[0].recipient, undefined);
  assert.equal(mine[0].requestKey, undefined);
  assert.deepEqual((await service.listForUser('user-three', false)).map((item) => item.id), [9]);
  await assert.rejects(service.markReadForUser('user-three', message.id), { status: 404 });
  assert.equal(store.get(message.id).readAt, null);
  await service.markReadForUser('user-two', message.id);
  const readAt = store.get(message.id).readAt;
  await service.markReadForUser('user-two', message.id);
  assert.equal(store.get(message.id).readAt, readAt);
  assert.deepEqual((await service.listForUser('user-two', true)).map((item) => item.id), [9]);
  assert.equal((await service.listForUser('user-two', false))[0].read_at, readAt);
  assert.equal((await service.markReadForUser('user-two', 9)).message, 'native-read');
  assert.ok(calls.some((call) => call.url.endsWith('/announcements/9/read') && call.options.method === 'POST'));
  assert.ok(calls.filter((call) => call.url.startsWith('http')).every((call) =>
    ['Bearer user-two', 'Bearer user-three'].includes(call.options.headers.authorization)));
});

test('drafts, schedules, expiration and withdrawal enforce the same boundary for listing and reading', async (t) => {
  const { service, store } = await fixture(t);
  const draft = await service.create(input({ status: 'draft' }), context());
  const future = await service.create(input({ startsAt: '2099-01-01T00:00:00.000Z', endsAt: '2099-02-01T00:00:00.000Z' }), context());
  assert.equal(store.forUser(2).length, 0);
  await assert.rejects(service.markReadForUser('user-two', draft.id), { status: 404 });
  await assert.rejects(service.markReadForUser('user-two', future.id), { status: 404 });
  const now = Date.parse('2026-10-19T10:00:00.000Z');
  const entry = { userId: 2, status: 'active', startsAt: new Date(now).toISOString(), endsAt: new Date(now + 1000).toISOString() };
  assert.equal(visibleTo(entry, 2, now - 1), false);
  assert.equal(visibleTo(entry, 2, now), true);
  assert.equal(visibleTo(entry, 2, now + 1000), false);
  assert.equal(visibleTo(entry, 3, now), false);
  await service.update(draft.id, input(), context());
  assert.equal(store.forUser(2).length, 1);
  await service.archive(draft.id, 'another-operator');
  assert.equal(store.forUser(2).length, 0);
  await assert.rejects(service.markReadForUser('user-two', draft.id), { status: 404 });
});

test('input validation and immutable recipients prevent empty or broadened targeting', async (t) => {
  const { service, store } = await fixture(t);
  for (const overrides of [
    { userId: 0 }, { userId: [2, 3] }, { userId: '2' }, { userId: Number.MAX_SAFE_INTEGER + 1 },
    { title: ' ' }, { content: ' ' }, { content: 'x'.repeat(16001) }, { notifyMode: 'all' },
    { targeting: {} }, { startsAt: 'invalid' }, { endsAt: '2020-01-01T00:00:00.000Z' },
    { startsAt: '2099-02-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z' }
  ]) await assert.rejects(service.create(input(overrides), context()), { status: 400 });
  assert.equal(store.items().length, 0);
  const message = await service.create(input(), context());
  await assert.rejects(service.update(message.id, input({ userId: 3 }), context()), { code: 'MESSAGE_RECIPIENT_LOCKED' });
  assert.equal(store.get(message.id).userId, 2);
  assert.equal((await service.searchUsers({ search: '99' }, 'admin')).items.length, 0);
});

test('search uses the current administrator token and returns only recipient identity', async (t) => {
  const { service, calls } = await fixture(t);
  const result = await service.searchUsers({ search: 'two+test@example.test' }, 'current-admin-token');
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['email', 'id', 'username']);
  assert.match(calls[0].url, /search=two%2Btest%40example.test/);
  assert.equal(calls[0].options.headers.authorization, 'Bearer current-admin-token');
  assert.equal(calls[0].authenticated, false);
  await service.searchUsers({ search: '2' });
  assert.equal(calls[1].authenticated, true);
});

test('concurrent writes, repeated sends and read receipts persist across restart without duplicate delivery', async (t) => {
  const { service, store, directory } = await fixture(t);
  const request = context();
  const [first, repeated] = await Promise.all([service.create(input(), request), service.create(input(), request)]);
  assert.equal(first.id, repeated.id);
  assert.equal(store.items().length, 1);
  await assert.rejects(service.create(input({ userId: 3 }), request), { code: 'MESSAGE_REQUEST_CONFLICT' });
  await Promise.all([service.markReadForUser('user-two', first.id), service.update(first.id, input({ title: '更新标题' }), context())]);
  const restarted = new UserMessageStore(directory);
  await restarted.initialize();
  assert.equal(restarted.get(first.id).title, '更新标题');
  assert.ok(restarted.get(first.id).readAt);
  assert.equal(restarted.forUser(2, true).length, 0);
  const next = await restarted.create({ ...store.get(first.id), requestKey: crypto.randomUUID() });
  assert.notEqual(next.id, first.id);
});

test('failed writes do not expose undurable messages and do not block subsequent saves', async (t) => {
  const { service, store } = await fixture(t);
  const original = store.filePath;
  store.filePath = path.join(path.dirname(original), 'missing-directory', 'messages.json');
  await assert.rejects(service.create(input(), context()));
  assert.equal(store.items().length, 0);
  store.filePath = original;
  assert.equal((await service.create(input(), context())).id, -1);
});

test('disabled delivery permits drafts but blocks publication and the user gateway', async (t) => {
  const { service, store } = await fixture(t, { userMessagesEnabled: false });
  assert.equal((await service.create(input({ status: 'draft' }), context())).status, 'draft');
  await assert.rejects(service.create(input(), context()), { code: 'USER_MESSAGE_DELIVERY_DISABLED' });
  await assert.rejects(service.listForUser('user-two', false), { code: 'USER_MESSAGE_DELIVERY_DISABLED' });
  assert.equal(store.forUser(2).length, 0);
  assert.equal(loadConfig({ OPERATIONS_CENTER_ADMIN_PASSWORD: 'test-password-123' }).userMessagesEnabled, false);
  assert.throws(() => loadConfig({ OPERATIONS_CENTER_ADMIN_PASSWORD: 'test-password-123', OPERATIONS_CENTER_USER_MESSAGES_ENABLED: 'true' }), /SUB2API_ANNOUNCEMENTS_UPSTREAM_URL/);
});

test('revoked tokens and malformed native responses fail closed without returning targeted content', async (t) => {
  const { service, store } = await fixture(t);
  await service.create(input(), context());
  await assert.rejects(service.listForUser('', false), { status: 401 });
  await assert.rejects(service.listForUser('revoked-token', false), { status: 401 });
  await assert.rejects(service.markReadForUser('revoked-token', -1), { status: 401 });
  assert.equal(store.get(-1).readAt, null);
  service.fetch = async (url) => Response.json({ code: 0, data: url.endsWith('/auth/me') ? { id: 2 } : [{ id: -5 }] });
  await assert.rejects(service.listForUser('user-two', false), { code: 'SUB2API_INVALID_ANNOUNCEMENTS' });
});

test('HTTP APIs separate administrator sessions/CSRF from native user bearer authentication', async (t) => {
  const { service, config, store } = await fixture(t);
  const auth = new AuthService(config);
  t.after(() => auth.close());
  const app = createApp({ config, auth, messages: service });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/user-messages`)).status, 401);
  assert.equal((await fetch(`${base}/api/user-messages`, { headers: { authorization: 'Bearer user-two' } })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/announcements`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: config.adminPassword }) });
  const session = await login.json();
  const headers = { authorization: `Session ${session.sessionToken}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() };
  assert.equal((await fetch(`${base}/api/user-messages`, { method: 'POST', headers, body: JSON.stringify(input()) })).status, 403);
  assert.equal(store.items().length, 0);
  headers['x-csrf-token'] = session.csrfToken;
  const created = await fetch(`${base}/api/user-messages`, { method: 'POST', headers, body: JSON.stringify(input()) });
  assert.equal(created.status, 201);
  const message = await created.json();
  const other = await fetch(`${base}/api/v1/announcements?userId=2`, { headers: { authorization: 'Bearer user-three' } });
  assert.equal(other.status, 200);
  assert.equal(other.headers.get('cache-control'), 'no-store');
  assert.equal(other.headers.get('x-operations-announcements'), '1');
  assert.deepEqual((await other.json()).data.map((item) => item.id), [9]);
  assert.equal((await fetch(`${base}/api/v1/announcements`, { headers })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/announcements/${message.id}/read`, { method: 'POST', headers: { authorization: 'Bearer user-three' } })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/announcements/${message.id}/read`, { method: 'POST', headers: { authorization: 'Bearer user-two' } })).status, 200);
  assert.equal((await fetch(`${base}/api/user-messages/${message.id}/archive`, { method: 'POST', headers: { authorization: headers.authorization } })).status, 403);
  assert.equal((await fetch(`${base}/api/user-messages/${message.id}/archive`, { method: 'POST', headers })).status, 200);
  const report = await fetch(`${base}/api/user-messages?status=archived`, { headers });
  assert.equal((await report.json()).total, 1);
  for (const route of ['/vendor/marked.js', '/vendor/dompurify.js', '/user-messages-ui.js', '/user-messages.css']) {
    const asset = await fetch(`${base}${route}`);
    assert.equal(asset.status, 200, route);
    assert.doesNotMatch(await asset.text(), /^<!doctype html>/i);
  }
  assert.equal((await fetch(`${base}/api/user-messages/${message.id}`, { method: 'DELETE', headers })).status, 204);
  assert.equal(store.items().length, 0);
});

test('announcement gateway detects an upstream proxy loop before repeating authentication', async (t) => {
  const { service, config } = await fixture(t);
  const auth = new AuthService(config);
  t.after(() => auth.close());
  const server = http.createServer(createApp({ config, auth, messages: service }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  service.fetch = async (url, options) => {
    calls.push(url);
    if (url.endsWith('/auth/me')) return Response.json({ code: 0, data: { id: 2 } });
    return fetch(`${base}/api/v1/announcements`, options);
  };
  await assert.rejects(service.listForUser('user-two', false), { status: 508 });
  assert.equal(calls.length, 2);
});
