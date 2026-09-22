'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { parseDateRange, dateInTimezone } = require('../src/services/metrics-service');

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    OPERATIONS_CENTER_ADMIN_PASSWORD: 'correct-horse-battery',
    SUB2API_DATABASE_URL: 'postgresql://reader@example.test/sub2api',
    ...overrides
  };
}

test('cleanup requires an explicit maintenance connection', () => {
  assert.throws(
    () => loadConfig(baseEnv({ OPERATIONS_CENTER_ENABLE_CLEANUP: 'true' })),
    /SUB2API_MAINTENANCE_DATABASE_URL/
  );
  const config = loadConfig(baseEnv({
    OPERATIONS_CENTER_ENABLE_CLEANUP: 'true',
    SUB2API_MAINTENANCE_DATABASE_URL: 'postgresql://maintainer@example.test/sub2api'
  }));
  assert.equal(config.cleanupEnabled, true);
  assert.match(config.maintenanceDatabaseUrl, /^postgresql:/);
});

test('invalid IANA timezone is rejected', () => {
  assert.throws(() => loadConfig(baseEnv({ SUB2API_TIMEZONE: 'Mars/Olympus' })), /IANA/);
});

test('Sub2API SSO mode does not require local or upstream account passwords', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    OPERATIONS_CENTER_AUTH_MODE: 'sub2api',
    SUB2API_BASE_URL: 'http://sub2api.internal:8080',
    SUB2API_PUBLIC_URL: 'https://sub2api.example.test',
    SUB2API_DATABASE_URL: 'postgresql://reader@example.test/sub2api'
  });
  assert.equal(config.authMode, 'sub2api');
  assert.equal(config.adminPassword, '');
  assert.equal(config.sub2apiAdminEmail, null);
  assert.equal(config.sub2apiAdminPassword, null);
  assert.equal(config.sub2apiPublicUrl, 'https://sub2api.example.test');
});

test('local mode still requires an independent administrator password', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    OPERATIONS_CENTER_AUTH_MODE: 'local',
    SUB2API_DATABASE_URL: 'postgresql://reader@example.test/sub2api'
  }), /local 认证模式/);
});

test('database can be configured after startup and managed settings override deployment placeholders', () => {
  const initial = loadConfig({
    NODE_ENV: 'test',
    OPERATIONS_CENTER_ADMIN_PASSWORD: 'correct-horse-battery'
  });
  assert.equal(initial.databaseUrl, null);
  assert.equal(initial.databaseSource, 'none');

  const managed = loadConfig(baseEnv(), {
    database: {
      readUrl: 'postgresql://managed-reader@example.test/sub2api',
      maintenanceUrl: 'postgresql://managed-cleaner@example.test/sub2api',
      sslMode: 'require'
    }
  });
  assert.match(managed.databaseUrl, /managed-reader/);
  assert.equal(managed.databaseSource, 'managed');
  assert.equal(managed.maintenanceDatabaseSource, 'managed');
  assert.equal(managed.databaseSsl, 'require');

  const managedReadOnly = loadConfig(baseEnv({
    SUB2API_MAINTENANCE_DATABASE_URL: 'postgresql://old-cleaner@example.test/sub2api'
  }), {
    database: { readUrl: 'postgresql://managed-reader@example.test/sub2api', maintenanceUrl: null }
  });
  assert.equal(managedReadOnly.maintenanceDatabaseUrl, null);
  assert.equal(managedReadOnly.maintenanceDatabaseSource, 'none');
});

test('managed credential settings can explicitly keep Sub2API account passwords optional', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    OPERATIONS_CENTER_ADMIN_PASSWORD: 'correct-horse-battery',
    ADMIN_EMAIL: 'deployment@example.test',
    ADMIN_PASSWORD: 'deployment-password'
  }, {
    sub2api: { clearPersistentCredentials: true }
  });
  assert.equal(config.sub2apiAdminEmail, null);
  assert.equal(config.sub2apiAdminPassword, null);
  assert.equal(config.sub2apiCredentialSource, 'session');

  const account = loadConfig({
    NODE_ENV: 'test',
    OPERATIONS_CENTER_ADMIN_PASSWORD: 'correct-horse-battery',
    SUB2API_ADMIN_TOKEN: 'old-deployment-token'
  }, {
    sub2api: { adminToken: null, adminEmail: 'managed@example.test', adminPassword: 'managed-password' }
  });
  assert.equal(account.sub2apiAdminToken, null);
  assert.equal(account.sub2apiAdminEmail, 'managed@example.test');
  assert.equal(account.sub2apiCredentialSource, 'managed');
});

test('automatic cleanup requires the complete destructive safety configuration', () => {
  assert.throws(() => loadConfig(baseEnv({
    OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED: 'true'
  })), /OPERATIONS_CENTER_ENABLE_CLEANUP/);

  assert.throws(() => loadConfig(baseEnv({
    OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED: 'true',
    OPERATIONS_CENTER_ENABLE_CLEANUP: 'true',
    SUB2API_MAINTENANCE_DATABASE_URL: 'postgresql://maintainer@example.test/sub2api',
    OPERATIONS_CENTER_REQUIRE_FRESH_BACKUP: 'false'
  })), /新鲜备份/);

  const loaded = loadConfig(baseEnv({
    OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED: 'true',
    OPERATIONS_CENTER_ENABLE_CLEANUP: 'true',
    SUB2API_MAINTENANCE_DATABASE_URL: 'postgresql://maintainer@example.test/sub2api',
    SUB2API_BASE_URL: 'https://sub2api.example.test',
    SUB2API_ADMIN_TOKEN: 'managed-admin-token',
    OPERATIONS_CENTER_AUTO_CLEANUP_TIME: '04:15',
    OPERATIONS_CENTER_AUTO_CLEANUP_TARGETS: 'system_logs,ops_metrics,system_logs'
  }));
  assert.deepEqual(loaded.automaticCleanup, {
    enabled: true,
    time: '04:15',
    targets: ['system_logs', 'ops_metrics'],
    backupWaitMinutes: 10
  });
});

test('automatic cleanup rejects unknown targets and backup waits beyond preview validity', () => {
  assert.throws(() => loadConfig(baseEnv({
    OPERATIONS_CENTER_AUTO_CLEANUP_TARGETS: 'system_logs,users'
  })), /Invalid option/);
  assert.throws(() => loadConfig(baseEnv({
    OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED: 'true',
    OPERATIONS_CENTER_ENABLE_CLEANUP: 'true',
    SUB2API_MAINTENANCE_DATABASE_URL: 'postgresql://maintainer@example.test/sub2api',
    SUB2API_BASE_URL: 'https://sub2api.example.test',
    SUB2API_ADMIN_TOKEN: 'managed-admin-token',
    OPERATIONS_CENTER_PREVIEW_TTL_MINUTES: '10',
    OPERATIONS_CENTER_AUTO_CLEANUP_BACKUP_WAIT_MINUTES: '9'
  })), /预览有效期/);
});

test('SSO mode may start automatic cleanup without stored Sub2API account credentials', () => {
  const loaded = loadConfig({
    NODE_ENV: 'production',
    OPERATIONS_CENTER_AUTH_MODE: 'sub2api',
    SUB2API_DATABASE_URL: 'postgresql://reader@example.test/sub2api',
    SUB2API_MAINTENANCE_DATABASE_URL: 'postgresql://maintainer@example.test/sub2api',
    SUB2API_BASE_URL: 'https://sub2api.example.test',
    OPERATIONS_CENTER_ENABLE_CLEANUP: 'true',
    OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED: 'true'
  });
  assert.equal(loaded.automaticCleanup.enabled, true);
  assert.equal(loaded.sub2apiAdminToken, null);
});

test('date ranges are inclusive and bounded', () => {
  assert.deepEqual(parseDateRange({ start: '2026-09-01', end: '2026-09-30' }), {
    start: '2026-09-01',
    end: '2026-09-30',
    endExclusive: '2026-10-01',
    days: 30
  });
  assert.throws(() => parseDateRange({ start: '2026-10-01', end: '2026-09-30' }), /结束日期/);
  assert.throws(() => parseDateRange({ start: '2020-01-01', end: '2026-01-01' }, { maxDays: 30 }), /最多 30 天/);
});

test('timezone date does not silently use UTC', () => {
  const instant = new Date('2026-09-20T16:30:00Z');
  assert.equal(dateInTimezone('UTC', instant), '2026-09-20');
  assert.equal(dateInTimezone('Asia/Shanghai', instant), '2026-09-21');
});
