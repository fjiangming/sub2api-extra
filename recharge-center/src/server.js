'use strict';

const { loadConfig } = require('./config');
const { createDatabase } = require('./db');
const { QrService } = require('./qr-service');
const { Sub2ApiClient } = require('./sub2api-client');
const { AuthService } = require('./auth');
const { OrderService } = require('./order-service');
const { OfficialPaymentService } = require('./official-payment-service');
const { NotificationService } = require('./notification-service');
const { ListenerService } = require('./listener-service');
const { QrProvisioningService } = require('./qr-provisioning-service');
const { createApp } = require('./app');

function createRuntime(env = process.env, options = {}) {
  const projectRoot = options.projectRoot || require('path').join(__dirname, '..');
  const config = loadConfig(env, { projectRoot });
  const db = createDatabase(config.databasePath, config.secret);
  const qr = new QrService(config);
  const sub2api = options.sub2api || new Sub2ApiClient(config, { fetch: options.fetch });
  const notifications = options.notifications || options.alerts || new NotificationService(config, {
    fetch: options.fetch,
    transport: options.notificationTransport
  });
  const auth = new AuthService(config, sub2api);
  const orders = new OrderService({ db, config, sub2api, alerts: notifications, clock: options.clock });
  const listener = new ListenerService({ db, config, clock: options.clock });
  const qrProvisioning = new QrProvisioningService({ db, config, alerts: notifications, clock: options.clock });
  const officialPayments = config.paymentMode === 'sub2api_official'
    ? new OfficialPaymentService({ config, sub2api, clock: options.clock })
    : null;
  const app = createApp({ config, db, auth, orders, qr, officialPayments, listener, qrProvisioning });
  return {
    app,
    config,
    db,
    auth,
    orders,
    qr,
    notifications,
    listener,
    qrProvisioning,
    officialPayments,
    close() {
      officialPayments?.close();
      notifications.close?.();
      auth.close();
      if (db.open) db.close();
    }
  };
}

if (require.main === module) {
  let runtime;
  try {
    runtime = createRuntime();
  } catch (error) {
    console.error(JSON.stringify({ level: 'fatal', code: 'STARTUP_FAILED', message: error.message }));
    process.exit(1);
  }
  const server = runtime.app.listen(runtime.config.port, runtime.config.bindHost, () => {
    console.log(JSON.stringify({
      level: 'info',
      message: 'recharge-center listening',
      host: runtime.config.bindHost,
      port: runtime.config.port,
      qrAvailable: runtime.qr.status().available
    }));
  });
  const shutdown = (signal) => {
    console.log(JSON.stringify({ level: 'info', message: 'recharge-center shutting down', signal }));
    server.close(() => {
      runtime.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createRuntime };
