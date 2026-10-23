'use strict';

// Isolated local demonstration. No production database, credentials, supplier
// connection or inference request is used; settlement only changes demo state.
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');
const { loadConfig } = require('../src/config');
const { BillingRecoveryStore } = require('../src/billing-recovery-store');
const { BillingImportStore } = require('../src/billing-import-store');
const { BillingImportService, manualUsage } = require('../src/services/billing-import-service');
const { normalizeSources } = require('../src/services/billing-import-source');

const sample = `Time,API Key Name,Model,Input Tokens,Output Tokens,Cache Read Tokens,Cache Creation Tokens,Duration (ms),Billed Cost,Type,Billing Mode
2026-10-22T09:08:08+08:00,demo-key,claude-opus-5-5,4964,13212,0,0,174000,0.224436,Sync,按量
2026-10-22T09:09:08+08:00,demo-key,gpt-5,6366,3653,0,0,46240,0.077834,Sync,按量
2026-10-22T09:10:08+08:00,demo-key,gemini-2.5-pro,1000,3000,0,0,95000,0.05,Sync,按量
2026-10-22T09:11:08+08:00,demo-key,claude-opus-5-5,5746,12855,0,0,165000,0.221266,Sync,按量
2026-10-22T09:12:08+08:00,demo-key,claude-opus-5-5,5198,16003,0,0,208000,0.269273,Sync,按量
2026-10-22T09:08:08+08:00,demo-key,claude-opus-5-5,4964,13212,0,0,174000,0.224436,Sync,按量
`;

async function startPreview() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-import-preview-'));
  const config = loadConfig({ NODE_ENV: 'test', OPERATIONS_CENTER_AUTH_MODE: 'local', OPERATIONS_CENTER_ADMIN_PASSWORD: crypto.randomBytes(24).toString('hex') });
  const auth = new AuthService(config);
  const persistent = new BillingRecoveryStore(directory); persistent.initialize();
  const store = new BillingImportStore(persistent); store.initialize();
  const caseID = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const entry = (number, model, user, time, subscription = false) => ({ id: caseID(number), version: 1, state: 'unknown',
    user_id: user, api_key_id: user + 100, account_id: 356, group_id: 15, subscription_id: subscription ? 7 : null,
    platform: model.startsWith('gpt') ? 'openai' : 'anthropic', model, created_at: time, updated_at: time,
    request_snapshot: { user_email: `demo-user-${user}@example.test`, api_key_name: `demo-key-${user}`, account_name: '演示上游',
      pricing: { eligible: true }, request_id: `demo-root-${number}` } });
  const entries = new Map([
    [caseID(1), entry(1, 'claude-opus-5-5', 11, '2026-10-22T01:08:08Z')],
    [caseID(2), entry(2, 'gpt-5', 12, '2026-10-22T01:09:08Z', true)]
  ]);
  const rule = { input: 5, output: 25, cacheRead: 0.5, cache5m: 6.25, cache1h: 10, multiplier: 0.7, accountMultiplier: 1 };
  const recovery = {
    status: () => ({ automaticEnabled: false }),
    list: async ({ state }) => { const items = [...entries.values()].filter(row => !state || row.state === state); return { items, total: items.length }; },
    detail: async id => ({ case: structuredClone(entries.get(id)), events: [] }),
    request: async (url, { body }) => url === '/imports/reserve' ? { case_id: body.case_id } : {
      usage_record: manualUsage({ model: entries.get(url.split('/')[1]).model, stream: false }, body.tokens, rule)
    },
    restore: async (id, body) => { const row = entries.get(id); row.usage_record = structuredClone(body.usage_record); row.state = 'review'; row.version++; },
    review: async (id, body) => { const row = entries.get(id); row.state = body.state; row.version++; },
    settle: async id => { const row = entries.get(id); row.state = 'settled'; row.version++; }
  };
  const errors = [13, 14].map(user => ({ id: String(user), user_id: String(user), api_key_id: String(user + 100), account_id: '356', group_id: '15',
    user_email: `demo-user-${user}@example.test`, request_id: `demo-error-${user}`, model: 'claude-opus-5-5', created_at: '2026-10-22T01:13:13Z', response_latency_ms: 125000 }));
  const source = { accounts: async () => [{ id: '356', name: '演示上游 / demo-key', platform: 'anthropic' }],
    load: async () => ({ coreAvailable: true, candidates: normalizeSources(errors, [{ id: '20', user_id: '15', api_key_id: '115',
      account_id: '356', model: 'gemini-2.5-pro', created_at: '2026-10-22T01:11:43Z', duration_ms: 95000,
      input_tokens: 1000, output_tokens: 3000, cache_read_tokens: 0, cache_creation_tokens: 0 }], [...entries.values()]) }) };
  const imports = new BillingImportService({ store, source, recovery });
  const batch = await imports.import({ fileName: '演示账单.csv', csv: sample });
  await imports.match(batch.id, { accountMappings: { 'demo-key': 356 } });
  const app = createApp({ config, auth, database: { configured: () => false }, billingRecovery: recovery, billingImports: imports,
    settings: { getStatus: () => ({ setupRequired: false }) } });
  const outer = express();
  outer.get('/preview', async (req, res, next) => {
    try { await auth.login(req, res, { username: config.adminUser, password: config.adminPassword }); res.redirect('/#billing'); }
    catch (error) { next(error); }
  });
  outer.get('/sample.csv', (_req, res) => res.type('text/csv').send(sample));
  outer.use(app);
  let port = Number(process.env.BILLING_IMPORT_PREVIEW_PORT || 19876), server;
  while (!server) {
    try {
      server = await new Promise((resolve, reject) => {
        const candidate = outer.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(candidate)); candidate.once('error', reject);
      });
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; port++; }
  }
  console.log(`CSV billing preview (demo data only): http://127.0.0.1:${port}/preview`);
  let stopped = false;
  return { port, async stop() {
    if (stopped) return; stopped = true;
    auth.close();
    await new Promise(resolve => server.close(resolve));
    persistent.close(); fs.rmSync(directory, { force: true, recursive: true });
  } };
}

if (require.main === module) startPreview().then(({ stop }) => {
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
}).catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { startPreview, sample };
