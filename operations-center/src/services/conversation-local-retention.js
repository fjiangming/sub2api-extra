'use strict';

const crypto = require('node:crypto');

function initializeLocalRetention(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cl_payload_leases(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS cl_payload_lease_expiry ON cl_payload_leases(expires_at);
    CREATE TABLE IF NOT EXISTS cl_delivered_records(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,body_sha256 TEXT NOT NULL,deleted_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS cl_delivered_record_expiry ON cl_delivered_records(deleted_at);`);
}

function holdPayloads(db, now = Date.now) {
  const id = crypto.randomUUID();
  const renew = () => db.prepare('INSERT INTO cl_payload_leases VALUES(?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at').run(id, now() + 120000);
  renew();
  const timer = setInterval(() => { try { renew(); } catch { /* A live supervisor also withdraws cleanup permission while reading. */ } }, 10000);
  timer.unref();
  let released = false;
  return () => {
    if (released) return;
    released = true; clearInterval(timer);
    try { db.prepare('DELETE FROM cl_payload_leases WHERE id=?').run(id); } catch { /* A crashed/closed reader lease expires. */ }
  };
}

module.exports = { initializeLocalRetention, holdPayloads };
