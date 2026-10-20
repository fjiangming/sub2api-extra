'use strict';

const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { AuthService } = require('../src/auth');
const { LatencyService } = require('../src/services/latency-service');
const { LatencyTelemetryStore } = require('../src/latency-telemetry-store');
const { profileFixture } = require('../tests/profile-fixture');

async function startPreview() {
  const now = new Date();
  const fixture = await profileFixture({ now: now.toISOString() });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-preview-'));
  const config = { ...fixture.config, env: 'test', authMode: 'local', trustProxy: false,
    adminUser: 'admin', adminPassword: 'latency-local-preview', sessionTtlMinutes: 120,
    cookieSecure: false, dataDir: directory, latencyTelemetry: { token: 'preview-only-token-0123456789abcdef', minFreeMb: 0, maxMb: 32 } };
  const telemetry = new LatencyTelemetryStore(config); telemetry.initialize();
  await fixture.database.engine.exec(`ALTER TABLE usage_logs ADD duration_ms integer, ADD first_token_ms integer,
    ADD stream boolean DEFAULT true, ADD reasoning_effort text, ADD request_id text, ADD upstream_request_id text;
    CREATE TABLE ops_error_logs (id bigserial, user_id bigint, account_id bigint, created_at timestamptz,
      model text, duration_ms integer, stream boolean, time_to_first_token_ms bigint, status_code integer, request_id text);`);
  const rows = Array.from({ length: 160 }, (_, index) => {
    const first = index === 0 ? 139499 : 10000 + (index * 3497) % 220000;
    return { user_id: 2 + index % 6, account_id: ['270', '243', '247'][index % 3],
      model: ['gpt-5', 'claude-sonnet-4-5', 'gpt-5-mini'][index % 3],
      request_id: `client:demo-client-${index}`, upstream_request_id: `demo-upstream-${index}`,
      created_at: new Date(now.getTime() - (index + 3) * 60000).toISOString(),
      stream: true, duration_ms: first + 11249, first_token_ms: first,
      reasoning_effort: index === 0 ? 'medium' : ['medium', 'high', 'max'][index % 3],
      input_tokens: 244 + index, output_tokens: 384, cache_creation_tokens: 0, cache_read_tokens: 237400 };
  });
  await fixture.database.engine.query(`INSERT INTO usage_logs (user_id, account_id, model, request_id, upstream_request_id,
    created_at, stream, duration_ms, first_token_ms, reasoning_effort, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
    SELECT * FROM jsonb_to_recordset($1::jsonb) r(user_id bigint, account_id bigint, model text, request_id text,
      upstream_request_id text, created_at timestamptz, stream boolean, duration_ms integer, first_token_ms integer,
      reasoning_effort text, input_tokens integer, output_tokens integer, cache_creation_tokens integer, cache_read_tokens integer)`, [JSON.stringify(rows)]);
  const first = rows[0];
  const stages = [[0, 'request_start'], [30, 'body_read'], [80, 'prepare_start'], [100, 'attempt_start'],
    [120, 'rewrite_end'], [130, 'get_conn'], [400, 'got_conn'], [118000, 'wrote_request'],
    [118100, 'response_headers'], [118200, 'first_sse'], [139499, 'first_semantic'], [139500, 'first_content'],
    [150748, 'attempt_end'], [150749, 'request_end']];
  telemetry.ingest({ type: 'events', events: stages.map(([elapsedMs, name], sequence) => ({
    requestId: 'demo-root-0', sequence, name, elapsedMs,
    ...(sequence >= 3 && name !== 'request_end' ? { attemptId: '1' } : {}),
    at: new Date(Date.parse(first.created_at) + elapsedMs).toISOString(),
    attributes: { host: 'gateway-demo', accountId: '270', model: first.model, effort: 'medium',
      ...(name === 'response_headers' ? { upstreamRequestId: first.upstream_request_id } : {}),
      ...(name === 'request_end' ? { outcome: 'completed', usageRequestId: first.request_id } : {}) }
  })) });
  telemetry.ingest({ type: 'proxy', requestId: 'demo-root-0', at: new Date().toISOString(),
    requestTimeMs: 150900, upstreamConnectMs: 1, upstreamHeaderMs: 118100, upstreamResponseMs: 150800,
    requestBytes: 14660000, sentBytes: 65536, statusCode: 200, cfRayId: 'demo-ray' });
  telemetry.ingest({ type: 'events', events: [{ requestId: 'demo-active-1', sequence: 0,
    name: 'request_start', elapsedMs: 0, at: new Date(now.getTime() - 90000).toISOString(),
    attributes: { host: 'gateway-demo', accountId: '270', model: 'gpt-5', effort: 'high' } },
  { requestId: 'demo-active-1', sequence: 1, name: 'wrote_request', elapsedMs: 1000,
    at: new Date(now.getTime() - 89000).toISOString(), attributes: {} }] });
  for (let index = 0; index < 240; index += 1) telemetry.ingest({ type: 'resource', host: 'gateway-demo',
    at: new Date(now.getTime() - (240 - index) * 15000).toISOString(),
    cpuPercent: 15 + Math.sin(index / 9) * 8, stealPercent: index % 31 < 4 ? 18 : 2,
    iowaitPercent: 0.5, memoryAvailableBytes: 4.6 * 1073741824, memoryTotalBytes: 8 * 1073741824,
    swapUsedBytes: 0, diskAvailableBytes: 70 * 1073741824, diskTotalBytes: 80 * 1073741824,
    diskReadBytesPerSecond: 128000, diskWriteBytesPerSecond: 256000,
    networkRxBytesPerSecond: 200000 + index * 1700, networkTxBytesPerSecond: 1400000 + Math.sin(index / 7) * 400000,
    tcpRetransmitsPerSecond: index % 31 < 4 ? 3 : 0.1 });
  const providerMonitor = { configured: () => true, getLatencySamples: async ({ accountId }) => ({
    items: rows.filter((row) => row.account_id === accountId).map((row) => ({ ...row, providerName: '本地演示供应商',
      request_id: row.upstream_request_id, first_token_ms: row === first ? 21610 : row.first_token_ms - 5000,
      duration_ms: row === first ? 32940 : row.duration_ms - 5000 })),
    mappings: [{ providerName: '本地演示供应商', scope: 'history', keyMapped: true,
      lastSyncAt: now.toISOString(), coverage: { status: 'success' } }], truncated: false
  }) };
  const latency = new LatencyService({ pool: fixture.database, inspector: fixture.inspector, config, providerMonitor, telemetry });
  const report = latency.report.bind(latency);
  latency.report = async (input) => { const result = await report(input); return { ...result, warnings: ['当前为隔离的本地演示数据，不连接真实业务。', ...result.warnings] }; };
  const auth = new AuthService(config);
  const app = createApp({ config, auth, database: fixture.database, inspector: fixture.inspector, latency, telemetry,
    settings: { getStatus: () => ({ setupRequired: false }) } });
  const outer = express();
  outer.get('/preview', async (req, res, next) => {
    try { await auth.login(req, res, { username: config.adminUser, password: config.adminPassword }); res.redirect('/#latency'); }
    catch (error) { next(error); }
  });
  outer.use(app);
  let port = Number(process.env.LATENCY_PREVIEW_PORT || 19872), server;
  while (!server) {
    try {
      server = await new Promise((resolve, reject) => {
        const candidate = outer.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(candidate)); candidate.once('error', reject);
      });
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; port += 1; }
  }
  console.log(`Latency preview: http://127.0.0.1:${port}/preview`);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    auth.close();
    try { await new Promise((resolve) => server.close(resolve)); }
    finally {
      telemetry.close();
      try { await fixture.database.close(); }
      finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
  };
  return { port, stop };
}

if (require.main === module) startPreview().then(({ stop }) => {
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
}).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { startPreview };
