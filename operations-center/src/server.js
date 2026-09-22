'use strict';

const http = require('http');
const { loadConfig } = require('./config');
const { createDatabase } = require('./db');
const { AuthService } = require('./auth');
const { SchemaInspector } = require('./schema-inspector');
const { Sub2ApiClient } = require('./sub2api-client');
const { MetricsService } = require('./services/metrics-service');
const { StorageService } = require('./services/storage-service');
const { RetentionService } = require('./services/retention-service');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const database = createDatabase(config);
  const auth = new AuthService(config);
  const inspector = new SchemaInspector(database.read);
  const sub2api = new Sub2ApiClient(config);
  const metrics = new MetricsService(database.read, inspector, config);
  const storage = new StorageService(database.read, inspector, config);
  const retention = new RetentionService({
    readPool: database.read,
    maintenancePool: database.maintenance,
    inspector,
    sub2api,
    config
  });
  const app = createApp({ config, database, auth, inspector, metrics, storage, retention, sub2api });
  const server = http.createServer(app);
  server.requestTimeout = 120000;
  server.headersTimeout = 65000;
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindHost, resolve);
  });
  storage.start();
  console.info(`operations-center listening on http://${config.bindHost}:${config.port}`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.info(`operations-center shutting down (${signal})`);
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
