'use strict';

// Isolated local demonstration. No production database, credentials, supplier
// connection or inference request is used; settlement only changes demo state.
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');
const { loadConfig } = require('../src/config');
const { BillingRecoveryStore } = require('../src/billing-recovery-store');
const { BillingImportStore } = require('../src/billing-import-store');
const { BillingImportService, manualUsage } = require('../src/services/billing-import-service');
const { normalizeSources, billingImportWindow } = require('../src/services/billing-import-source');
const { buildLogCandidates } = require('../src/services/billing-import-logs');

const sample = `Time,API Key Name,Model,Input Tokens,Output Tokens,Cache Read Tokens,Cache Creation Tokens,Duration (ms),Billed Cost,Type,Billing Mode
2026-10-22T09:08:08+08:00,demo-key,claude-opus-5-5,4964,13212,0,0,174000,0.224436,Sync,按量
2026-10-22T09:09:08+08:00,demo-key,gpt-5,6366,3653,0,0,46240,0.077834,Sync,按量
2026-10-22T09:10:08+08:00,demo-key,gemini-2.5-pro,1000,3000,0,0,95000,0.05,Sync,按量
2026-10-22T09:11:08+08:00,demo-key,claude-opus-5-5,5746,12855,0,0,165000,0.221266,Sync,按量
2026-10-22T09:12:08+08:00,demo-key,claude-opus-5-5,5198,16003,0,0,208000,0.269273,Sync,按量
2026-10-22T09:08:08+08:00,demo-key,claude-opus-5-5,4964,13212,0,0,174000,0.224436,Sync,按量
2026-10-22T09:20:00+08:00,demo-key,gpt-4.1,21,52,0,0,10000,0.001,Sync,按量
2026-10-22T09:21:00+08:00,demo-key,gemini-flash,22,53,0,0,10000,0.001,Sync,按量
2026-10-22T09:22:00+08:00,demo-key,claude-opus-5-5,503,1934,0,0,210000,0.3,Sync,按量
2026-10-22T09:23:00+08:00,demo-key,gpt-5.2,23,54,0,0,20000,0.001,Sync,按量
`;
const groupSample = sample + `2026-10-22T09:30:00+08:00,demo-key,claude-opus-5-5,1200,4500,0,0,210000,0.11,Sync,按量
2026-10-22T09:30:01+08:00,demo-key,claude-opus-5-5,1400,4700,0,0,210000,0.12,Sync,按量
`;
function makeManySample(count = 21) {
  const rows = [];
  for (let index = 0; index < 3; index++) rows.push({ Time: '2026-10-22T09:00:10+08:00', Model: `preview-anchor-${index}`,
    'Input Tokens': '100', 'Output Tokens': String(200 + index), 'Duration (ms)': '10000', 'Billed Cost': '0.001' });
  for (let index = 0; index < count; index++) rows.push({
    Time: new Date(Date.parse('2026-10-22T01:30:10Z') + index * 60000).toISOString(),
    Model: 'claude-opus-5-5', 'Input Tokens': '503', 'Output Tokens': '1934',
    'Duration (ms)': '10000', 'Billed Cost': '0.01'
  });
  const columns = sample.slice(0, sample.indexOf('\n'));
  const names = columns.split(','), defaults = Object.fromEntries(names.map((name, index) =>
    [name, sample.split('\n')[1].split(',')[index] || '']));
  return `${columns}\n${rows.map(row => names.map(name => row[name] ?? defaults[name] ?? '').map(value =>
    `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')}`;
}
const manySample = makeManySample();

async function portInUse(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    const finish = inUse => { socket.destroy(); resolve(inUse); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(true));
  });
}

async function startPreview({ port: requestedPort, includeGroups = false, includeMany = false, manyCount = 21 } = {}) {
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
  const manyAnchors = [];
  if (includeMany) {
    for (let index = 0; index < 3; index++) manyAnchors.push({ id: `anchor-${index}`, user_id: '15', api_key_id: '115',
      account_id: '356', group_id: '15', model: `preview-anchor-${index}`, created_at: '2026-10-22T01:00:10Z',
      duration_ms: 10000, billing_dedup: true, actual_cost: 0.001, input_tokens: 100, output_tokens: 200 + index,
      cache_read_tokens: 0, cache_creation_tokens: 0 });
    for (let index = 0; index < manyCount; index++) {
      const id = caseID(200 + index), start = new Date(Date.parse('2026-10-22T01:30:00Z') + index * 60000).toISOString();
      entries.set(id, entry(200 + index, 'claude-opus-5-5', 24, start));
      entries.get(id).updated_at = new Date(Date.parse(start) + 10000).toISOString();
    }
  }
  entries.get(caseID(1)).observed_usage = { output_tokens: 1000 };
  entries.set(caseID(3), { ...entry(3, 'claude-opus-5-5', 11, '2026-10-22T01:08:08Z'),
    observed_usage: { output_tokens: 14000 } });
  const rule = { input: 5, output: 25, cacheRead: 0.5, cache5m: 6.25, cache1h: 10, multiplier: 0.7, accountMultiplier: 1 };
  const claims = new Map(), groupReceipts = new Map(), claimEvidence = new Map();
  const ledger = { balances: new Map(), usageRecords: new Map(), charges: new Map() };
  const recovery = {
    status: () => ({ automaticEnabled: false }),
    list: async ({ state }) => { const items = [...entries.values()].filter(row => !state || row.state === state); return { items, total: items.length }; },
    detail: async id => ({ case: structuredClone(entries.get(id)), events: [] }),
    request: async (url, { body } = {}) => {
      if (url.startsWith('/imports/claims')) return { claims: [...claimEvidence.values()] };
      if (url === '/imports/reserve-group') {
        if (groupReceipts.has(body.identity)) return { claims: groupReceipts.get(body.identity) };
        const receipt = [];
        for (const member of body.members) {
          const result = await recovery.request('/imports/reserve', { body: member.source });
          receipt.push({ ...claimEvidence.get(member.source.bill_identity), case_id: result.case_id });
        }
        groupReceipts.set(body.identity, receipt);
        return { claims: receipt };
      }
      if (url === '/imports/reserve') {
        let id = body.case_id || claims.get(body.bill_identity);
        if (!id) {
          id = caseID(10000 + claims.size);
          const row = entry(10000 + claims.size, body.model, body.user_id, body.started_at);
          row.api_key_id = body.api_key_id;
          row.request_snapshot = { request_id: body.log_source?.request_id, user_email: `demo-user-${body.user_id}@example.test` };
          entries.set(id, row); claims.set(body.bill_identity, id);
        }
        claimEvidence.set(body.bill_identity, { account_id: body.account_id, bill_identity: body.bill_identity,
          local_reference: body.case_id ? `case:${body.case_id}` : body.log_source ? `log:${body.log_source.request_id}` : `error:${body.error_id}:${body.event_index}`,
          case_id: id, user_id: body.user_id, api_key_id: body.api_key_id, group_id: 15, state: entries.get(id).state });
        return { case_id: id };
      }
      if (url === '/imports/quote') {
        const source = body.source, historical = Boolean(source.case_id);
        const prices = historical ? rule : { ...rule, multiplier: 0.9, accountMultiplier: 0.79 };
        return { usage_record: { ...manualUsage({ model: source.model, stream: false }, body.tokens, prices),
          UserID: source.user_id, APIKeyID: source.api_key_id, AccountID: source.account_id, GroupID: 15 },
        pricing_source: historical ? 'immutable_dispatch_snapshot' : 'current_sub2api_prices', pricing_at: new Date().toISOString() };
      }
      return { usage_record: manualUsage({ model: entries.get(url.split('/')[1]).model, stream: false }, body.tokens, rule) };
    },
    restore: async (id, body) => { const row = entries.get(id); row.usage_record = structuredClone(body.usage_record); row.state = 'review'; row.version++; },
    review: async (id, body) => { const row = entries.get(id); row.state = body.state; row.version++; },
    settle: async id => { const row = entries.get(id);
      if (row.state === 'settled') return;
      if (row.state !== 'prepared' || !row.usage_record) throw new Error('demo settlement requires prepared usage');
      ledger.usageRecords.set(id, structuredClone(row.usage_record));
      if (!row.subscription_id) {
        ledger.balances.set(String(row.user_id), Number(((ledger.balances.get(String(row.user_id)) ?? 100) - row.usage_record.ActualCost).toFixed(8)));
        ledger.charges.set(id, (ledger.charges.get(id) || 0) + 1);
      }
      row.state = 'settled'; row.version++;
      for (const claim of claimEvidence.values()) if (claim.case_id === id) claim.state = 'settled'; }
  };
  const errors = [13, 14].map(user => ({ id: String(user), user_id: String(user), api_key_id: String(user + 100), account_id: '356', group_id: '15',
    user_email: `demo-user-${user}@example.test`, request_id: `demo-error-${user}`, model: 'claude-opus-5-5', created_at: '2026-10-22T01:13:13Z', response_latency_ms: 125000 }));
  errors.push({ id: '11', user_id: '11', api_key_id: '111', account_id: '356', group_id: '15',
    request_id: 'demo-root-1', model: 'claude-opus-5-5', created_at: '2026-10-22T01:10:13Z', response_latency_ms: 125000 });
  if (includeGroups) for (let index = 0; index < 2; index++) errors.push({ id: String(30 + index), user_id: '24', api_key_id: '124', account_id: '356',
    group_id: '15', request_id: `demo-group-${index}`, model: 'claude-opus-5-5',
    user_email: 'demo-user-24@example.test', created_at: includeMany ? '2026-10-22T02:32:05Z' : '2026-10-22T01:32:05Z', response_latency_ms: 125000 });
  const common = { user_id: '15', api_key_id: '115', group_id: '15', account_id: '356', cache_read_tokens: 0, cache_creation_tokens: 0, billing_dedup: true, actual_cost: 0.001 };
  const logs = buildLogCandidates([
    { component: 'gateway', request_id: 'demo-file-only', ts: '2026-10-22T01:22:00Z', user_id: 22, api_key_id: 122, group_id: 15 },
    { component: 'gateway', request_id: 'demo-file-only', ts: '2026-10-22T01:22:00Z', selected_account_id: 356, model: 'claude-opus-5-5', stream: false },
    { component: 'http.access', request_id: 'demo-file-only', ts: '2026-10-22T01:24:05Z', account_id: 356, status_code: 499, latency_ms: 125000 }
  ], { accounts: ['356'], from: '2026-10-22T00:00:00Z', to: '2026-10-23T00:00:00Z' });
  for (const row of logs) { row.billingType = 'balance'; row.userEmail = `demo-user-${row.userId}@example.test`; }
  const source = { accounts: async () => [{ id: '356', name: '演示上游 / demo-key', platform: 'anthropic' }],
    load: async (records, options) => ({ coreAvailable: true, candidates: normalizeSources(errors, [...manyAnchors, { id: '20', user_id: '15', api_key_id: '115',
      account_id: '356', model: 'gemini-2.5-pro', created_at: '2026-10-22T01:11:43Z', duration_ms: 95000,
      group_id: '15', billing_dedup: true, actual_cost: 0.05,
      input_tokens: 1000, output_tokens: 3000, cache_read_tokens: 0, cache_creation_tokens: 0 },
    { ...common, id: '21', model: 'gpt-4.1', created_at: '2026-10-22T01:20:10Z', duration_ms: 10000, input_tokens: 21, output_tokens: 52 },
    { ...common, id: '22', model: 'gemini-flash', created_at: '2026-10-22T01:21:10Z', duration_ms: 10000, input_tokens: 22, output_tokens: 53 },
    { ...common, id: '23', model: 'gpt-5.2', created_at: '2026-10-22T01:23:20Z', duration_ms: 20000, input_tokens: 23, output_tokens: 54, billing_dedup: false, actual_cost: 0 }
    ], [...entries.values()], logs), claims: [...claimEvidence.values()], diagnostics: { window: billingImportWindow(records, options), claimsAvailable: true,
      native: { usages: 4, errors: errors.length, cases: entries.size },
      logs: { status: 'read', coverageComplete: false, first: '2026-10-22T01:22:00Z', last: '2026-10-22T01:24:05Z' } } }) };
  const imports = new BillingImportService({ store, source, recovery });
  imports.start();
  const demoCSV = includeMany ? makeManySample(manyCount) : includeGroups ? groupSample : sample;
  const batch = await imports.import({ fileName: '演示账单.csv', csv: demoCSV });
  if (!includeMany) await imports.match(batch.id, { accountMappings: { 'demo-key': 356 } });
  const app = createApp({ config, auth, database: { configured: () => false }, billingRecovery: recovery, billingImports: imports,
    settings: { getStatus: () => ({ setupRequired: false }) } });
  const outer = express();
  outer.get('/preview', async (req, res, next) => {
    try { await auth.login(req, res, { username: config.adminUser, password: config.adminPassword }); res.redirect('/#billing'); }
    catch (error) { next(error); }
  });
  outer.get('/sample.csv', (_req, res) => res.type('text/csv').send(demoCSV));
  outer.use(app);
  let port = requestedPort ?? Number(process.env.BILLING_IMPORT_PREVIEW_PORT || 19876), server;
  while (!server) {
    if (port && await portInUse(port)) { port++; continue; }
    try {
      server = await new Promise((resolve, reject) => {
        const candidate = outer.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(candidate)); candidate.once('error', reject);
      });
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; port++; }
  }
  port = server.address().port;
  console.log(`CSV billing preview (demo data only): http://127.0.0.1:${port}/preview`);
  let stopped = false;
  return { port, imports, ledger, async stop() {
    if (stopped) return; stopped = true;
    await imports.stop();
    auth.close();
    await new Promise(resolve => server.close(resolve));
    persistent.close(); fs.rmSync(directory, { force: true, recursive: true });
  } };
}

if (require.main === module) startPreview({ includeGroups: true }).then(({ stop }) => {
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
}).catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { startPreview, sample, groupSample, manySample, makeManySample };
