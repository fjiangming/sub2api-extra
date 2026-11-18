'use strict';

const crypto = require('node:crypto');
const { publicPolicy, invalid } = require('./conversation-push-policy');
const { ConversationPushTransport } = require('./conversation-push-transport');
const { ConversationJsonlService } = require('./conversation-jsonl-service');
const { dayAt, objectKey, jsonlBytes } = require('./conversation-jsonl-format');

class ConversationPushService {
  constructor(store,{transport=new ConversationPushTransport(),jsonlOptions,canWork=() => true}={}) {
    this.store=store;this.transport=transport;this.stopping=false;this.active=null;this.lastError='';this.lastRun=null;this.testing=false;
    this.canWork=canWork;
    this.jsonl=new ConversationJsonlService(store,transport,{...jsonlOptions,canWork});
  }
  policy() { return publicPolicy(this.store.policy()); }
  configure(input) { const result=this.store.configure(input);this.invalidate();this.wake();return result; }
  invalidate() { this.active?.controller.abort();this.testController?.abort();this.jsonl.invalidate(); }
  status(query) { return {...this.store.list(query),jsonl:this.jsonl.store.list(),lastError:this.jsonl.lastError||this.lastError,lastRun:this.jsonl.lastRun||this.lastRun,enabled:this.store.policy().enabled}; }
  preview(input) { return this.store.preview(input); }
  enqueue(input) { const result=this.store.enqueue(input);this.wake();return result; }
  retry(id) {
    const job=this.store.db.prepare('SELECT jsonl_file_id FROM cl_push_jobs WHERE id=?').get(id),file=job?.jsonl_file_id&&this.jsonl.store.get(job.jsonl_file_id);
    const result=file?.status==='failed'?this.jsonl.store.retry(file.id):this.store.retry(id);this.wake();return result;
  }
  retryFile(id) { const result=this.jsonl.store.retry(id);this.wake();return result; }
  flush() { const result=this.jsonl.store.flush();this.wake();return result; }
  cancelBatch(id) { const result=this.store.cancelBatch(id);this.invalidate();this.wake();return result; }
  async test(destination) {
    if(!['webhook','s3'].includes(destination))throw invalid();
    const policy=this.store.policy();
    if(!policy[destination].enabled)throw invalid('请先保存并启用目标');
    if(this.testing)throw invalid('连接测试正在执行','CONVERSATION_PUSH_BUSY',409);
    this.testing=true;
    const controller=new AbortController();this.testController=controller;
    try {
      const envelope={schema:'sub2api.conversation.test.v1',delivery_id:'test-'+crypto.randomUUID(),at:Date.now()};
      const hooks={guard:()=>{if(this.store.policy().version!==policy.version||this.stopping)throw new Error('POLICY_CHANGED');}};
      if(destination==='s3'&&policy.s3.format==='jsonl') {
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
    if(this.stopping||!this.canWork())return false;
    this.store.scanAutomatic();
    const job=this.store.claim({single:true});if(!job)return false;
    const controller=new AbortController();this.active={job,controller};
    const guard=()=>{
      const valid=this.store.validJob(job),current=this.store.db.prepare('SELECT status,lease_token FROM cl_push_jobs WHERE id=?').get(job.id);
      if(this.stopping||valid.paused||valid.cancel||current?.status!=='running'||current.lease_token!==job.lease_token)throw new Error('DELIVERY_INVALIDATED');
    };
    try {
      guard();
      const envelope=this.store.envelope(job);
      this.store.freezeCopy(job,envelope);
      guard();
      const result=await this.transport.send(this.store.policy(),job.destination,envelope,controller.signal,{guard});
      this.store.finish(job,result);this.lastError=result.errorCode||'';this.lastRun=Date.now();
    } catch {
      this.store.finish(job,{status:'failed',errorCode:'DELIVERY_INVALIDATED',retryable:true});
      this.lastError='DELIVERY_INVALIDATED';
    } finally { this.active=null; }
    return true;
  }
  wake() {
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
