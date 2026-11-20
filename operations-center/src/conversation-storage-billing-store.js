'use strict';

const { z } = require('zod');
const { target,platformIdSchema,invalid } = require('./services/conversation-push-policy');

const TB = 1000000000000n;
const filters = z.object({platform:platformIdSchema.optional(),model:z.string().max(160).optional(),
  start:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),end:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page:z.coerce.number().int().min(1).max(1000000).default(1)}).strict();
function amountMicros(bytes,rate) {
  const [whole,fraction='']=String(rate).split('.');
  const units=BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0'));
  return (BigInt(bytes)*units*100n+TB/2n)/TB;
}
function decimal(value,scale=6) {
  const number=BigInt(value||0),unit=10n**BigInt(scale);
  return (number/unit).toString()+'.'+(number%unit).toString().padStart(scale,'0');
}
function publicRow(row) {
  return {...row,bytes:Number(row.bytes),records:Number(row.records),delivered_at:Number(row.delivered_at),
    policy_version:Number(row.policy_version),rate_version:Number(row.rate_version),billing_enabled:Boolean(row.billing_enabled),
    amount:row.amount_micros===null?null:decimal(row.amount_micros),amount_micros:row.amount_micros===null?null:String(row.amount_micros),
    terabytes:decimal(row.bytes,12)};
}

class ConversationStorageBillingStore {
  constructor(push) {this.push=push;this.db=push.db;this.now=push.now;}
  initialize() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS cl_push_storage_usage(
      id TEXT PRIMARY KEY,platform_id TEXT NOT NULL,platform_name TEXT NOT NULL,type TEXT NOT NULL,model TEXT NOT NULL,
      bytes INTEGER NOT NULL CHECK(bytes>0),records INTEGER NOT NULL,delivery_id TEXT NOT NULL,object_key TEXT NOT NULL,
      sha256 TEXT NOT NULL,delivered_at INTEGER NOT NULL,log_date TEXT NOT NULL,policy_version INTEGER NOT NULL,
      billing_enabled INTEGER NOT NULL,rate_version INTEGER NOT NULL,rate TEXT,amount_micros INTEGER);
      CREATE INDEX IF NOT EXISTS cl_push_storage_time ON cl_push_storage_usage(delivered_at DESC,id);
      CREATE INDEX IF NOT EXISTS cl_push_storage_platform ON cl_push_storage_usage(platform_id,delivered_at DESC);
      CREATE INDEX IF NOT EXISTS cl_push_storage_unpriced ON cl_push_storage_usage(platform_id,model) WHERE rate IS NULL;`);
    return this;
  }
  record({id,platformId,model,bytes,records=1,deliveryId,objectKey='',sha256,at=this.now(),logDate='',policy=this.push.policy(),historical=false}) {
    if(!Number.isSafeInteger(bytes)||bytes<=0||!/^[a-f0-9]{64}$/.test(sha256||''))return 0;
    const destination=target(policy,platformId);if(!destination)return 0;
    const billing=destination.billing,price=!historical&&billing?.enabled?billing.rates.find(row=>row.model===model):null;
    return this.db.prepare(`INSERT OR IGNORE INTO cl_push_storage_usage
      (id,platform_id,platform_name,type,model,bytes,records,delivery_id,object_key,sha256,delivered_at,log_date,policy_version,billing_enabled,rate_version,rate,amount_micros)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,platformId,destination.name||platformId,destination.type,model,bytes,records,
      deliveryId,objectKey,sha256,at,logDate,policy.version,Number(Boolean(billing?.enabled)),billing?.version||1,price?.price??null,price?amountMicros(bytes,price.price):null).changes;
  }
  recordFile(file,policy=this.push.policy(),historical=false) {
    if(file.status!=='sent'||file.http_status<200||file.http_status>=300||file.uploaded_bytes!==file.bytes)return 0;
    return this.record({id:'jsonl:'+file.id,platformId:file.destination||'s3',model:file.model,bytes:file.bytes,records:file.records,
      deliveryId:file.id,objectKey:file.object_key,sha256:file.sha256,at:file.updated_at,logDate:file.day,policy,historical});
  }
  backfill() {
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cl_push_jsonl_files'").get())return 0;
    const rows=this.db.prepare(`SELECT f.* FROM cl_push_jsonl_files f WHERE f.status='sent' AND f.http_status>=200 AND f.http_status<300
      AND f.uploaded_bytes=f.bytes AND length(f.sha256)=64 AND f.sha256 NOT GLOB '*[^a-f0-9]*'
      AND NOT EXISTS(SELECT 1 FROM cl_push_storage_usage u WHERE u.id='jsonl:'||f.id)
      ORDER BY f.updated_at,f.id LIMIT 16`).all();
    if(!rows.length)return 0;
    return this.db.transaction(()=>rows.reduce((sum,row)=>{
      const current=this.push.policy(),policy=target(current,row.destination)?current:this.push.policy(row.policy_version);
      return sum+this.recordFile(row,policy,true);
    },0)).immediate();
  }
  selection(input={}) {
    const parsed=filters.safeParse(input);if(!parsed.success)throw invalid('存储计费筛选参数无效');
    const value=parsed.data,where=[],args=[];
    if(value.start&&value.end&&value.start>value.end)throw invalid('结束日期不能早于开始日期');
    for(const [key,column] of [['platform','platform_id'],['model','model']])if(value[key]){where.push(column+'=?');args.push(value[key]);}
    if(value.start){where.push('log_date>=?');args.push(value.start);}
    if(value.end){where.push('log_date<=?');args.push(value.end);}
    return {value,sql:where.length?' WHERE '+where.join(' AND '):'',args};
  }
  report(input={}) {
    const {value,sql,args}=this.selection(input);
    return this.db.transaction(()=>{
    const summary=this.db.prepare(`SELECT COUNT(*) files,COALESCE(SUM(bytes),0) bytes,COALESCE(SUM(amount_micros),0) amount_micros,
      SUM(CASE WHEN rate IS NOT NULL THEN 1 ELSE 0 END) priced_files,
      SUM(CASE WHEN rate IS NULL AND billing_enabled=1 THEN 1 ELSE 0 END) pending_files,
      COALESCE(SUM(CASE WHEN rate IS NULL AND billing_enabled=1 THEN bytes ELSE 0 END),0) pending_bytes,
      SUM(CASE WHEN billing_enabled=0 THEN 1 ELSE 0 END) disabled_files FROM cl_push_storage_usage${sql}`).safeIntegers(true).get(...args);
    const models=this.db.prepare(`SELECT platform_id,platform_name,model,rate,rate_version,billing_enabled,COUNT(*) files,SUM(bytes) bytes,
      SUM(records) records,SUM(amount_micros) amount_micros FROM cl_push_storage_usage${sql}
      GROUP BY platform_id,platform_name,model,rate,rate_version,billing_enabled ORDER BY platform_name,model,rate_version LIMIT 1001`).safeIntegers(true).all(...args);
    const items=this.db.prepare(`SELECT * FROM cl_push_storage_usage${sql} ORDER BY delivered_at DESC,id LIMIT 20 OFFSET ?`).safeIntegers(true).all(...args,(value.page-1)*20);
    return {currency:'CNY',bytesPerTb:Number(TB),page:value.page,pages:Math.ceil(Number(summary.files)/20),total:Number(summary.files),
      summary:{files:Number(summary.files),bytes:Number(summary.bytes),terabytes:decimal(summary.bytes,12),amount:decimal(summary.amount_micros),
        pricedFiles:Number(summary.priced_files||0),pendingFiles:Number(summary.pending_files||0),pendingBytes:Number(summary.pending_bytes),disabledFiles:Number(summary.disabled_files||0)},
      models:models.slice(0,1000).map(row=>({...row,files:Number(row.files),bytes:Number(row.bytes),records:Number(row.records),rate_version:Number(row.rate_version),
        billing_enabled:Boolean(row.billing_enabled),terabytes:decimal(row.bytes,12),amount:row.amount_micros===null?null:decimal(row.amount_micros),amount_micros:undefined})),
      modelsTruncated:models.length>1000,items:items.map(publicRow),
      platformTotals:this.db.prepare(`SELECT platform_id,COUNT(*) files,SUM(bytes) bytes,COALESCE(SUM(amount_micros),0) amount_micros
        FROM cl_push_storage_usage${sql} GROUP BY platform_id`).safeIntegers(true).all(...args)
        .map(row=>({id:row.platform_id,files:Number(row.files),bytes:Number(row.bytes),amount:decimal(row.amount_micros)})),
      platforms:this.db.prepare('SELECT platform_id id,platform_name name FROM cl_push_storage_usage GROUP BY platform_id ORDER BY platform_name').all()};
    })();
  }
}

module.exports={ConversationStorageBillingStore,amountMicros,decimal};
