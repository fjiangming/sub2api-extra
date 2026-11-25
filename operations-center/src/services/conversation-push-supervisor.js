'use strict';

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { ConversationPushService } = require('./conversation-push-service');
const { target } = require('./conversation-push-policy');

class ConversationPushSupervisor extends ConversationPushService {
  constructor(store, { memoryBudgetBytes, heapMiB = process.env.OPERATIONS_CENTER_PUSH_HEAP_MIB, canWork = () => true, canCleanup = () => true,
    workerFile = path.join(__dirname, 'conversation-push-worker.js') } = {}) {
    super(store); this.child = null; this.ready = false; this.pending = new Map(); this.memoryBudgetBytes = memoryBudgetBytes;
    const heap = Number(heapMiB);
    this.heapMiB = /^\d+$/.test(String(heapMiB)) && Number.isSafeInteger(heap) && heap >= 128 && heap <= 8192 ? heap : 2048;
    this.canWork = canWork; this.canCleanup = canCleanup; this.workerFile = workerFile;
  }
  send(message) { if (this.child?.connected) this.child.send(message, () => {}); }
  wake() { this.send({ type: 'wake' }); }
  invalidate() { this.send({ type: 'invalidate' }); }
  status(query) { return { ...super.status(query), workerReady: this.ready }; }
  restartWorker() {
    if (!this.child || this.retiring || this.stopping) return;
    this.retiring = true; this.ready = false; this.lastError = 'UPLOAD_STALLED';
    this.child.kill('SIGKILL');
  }
  checkHeartbeat(at = performance.now()) {
    if (this.ready && at - this.lastHeartbeatAt >= 60000) this.restartWorker();
  }
  start() {
    if (this.child || this.stopping) return;
    const child = fork(this.workerFile, [], {
      execArgv: [`--max-old-space-size=${this.heapMiB}`, '--max-semi-space-size=8', '--expose-gc'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
    });
    this.child = child; this.ready = false; this.retiring = false;
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* Host may not support process priorities. */ }
    const startupTimer = setTimeout(() => { if (!this.ready) child.kill('SIGKILL'); }, 10000); startupTimer.unref();
    child.on('message', message => {
      if (this.child !== child || this.retiring) return;
      if (message?.type === 'ready') {
        clearTimeout(startupTimer); this.ready = true; this.lastError = ''; this.lastHeartbeatAt = performance.now();
        const priority = () => {
          this.checkHeartbeat(); if (!this.ready) return;
          let allowed = false,cleanupAllowed = false;
          try { allowed = this.canWork(); cleanupAllowed = allowed && this.canCleanup(); } catch { /* Pause on unavailable metadata. */ }
          this.send({type:'priority',allowed,cleanupAllowed});
        };
        priority(); this.priorityTimer = setInterval(priority,250); this.priorityTimer.unref();
      }
      if (message?.type === 'status') {
        this.lastHeartbeatAt = performance.now();
        if (message.jsonlRestartRequired) { this.restartWorker(); return; }
        this.lastError = message.lastError || ''; this.lastRun = message.lastRun || null;
        this.jsonl.lastError = message.jsonlError || ''; this.jsonl.lastRun = message.jsonlRun || null;
        this.cleanupError = message.cleanupError || '';
        this.pricingError = message.pricingError || ''; this.pricingPause = message.pricingPause || '';
      }
      if (message?.type === 'test-result') { const pending = this.pending.get(message.id); if (pending) { this.pending.delete(message.id); pending.resolve(message.result); } }
    });
    child.on('error', () => { this.lastError = 'PUSH_WORKER_UNAVAILABLE'; });
    child.once('exit', () => {
      clearTimeout(startupTimer); clearInterval(this.priorityTimer); if (this.child !== child) return;
      this.child = null; this.ready = false; this.lastError = this.retiring ? 'UPLOAD_STALLED' : 'PUSH_WORKER_UNAVAILABLE'; this.retiring = false;
      for (const pending of this.pending.values()) pending.resolve({ status: 'failed', errorCode: 'PUSH_WORKER_UNAVAILABLE', retryable: true });
      this.pending.clear();
      if (!this.stopping) { this.restartTimer = setTimeout(() => this.start(), 5000); this.restartTimer.unref(); }
    });
    this.send({ type: 'initialize', directory: path.dirname(this.store.archive.directory), timezone: this.store.archive.timezone, memoryBudgetBytes: this.memoryBudgetBytes });
  }
  async test(destination) {
    if (!target(this.store.policy(),destination)?.enabled || !this.ready) return { status: 'failed', errorCode: 'PUSH_WORKER_UNAVAILABLE' };
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
