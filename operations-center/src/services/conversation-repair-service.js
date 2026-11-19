'use strict';

const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { ConversationRepairStore } = require('../conversation-repair-store');
const { availableMemory } = require('./conversation-memory');

class ConversationRepairService {
  constructor(archive,{canWork = () => true,memoryBudgetBytes,timeoutMs = 20000,intervalMs = 1000} = {}) {
    this.archive = archive; this.store = new ConversationRepairStore(archive).initialize(); this.canWork = canWork;
    this.memoryBudgetBytes = memoryBudgetBytes; this.timeoutMs = timeoutMs; this.intervalMs = intervalMs;
    this.child = null; this.ready = false; this.busy = false; this.stopped = false; this.lastError = '';
  }
  status(scope = 'compatibility') { return {job:this.store.latest(scope),activeScope:this.store.pending()?.scope || null,policyVersion:this.archive.policy().version,workerReady:this.ready,lastError:this.lastError}; }
  request(input,scope = 'compatibility') { this.store.request(input,scope); this.wake(); return this.status(scope); }
  cancel(id,scope = 'compatibility') { this.store.cancel(id,scope); return this.status(scope); }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.wake(); } catch { this.lastError = 'REPAIR_STORAGE_UNAVAILABLE'; } },5000);
    this.timer.unref(); this.wake();
  }
  schedule(delay) {
    clearTimeout(this.nextStep);
    this.nextStep = setTimeout(() => {
      if (!this.child || !this.ready || this.busy || this.stopped) return;
      try {
        if (!this.store.pending()) return this.child.send({type:'stop'},() => {});
        if (!this.canWork()) return this.schedule(this.intervalMs);
        const child = this.child; this.busy = true;
        this.deadline = setTimeout(() => { this.lastError = 'REPAIR_TIMEOUT'; child.kill('SIGKILL'); },this.timeoutMs); this.deadline.unref();
        child.send({type:'step'},() => {});
      } catch { this.lastError = 'REPAIR_STORAGE_UNAVAILABLE'; this.schedule(this.intervalMs); }
    },delay);
    this.nextStep.unref();
  }
  wake() {
    if (this.child || this.stopped || !this.store.pending() || !this.canWork() || availableMemory(this.memoryBudgetBytes) < 96 * 1024 ** 2) return;
    const child = fork(path.join(__dirname,'conversation-repair-worker.js'),[],{
      execArgv:['--max-old-space-size=256','--max-semi-space-size=8'],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true
    });
    this.child = child; this.ready = false;
    try { os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Not supported by every host. */ }
    const startup = setTimeout(() => { if (!this.ready) child.kill('SIGKILL'); },10000); startup.unref();
    child.on('message',message => {
      if (this.child !== child) return;
      if (message?.type === 'ready') { clearTimeout(startup); this.ready = true; this.lastError = ''; this.schedule(0); }
      if (message?.type === 'idle') {
        clearTimeout(this.deadline); this.busy = false; this.lastError = '';
        this.schedule(message.busy || message.processed ? this.intervalMs : Math.min(250,this.intervalMs));
      }
      if (message?.type === 'failure') this.lastError = 'REPAIR_STORAGE_UNAVAILABLE';
    });
    child.on('error',() => { this.lastError = 'REPAIR_WORKER_UNAVAILABLE'; });
    child.once('exit',code => {
      clearTimeout(startup); clearTimeout(this.deadline); clearTimeout(this.nextStep);
      if (this.child !== child) return;
      this.child = null; this.ready = false; this.busy = false;
      if (code !== 0 && !this.stopped && !this.lastError) this.lastError = 'REPAIR_WORKER_UNAVAILABLE';
    });
    child.send({type:'initialize',directory:path.dirname(this.archive.directory),timezone:this.archive.timezone,memoryBudgetBytes:this.memoryBudgetBytes},() => {});
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); clearTimeout(this.nextStep); clearTimeout(this.deadline);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'),1500);
      child.once('exit',() => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({type:'stop'},() => {}); else child.kill();
    });
  }
}

module.exports = { ConversationRepairService };
