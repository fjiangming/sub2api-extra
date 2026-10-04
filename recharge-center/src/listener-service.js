'use strict';

const crypto = require('crypto');
const { AppError } = require('./errors');
const { hmacHex, safeEqual } = require('./security');

function listenerSignature(secret, timestamp, nonce, rawBody) {
  return crypto.createHmac('sha256', secret)
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

  authenticate(req) {
    if (!this.config.automaticPersonalMode || !this.config.listenerSecret) {
      throw new AppError('LISTENER_DISABLED', '付款监听接口未启用', { status: 404 });
    }
    const timestamp = String(req.get('x-recharge-timestamp') || '');
    const nonce = String(req.get('x-recharge-nonce') || '');
    const signature = String(req.get('x-recharge-signature') || '').toLowerCase();
    if (!/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) {
      throw new AppError('LISTENER_AUTH_INVALID', '监听器签名头无效', { status: 401 });
    }
    const nowSeconds = Math.floor(this.clock().getTime() / 1000);
    if (Math.abs(nowSeconds - Number(timestamp)) > this.config.listenerSignatureToleranceSeconds) {
      throw new AppError('LISTENER_TIMESTAMP_STALE', '监听器请求时间戳已失效', { status: 401 });
    }
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
    const expected = listenerSignature(this.config.listenerSecret, timestamp, nonce, rawBody);
    if (!safeEqual(expected, signature)) {
      throw new AppError('LISTENER_SIGNATURE_INVALID', '监听器签名校验失败', { status: 401 });
    }
    const nonceHash = hmacHex(this.config.secret, 'listener-nonce:v1', nonce);
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
    const now = this.clock().getTime();
    const ageMs = heartbeat ? now - Date.parse(heartbeat.value) : Number.POSITIVE_INFINITY;
    const observedAgeMs = observed ? now - Date.parse(observed.value) : Number.POSITIVE_INFINITY;
    const healthy = Boolean(
      heartbeat && collector && safeEqual(collector.value, this.config.listenerCollectorId) &&
      ready?.value === 'true' && Number.isFinite(ageMs) && ageMs >= -5000 &&
      ageMs <= this.config.listenerMaxStaleSeconds * 1000 && Number.isFinite(observedAgeMs) &&
      observedAgeMs >= -5000 && observedAgeMs <= this.config.listenerMaxStaleSeconds * 1000
    );
    return {
      required: true,
      healthy,
      lastHeartbeatAt: heartbeat?.value || null,
      lastSuccessfulPollAt: observed?.value || null,
      staleAfterSeconds: this.config.listenerMaxStaleSeconds
    };
  }

  assertReady() {
    if (!this.status().healthy) {
      throw new AppError('PAYMENT_LISTENER_UNAVAILABLE', '到账监听暂不可用，请稍后再试', { status: 503 });
    }
  }
}

module.exports = { ListenerService, listenerSignature };
