'use strict';

const http = require('http');
const path = require('node:path');
const { loadConfig, resolveDataDir } = require('./config');
const { createDatabase } = require('./db');
const { RuntimeSettingsStore } = require('./runtime-settings-store');
const { CostLedgerStore } = require('./cost-ledger-store');
const { DailyProfitStore } = require('./daily-profit-store');
const { UserMessageStore } = require('./user-message-store');
const { AuthService } = require('./auth');
const { SchemaInspector } = require('./schema-inspector');
const { Sub2ApiClient } = require('./sub2api-client');
const { ProviderMonitorClient } = require('./provider-monitor-client');
const { LatencyTelemetryStore } = require('./latency-telemetry-store');
const { LatencyService } = require('./services/latency-service');
const { MetricsService } = require('./services/metrics-service');
const { UserProfilesService } = require('./services/user-profiles-service');
const { CostAnalysisService } = require('./services/cost-analysis-service');
const { DailyProfitService } = require('./services/daily-profit-service');
const { UserMessagesService } = require('./services/user-messages-service');
const { BillingRecoveryService } = require('./services/billing-recovery-service');
const { BillingRecoveryStore } = require('./billing-recovery-store');
const { BillingImportStore } = require('./billing-import-store');
const { BillingImportSource } = require('./services/billing-import-source');
const { BillingImportLogs } = require('./services/billing-import-logs');
const { BillingImportService } = require('./services/billing-import-service');
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
  const billingRecoveryStore = new BillingRecoveryStore(path.join(config.dataDir, 'billing-recovery'));
  billingRecoveryStore.initialize();
  const billingRecovery = new BillingRecoveryService({ config, sub2api, providerMonitor, store: billingRecoveryStore });
  const telemetry = new LatencyTelemetryStore(config);
  try { telemetry.initialize(); } catch (error) {
    telemetry.close();
    telemetry.lastError = error.code || 'TELEMETRY_INITIALIZATION_FAILED';
    console.warn(`latency telemetry unavailable: ${telemetry.lastError}`);
  }
  const costStore = new CostLedgerStore(config.dataDir);
  await costStore.initialize();
  const messageStore = new UserMessageStore(config.dataDir);
  await messageStore.initialize();
  const messages = new UserMessagesService({ config, store: messageStore, sub2api });
  const auth = new AuthService(config, {
    onAdminToken: (token, expiresAt) => sub2api.setRuntimeToken(token, expiresAt),
    onAdminTokenCleared: (token) => sub2api.clearRuntimeToken(token)
  });
  const inspector = new SchemaInspector(database.read);
  const billingImportStore = new BillingImportStore(billingRecoveryStore);
  billingImportStore.initialize();
  const billingImports = new BillingImportService({ store: billingImportStore, recovery: billingRecovery,
    source: new BillingImportSource({ pool: database.read, inspector, recovery: billingRecovery,
      logs: new BillingImportLogs(config.billingLogDir) }) });
  billingImports.start();
  const metrics = new MetricsService(database.read, inspector, config);
  const profiles = new UserProfilesService(database.read, inspector, config);
  const latency = new LatencyService({ pool: database.read, inspector, config, providerMonitor, telemetry });
  const costAnalysis = new CostAnalysisService({
    pool: database.read,
    inspector,
    config,
    store: costStore,
    providerMonitor,
    sub2api
  });
  const dailyProfitStore = new DailyProfitStore(config.dataDir);
  dailyProfitStore.initialize();
  const dailyProfit = new DailyProfitService({ analysis: costAnalysis, store: dailyProfitStore, config });
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
    config, database, auth, inspector, metrics, profiles, latency, telemetry, costAnalysis, dailyProfit, messages, billingRecovery, billingImports, storage, retention, scheduler, sub2api, settings
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
  dailyProfit.start();
  billingRecovery.start();
  console.info(`operations-center listening on http://${config.bindHost}:${config.port}`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.info(`operations-center shutting down (${signal})`);
    scheduler.stop();
    await dailyProfit.stop();
    await billingImports.stop();
    await billingRecovery.stop();
    storage.stop();
    auth.close();
    await new Promise((resolve) => server.close(resolve));
    dailyProfitStore.close();
    billingRecoveryStore.close();
    telemetry.close();
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
