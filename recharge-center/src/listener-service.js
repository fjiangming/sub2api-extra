'use strict';

const crypto = require('crypto');
const { AppError } = require('./errors');
const { hmacHex, safeEqual } = require('./security');

function listenerSignature(secret, timestamp, nonce, rawBody, method, pathname) {
  return crypto.createHmac('sha256', secret)
    .update(String(method || '').toUpperCase())
    .update('\n')
    .update(String(pathname || ''))
    .update('\n')
    .update(String(timestamp))
    .update('\n')
    .update(String(nonce))
    .update('\n')
    .update(rawBody)
    .digest('hex');
}

class ListenerService {
  constructor({ db, config, clock = () => new Date() }) {
    this.db = db;
    this.config = config;
    this.clock = clock;
  }

  authenticate(req, scope = 'ledger') {
    const qrScope = scope === 'qr';
    const secret = qrScope ? this.config.qrProvisionerSecret : this.config.listenerSecret;
    if (!this.config.automaticPersonalMode || !secret || (qrScope && !this.config.collectorQrProvisioning)) {
      throw new AppError('LISTENER_DISABLED', '付款监听接口未启用', { status: 404 });
    }
    const signatureVersion = String(req.get('x-recharge-signature-version') || '');
    const timestamp = String(req.get('x-recharge-timestamp') || '');
    const nonce = String(req.get('x-recharge-nonce') || '');
    const signature = String(req.get('x-recharge-signature') || '').toLowerCase();
    if (signatureVersion !== '2' || !/^\d{10}$/.test(timestamp) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) {
      throw new AppError('LISTENER_AUTH_INVALID', '监听器签名头无效', { status: 401 });
    }
    const nowSeconds = Math.floor(this.clock().getTime() / 1000);
    if (Math.abs(nowSeconds - Number(timestamp)) > this.config.listenerSignatureToleranceSeconds) {
      throw new AppError('LISTENER_TIMESTAMP_STALE', '监听器请求时间戳已失效', { status: 401 });
    }
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
    const expected = listenerSignature(secret, timestamp, nonce, rawBody, req.method, req.path);
    if (!safeEqual(expected, signature)) {
      throw new AppError('LISTENER_SIGNATURE_INVALID', '监听器签名校验失败', { status: 401 });
    }
    const nonceHash = hmacHex(this.config.secret, `listener-nonce:${scope}:v2`, nonce);
    const usedAt = this.clock().toISOString();
    const expiresAt = new Date(this.clock().getTime() + this.config.listenerSignatureToleranceSeconds * 2000).toISOString();
    try {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM listener_nonces WHERE expires_at <= ?').run(usedAt);
        this.db.prepare(`
          INSERT INTO listener_nonces(nonce_hash, used_at, expires_at) VALUES (?, ?, ?)
        `).run(nonceHash, usedAt, expiresAt);
      })();
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        throw new AppError('LISTENER_REPLAY_REJECTED', '监听器请求已被使用', { status: 409 });
      }
      throw error;
    }
  }

  assertCollector(collectorId) {
    if (!safeEqual(collectorId, this.config.listenerCollectorId)) {
      throw new AppError('LISTENER_COLLECTOR_REJECTED', '监听器身份不匹配', { status: 403 });
    }
  }

  heartbeat(input) {
    this.assertCollector(input.collectorId);
    const receivedAt = this.clock().toISOString();
    const set = this.db.prepare(`
      INSERT INTO service_metadata(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    this.db.transaction(() => {
      set.run('listener_last_heartbeat_at', receivedAt, receivedAt);
      set.run('listener_collector_id', input.collectorId, receivedAt);
      set.run('listener_ready', input.ready ? 'true' : 'false', receivedAt);
      set.run('listener_observed_at', input.observedAt, receivedAt);
      if (input.version) set.run('listener_version', input.version, receivedAt);
    })();
    return {
      status: 'accepted',
      ready: input.ready,
      receivedAt,
      observedAt: input.observedAt,
      maxStaleSeconds: this.config.listenerMaxStaleSeconds
    };
  }

  qrHeartbeat(input) {
    this.assertCollector(input.collectorId);
    const receivedAt = this.clock().toISOString();
    const set = this.db.prepare(`
      INSERT INTO service_metadata(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    this.db.transaction(() => {
      set.run('qr_provisioner_last_heartbeat_at', receivedAt, receivedAt);
      set.run('qr_provisioner_collector_id', input.collectorId, receivedAt);
      set.run('qr_provisioner_ready', input.ready ? 'true' : 'false', receivedAt);
      set.run('qr_provisioner_observed_at', input.observedAt, receivedAt);
      if (input.version) set.run('qr_provisioner_version', input.version, receivedAt);
    })();
    return {
      status: 'accepted',
      ready: input.ready,
      receivedAt,
      observedAt: input.observedAt,
      maxStaleSeconds: this.config.listenerMaxStaleSeconds
    };
  }

  status() {
    if (!this.config.automaticPersonalMode) return { required: false, healthy: true };
    const heartbeat = this.db.prepare(`
      SELECT value, updated_at FROM service_metadata WHERE key = 'listener_last_heartbeat_at'
    `).get();
    const collector = this.db.prepare(`
      SELECT value FROM service_metadata WHERE key = 'listener_collector_id'
    `).get();
    const ready = this.db.prepare(`
      SELECT value FROM service_metadata WHERE key = 'listener_ready'
    `).get();
    const observed = this.db.prepare(`
      SELECT value FROM service_metadata WHERE key = 'listener_observed_at'
    `).get();
    const qrHeartbeat = this.db.prepare(`
      SELECT value FROM service_metadata WHERE key = 'qr_provisioner_last_heartbeat_at'
    `).get();
    const qrProvisioningReady = this.db.prepare(`
      SELECT value FROM service_metadata WHERE key = 'qr_provisioner_ready'
    `).get();
    const qrObserved = this.db.prepare(`
      SELECT value FROM service_metadata WHERE key = 'qr_provisioner_observed_at'
    `).get();
    const qrCollector = this.db.prepare(`
      SELECT value FROM service_metadata WHERE key = 'qr_provisioner_collector_id'
    `).get();
    const now = this.clock().getTime();
    const ageMs = heartbeat ? now - Date.parse(heartbeat.value) : Number.POSITIVE_INFINITY;
    const observedAgeMs = observed ? now - Date.parse(observed.value) : Number.POSITIVE_INFINITY;
    const ledgerHealthy = Boolean(
      heartbeat && collector && safeEqual(collector.value, this.config.listenerCollectorId) &&
      ready?.value === 'true' && Number.isFinite(ageMs) && ageMs >= -5000 &&
      ageMs <= this.config.listenerMaxStaleSeconds * 1000 && Number.isFinite(observedAgeMs) &&
      observedAgeMs >= -5000 && observedAgeMs <= this.config.listenerMaxStaleSeconds * 1000
    );
    const qrProvisioningRequired = this.config.collectorQrProvisioning === true;
    const qrHeartbeatAgeMs = qrHeartbeat ? now - Date.parse(qrHeartbeat.value) : Number.POSITIVE_INFINITY;
    const qrObservedAgeMs = qrObserved ? now - Date.parse(qrObserved.value) : Number.POSITIVE_INFINITY;
    const qrProvisioningHealthy = !qrProvisioningRequired ||
      (qrCollector && safeEqual(qrCollector.value, this.config.listenerCollectorId) &&
       qrProvisioningReady?.value === 'true' && Number.isFinite(qrHeartbeatAgeMs) &&
       qrHeartbeatAgeMs >= -5000 && qrHeartbeatAgeMs <= this.config.listenerMaxStaleSeconds * 1000 &&
       Number.isFinite(qrObservedAgeMs) && qrObservedAgeMs >= -5000 &&
       qrObservedAgeMs <= this.config.listenerMaxStaleSeconds * 1000);
    const healthy = ledgerHealthy && qrProvisioningHealthy;
    return {
      required: true,
      healthy,
      ledgerHealthy,
      qrProvisioningRequired,
      qrProvisioningHealthy,
      lastQrProvisionerHeartbeatAt: qrHeartbeat?.value || null,
      lastQrProvisionerCheckAt: qrObserved?.value || null,
      lastHeartbeatAt: heartbeat?.value || null,
      lastSuccessfulPollAt: observed?.value || null,
      staleAfterSeconds: this.config.listenerMaxStaleSeconds
    };
  }

  assertReady() {
    if (!this.status().healthy) {
      throw new AppError('PAYMENT_LISTENER_UNAVAILABLE', '到账监听或逐单收钱码生成暂不可用，请稍后再试', { status: 503 });
    }
  }
}

module.exports = { ListenerService, listenerSignature };
