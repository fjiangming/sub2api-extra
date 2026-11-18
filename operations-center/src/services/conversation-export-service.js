'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const {ConversationReadService} = require('./conversation-read-service');
const {parseExport,failure} = require('./conversation-export-data');
const terminal = job => ['completed','failed','cancelled','expired'].includes(job.status);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

class ConversationExportService extends ConversationReadService {
  constructor(archive,auth,{ticketTtlMs=120000,historyTtlMs=600000,bytesPerSecond=2097152,maxPauseMs=30000,...options}={}) {
    super(archive,{timeoutMs:86400000,maxQueue:1,workerFile:path.join(__dirname,'conversation-export-worker.js'),...options});
    Object.assign(this,{auth,ticketTtlMs,historyTtlMs,bytesPerSecond,maxPauseMs});
    this.needsIndex=false;this.jobs=new Map();this.current=null;
  }
  sessionAlive(job) {
    const session=this.auth.sessions.get(job.sessionId);
    return Boolean(session && session.expiresAt>Date.now() && (!session.upstreamExpiresAt || session.upstreamExpiresAt>Date.now()));
  }
  publicJob(job) {
    const {id,status,createdAt,startedAt,endedAt,expiresAt,selected,exported,skipped,bytes,sha256,pauseReason,errorCode,errorMessage}=job;
    return {id,status,createdAt,startedAt,endedAt,expiresAt,limit:job.spec.limit,source:job.spec.source,
      selected,exported,skipped,bytes,sha256,pauseReason,errorCode,errorMessage};
  }
  create(req,input) {
    const spec=parseExport(input),sessionId=req.sessionId;
    if (!sessionId || !this.sessionAlive({sessionId})) throw failure('AUTH_REQUIRED','请重新登录后导出',401);
    if (this.stopped) throw failure('UNAVAILABLE','导出服务暂不可用',503);
    for (const job of this.jobs.values()) if (terminal(job) && Date.now()-job.endedAt>this.historyTtlMs) this.jobs.delete(job.id);
    if (this.current && !this.sessionAlive(this.current)) this.cancel({sessionId:this.current.sessionId},this.current.id);
    if (this.current && !terminal(this.current)) throw failure('BUSY','已有下载正在准备或进行中，请等待或取消',409);
    const ticket=crypto.randomBytes(32).toString('base64url'),now=Date.now();
    const job={id:crypto.randomUUID(),sessionId,spec,status:'ready',ticketHash:digest(ticket),createdAt:now,
      expiresAt:Math.min(now+this.ticketTtlMs,this.auth.sessions.get(sessionId).expiresAt),selected:0,exported:0,skipped:{},bytes:0,pauseReason:''};
    job.expiryTimer=setTimeout(() => {
      if (job.status!=='ready') return;
      job.status='expired';job.endedAt=Date.now();job.ticketHash='';if (this.current===job) this.current=null;
    },Math.max(1,job.expiresAt-now));job.expiryTimer.unref();
    this.jobs.set(job.id,job);this.current=job;
    // Keep only bounded metadata; the ticket and admin session never enter archive storage.
    while (this.jobs.size>20) this.jobs.delete(this.jobs.keys().next().value);
    return {job:this.publicJob(job),downloadUrl:`/api/conversation-logs/exports/${job.id}/download?ticket=${encodeURIComponent(ticket)}`};
  }
  owned(req,id) {
    const job=this.jobs.get(id);
    if (!job || job.sessionId!==req.sessionId) throw failure('NOT_FOUND','导出任务不存在或已过期',404);
    return job;
  }
  status(req,id) { return this.publicJob(this.owned(req,id)); }
  cancel(req,id) {
    const job=this.owned(req,id);
    if (!terminal(job)) {
      job.status='cancelled';job.endedAt=Date.now();job.ticketHash='';job.errorCode='CONVERSATION_EXPORT_CANCELLED';job.errorMessage='导出已取消，未完成的下载不可作为完整文件';
      clearTimeout(job.expiryTimer);
      if (job.entry) this.fail(job.entry,job.errorCode,job.errorMessage,409);
      if (this.current===job) this.current=null;
    }
    return this.publicJob(job);
  }
  download(req,res,next) {
    try {
      const job=this.jobs.get(req.params.id),ticket=req.query.ticket;
      if (!job || job.status!=='ready' || typeof ticket!=='string' || ticket.length>128 || job.expiresAt<=Date.now()
        || !job.ticketHash || !crypto.timingSafeEqual(Buffer.from(digest(ticket),'hex'),Buffer.from(job.ticketHash,'hex')) || !this.sessionAlive(job)) {
        throw failure('TICKET_INVALID','下载链接已失效，请在已登录页面重新导出',401);
      }
      job.ticketHash='';clearTimeout(job.expiryTimer);job.status='running';job.startedAt=Date.now();
      res.set({'cache-control':'no-store','referrer-policy':'no-referrer','x-accel-buffering':'no'});
      super.proxy(req,res,next,'/export');
      const entry=this.queue.find(value => value.req===req) || (this.active?.req===req ? this.active : null);
      if (entry) {entry.job=job;job.entry=entry;}
      else {job.status='failed';job.endedAt=Date.now();if (this.current===job) this.current=null;}
    } catch(error) {next(error);}
  }
  fail(entry,code,message,status=503) {
    if (code.startsWith('CONVERSATION_READ_')) {
      const kind=code.slice('CONVERSATION_READ_'.length);code='CONVERSATION_EXPORT_'+kind;
      message=kind==='MEMORY' ? '当前导出内存不足，请稍后重试' : kind==='TIMEOUT' ? '导出超时，文件未确认完整，请重新导出' : '导出暂不可用，请稍后重试';
    }
    const job=entry.job || this.current;
    if (job && !terminal(job)) {job.status='failed';job.errorCode=code;job.errorMessage=message;job.endedAt=Date.now();}
    super.fail(entry,code,message,status);
  }
  finish(entry) {
    if (entry.done) return;
    const job=entry.job || this.current;
    if (job && !terminal(job)) {
      job.status='cancelled';job.errorCode='CONVERSATION_EXPORT_DISCONNECTED';job.errorMessage='下载连接已中断，请重新导出';job.endedAt=Date.now();
    }
    if (job) {job.entry=null;job.pauseReason='';clearTimeout(job.expiryTimer);if (this.current===job) this.current=null;}
    if (entry.progressListener) entry.child?.removeListener('message',entry.progressListener);
    super.finish(entry);this.killChild();
  }
  send(entry) {
    const job=entry.job;
    if (!job || !this.sessionAlive(job)) return this.fail(entry,'CONVERSATION_EXPORT_AUTH_REQUIRED','登录已失效，下载已中止',401);
    this.active=entry;entry.child=this.child;clearTimeout(entry.timer);clearTimeout(this.idleTimer);
    entry.timer=setTimeout(() => this.fail(entry,'CONVERSATION_EXPORT_TIMEOUT','导出超时，文件未确认完整，请重新导出'),this.timeoutMs);
    const permit=() => {
      if (entry.done) return;
      if (!this.sessionAlive(job)) return this.fail(entry,'CONVERSATION_EXPORT_AUTH_REQUIRED','登录已失效，下载已中止',401);
      let allowed=false;try {allowed=Boolean(this.canWork());} catch { /* Busy services take priority. */ }
      if (entry.child.connected) entry.child.send({type:'export-permit',allowed},() => {});
    };
    entry.monitor=setInterval(permit,100);entry.monitor.unref();permit();
    entry.progressListener=message => {
      if (entry.done) return;
      if (message?.type==='export-progress') {
        for (const key of ['selected','exported','skipped','pauseReason']) job[key]=message[key];
      } else if (message?.type==='export-error') {
        entry.workerError=message;this.fail(entry,message.code,message.message,message.status);
      }
    };
    entry.child.on('message',entry.progressListener);
    const upstream=http.request({host:'127.0.0.1',port:this.port,method:'GET',path:'/export',agent:false,
      headers:{authorization:'Bearer '+this.secret,'x-conversation-export':JSON.stringify({spec:job.spec,bytesPerSecond:this.bytesPerSecond,maxPauseMs:this.maxPauseMs})}});
    entry.upstream=upstream;
    const failed=() => {
      if (!entry.done) this.fail(entry,entry.workerError?.code || 'CONVERSATION_EXPORT_INTERRUPTED',
        entry.workerError?.message || '下载中断，文件未确认完整，请重新导出',entry.workerError?.status || 503);
    };
    upstream.on('response',response => {
      if (entry.done) {response.destroy();return;}
      if (response.statusCode!==200) {
        let body='';response.on('data',chunk => {if (body.length<8192) body+=chunk;});
        response.on('end',() => {
          try {entry.workerError=JSON.parse(body).error;} catch { /* Use the fixed error below. */ }
          failed();
        });response.once('error',failed);return;
      }
      entry.res.status(200);
      for (const name of ['content-type','content-disposition','x-content-type-options']) if (response.headers[name]) entry.res.set(name,response.headers[name]);
      response.on('data',chunk => {job.bytes+=chunk.length;});
      entry.res.once('finish',() => {
        if (!entry.done && entry.summary) {Object.assign(job,entry.summary,{status:'completed',endedAt:Date.now(),pauseReason:''});this.finish(entry);}
      });
      response.pipe(entry.res,{end:false});
      response.once('end',() => {
        if (entry.done) return;
        try {
          const summary=JSON.parse(response.trailers['x-conversation-export-result']);
          if (!response.complete || summary.bytes!==job.bytes || !Number.isInteger(summary.exported) || summary.exported<1
            || summary.selected>job.spec.limit || !/^[a-f0-9]{64}$/.test(summary.sha256)
            || summary.exported+Object.values(summary.skipped).reduce((sum,count) => sum+count,0)!==summary.selected) throw new Error('INCOMPLETE');
          entry.summary=summary;entry.res.end();
        } catch {failed();}
      });
      response.once('error',failed);response.once('aborted',failed);
    });
    upstream.once('error',failed);upstream.end();
  }
  async stop() {
    for (const job of this.jobs.values()) {
      clearTimeout(job.expiryTimer);
      if (job.status==='ready') {job.status='cancelled';job.ticketHash='';job.endedAt=Date.now();}
    }
    await super.stop();this.jobs.clear();this.current=null;
  }
}

module.exports={ConversationExportService};
