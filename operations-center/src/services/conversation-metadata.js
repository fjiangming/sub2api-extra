'use strict';

const fields = ['id','request_id','user_id','key_id','account_id','session_id','at','duration_ms','host','path','method','protocol','model','status',
  'complete','reason','policy_version','mode','encoding','original','masked','hits','bytes','processing_error','processing_policy_version','processed_at',
  'redaction_version','redaction_policy_hash','capture_version','body_sha256','inspection_warnings','upstream_status','upstream_evidence',
  'completion_version','completion_source','archived_at','processing_pending','fingerprint'];
const integers = new Set(['user_id','key_id','account_id','at','duration_ms','status','complete','policy_version','original','masked','bytes',
  'processing_policy_version','processed_at','redaction_version','capture_version','completion_version','archived_at','processing_pending']);
const projection = (prefix = '') => fields.map(field => ['original','masked'].includes(field)
  ? `(${prefix}${field} IS NOT NULL) AS ${field}` : prefix + field).join(',');

function initializeMetadata(db) {
  db.transaction(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS cl_record_metadata(${fields.map(field => field === 'id' ? 'id TEXT PRIMARY KEY' : field + (integers.has(field) ? ' INTEGER' : ' TEXT') + ' NOT NULL').join(',')});
    CREATE INDEX IF NOT EXISTS cl_metadata_time ON cl_record_metadata(at DESC,id);
    CREATE INDEX IF NOT EXISTS cl_metadata_request ON cl_record_metadata(request_id,at);
    CREATE INDEX IF NOT EXISTS cl_metadata_session ON cl_record_metadata(user_id,key_id,session_id,at);`);
  const columns = new Set(db.pragma('table_info(cl_record_metadata)').map(column => column.name));
  if (!columns.has('processing_pending')) db.exec('ALTER TABLE cl_record_metadata ADD COLUMN processing_pending INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('fingerprint')) db.exec("ALTER TABLE cl_record_metadata ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE INDEX IF NOT EXISTS cl_metadata_push_pending ON cl_record_metadata(id) WHERE fingerprint=''");
  const values = fields.map(field => ['original','masked'].includes(field) ? `(NEW.${field} IS NOT NULL)` : 'NEW.' + field).join(',');
  for (const operation of ['INSERT','UPDATE']) db.exec(`DROP TRIGGER IF EXISTS cl_metadata_${operation.toLowerCase()}; CREATE TRIGGER cl_metadata_${operation.toLowerCase()} AFTER ${operation} ON cl_records
    BEGIN INSERT OR REPLACE INTO cl_record_metadata(${fields}) VALUES(${values}); END;`);
  db.exec('CREATE TRIGGER IF NOT EXISTS cl_metadata_delete AFTER DELETE ON cl_records BEGIN DELETE FROM cl_record_metadata WHERE id=OLD.id; END;');
  }).immediate();
}

function metadataStatus(db) {
  const {total,prepared:indexed} = db.prepare(`SELECT (SELECT COUNT(*) FROM cl_records) total,
    (SELECT COUNT(*) FROM cl_record_metadata) prepared`).get();
  return {ready:total === indexed,indexed,total};
}

function pushMetadataStatus(db) {
  const {total,prepared:indexed,pending} = db.prepare(`SELECT (SELECT COUNT(*) FROM cl_records) total,
    (SELECT COUNT(*) FROM cl_record_metadata) prepared,
    (SELECT COUNT(*) FROM cl_record_metadata WHERE fingerprint='') pending`).get();
  return {ready:total === indexed && pending === 0,indexed:indexed - pending,total};
}

function backfillMetadata(db) {
  const legacy = db.prepare("SELECT id FROM cl_record_metadata WHERE fingerprint='' LIMIT 1").get();
  if (legacy) {
    // The legacy fingerprint is after body BLOBs; only the isolated reader may fetch it.
    const row = db.prepare('SELECT fingerprint FROM cl_records WHERE id=?').get(legacy.id);
    if (row) db.prepare("UPDATE cl_record_metadata SET fingerprint=? WHERE id=? AND fingerprint=''").run(row.fingerprint,legacy.id);
    return {done:false};
  }
  const missing = db.prepare(`SELECT r.id FROM cl_records r INDEXED BY cl_time LEFT JOIN cl_record_metadata m ON m.id=r.id
    WHERE m.id IS NULL ORDER BY r.at DESC,r.id LIMIT 1`).get();
  if (!missing) return {done:true};
  // Reading old overflow pages must finish before taking the short writer lock.
  const row = db.prepare('SELECT ' + projection() + ' FROM cl_records WHERE id=?').get(missing.id);
  if (!row) return {done:false};
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM cl_records WHERE id=?').get(row.id)) return;
    // A concurrent update already installed a newer projection through its trigger.
    db.prepare(`INSERT OR IGNORE INTO cl_record_metadata(${fields}) VALUES(${fields.map(() => '?')})`).run(...fields.map(field => row[field]));
  }).immediate();
  return {done:false};
}

module.exports = {fields,projection,initializeMetadata,metadataStatus,pushMetadataStatus,backfillMetadata};
