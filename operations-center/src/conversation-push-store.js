'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const { modelAllowed } = require('./services/conversation-models');
const { defaults,parsePolicy,publicPolicy,targetHash,invalid } = require('./services/conversation-push-policy');

const destinations = z.array(z.enum(['webhook','s3'])).min(1).max(2);
const filterSchema = z.object({search:z.string().max(200).optional(),start:z.string().max(32).optional(),end:z.string().max(32).optional(),
  user_id:z.string().max(20).optional(),key_id:z.string().max(20).optional(),request_id:z.string().max(32).optional(),session_id:z.string().max(64).optional(),
  protocol:z.enum(['','JSON','SSE','WebSocket']).optional(),capture:z.enum(['','complete','partial','missing','redaction_failed']).optional()}).strict();
const previewSchema = z.object({filter:filterSchema,destinations}).strict();
const enqueueSchema = previewSchema.extend({batchId:z.string().uuid(),previewToken:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const columns = 'id,rowid AS cursor_id,user_id,model,at,fingerprint,processed_at,processing_policy_version,processing_error,original IS NOT NULL AS original,masked IS NOT NULL AS masked';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parse(schema,value) { const result=schema.safeParse(value);if(!result.success)throw invalid();return result.data; }

class ConversationPushStore {
  constructor(archive,{now=Date.now}={}) { this.archive=archive;this.db=archive.db;this.now=now; }
  initialize() {
    this.db.pragma('foreign_keys = ON');
    this.db.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS cl_push_policies(version INTEGER PRIMARY KEY,body BLOB NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cl_push_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),row_id INTEGER NOT NULL,record_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cl_push_arrivals(seq INTEGER PRIMARY KEY AUTOINCREMENT,record_id TEXT NOT NULL UNIQUE REFERENCES cl_records(id) ON DELETE CASCADE);
      CREATE TRIGGER IF NOT EXISTS cl_push_arrival AFTER INSERT ON cl_records BEGIN INSERT INTO cl_push_arrivals(record_id) VALUES(NEW.id); END;
      CREATE TABLE IF NOT EXISTS cl_push_batches(id TEXT PRIMARY KEY,digest TEXT NOT NULL,created_at INTEGER NOT NULL,matched INTEGER NOT NULL,eligible INTEGER NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cl_push_jobs(id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES cl_records(id) ON DELETE CASCADE,
        destination TEXT NOT NULL,target_hash TEXT NOT NULL,source TEXT NOT NULL,content_version TEXT NOT NULL,batch_id TEXT NOT NULL,
        status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,lease_token TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error_code TEXT NOT NULL DEFAULT '',http_status INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS cl_push_due ON cl_push_jobs(status,next_at);
      CREATE INDEX IF NOT EXISTS cl_push_record ON cl_push_jobs(record_id);
      CREATE INDEX IF NOT EXISTS cl_push_batch ON cl_push_jobs(batch_id,created_at);`);
      if(!this.db.prepare('SELECT 1 FROM cl_push_policies LIMIT 1').get()) this.db.prepare('INSERT INTO cl_push_policies VALUES(?,?,?)').run(1,this.archive.seal(defaults,'push-policy:1'),this.now());
      if(!this.db.prepare('SELECT 1 FROM cl_push_cursor LIMIT 1').get()) this.setCursor(this.latest());
      this.policy();
    })();
    return this;
  }
  latest() { return {cursor_id:this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='cl_push_arrivals'").get()?.seq || 0,id:''}; }
  setCursor(row) {
    this.db.prepare(`INSERT INTO cl_push_cursor VALUES(1,?,'') ON CONFLICT(singleton) DO UPDATE SET row_id=excluded.row_id,record_id=''
      WHERE cl_push_cursor.row_id!=excluded.row_id OR cl_push_cursor.record_id!=''`).run(row.cursor_id);
  }
  policy() { const row=this.db.prepare('SELECT * FROM cl_push_policies ORDER BY version DESC LIMIT 1').get();return this.archive.open(row.body,'push-policy:'+row.version); }
  configure(input) {
    return this.db.transaction(()=>{
      const before=this.policy(),after=parsePolicy(input,before);
      this.db.prepare('INSERT INTO cl_push_policies VALUES(?,?,?)').run(after.version,this.archive.seal(after,'push-policy:'+after.version),this.now());
      if(!before.enabled || !before.automatic || !after.enabled || !after.automatic) this.setCursor(this.latest());
      return publicPolicy(after);
    })();
  }
  // The archive increments processed_at strictly on every reprocess; metadata scans never load body BLOBs.
  version(row,source) { return hash([row.fingerprint,source,source==='masked'?[row.processed_at,row.processing_policy_version]:0]); }
  allowed(row,policy) { return !policy.excludedUserIds.includes(row.user_id) && modelAllowed(policy,row.model); }
  jobId(row,policy,destination) { return hash([row.id,destination,targetHash(policy,destination),this.version(row,policy.source)]); }
  pendingCount() { return this.db.prepare("SELECT COUNT(*) n FROM cl_push_jobs WHERE status IN ('pending','running')").get().n; }
  insert(row,policy,destination,batchId) {
    return this.db.prepare(`INSERT OR IGNORE INTO cl_push_jobs(id,record_id,destination,target_hash,source,content_version,batch_id,status,next_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`).run(this.jobId(row,policy,destination),row.id,destination,targetHash(policy,destination),policy.source,this.version(row,policy.source),batchId,this.now(),this.now(),this.now()).changes;
  }
  selection(input) {
    const value=parse(previewSchema,input),policy=this.policy(),archivePolicy=this.archive.policy();
    if(!policy.enabled) throw invalid('请先启用推送','CONVERSATION_PUSH_DISABLED',409);
    const targets=[...new Set(value.destinations)].sort();
    if(targets.some(target=>!policy[target].enabled)) throw invalid('所选目标未启用');
    const where=this.archive.where(value.filter);
    const rows=this.db.prepare(`SELECT ${columns} FROM cl_records${where.sql} ORDER BY at,id LIMIT 10001`).all(...where.args);
    if(rows.length>10000)throw invalid('单批最多 10,000 条，请缩小筛选范围');
    const eligible=rows.filter(row=>this.allowed(row,archivePolicy)&&row[policy.source]);
    const token=crypto.createHmac('sha256',this.archive.key).update(JSON.stringify([policy.version,archivePolicy.version,value.filter,targets,eligible.map(row=>[row.id,this.version(row,policy.source)])])).digest('hex');
    const existing=this.db.prepare('SELECT status FROM cl_push_jobs WHERE id=?');
    let duplicates=0;
    for(const row of eligible)for(const target of targets)if(existing.get(this.jobId(row,policy,target)))duplicates++;
    return {policy,targets,eligible,previewToken:token,matched:rows.length,excluded:rows.filter(row=>!this.allowed(row,archivePolicy)).length,
      unavailable:rows.filter(row=>this.allowed(row,archivePolicy)&&!row[policy.source]).length,duplicates,jobs:eligible.length*targets.length-duplicates};
  }
  preview(input) {
    const value=this.selection(input);
    return {previewToken:value.previewToken,matched:value.matched,eligible:value.eligible.length,excluded:value.excluded,unavailable:value.unavailable,duplicates:value.duplicates,jobs:value.jobs,policyVersion:value.policy.version};
  }
  enqueue(input) {
    const value=parse(enqueueSchema,input),digest=hash(value);
    return this.db.transaction(()=>{
      const existing=this.db.prepare('SELECT * FROM cl_push_batches WHERE id=?').get(value.batchId);
      if(existing){if(existing.digest!==digest)throw invalid('同一批次不能更改参数','CONVERSATION_PUSH_CONFLICT',409);return this.batch(value.batchId);}
      const selected=this.selection({filter:value.filter,destinations:value.destinations});
      if(selected.previewToken!==value.previewToken)throw invalid('策略或日志已变化，请重新预览','CONVERSATION_PUSH_PREVIEW_CHANGED',409);
      if(this.pendingCount()+selected.jobs>selected.policy.queueLimit)throw invalid('推送队列已满，请等待或缩小批次','CONVERSATION_PUSH_QUEUE_FULL',409);
      let created=0;
      for(const row of selected.eligible)for(const target of selected.targets)created+=this.insert(row,selected.policy,target,value.batchId);
      this.db.prepare('INSERT INTO cl_push_batches VALUES(?,?,?,?,?,?)').run(value.batchId,digest,this.now(),selected.matched,selected.eligible.length,created);
      return this.batch(value.batchId);
    })();
  }
  scanAutomatic() {
    return this.db.transaction(()=>{
      const policy=this.policy();
      if(!policy.enabled||!policy.automatic){this.setCursor(this.latest());return {created:0};}
      const cursor=this.db.prepare('SELECT * FROM cl_push_cursor WHERE singleton=1').get();
      const rows=this.db.prepare(`SELECT ${columns.replace('rowid AS cursor_id','a.seq AS cursor_id')} FROM cl_records JOIN cl_push_arrivals a ON a.record_id=id WHERE a.seq>? ORDER BY a.seq LIMIT 50`).all(cursor.row_id);
      const archivePolicy=this.archive.policy(),targets=['webhook','s3'].filter(target=>policy[target].enabled);
      let created=0,pending=this.pendingCount();
      for(const row of rows){
        if(this.allowed(row,archivePolicy)&&row[policy.source]){
          const needed=targets.filter(target=>!this.db.prepare('SELECT 1 FROM cl_push_jobs WHERE id=?').get(this.jobId(row,policy,target)));
          if(pending+needed.length>policy.queueLimit)return {created,full:true};
          for(const target of needed){created+=this.insert(row,policy,target,'');pending++;}
        }
        this.setCursor(row);
      }
      return {created};
    })();
  }
  metadata(id) { return this.db.prepare(`SELECT ${columns} FROM cl_records WHERE id=?`).get(id); }
  validJob(job,policy=this.policy()) {
    if(!policy.enabled||!policy[job.destination].enabled)return {paused:true};
    if(policy.source!==job.source||targetHash(policy,job.destination)!==job.target_hash)return {cancel:'TARGET_CHANGED'};
    const row=this.metadata(job.record_id);
    if(!row)return {cancel:'RECORD_EXPIRED'};
    if(!this.allowed(row,this.archive.policy()))return {cancel:'COLLECTION_EXCLUDED'};
    if(!row[job.source])return {cancel:'COPY_UNAVAILABLE'};
    if(this.version(row,job.source)!==job.content_version)return {cancel:'CONTENT_CHANGED'};
    return {row};
  }
  claim() {
    return this.db.transaction(()=>{
      const policy=this.policy();if(!policy.enabled)return null;
      this.db.prepare("UPDATE cl_push_jobs SET status=CASE WHEN attempts<? THEN 'pending' ELSE 'failed' END,error_code='DELIVERY_UNKNOWN',lease_token='',lease_until=0 WHERE status='running' AND lease_until<=?").run(policy.maxAttempts,this.now());
      const targets=['webhook','s3'].filter(target=>policy[target].enabled);
      if(!targets.length)return null;
      const candidates=this.db.prepare(`SELECT * FROM cl_push_jobs WHERE status='pending' AND next_at<=? AND destination IN (${targets.map(()=>'?').join(',')}) ORDER BY next_at,created_at,id LIMIT 100`).all(this.now(),...targets);
      for(const job of candidates){
        const valid=this.validJob(job,policy);
        if(valid.paused)continue;
        if(valid.cancel){this.db.prepare("UPDATE cl_push_jobs SET status='cancelled',error_code=?,updated_at=? WHERE id=?").run(valid.cancel,this.now(),job.id);continue;}
        if(job.attempts>=policy.maxAttempts){this.db.prepare("UPDATE cl_push_jobs SET status='failed',error_code='ATTEMPTS_EXHAUSTED',updated_at=? WHERE id=?").run(this.now(),job.id);continue;}
        const lease=crypto.randomUUID();
        this.db.prepare("UPDATE cl_push_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status='pending'")
          .run(lease,this.now()+(policy.timeoutSeconds+10)*1000,this.now(),job.id);
        return {...job,attempts:job.attempts+1,lease_token:lease};
      }
      return null;
    })();
  }
  finish(job,{status,errorCode='',httpStatus=0,retryable=false}) {
    const policy=this.policy(),retry=retryable&&job.attempts<policy.maxAttempts;
    return this.db.prepare("UPDATE cl_push_jobs SET status=?,error_code=?,http_status=?,next_at=?,lease_token='',lease_until=0,updated_at=? WHERE id=? AND status='running' AND lease_token=?")
      .run(retry?'pending':status,errorCode,httpStatus,this.now()+Math.min(3600000,policy.retrySeconds*1000*2**Math.max(0,job.attempts-1)),this.now(),job.id,job.lease_token).changes;
  }
  retry(id) {
    const job=this.db.prepare('SELECT * FROM cl_push_jobs WHERE id=?').get(id);
    if(!job)throw invalid('任务不存在','CONVERSATION_PUSH_NOT_FOUND',404);
    if(!['failed','cancelled'].includes(job.status))throw invalid('该任务无需重试','CONVERSATION_PUSH_CONFLICT',409);
    const valid=this.validJob(job);if(valid.paused||valid.cancel)throw invalid('请先核对当前目标、模型名单和日志副本','CONVERSATION_PUSH_RETRY_BLOCKED',409);
    if(this.pendingCount()>=this.policy().queueLimit)throw invalid('推送队列已满','CONVERSATION_PUSH_QUEUE_FULL',409);
    this.db.prepare("UPDATE cl_push_jobs SET status='pending',attempts=0,error_code='',http_status=0,next_at=?,updated_at=? WHERE id=? AND status IN ('failed','cancelled')").run(this.now(),this.now(),id);
    return {id,status:'pending'};
  }
  cancelBatch(id) {
    const result=this.db.prepare("UPDATE cl_push_jobs SET status='cancelled',error_code='ADMIN_CANCELLED',lease_token='',lease_until=0,updated_at=? WHERE batch_id=? AND status IN ('pending','running')").run(this.now(),id);
    return {cancelled:result.changes};
  }
  batch(id) {
    const row=this.db.prepare('SELECT id,created_at,matched,eligible,created FROM cl_push_batches WHERE id=?').get(id);if(!row)throw invalid('批次不存在','CONVERSATION_PUSH_NOT_FOUND',404);
    return {...row,counts:this.db.prepare('SELECT status,COUNT(*) count FROM cl_push_jobs WHERE batch_id=? GROUP BY status').all(id)};
  }
  list(query={}) {
    const page=Math.max(1,Math.min(1000000,Number(query.page)||1))|0;
    if(query.status&&!['pending','running','sent','failed','cancelled'].includes(query.status))throw invalid();
    const where=query.status?' WHERE j.status=?':'',args=query.status?[query.status]:[];
    const total=this.db.prepare('SELECT COUNT(*) n FROM cl_push_jobs j'+where).get(...args).n;
    const items=this.db.prepare(`SELECT j.id,j.record_id,j.destination,j.source,j.batch_id,j.status,j.attempts,j.next_at,j.created_at,j.updated_at,j.error_code,j.http_status,r.model,r.user_id
      FROM cl_push_jobs j JOIN cl_records r ON r.id=j.record_id${where} ORDER BY j.created_at DESC,j.id LIMIT 20 OFFSET ?`).all(...args,(page-1)*20);
    return {items,page,pages:Math.ceil(total/20),total,counts:this.db.prepare('SELECT status,COUNT(*) count FROM cl_push_jobs GROUP BY status').all(),
      batches:this.db.prepare('SELECT id,created_at,matched,eligible,created FROM cl_push_batches ORDER BY created_at DESC LIMIT 10').all()};
  }
  envelope(job) {
    const fields='id,request_id,user_id,key_id,account_id,session_id,at,duration_ms,host,path,method,protocol,model,status,complete,reason,policy_version,mode,encoding,processing_error,processing_policy_version,processed_at';
    const row=this.db.prepare(`SELECT ${fields},${job.source} AS payload FROM cl_records WHERE id=?`).get(job.record_id);
    if(!row?.payload)throw invalid('日志副本不可用','CONVERSATION_PUSH_COPY_UNAVAILABLE',409);
    const {payload,...metadata}=row,raw=this.archive.open(payload,row.id+':'+job.source);
    const checksum=value=>{const bytes=Buffer.from(value,'base64');return {bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};};
    return {schema:'sub2api.conversation.v1',delivery_id:job.id,source:job.source,metadata:{...metadata,complete:Boolean(metadata.complete),encoding:job.source==='original'?metadata.encoding:''},
      body_encoding:'base64',request:raw.request,response:raw.response,frames:raw.frames,
      checksums:{request:checksum(raw.request),response:checksum(raw.response),frames:raw.frames.map(frame=>checksum(frame.body))}};
  }
}
module.exports={ConversationPushStore};
