'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db');

test('database refuses a changed HMAC secret for an existing financial ledger', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-secret-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ledger.db');
  const first = createDatabase(file, 'first-secret-0123456789abcdef0123456789');
  first.close();
  assert.throws(
    () => createDatabase(file, 'second-secret-0123456789abcdef0123456789'),
    /SECRET.*不匹配/
  );
});

test('audit events are append-only at the database layer', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-audit-test-'));
  const db = createDatabase(path.join(directory, 'ledger.db'), 'audit-secret-0123456789abcdef0123456789');
  t.after(() => {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const event = db.prepare(`
    INSERT INTO audit_events(occurred_at, actor_type, event_type, metadata_json)
    VALUES (?, 'system', 'TEST_EVENT', '{}')
  `).run(new Date().toISOString());
  assert.throws(() => db.prepare('UPDATE audit_events SET event_type = ? WHERE id = ?').run('CHANGED', event.lastInsertRowid), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_events WHERE id = ?').run(event.lastInsertRowid), /append-only/);
});

test('legacy ledgers preserve historical amounts while migrating to exact-amount orders', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-migration-test-'));
  const file = path.join(directory, 'ledger.db');
  const secret = 'migration-secret-0123456789abcdef0123456789';
  const initial = createDatabase(file, secret);
  initial.exec(`
    ALTER TABLE recharge_orders ADD COLUMN base_amount_minor
      INTEGER NOT NULL DEFAULT 1000 CHECK (base_amount_minor > 0 AND base_amount_minor % 100 = 0);
    ALTER TABLE recharge_orders ADD COLUMN cent_fingerprint
      INTEGER NOT NULL DEFAULT 1 CHECK (cent_fingerprint BETWEEN 1 AND 99);
    CREATE UNIQUE INDEX recharge_orders_active_payable_amount
      ON recharge_orders(payable_amount_minor)
      WHERE status IN ('awaiting_payment', 'payment_reported', 'fulfilling', 'needs_attention');
  `);
  initial.prepare(`
    INSERT INTO recharge_orders(
      id, order_no, user_id, user_email_masked, base_amount_minor, requested_amount_minor, payable_amount_minor,
      credit_amount_micros, cent_fingerprint, status, redeem_code, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?, ?, ?)
  `).run(
    'migration-order', 'RC-MIGRATION', 1, 'te***@example.com', 1000, 1001, 1001,
    1001000000, 1, 'RCPLAINTEXTCODE0123456789012345',
    '2026-10-02T01:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'
  );
  initial.prepare(`
    INSERT INTO amount_reservations(payable_amount_minor, order_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(1001, 'migration-order', '2026-10-02T01:15:00.000Z', '2026-10-02T00:00:00.000Z');
  initial.exec(`
    ALTER TABLE recharge_orders DROP COLUMN alipay_paid_at;
    ALTER TABLE recharge_orders DROP COLUMN payment_match_until;
    DELETE FROM schema_migrations WHERE version >= 2;
  `);
  initial.close();
  const reopened = createDatabase(file, secret);
  t.after(() => {
    if (reopened.open) reopened.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const columns = reopened.prepare('PRAGMA table_info(recharge_orders)').all().map((column) => column.name);
  assert.ok(columns.includes('alipay_paid_at'));
  assert.equal(columns.includes('cent_fingerprint'), false);
  assert.equal(columns.includes('base_amount_minor'), false);
  assert.equal(reopened.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 10);
  assert.ok(columns.includes('payment_match_until'));
  assert.ok(columns.includes('payment_qr_ciphertext'));
  assert.ok(reopened.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'qr_provision_jobs'
  `).get());
  assert.ok(reopened.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alipay_accountlog_entries'
  `).get());
  assert.ok(reopened.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'official_order_creations'
  `).get());
  const legacyIndex = reopened.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'recharge_orders_active_payable_amount'
  `).get();
  assert.equal(legacyIndex, undefined);
  const migrated = reopened.prepare(`
    SELECT payable_amount_minor, credit_amount_micros, redeem_code, payment_match_until
    FROM recharge_orders WHERE id = ?
  `).get('migration-order');
  assert.equal(migrated.payable_amount_minor, 1001);
  assert.equal(migrated.credit_amount_micros, 1001000000);
  assert.equal(migrated.payment_match_until, null);
  assert.match(migrated.redeem_code, /^sealed:v1:/);
  assert.equal(migrated.redeem_code.includes('RCPLAINTEXTCODE'), false);
  assert.deepEqual(reopened.prepare('SELECT * FROM amount_reservations').get(), {
    payable_amount_minor: 1001,
    order_id: 'migration-order',
    expires_at: '2026-10-02T01:15:00.000Z',
    created_at: '2026-10-02T00:00:00.000Z'
  });
});
