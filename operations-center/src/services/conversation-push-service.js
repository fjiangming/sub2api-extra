'use strict';

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { publicPolicy,target,targetPolicy,invalid } = require('./conversation-push-policy');
const { ConversationPushTransport } = require('./conversation-push-transport');
const { ConversationJsonlService } = require('./conversation-jsonl-service');
const { dayAt, objectKey, jsonlBytes } = require('./conversation-jsonl-format');
const { processingBudgets } = require('./conversation-memory');

class ConversationPushService {
  constructor(store,{transport=new ConversationPushTransport(),jsonlOptions,canWork=() => true,canCleanup=() => true,memoryBudget=processingBudgets}={}) {
    this.store=store;this.transport=transport;this.stopping=false;this.active=null;this.lastError='';this.lastRun=null;this.testing=false;
    this.canWork=canWork;this.canCleanup=canCleanup;this.memoryBudget=memoryBudget;this.cleanupError='';this.nextCleanup=0;this.nextPrune=0;
    this.pricingPause='';this.pricingError='';
    this.jsonl=new ConversationJsonlService(store,transport,{memoryBudget,...jsonlOptions,canWork:()=>canWork()&&!this.active&&!this.testing});
  }
  policy() { return publicPolicy(this.store.policy()); }
  async write(action,code,message) {
    const deadline=performance.now()+1500;
    for (;;) {
      try { return action(); }
      catch(error) {
        if(!/^SQLITE_(?:BUSY|LOCKED)/.test(error.code||''))throw error;
        if(performance.now()>=deadline)throw invalid(message,code,503);
        await delay(50);
      }
    }
  }
  async configure(input) {
    const result=await this.write(()=>this.store.configure(input),'CONVERSATION_PUSH_POLICY_BUSY','归档正在写入，暂时无法保存推送策略，请稍后重试');
    this.invalidate();this.wake();return result;
  }
  invalidate() { this.active?.controller.abort();this.testController?.abort();this.jsonl.invalidate(); }
  status(query) { return {...this.store.list(query),automatic:this.store.automaticStatus(),jsonl:this.jsonl.store.list(),cleanup:{...this.store.cleanup.status(),error:this.cleanupError},lastError:this.jsonl.lastError||this.lastError,lastRun:this.jsonl.lastRun||this.lastRun,enabled:this.store.policy().enabled}; }
  maintain() {
    this.pricingPause=this.stopping?'stopped':!this.canWork()||!this.canCleanup()?'foreground':this.active||this.testing||this.jsonl.active?'push':'';
    if (this.pricingPause || this.store.now()<this.nextCleanup) return;
    this.nextCleanup=this.store.now()+1000;
    const pricing=this.store.pricing.pending(),policy=this.store.policy();
    if (pricing && (this.pricingTurn!==false || !policy.enabled || !policy.deleteAfterPush)) {
      this.pricingTurn=false;
      try {
        const result=this.store.pricing.step({canWork:()=>!this.stopping&&this.canWork()&&this.canCleanup()});
        this.pricingError=result.busy?'CONVERSATION_STORAGE_PRICING_BUSY':'';
      } catch { this.pricingError='CONVERSATION_STORAGE_PRICING_RETRY'; }
      return;
    }
    this.pricingTurn=true;
    try {
      if (this.store.now()>=this.nextPrune) {this.store.cleanup.prune();this.nextPrune=this.store.now()+5000;}
      if(!pricing)this.store.billing.backfill();
      if (!this.store.policy().enabled || !this.store.policy().deleteAfterPush) return;
      const began=Date.now();
      for (let index=0;index<16 && Date.now()-began<25 && this.canWork() && this.canCleanup();index++) {
        if (!this.store.cleanup.step().deleted) break;
      }
      if (this.canWork() && this.canCleanup() && !this.store.db.prepare('SELECT 1 FROM cl_payload_leases WHERE expires_at>? LIMIT 1').get(this.store.now())) {
        if (this.store.db.pragma('freelist_count',{simple:true})>0) this.store.cleanup.reclaim();
      }
      this.cleanupError='';
    } catch { this.cleanupError='LOCAL_CLEANUP_RETRY'; }
  }
  preview(input) { return this.store.preview(input); }
  async enqueue(input) {
    const result=await this.write(()=>this.store.enqueue(input),'CONVERSATION_PUSH_QUEUE_BUSY','归档正在写入，暂时无法创建推送批次，请稍后重试');
    this.wake();return result;
  }
  retry(id) {
    const job=this.store.db.prepare('SELECT jsonl_file_id FROM cl_push_jobs WHERE id=?').get(id),file=job?.jsonl_file_id&&this.jsonl.store.get(job.jsonl_file_id);
    const result=file?.status==='failed'?this.jsonl.store.retry(file.id):this.store.retry(id);this.wake();return result;
  }
  retryFile(id) { const result=this.jsonl.store.retry(id);this.wake();return result; }
  flush() { const result=this.jsonl.store.flush();this.wake();return result; }
  cancelBatch(id) { const result=this.store.cancelBatch(id);this.invalidate();this.wake();return result; }
  pricingStatus() {
    const job=this.store.pricing.status(),active=job&&['pending','running'].includes(job.status);
    return {job,workerReady:this.ready!==false,pauseReason:active?(this.ready===false?'worker':!this.canWork()||!this.canCleanup()?'foreground':this.pricingError?'retry':this.pricingPause):'',error:active?this.pricingError:''};
  }
  billing(query) { return {...this.store.billing.report(query),pricing:this.pricingStatus()}; }
  fillBilling(input) {
    const job=this.store.pricing.request(input);
    setImmediate(()=>{if(!this.stopping)this.wake();});
    return {job};
  }
  cancelBilling(id) { return {job:this.store.pricing.cancel(id)}; }
  async test(destination) {
    const selected=target(this.store.policy(),destination);
    if(!selected?.enabled)throw invalid('请先保存并启用目标');
    const policy=targetPolicy(this.store.policy(),destination);
    if(this.testing)throw invalid('连接测试正在执行','CONVERSATION_PUSH_BUSY',409);
    this.testing=true;
    const controller=new AbortController();this.testController=controller;
    try {
      const envelope={schema:'sub2api.conversation.test.v1',delivery_id:'test-'+crypto.randomUUID(),at:Date.now()};
      const hooks={guard:()=>{if(this.store.policy().version!==policy.version||this.stopping)throw new Error('POLICY_CHANGED');}};
      if(selected.type==='s3'&&policy.s3.format==='jsonl') {
        const id=crypto.randomBytes(16).toString('hex');
        const file={id,source:'test',records:1,bytes:jsonlBytes(envelope),object_key:objectKey(policy.s3.prefix,dayAt(envelope.at,policy.s3.jsonl.timezone),'test',envelope.at,id)};
        this.testRun=(async()=>{
          let uploadId='';
          const result=await this.transport.sendJsonl(policy,file,[envelope],controller.signal,{...hooks,onCreated:id=>{uploadId=id;}});
          if(result.status!=='sent'&&uploadId)await this.transport.abortJsonl(policy,{...file,upload_id:uploadId});
          return result;
        })();
      } else this.testRun=this.transport.send(policy,destination,envelope,controller.signal,hooks);
      return await this.testRun;
    } finally { this.testing=false;this.testController=null;this.testRun=null; }
  }
  async tick() {
    if(this.stopping||this.active||this.testing||this.jsonl.active||!this.canWork())return false;
    this.store.scanAutomatic();
    const job=this.store.claim({single:true});if(!job)return false;
    const controller=new AbortController();this.active={job,controller};
    const guard=()=>{
      const valid=this.store.validJob(job),current=this.store.db.prepare('SELECT status,lease_token FROM cl_push_jobs WHERE id=?').get(job.id);
      if(this.stopping||valid.paused||valid.cancel||current?.status!=='running'||current.lease_token!==job.lease_token)throw new Error('DELIVERY_INVALIDATED');
    };
    try {
      guard();
      const envelope=this.store.delivery(job,undefined,this.memoryBudget);
      this.store.freezeCopy(job,envelope);
      guard();
      const result=await this.transport.send(this.store.policy(),job.destination,envelope,controller.signal,{guard});
      this.store.finish(job,result);this.lastError=result.errorCode||'';this.lastRun=Date.now();
    } catch (error) {
      const code=['EXPORT_MEMORY','EXPORT_REQUEST_ID'].includes(error.code)?error.code:'DELIVERY_INVALIDATED';
      this.store.finish(job,{status:'failed',errorCode:code,retryable:code!=='EXPORT_REQUEST_ID'});
      this.lastError=code;
    } finally { this.active=null; }
    return true;
  }
  wake() {
    this.maintain();
    this.jsonl.wake();
    if(this.stopping||this.running)return;
    this.running=(async()=>{for(let count=0;count<20&&!this.stopping;count++){if(!await this.tick())break;await new Promise(resolve=>setImmediate(resolve));}})()
      .catch(()=>{this.lastError='QUEUE_FAILED';}).finally(()=>{this.running=null;});
  }
  start() {
    if(this.timer)return;
    this.stopping=false;
    this.jsonl.start();
    this.timer=setInterval(()=>this.wake(),1000);this.timer.unref();this.wake();
  }
  async stop() {
    this.stopping=true;clearInterval(this.timer);this.timer=null;this.invalidate();this.testController?.abort();
    await this.running;await this.testRun;await this.jsonl.stop();
  }
}
module.exports={ConversationPushService};
