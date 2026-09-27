'use strict';

const http = require('http');
const { loadConfig, resolveDataDir } = require('./config');
const { createDatabase } = require('./db');
const { RuntimeSettingsStore } = require('./runtime-settings-store');
const { CostLedgerStore } = require('./cost-ledger-store');
const { AuthService } = require('./auth');
const { SchemaInspector } = require('./schema-inspector');
const { Sub2ApiClient } = require('./sub2api-client');
const { ProviderMonitorClient } = require('./provider-monitor-client');
const { MetricsService } = require('./services/metrics-service');
const { CostAnalysisService } = require('./services/cost-analysis-service');
const { StorageService } = require('./services/storage-service');
const { RetentionService } = require('./services/retention-service');
const { CleanupScheduler } = require('./services/cleanup-scheduler');
const { SystemSettingsService } = require('./services/system-settings-service');
const { createApp } = require('./app');

async function main() {
  const settingsStore = new RuntimeSettingsStore(resolveDataDir());
  const runtimeSettings = await settingsStore.initialize();
  const config = loadConfig(process.env, runtimeSettings);
  const database = createDatabase(config);
  const sub2api = new Sub2ApiClient(config);
  const providerMonitor = new ProviderMonitorClient(config);
  const costStore = new CostLedgerStore(config.dataDir);
  await costStore.initialize();
  const auth = new AuthService(config, {
    onAdminToken: (token, expiresAt) => sub2api.setRuntimeToken(token, expiresAt),
    onAdminTokenCleared: (token) => sub2api.clearRuntimeToken(token)
  });
  const inspector = new SchemaInspector(database.read);
  const metrics = new MetricsService(database.read, inspector, config);
  const costAnalysis = new CostAnalysisService({
    pool: database.read,
    inspector,
    config,
    store: costStore,
    providerMonitor,
    sub2api
  });
  const storage = new StorageService(database.read, inspector, config);
  const retention = new RetentionService({
    readPool: database.read,
    maintenancePool: database.maintenance,
    inspector,
    sub2api,
    config
  });
  const scheduler = new CleanupScheduler({ retention, config });
  const settings = new SystemSettingsService({
    config,
    database,
    settingsStore,
    inspector,
    storage,
    retention,
    scheduler,
    sub2api
  });
  const app = createApp({
    config, database, auth, inspector, metrics, costAnalysis, storage, retention, scheduler, sub2api, settings
  });
  const server = http.createServer(app);
  server.requestTimeout = 120000;
  server.headersTimeout = 65000;
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindHost, resolve);
  });
  storage.start();
  scheduler.start();
  console.info(`operations-center listening on http://${config.bindHost}:${config.port}`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.info(`operations-center shutting down (${signal})`);
    scheduler.stop();
    storage.stop();
    auth.close();
    await new Promise((resolve) => server.close(resolve));
    await database.close();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
  process.on('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
