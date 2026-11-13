'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { DomainAccessStore } = require('../src/domain-access-store');
const { DomainAccessSource } = require('../src/services/domain-access-source');
const { DomainAccessService } = require('../src/services/domain-access-service');
const { UserMessageStore } = require('../src/user-message-store');
const { UserMessagesService } = require('../src/services/user-messages-service');
const { loadConfig } = require('../src/config');

const OLD = 'epoint2api.fjmooo.cn', TARGET = 'yunhop.cc';
const requestId = seed => crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 32);
function gatewayLine(seed, at, extra = {}) {
  const id = requestId(seed);
  return JSON.stringify({ version: 1, source: 'operations-domain-gateway', gateway_id: id, backend_id: id,
    at: new Date(at).toISOString(), host: OLD, method: 'POST', path: '/v1/responses', status: '200', ...extra });
}
async function domainAccessFixture({ now = Date.parse('2026-11-13T07:00:00Z'), seed = true, directory = null } = {}) {
  const root = directory || await fs.mkdtemp(path.join(os.tmpdir(), 'sub2api-domain-live-'));
  const logDir = path.join(root, 'logs'); await fs.mkdir(path.join(logDir, 'history'), { recursive: true });
  const database = new PGlite();
  await database.exec(`CREATE SCHEMA sub2api_custom;
    CREATE TABLE public.users(id BIGINT PRIMARY KEY,username TEXT,email TEXT,role TEXT,deleted_at TIMESTAMPTZ);
    CREATE TABLE sub2api_custom.billing_recovery(id TEXT PRIMARY KEY,user_id BIGINT,api_key_id BIGINT,created_at TIMESTAMPTZ,request_snapshot JSONB);`);
  const queries = [], upstream = [], failUsers = new Set();
  const pool = { configured: () => true, connect: async () => ({
    query: async (sql, args) => { queries.push(sql); return database.query(sql, args); }, release() {} }) };
  const store = new DomainAccessStore(root, { now: () => now }); store.initialize();
  const messageStore = new UserMessageStore(root); await messageStore.initialize();
  const config = loadConfig({ NODE_ENV: 'test', OPERATIONS_CENTER_ADMIN_PASSWORD: 'domain-access-local-preview',
    OPERATIONS_CENTER_DOMAIN_ACCESS_LOG_DIR: logDir });
  const sub2api = { raw: async (url, options) => {
    upstream.push({ url, method: options.method || 'GET' });
    const id = Number(/\/users\/(\d+)$/.exec(url)?.[1]);
    if (!id || failUsers.has(id)) throw Object.assign(new Error('fixture user unavailable'), { code: 'FIXTURE_USER_UNAVAILABLE' });
    const user = (await database.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    if (!user) throw new Error('fixture user missing');
    return { code: 0, data: user };
  } };
  const messages = new UserMessagesService({ config, store: messageStore, sub2api });
  const source = new DomainAccessSource({ pool, now: () => now });
  const service = new DomainAccessService({ config, store, source, messages, now: () => now });
  async function identity(seedId, userId, { keyId = userId * 10, at = now - 60000, caseId = 'case-' + seedId,
    snapshot = { request_id: requestId(seedId) } } = {}) {
    await database.query('INSERT INTO sub2api_custom.billing_recovery VALUES ($1,$2,$3,$4,$5)',
      [caseId, userId, keyId, new Date(at).toISOString(), snapshot]);
  }
  if (seed) {
    const lines = [];
    for (let userId = 1; userId <= 26; userId++) {
      await database.query('INSERT INTO users VALUES ($1,$2,$3,$4,NULL)',
        [userId, userId === 1 ? '示例管理员' : `示例用户 ${String(userId).padStart(2,'0')}`, `user${userId}@example.com`, userId === 1 ? 'admin' : 'user']);
      for (let index = 0; index < 3; index++) {
        const seedId = `u${userId}-${index}`, at = now - ((userId % 6) * 86400000) - index * 300000 - 60000;
        lines.push(gatewayLine(seedId, at)); await identity(seedId, userId, { at });
      }
      const seedId = `new-${userId}`, at = now - 600000;
      lines.push(gatewayLine(seedId, at, { host: TARGET })); await identity(seedId, userId, { at });
    }
    lines.push(gatewayLine('pending', now - 50000));
    lines.push(gatewayLine('conflict', now - 40000));
    await identity('conflict', 2); await identity('conflict', 3, { caseId: 'case-conflict-two' });
    lines.push(gatewayLine('unverified', now - 30000, { backend_id: requestId('forged-client') }));
    lines.push(gatewayLine('browser', now - 20000, { method: 'GET', path: '/' }));
    await fs.writeFile(path.join(logDir, 'domain-access.jsonl'), lines.join('\n') + '\n');
    await fs.writeFile(path.join(logDir, 'history', 'legacy.log'),
      `192.0.2.1 - - [12/Nov/2026:19:00:00 +0800] "GET /v1/models?key=SECRET HTTP/1.1" 200 42 "https://${OLD}/?token=SECRET" "EXAMPLE AGENT"\n` +
      `2026/11/12 19:01:00 [error] 1#1: *1 example error, request: "POST /v1/responses HTTP/1.1", host: "${OLD}"\n`);
    await service.tick(); await service.tick();
  }
  return { root, logDir, config, now, store, database, source, service, messages, messageStore, pool, queries, upstream, failUsers, identity,
    async close({ keep = false } = {}) { await service.stop(); store.close(); await database.close(); if (!keep) await fs.rm(root, { recursive: true, force: true }); } };
}
module.exports = { domainAccessFixture, gatewayLine, requestId, OLD, TARGET };
