'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {fork} = require('node:child_process');
const {availableMemory} = require('./conversation-memory');
const {AppError} = require('../errors');
const {holdPayloads} = require('./conversation-local-retention');

class ConversationReadService {
  constructor(archive,{timeoutMs=15000,queueTimeoutMs=5000,backfillTimeoutMs=10000,intervalMs=1000,idleMs=15000,maxQueue=8,
    configured=false,canWork=() => true,memoryBudgetBytes,workerFile=path.join(__dirname,'conversation-read-worker.js'),
    workerExecArgv=['--max-old-space-size=192','--max-semi-space-size=4']} = {}) {
    Object.assign(this,{archive,timeoutMs,queueTimeoutMs,backfillTimeoutMs,intervalMs,idleMs,maxQueue,configured,canWork,memoryBudgetBytes,workerFile,workerExecArgv});
    this.queue=[];this.child=null;this.port=0;this.active=null;this.stopped=false;this.needsIndex=true;
    this.secret=crypto.randomBytes(32).toString('hex');
  }
  start() { this.scheduleIndex(); }
  scheduleIndex() {
    clearTimeout(this.indexTimer);
    if (!this.stopped && this.needsIndex) {
      this.indexTimer=setTimeout(() => this.indexNext(),this.intervalMs);this.indexTimer.unref();
    }
  }
  fail(entry,code,message,status=503) {
    if (entry.done) return;
    entry.upstream?.destroy();
    if (entry.res && !entry.res.destroyed && !entry.res.writableEnded) {
      if (entry.res.headersSent) entry.res.destroy();
      else entry.res.status(status).json({error:{code,message}});
    }
    this.finish(entry);
  }
  finish(entry) {
    if (entry.done) return;
    entry.done=true;clearTimeout(entry.timer);clearInterval(entry.monitor);
    entry.releasePayloads?.();
    entry.res?.removeListener('close',entry.cancel);
    this.queue=this.queue.filter(value => value!==entry);
    if (this.active===entry) this.active=null;
    if (!this.stopped) setImmediate(() => this.drain());
  }
  killChild() {
    if (this.child) {this.port=0;this.retiring=true;this.child.kill('SIGKILL');}
  }
  preempt() {
    const entry=this.active;
    if (!entry?.internal) return;
    entry.upstream?.destroy();this.killChild();this.finish(entry);
  }
  proxy(req,res,_next,target) {
    if (this.stopped || this.queue.length>=this.maxQueue) return res.status(503).json({error:{code:'CONVERSATION_READ_BUSY',message:'日志读取繁忙，请稍后重试'}});
    const entry={req,res,target};
    if (target === '/export' || /^\/records\/[^/?]+/.test(target)) {
      try { entry.releasePayloads=holdPayloads(this.archive.db); }
      catch { return res.status(503).json({error:{code:'CONVERSATION_READ_BUSY',message:'日志读取繁忙，请稍后重试'}}); }
    }
    entry.cancel=() => {
      if (entry.done) return;
      if (this.active===entry && !res.writableEnded) {entry.upstream?.destroy();this.killChild();}
      this.finish(entry);
    };
    res.once('close',entry.cancel);
    entry.timer=setTimeout(() => this.fail(entry,'CONVERSATION_READ_BUSY','日志读取繁忙，请稍后重试'),this.queueTimeoutMs);
    this.queue.push(entry);this.preempt();this.drain();
  }
  async ensureChild() {
    // A killed SQLite reader may still be exiting. Never overlap it with a new process.
    if (this.retiring) await this.childExit;
    if (this.stopped) throw new Error('READ_STOPPED');
    if (this.starting) return this.starting;
    if (this.child && this.port) return;
    if (availableMemory(this.memoryBudgetBytes)<96*1024**2) throw new AppError('CONVERSATION_READ_MEMORY','当前读取内存不足，原文保留，请稍后重试',{status:409});
    this.starting=this.spawn().finally(() => {this.starting=null;});
    return this.starting;
  }
  async spawn() {
    const child=fork(this.workerFile,[],{execArgv:this.workerExecArgv,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    this.child=child;this.retiring=false;
    try {os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);} catch { /* Not supported on every host. */ }
    this.childExit=new Promise(resolve => {
      const exited=() => {
        if (this.child===child) {
          this.child=null;this.port=0;this.retiring=false;
          if (this.active?.child===child) this.fail(this.active,'CONVERSATION_READ_UNAVAILABLE','日志读取暂不可用，请稍后重试');
        }
        resolve();
      };
      child.once('exit',exited);
      child.once('error',() => {if (!child.pid) exited();});
    });
    await new Promise((resolve,reject) => {
      const deadline=setTimeout(() => {this.killChild();fail();},5000);
      const fail=() => {clearTimeout(deadline);reject(new Error('READ_START_FAILED'));};
      child.once('error',fail);child.once('exit',fail);
      const ready=message => {
        if (message?.type!=='ready' || this.child!==child || this.retiring || !Number.isInteger(message.port) || message.port<1 || message.port>65535) return;
        clearTimeout(deadline);child.removeListener('error',fail);child.removeListener('exit',fail);child.removeListener('message',ready);
        this.port=message.port;resolve();
      };
      child.on('message',ready);
      child.send({type:'initialize',directory:path.dirname(this.archive.directory),timezone:this.archive.timezone,secret:this.secret,memoryBudgetBytes:this.memoryBudgetBytes},error => {
        if (error) {this.killChild();fail();}
      });
    });
  }
  async drain() {
    if (this.stopped || this.active || this.draining) return;
    if (!this.queue.length) {
      this.scheduleIndex();clearTimeout(this.idleTimer);
      this.idleTimer=setTimeout(() => {if (!this.active && !this.queue.length && !this.draining) this.killChild();},this.idleMs);this.idleTimer.unref();
      return;
    }
    const pending=this.queue[0];
    clearTimeout(this.idleTimer);this.draining=true;
    try {
      await this.ensureChild();
      if (!this.stopped && !this.active && this.queue.length) this.send(this.queue.shift());
    } catch(error) {
      if (this.queue.includes(pending)) this.fail(pending,error instanceof AppError ? error.code : 'CONVERSATION_READ_UNAVAILABLE',
        error instanceof AppError ? error.message : '日志读取暂不可用，请稍后重试',error instanceof AppError ? error.status : 503);
    } finally {
      this.draining=false;
      if (!this.stopped && !this.active) setImmediate(() => this.drain());
    }
  }
  send(entry) {
    this.active=entry;entry.child=this.child;clearTimeout(entry.timer);clearTimeout(this.idleTimer);
    entry.timer=setTimeout(() => {
      this.killChild();this.fail(entry,'CONVERSATION_READ_TIMEOUT','日志读取超时，请稍后重试');
    },entry.internal ? this.backfillTimeoutMs : this.timeoutMs);
    if (entry.internal) {
      entry.monitor=setInterval(() => {if (!this.canWork()) this.preempt();},50);entry.monitor.unref();
    }
    const live={...this.archive.liveStatus(),configured:this.configured};
    const upstream=http.request({host:'127.0.0.1',port:this.port,method:entry.internal ? 'POST' : 'GET',path:entry.target,agent:false,
      headers:{authorization:'Bearer '+this.secret,'x-conversation-live':JSON.stringify(live)}});
    entry.upstream=upstream;
    const failed=() => {
      if (!entry.done) {this.killChild();this.fail(entry,'CONVERSATION_READ_UNAVAILABLE','日志读取暂不可用，请稍后重试');}
    };
    upstream.on('response',response => {
      if (entry.done) {response.resume();return;}
      if (response.headers['x-conversation-metadata-ready']) this.needsIndex=response.headers['x-conversation-metadata-ready']!=='true';
      if (entry.internal) {
        let body='';response.on('data',chunk => {if (body.length<4096) body+=chunk;});
        response.on('end',() => {
          try {if (response.statusCode===200 && JSON.parse(body).done) this.needsIndex=false;} catch { /* Retry a failed background step later. */ }
          this.finish(entry);
        });
      } else {
        entry.res.status(response.statusCode);
        for (const name of ['content-type','content-disposition','content-length']) if (response.headers[name]) entry.res.set(name,response.headers[name]);
        response.pipe(entry.res);response.once('end',() => this.finish(entry));
      }
      response.once('error',failed);
    });
    upstream.once('error',failed);upstream.end();
  }
  async indexNext() {
    if (this.stopped || !this.needsIndex) return;
    if (this.active || this.queue.length || this.draining || !this.canWork()) {this.scheduleIndex();return;}
    this.draining=true;
    try {
      await this.ensureChild();
      if (!this.stopped && !this.active && !this.queue.length && this.canWork()) this.send({internal:true,target:'/index-next'});
    } catch { /* Memory pressure or worker failure must not stop ingestion. */ }
    finally {this.draining=false;if (!this.active) {this.scheduleIndex();this.drain();}}
  }
  async stop() {
    this.stopped=true;clearTimeout(this.indexTimer);clearTimeout(this.idleTimer);
    for (const entry of [...this.queue,...(this.active ? [this.active] : [])]) this.fail(entry,'CONVERSATION_READ_UNAVAILABLE','日志读取已停止');
    this.killChild();await this.childExit;
  }
}

module.exports={ConversationReadService};
