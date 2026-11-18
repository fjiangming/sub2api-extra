'use strict';

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { ConversationPushService } = require('./conversation-push-service');

class ConversationPushSupervisor extends ConversationPushService {
  constructor(store, { memoryBudgetBytes, canWork = () => true } = {}) {
    super(store); this.child = null; this.ready = false; this.pending = new Map(); this.memoryBudgetBytes = memoryBudgetBytes;
    this.canWork = canWork;
  }
  send(message) { if (this.child?.connected) this.child.send(message, () => {}); }
  wake() { this.send({ type: 'wake' }); }
  invalidate() { this.send({ type: 'invalidate' }); }
  status(query) { return { ...super.status(query), workerReady: this.ready }; }
  start() {
    if (this.child || this.stopping) return;
    const child = fork(path.join(__dirname, 'conversation-push-worker.js'), [], {
      execArgv: ['--max-old-space-size=256', '--max-semi-space-size=8'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
    });
    this.child = child; this.ready = false;
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* Host may not support process priorities. */ }
    const startupTimer = setTimeout(() => { if (!this.ready) child.kill('SIGKILL'); }, 10000); startupTimer.unref();
    child.on('message', message => {
      if (this.child !== child) return;
      if (message?.type === 'ready') {
        clearTimeout(startupTimer); this.ready = true; this.lastError = '';
        const priority = () => { let allowed = false; try { allowed = this.canWork(); } catch { /* Pause on unavailable metadata. */ } this.send({type:'priority',allowed}); };
        priority(); this.priorityTimer = setInterval(priority,250); this.priorityTimer.unref();
      }
      if (message?.type === 'status') {
        this.lastError = message.lastError || ''; this.lastRun = message.lastRun || null;
        this.jsonl.lastError = message.jsonlError || ''; this.jsonl.lastRun = message.jsonlRun || null;
      }
      if (message?.type === 'test-result') { const pending = this.pending.get(message.id); if (pending) { this.pending.delete(message.id); pending.resolve(message.result); } }
    });
    child.on('error', () => { this.lastError = 'PUSH_WORKER_UNAVAILABLE'; });
    child.once('exit', () => {
      clearTimeout(startupTimer); clearInterval(this.priorityTimer); if (this.child !== child) return;
      this.child = null; this.ready = false; this.lastError = 'PUSH_WORKER_UNAVAILABLE';
      for (const pending of this.pending.values()) pending.resolve({ status: 'failed', errorCode: 'PUSH_WORKER_UNAVAILABLE', retryable: true });
      this.pending.clear();
      if (!this.stopping) { this.restartTimer = setTimeout(() => this.start(), 5000); this.restartTimer.unref(); }
    });
    this.send({ type: 'initialize', directory: path.dirname(this.store.archive.directory), timezone: this.store.archive.timezone, memoryBudgetBytes: this.memoryBudgetBytes });
  }
  async test(destination) {
    if (!['webhook','s3'].includes(destination) || !this.ready) return { status: 'failed', errorCode: 'PUSH_WORKER_UNAVAILABLE' };
    if (this.pending.size) return { status: 'failed', errorCode: 'CONVERSATION_PUSH_BUSY' };
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); this.send({ type: 'invalidate' }); resolve({ status: 'failed', errorCode: 'TIMEOUT' }); }, (this.store.policy().timeoutSeconds * 4 + 5) * 1000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); } }); this.send({ type: 'test', id, destination });
    });
  }
  async stop() {
    this.stopping = true; clearTimeout(this.restartTimer); clearInterval(this.priorityTimer); const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); this.send({ type: 'stop' });
    });
  }
}

module.exports = { ConversationPushSupervisor };
