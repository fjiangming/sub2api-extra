'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { hmacHex, safeEqual, sealText } = require('./security');

const SCHEMA_VERSION = 9;
const ORDER_STATUSES = [
  'awaiting_payment',
  'payment_reported',
  'fulfilling',
  'needs_attention',
  'completed',
  'rejected',
  'expired',
  'cancelled'
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recharge_orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  user_email_masked TEXT NOT NULL,
  payment_mode TEXT NOT NULL DEFAULT 'personal_manual',
  requested_amount_minor INTEGER NOT NULL CHECK (requested_amount_minor > 0),
  payable_amount_minor INTEGER NOT NULL CHECK (payable_amount_minor > 0),
  credit_amount_micros INTEGER NOT NULL CHECK (credit_amount_micros > 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  status TEXT NOT NULL CHECK (status IN (${ORDER_STATUSES.map((status) => `'${status}'`).join(', ')})),
  redeem_code TEXT NOT NULL UNIQUE,
  trade_hash TEXT UNIQUE,
  trade_last6 TEXT,
  payment_memo_hash TEXT,
  payment_memo_ciphertext TEXT,
  payment_memo_last6 TEXT,
  payment_qr_source TEXT CHECK (payment_qr_source IS NULL OR payment_qr_source IN ('template', 'collector')),
  payment_qr_status TEXT CHECK (payment_qr_status IS NULL OR payment_qr_status IN ('pending', 'ready', 'failed', 'expired')),
  payment_qr_hash TEXT,
  payment_qr_ciphertext TEXT,
  payment_qr_generated_at TEXT,
  auto_match_status TEXT,
  payment_reported_at TEXT,
  alipay_paid_at TEXT,
  verified_at TEXT,
  verified_by TEXT,
  expires_at TEXT NOT NULL,
  review_expires_at TEXT,
  fulfillment_started_at TEXT,
  fulfillment_attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  completed_at TEXT,
  rejected_at TEXT,
  rejected_reason TEXT,
  cancelled_at TEXT,
  payment_match_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS recharge_orders_user_created
  ON recharge_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recharge_orders_status_created
  ON recharge_orders(status, created_at DESC);
CREATE TABLE IF NOT EXISTS amount_reservations (
  payable_amount_minor INTEGER PRIMARY KEY CHECK (payable_amount_minor > 0),
  order_id TEXT NOT NULL UNIQUE REFERENCES recharge_orders(id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS amount_reservations_expiry
  ON amount_reservations(expires_at);

CREATE TABLE IF NOT EXISTS qr_provision_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES recharge_orders(id) ON DELETE RESTRICT,
  collector_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'failed', 'expired', 'cancelled')),
  lease_hash TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS qr_provision_jobs_status_created
  ON qr_provision_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS qr_provision_jobs_lease_expiry
  ON qr_provision_jobs(lease_expires_at);

CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  collector_event_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('browser', 'phone')),
  evidence_type TEXT NOT NULL,
  trade_hash TEXT NOT NULL UNIQUE,
  trade_last6 TEXT NOT NULL,
  memo_hash TEXT NOT NULL,
  memo_last6 TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  paid_at TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  order_id TEXT REFERENCES recharge_orders(id) ON DELETE RESTRICT,
  match_status TEXT NOT NULL,
  anomaly_code TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_events_order_time
  ON payment_events(order_id, received_at DESC);
CREATE INDEX IF NOT EXISTS payment_events_match_time
  ON payment_events(match_status, received_at DESC);

CREATE TABLE IF NOT EXISTS alipay_accountlog_entries (
  id TEXT PRIMARY KEY,
  account_log_hash TEXT NOT NULL UNIQUE,
  account_log_last6 TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  alipay_order_hash TEXT,
  merchant_order_hash TEXT,
  amount_minor INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('income', 'expense', 'unknown')),
  memo_hash TEXT,
  memo_last6 TEXT,
  other_account_hash TEXT,
  order_id TEXT REFERENCES recharge_orders(id) ON DELETE RESTRICT,
  match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'completed', 'duplicate', 'needs_attention', 'ignored')),
  anomaly_code TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alipay_accountlog_entries_order_time
  ON alipay_accountlog_entries(order_id, received_at DESC);
CREATE INDEX IF NOT EXISTS alipay_accountlog_entries_match_time
  ON alipay_accountlog_entries(match_status, received_at DESC);
CREATE INDEX IF NOT EXISTS alipay_accountlog_entries_amount_paid
  ON alipay_accountlog_entries(amount_minor, paid_at);

CREATE TABLE IF NOT EXISTS listener_nonces (
  nonce_hash TEXT PRIMARY KEY,
  used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listener_nonces_expiry
  ON listener_nonces(expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  order_id TEXT REFERENCES recharge_orders(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'admin', 'system')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  request_id TEXT,
  ip_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS audit_events_order_time
  ON audit_events(order_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_type_time
  ON audit_events(event_type, occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS audit_events_prevent_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_prevent_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
`;

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

function migrate(db, secret) {
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
  if (current > SCHEMA_VERSION) {
    throw new Error(`recharge-center 账本版本 ${current} 高于当前支持版本 ${SCHEMA_VERSION}；请先升级服务`);
  }
  if (!hasColumn(db, 'recharge_orders', 'alipay_paid_at')) {
    db.exec('ALTER TABLE recharge_orders ADD COLUMN alipay_paid_at TEXT');
  }
  const plaintextCodes = db.prepare(`
    SELECT id, redeem_code FROM recharge_orders WHERE redeem_code NOT LIKE 'sealed:v1:%'
  `).all();
  const updateCode = db.prepare('UPDATE recharge_orders SET redeem_code = ? WHERE id = ? AND redeem_code = ?');
  for (const row of plaintextCodes) {
    const sealed = sealText(secret, 'redeem-code:v1', row.redeem_code, row.id);
    if (updateCode.run(sealed, row.id, row.redeem_code).changes !== 1) {
      throw new Error(`兑换码加密迁移失败: ${row.id}`);
    }
  }
  const appliedAt = nowIso();
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(1, appliedAt);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, appliedAt);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(3, appliedAt);
  db.exec('DROP INDEX IF EXISTS recharge_orders_active_payable_amount');
  if (hasColumn(db, 'recharge_orders', 'cent_fingerprint')) {
    db.exec('ALTER TABLE recharge_orders DROP COLUMN cent_fingerprint');
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(4, appliedAt);
  if (hasColumn(db, 'recharge_orders', 'base_amount_minor')) {
    db.exec('ALTER TABLE recharge_orders DROP COLUMN base_amount_minor');
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(5, appliedAt);
  for (const [column, definition] of [
    ['payment_mode', "TEXT NOT NULL DEFAULT 'personal_manual'"],
    ['requested_amount_minor', 'INTEGER'],
    ['payment_memo_hash', 'TEXT'],
    ['payment_memo_ciphertext', 'TEXT'],
    ['payment_memo_last6', 'TEXT'],
    ['auto_match_status', 'TEXT']
  ]) {
    if (!hasColumn(db, 'recharge_orders', column)) {
      db.exec(`ALTER TABLE recharge_orders ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(`
    UPDATE recharge_orders
    SET requested_amount_minor = payable_amount_minor
    WHERE requested_amount_minor IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS recharge_orders_payment_memo
      ON recharge_orders(payment_memo_hash) WHERE payment_memo_hash IS NOT NULL;
  `);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(6, appliedAt);
  for (const [column, definition] of [
    ['payment_qr_source', 'TEXT'],
    ['payment_qr_status', 'TEXT'],
    ['payment_qr_hash', 'TEXT'],
    ['payment_qr_ciphertext', 'TEXT'],
    ['payment_qr_generated_at', 'TEXT']
  ]) {
    if (!hasColumn(db, 'recharge_orders', column)) {
      db.exec(`ALTER TABLE recharge_orders ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS qr_provision_jobs (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE REFERENCES recharge_orders(id) ON DELETE RESTRICT,
      collector_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'failed', 'expired', 'cancelled')),
      lease_hash TEXT,
      lease_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS qr_provision_jobs_status_created
      ON qr_provision_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS qr_provision_jobs_lease_expiry
      ON qr_provision_jobs(lease_expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS recharge_orders_payment_qr_hash
      ON recharge_orders(payment_qr_hash) WHERE payment_qr_hash IS NOT NULL;
    UPDATE recharge_orders
    SET payment_qr_source = 'template', payment_qr_status = 'ready'
    WHERE payment_mode = 'personal_transfer_auto' AND payment_qr_source IS NULL;
  `);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(7, appliedAt);
  db.exec(`
    CREATE TABLE IF NOT EXISTS alipay_accountlog_entries (
      id TEXT PRIMARY KEY,
      account_log_hash TEXT NOT NULL UNIQUE,
      account_log_last6 TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      alipay_order_hash TEXT,
      merchant_order_hash TEXT,
      amount_minor INTEGER NOT NULL,
      paid_at TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('income', 'expense', 'unknown')),
      memo_hash TEXT,
      memo_last6 TEXT,
      other_account_hash TEXT,
      order_id TEXT REFERENCES recharge_orders(id) ON DELETE RESTRICT,
      match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'completed', 'duplicate', 'needs_attention', 'ignored')),
      anomaly_code TEXT,
      received_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS alipay_accountlog_entries_order_time
      ON alipay_accountlog_entries(order_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS alipay_accountlog_entries_match_time
      ON alipay_accountlog_entries(match_status, received_at DESC);
    CREATE INDEX IF NOT EXISTS alipay_accountlog_entries_amount_paid
      ON alipay_accountlog_entries(amount_minor, paid_at);
  `);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(8, appliedAt);
  if (!hasColumn(db, 'recharge_orders', 'payment_match_until')) {
    db.exec('ALTER TABLE recharge_orders ADD COLUMN payment_match_until TEXT');
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(9, appliedAt);
}

function nowIso() {
  return new Date().toISOString();
}

function secureDataPath(databasePath) {
  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function assertSecretContinuity(db, secret) {
  const expected = hmacHex(secret, 'secret-verifier:v1', 'recharge-center');
  const existing = db.prepare('SELECT value FROM service_metadata WHERE key = ?').get('secret_verifier_v1');
  if (existing && !safeEqual(existing.value, expected)) {
    throw new Error('RECHARGE_CENTER_SECRET 与现有账本不匹配；为防止交易号去重失效，服务已拒绝启动');
  }
  if (!existing) {
    db.prepare(`
      INSERT INTO service_metadata(key, value, updated_at) VALUES (?, ?, ?)
    `).run('secret_verifier_v1', expected, nowIso());
  }
}

function createDatabase(databasePath, secret) {
  secureDataPath(databasePath);
  const db = new Database(databasePath, { timeout: 5000 });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    assertSecretContinuity(db, secret);
    db.transaction(() => migrate(db, secret))();
    try { fs.chmodSync(databasePath, 0o600); } catch {}
    for (const suffix of ['-wal', '-shm']) {
      const related = `${databasePath}${suffix}`;
      if (fs.existsSync(related)) {
        try { fs.chmodSync(related, 0o600); } catch {}
      }
    }
    return db;
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}

function pingDatabase(db) {
  const started = Date.now();
  const row = db.prepare('SELECT 1 AS ok').get();
  return { ok: row?.ok === 1, latencyMs: Date.now() - started, schemaVersion: SCHEMA_VERSION };
}

module.exports = { createDatabase, nowIso, pingDatabase, ORDER_STATUSES, SCHEMA_VERSION };
