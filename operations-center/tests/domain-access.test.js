'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { parseLine, domain, route } = require('../src/services/domain-access-format');
const { DomainAccessStore } = require('../src/domain-access-store');
const { DomainAccessSource } = require('../src/services/domain-access-source');
const { DomainAccessService } = require('../src/services/domain-access-service');
const { UserMessageStore } = require('../src/user-message-store');
const { domainAccessFixture, gatewayLine, requestId, OLD } = require('./domain-access-fixture');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');

test('gateway proof is mandatory and persisted routes never retain arbitrary secrets', () => {
  const at = Date.now();
  const valid = parseLine(gatewayLine('safe', at, { host: OLD + ':443', path: '/v1/responses?key=SECRET', authorization: 'SECRET' }));
  assert.equal(valid.domain, OLD); assert.equal(valid.path, '/v1/responses'); assert.equal(valid.identity, 'pending');
  assert(!JSON.stringify(valid).includes('SECRET'));
  assert.equal(parseLine(gatewayLine('spoof', at, { backend_id: 'client-controlled' })).identity, 'unverified');
  assert.equal(parseLine(gatewayLine('future', at + 86400000)), null);
  assert.equal(parseLine(gatewayLine('invalid', at, { gateway_id: 'unsafe-id' })), null);
  assert.equal(parseLine(gatewayLine('invalid', at, { host: 'https://' + OLD })), null);
  assert.equal(domain('foo.example.com.attacker.tld'), 'foo.example.com.attacker.tld');
  assert.equal(domain('foo..example.com'), null); assert.equal(route('/api/user/SECRET'), '/api/*');
  assert.equal(route('/private/SECRET'), '/web/*');
});

test('actual read-only SQL: exact root IDs, retry dedup, conflicts, administrators and history boundaries', async t => {
  const f = await domainAccessFixture(); t.after(() => f.close());
  const report = f.service.report({});
  assert.equal(report.summary.users, 25); assert.equal(report.summary.periodUsers, 25);
  assert.equal(report.summary.requests, 82); assert.equal(report.summary.unknown, 4);
  assert.equal(report.summary.history, 2);
  assert.equal(f.service.users({}).items.length, 20);
  assert.equal(f.service.users({ page: '2' }).items.length, 5);
  assert.equal(f.service.requests({ identity: 'ambiguous' }).total, 1);
  assert.equal(f.service.detail(requestId('conflict')).user_id, 0);
  assert(!f.service.users({}).items.some(row => row.id === 1));
  assert(f.queries.some(sql => sql === 'BEGIN READ ONLY'));
  assert(f.queries.some(sql => sql.includes("request_snapshot->>'request_id'=ANY")));
  assert(!f.queries.some(sql => /\b(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/.test(sql)));
  assert(f.upstream.every(row => row.method === 'GET'));
  assert(!JSON.stringify(f.service.history({})).includes('SECRET'));
  assert.equal(f.service.history({}).items.find(row => row.evidence === 'referer').count, 1);
  assert.throws(() => f.service.notify({ domain: OLD, userIds: [1], state: 'notified', note: 'no' }, 'admin'), /名单/);
  assert.throws(() => f.service.notify({ domain: OLD, userIds: [999], state: 'notified', note: 'no' }, 'admin'), /名单/);
  assert.throws(() => f.service.report({ start: '2026-02-30' }), /日期/);
});

test('collector persists complete-line offsets, resumes partial UTF-8, rename, copytruncate and gzip without double counting', async t => {
  const f = await domainAccessFixture({ seed: false }); t.after(() => f.close());
  const file = path.join(f.logDir, 'domain-access.jsonl');
  const first = gatewayLine('first', f.now), second = gatewayLine('second', f.now - 1000, { ignored: '中文' });
  const bytes = Buffer.from(first + '\n' + second + '\n'), split = bytes.length - 8;
  await fs.writeFile(file, bytes.subarray(0, split)); await f.service.collector.run();
  assert.equal(f.service.requests({}).total, 1);
  const replacement = new DomainAccessStore(f.root, { now: () => f.now }); replacement.initialize();
  assert.equal(replacement.files().find(row => row.name === 'domain-access.jsonl').offset, Buffer.byteLength(first + '\n')); replacement.close();
  await fs.appendFile(file, bytes.subarray(split)); await f.service.collector.run();
  assert.equal(f.service.requests({}).total, 2);
  await fs.rename(file, file + '.1');
  await fs.writeFile(file, gatewayLine('third', f.now - 2000) + '\n'); await f.service.collector.run();
  assert.equal(f.service.requests({}).total, 3);
  await fs.writeFile(file, gatewayLine('fourth', f.now - 3000) + '\n' + gatewayLine('fifth', f.now - 4000) + '\n');
  await f.service.collector.run(); assert.equal(f.service.requests({}).total, 5);
  assert(f.service.status().gaps.some(gap => gap.reason === 'copytruncate_or_rewrite'));
  await fs.writeFile(file + '.2.gz', zlib.gzipSync(bytes));
  await f.service.collector.run(); await f.service.collector.run();
  assert.equal(f.service.requests({}).total, 5);
  assert.equal(f.store.files().find(row => row.name.endsWith('.gz')).done, true);
  const before = f.service.report({}).summary.requests;
  await fs.appendFile(file, gatewayLine('third', f.now - 2000) + '\n'); await f.service.collector.run();
  assert.equal(f.service.report({}).summary.requests, before);
});

test('collector bounds large/malformed lines, ignores other domains and old raw logs, and isolates ID collisions', async t => {
  const f = await domainAccessFixture(); t.after(() => f.close());
  const file = path.join(f.logDir, 'domain-access.jsonl'), count = f.service.report({}).summary.requests;
  await fs.appendFile(file, 'x'.repeat(90000) + '\nnot-json\n' + gatewayLine('foreign', f.now, { host: 'other.example.com' }) + '\n' +
    gatewayLine('too-old', f.now - 40 * 86400000) + '\n');
  await f.service.collector.run(); assert.equal(f.service.report({}).summary.requests, count);
  assert(f.service.status().invalid >= 2); assert(f.service.status().ignored >= 2);
  const existing = f.service.detail(requestId('u2-0'));
  await fs.appendFile(file, gatewayLine('u2-0', f.now, { host: 'yunhop.cc' }) + '\n'); await f.service.collector.run();
  assert.equal(f.service.detail(existing.id).identity, 'ambiguous');
  assert.equal(f.service.detail(existing.id).user_id, 0);
  assert.equal(f.service.report({}).summary.users, 25, 'other verified requests still establish the same user');
  assert.equal(f.service.report({}).summary.unknown, 5);
  assert(f.service.status().collisionAt);
});

test('identity source refuses client aliases and fails visibly for missing permissions or bounded result overflow', async t => {
  const f = await domainAccessFixture(); t.after(() => f.close());
  await f.identity('alias', 2, { snapshot: { client_request_id: requestId('pending') } });
  const result = await f.source.match([f.service.detail(requestId('pending'))]);
  assert.equal(result[0].identity, 'pending');
  const queries = [];
  const unavailable = new DomainAccessSource({ pool: { connect: async () => ({ query: async sql => {
    queries.push(sql); if (sql.includes('SELECT')) throw Object.assign(new Error('SECRET'), { code: '42501' }); return { rows: [] };
  }, release() {} }) } });
  assert.deepEqual(await unavailable.match([f.service.detail(requestId('pending'))]), []);
  assert.equal(unavailable.lastError, '42501'); assert(queries.includes('ROLLBACK'));
  const limited = new DomainAccessSource({ pool: { connect: async () => ({ query: async sql => ({ rows: sql.startsWith('EXPLAIN') ? [{ 'QUERY PLAN': [{ Plan: { 'Total Cost': 1 } }] }] : sql.includes('SELECT') ? Array(2001).fill({}) : [] }), release() {} }) } });
  assert.deepEqual(await limited.match([f.service.detail(requestId('pending'))]), []);
  assert.equal(limited.lastError, 'IDENTITY_RESULT_LIMIT');
  let executed = false, currentTime = f.now;
  const expensive = new DomainAccessSource({ now: () => currentTime, pool: { connect: async () => ({ query: async sql => {
    if (sql.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Total Cost': 99999 } }] }] };
    if (sql.startsWith('SELECT')) executed = true;
    return { rows: [] };
  }, release() {} }) } });
  assert.deepEqual(await expensive.match([f.service.detail(requestId('pending'))]), []);
  assert.equal(expensive.lastError, 'IDENTITY_QUERY_PLAN_LIMIT'); assert.equal(executed, false);
  assert.equal(expensive.retryAt, currentTime + 60000);
});

test('retention preserves daily user totals after raw expiry and notifications are auditable, persistent and independent', async t => {
  const f = await domainAccessFixture(); t.after(() => f.close());
  const initial = f.service.report({}).summary;
  f.store.prune({ rawDays: 1, summaryDays: 365 }, f.service.today());
  assert.equal(f.service.report({}).summary.requests, initial.requests);
  assert.equal(f.service.report({}).summary.users, initial.users);
  assert(f.service.requests({}).total < initial.requests);
  f.store.prune({ rawDays: 90, summaryDays: 365 }, f.service.today());
  const archived = parseLine(gatewayLine('late-archive-copy', f.now - 3 * 86400000), { now: f.now });
  f.store.ingest([archived]);
  assert.equal(f.service.report({}).summary.requests, initial.requests, 'retention extension cannot partially replace an archived day');
  f.service.notify({ domain: OLD, userIds: [2,3], state: 'notified', note: '邮件已人工通知' }, 'operator');
  assert.equal(f.service.users({ notification: 'notified' }).total, 2);
  assert.equal(f.service.user(2, {}).notifications[0].note, '邮件已人工通知');
  const second = new DomainAccessStore(f.root, { now: () => f.now }); second.initialize();
  assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM da_notifications').get().n, 2); second.close();
  assert.equal(f.messageStore.count(), 0);
  assert.throws(() => f.service.configure({ ...f.service.settings(), rawDays: 90, summaryDays: 30 }, 'admin'), /汇总/);
});

test('durable draft batch has stable per-user idempotency, partial results and retries; only drafts are created', async t => {
  const f = await domainAccessFixture(); t.after(() => f.close());
  f.failUsers.add(3); const key = crypto.randomUUID();
  const input = { domain: OLD, userIds: [2,3], title: '更换域名', content: '请更换为 https://yunhop.cc' };
  f.service.createDraft(input, 'operator', key); await f.service.draftWork;
  let batch = f.service.drafts(OLD)[0];
  assert.equal(batch.recipients[0].state, 'drafted'); assert.equal(batch.recipients[1].state, 'failed');
  assert.equal(f.messageStore.count(), 1); assert(f.messageStore.items().every(row => row.status === 'draft'));
  f.service.createDraft(input, 'operator', key); assert.equal(f.messageStore.count(), 1);
  assert.throws(() => f.service.createDraft({ ...input, content: 'different' }, 'operator', key), /内容不同/);
  f.failUsers.delete(3); f.service.retryDraft(key); await f.service.draftWork;
  batch = f.service.drafts(OLD)[0]; assert(batch.recipients.every(row => row.state === 'drafted'));
  assert.equal(f.messageStore.count(), 2); assert(f.messageStore.items().every(row => row.status === 'draft' && row.notifyMode === 'silent'));
  assert.equal(f.service.users({ notification: 'drafted' }).total, 2);
  await f.messages.remove(batch.recipients[0].messageId);
  assert.equal(f.service.users({ notification: 'drafted' }).total, 1);
  assert(f.upstream.every(row => row.method === 'GET'), 'draft creation never publishes or changes upstream data');
  assert.equal(f.service.user(3, {}).notifications.length, 0, 'a draft is never marked as notified');
});

test('CSV export uses selected filters and neutralizes spreadsheet formulas', async t => {
  const f = await domainAccessFixture(); t.after(() => f.close());
  f.store.db.prepare("UPDATE da_profiles SET name='=HYPERLINK(\"example\")' WHERE id=2").run();
  const csv = f.service.csv({ search: 'user2@example.com' });
  assert(csv.includes("'=HYPERLINK")); assert(csv.includes('user2@example.com')); assert(!csv.includes('user3@example.com'));
  assert.equal(csv.split('\r\n').length, 2);
});

test('drafts recheck current core recipient role and email instead of trusting a stale local profile', async t => {
  const f = await domainAccessFixture(); t.after(() => f.close());
  await f.database.query("UPDATE users SET role='admin' WHERE id=2");
  await f.database.query("UPDATE users SET email='different@example.com' WHERE id=3");
  f.service.createDraft({ domain: OLD, userIds: [2,3], title: '迁移', content: '迁移通知' }, 'operator', crypto.randomUUID());
  await f.service.draftWork;
  assert(f.service.drafts()[0].recipients.every(row => row.state === 'failed' && row.error === 'DOMAIN_RECIPIENT_CHANGED'));
  assert.equal(f.messageStore.count(), 0);
});

test('restart after a saved message but lost batch acknowledgement resumes the same durable idempotency key', async t => {
  const f = await domainAccessFixture(); let restarted, reopened;
  t.after(async () => { await restarted?.stop(); reopened?.close(); await f.close(); });
  const original = f.store.draft.bind(f.store);
  f.store.draft = (id, batch) => {
    if (batch?.recipients.some(row => row.state === 'drafted')) throw new Error('simulated batch write interruption');
    return original(id, batch);
  };
  const key = crypto.randomUUID();
  f.service.createDraft({ domain: OLD, userIds: [2], title: 'restart', content: 'restart proof' }, 'operator', key);
  await f.service.draftWork;
  assert.equal(f.messageStore.count(), 1);
  assert.equal(original(key).recipients[0].state, 'pending');
  await f.service.stop(); f.store.close();
  reopened = new DomainAccessStore(f.root, { now: () => f.now }); reopened.initialize();
  const reopenedMessages = new UserMessageStore(f.root); await reopenedMessages.initialize();
  f.messages.store = reopenedMessages;
  restarted = new DomainAccessService({ config: f.config, store: reopened, source: f.source, messages: f.messages, now: () => f.now });
  restarted.processDrafts(); await restarted.draftWork;
  assert.equal(reopenedMessages.count(), 1); assert.equal(reopened.draft(key).recipients[0].state, 'drafted');
});

test('bundled Nginx schema yields a parsable trusted record and excludes credentials and arbitrary URLs', async () => {
  const directory = path.join(__dirname, '..', 'integrations', 'domain-access');
  const http = await fs.readFile(path.join(directory, 'http.conf'), 'utf8');
  const proxy = await fs.readFile(path.join(directory, 'proxy-id.conf'), 'utf8');
  const format = http.split('log_format operations_domain_json escape=json')[1];
  const values = { time_iso8601: '2026-11-13T15:00:00+08:00', http_host: OLD, request_id: requestId('nginx'),
    upstream_http_x_request_id: requestId('nginx'), request_method: 'POST', operations_domain_path: '/v1/responses', status: '200' };
  const line = [...format.matchAll(/'([^']*)'/g)].map(match => match[1]).join('').replace(/\$([a-z_][a-z_0-9]*)/g, (_, key) => values[key]);
  assert.equal(parseLine(line, { now: Date.parse('2026-11-13T07:00:00Z') }).identity, 'pending');
  assert.match(proxy, /^proxy_set_header X-Request-ID \$request_id;$/m);
  assert.doesNotMatch(http, /\$(?:request_uri|args|http_authorization|http_cookie|request_body|remote_addr|http_user_agent)\b/);
  const compose = await fs.readFile(path.join(directory, 'compose.override.yaml'), 'utf8');
  assert.match(compose, /read_only: true/); assert.doesNotMatch(compose, /docker.sock|sub2api:/);
});

test('formal API requires administrator login, CSRF on writes and no-store; unknown identities cannot draft', async t => {
  const f = await domainAccessFixture(); t.after(() => f.close());
  const auth = new AuthService(f.config); t.after(() => auth.close());
  const app = createApp({ config: f.config, auth, database: {}, domainAccess: f.service, messages: f.messages,
    settings: { getStatus: () => ({ setupRequired: false }) } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/domain-access/report')).status, 401);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: f.config.adminPassword }) });
  const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/api/domain-access/report', { headers: { cookie } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const [url, method] of [['settings','PUT'],['notifications','POST'],['drafts','POST'],['drafts/' + crypto.randomUUID() + '/retry','POST']]) {
    assert.equal((await fetch(base + '/api/domain-access/' + url, { method, headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  }
  const rejected = await fetch(base + '/api/domain-access/drafts', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ domain: OLD, userIds: [999], title: 'test', content: 'test' }) });
  assert.equal(rejected.status, 409); assert.equal(f.messageStore.count(), 0);
  const accepted = await fetch(base + '/api/domain-access/drafts', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ domain: OLD, userIds: [2], title: 'test', content: 'test' }) });
  assert.equal(accepted.status, 202); await f.service.draftWork; assert.equal(f.messageStore.count(), 1);
  const csv = await fetch(base + '/api/domain-access/users.csv?search=user2%40example.com', { headers: { cookie } });
  assert.equal(csv.status, 200); assert(csv.headers.get('content-type').startsWith('text/csv')); assert((await csv.text()).includes('user2@example.com'));
});
