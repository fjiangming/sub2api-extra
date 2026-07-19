const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createTestContext } = require('./helpers');
const { ProviderRepository } = require('../src/repositories/provider-repository');
const { TransferService } = require('../src/services/transfer-service');

test('relative data paths resolve from the provider-monitor project directory', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PROVIDER_MONITOR_SECRET: 'relative-path-secret-0123456789abcdef',
    PROVIDER_MONITOR_AUTH_MODE: 'local',
    PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD: 'test-password',
    PROVIDER_MONITOR_DATA_DIR: './runtime-data',
    PROVIDER_MONITOR_DATABASE: './runtime-data/runtime.db'
  });
  const projectRoot = path.resolve(__dirname, '..');
  assert.equal(config.dataDir, path.join(projectRoot, 'runtime-data'));
  assert.equal(config.databasePath, path.join(projectRoot, 'runtime-data', 'runtime.db'));
});

test('the local server binds to loopback by default and supports a container override', () => {
  const baseEnv = {
    PROVIDER_MONITOR_SECRET: 'bind-host-secret-0123456789abcdefghi',
    PROVIDER_MONITOR_AUTH_MODE: 'local',
    PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD: 'test-password'
  };

  assert.equal(loadConfig(baseEnv).bindHost, '127.0.0.1');
  assert.equal(loadConfig({ ...baseEnv, PROVIDER_MONITOR_BIND_HOST: '0.0.0.0' }).bindHost, '0.0.0.0');
});

test('the server listens on port 9871 by default and supports an environment override', () => {
  const baseEnv = {
    PROVIDER_MONITOR_SECRET: 'port-default-secret-0123456789abcdef',
    PROVIDER_MONITOR_AUTH_MODE: 'local',
    PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD: 'test-password'
  };

  assert.equal(loadConfig(baseEnv).port, 9871);
  assert.equal(loadConfig({ ...baseEnv, PORT: '4321' }).port, 4321);
});

test('an empty private host list remains empty at runtime', (t) => {
  const context = createTestContext({ PROVIDER_MONITOR_ALLOWED_HOSTS: '' });
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const transfers = new TransferService({ db: context.db, config: context.config, providers });

  transfers.applyRuntimeSettings();

  assert.deepEqual(context.config.allowedHosts, []);
});

test('system settings persist runtime policy and update the shared config object', (t) => {
  const context = createTestContext({
    PROVIDER_MONITOR_AUTOMATION_ENABLED: 'false',
    PROVIDER_MONITOR_ALLOWED_ORIGINS: 'https://legacy.example',
    PROVIDER_MONITOR_ALLOWED_HOSTS: 'legacy.internal'
  });
  t.after(() => context.cleanup());
  const providers = new ProviderRepository(context.db, context.config);
  const transfers = new TransferService({ db: context.db, config: context.config, providers });

  transfers.applyRuntimeSettings();
  assert.deepEqual(context.config.allowedOrigins, ['https://legacy.example']);
  const settings = transfers.saveSettings({
    automationEnabled: true,
    allowedOrigins: ['https://console.example', 'https://console.example'],
    allowedHosts: 'supplier.internal, 10.0.0.8',
    allowPrivateNetworks: true,
    sessionTtlMinutes: 90,
    queryTimeoutMs: 20000,
    maxResponseBytes: 3145728,
    defaultRefreshMinutes: 20,
    staleAfterMinutes: 75,
    keyHealthConcurrency: 4,
    rawSnapshotRetentionDays: 45,
    snapshotRetentionDays: 240,
    jobRetentionDays: 120,
    auditRetentionDays: 500,
    notificationRetentionDays: 200
  });

  assert.equal(settings.automationEnabled, true);
  assert.deepEqual(settings.allowedOrigins, ['https://console.example']);
  assert.deepEqual(settings.allowedHosts, ['supplier.internal', '10.0.0.8']);
  assert.equal(context.config.automationEnabled, true);
  assert.equal(context.config.allowPrivateNetworks, true);
  assert.equal(context.config.sessionTtlMinutes, 90);
  assert.equal(context.config.maxResponseBytes, 3145728);

  const restartedConfig = {
    ...context.config,
    automationEnabled: false,
    allowedOrigins: [],
    allowedHosts: [],
    allowPrivateNetworks: false
  };
  const restarted = new TransferService({
    db: context.db,
    config: restartedConfig,
    providers: new ProviderRepository(context.db, restartedConfig)
  });
  restarted.applyRuntimeSettings();
  assert.equal(restartedConfig.automationEnabled, true);
  assert.deepEqual(restartedConfig.allowedOrigins, ['https://console.example']);
  assert.deepEqual(restartedConfig.allowedHosts, ['supplier.internal', '10.0.0.8']);
});
