const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { createDatabase } = require('../src/db');

function createTestContext(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-monitor-test-'));
  const databasePath = path.join(directory, 'test.db');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PROVIDER_MONITOR_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    PROVIDER_MONITOR_DATABASE: databasePath,
    PROVIDER_MONITOR_DATA_DIR: directory,
    PROVIDER_MONITOR_AUTH_MODE: 'local',
    PROVIDER_MONITOR_LOCAL_ADMIN_USER: 'admin',
    PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD: 'test-password',
    PROVIDER_MONITOR_METRICS_ENABLED: 'false',
    PROVIDER_MONITOR_ALLOWED_HOSTS: 'localhost,127.0.0.1',
    ...overrides
  };
  const config = loadConfig(env);
  const db = createDatabase(databasePath);
  return {
    directory,
    config,
    db,
    cleanup() {
      if (db.open) db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

module.exports = {
  createTestContext
};
