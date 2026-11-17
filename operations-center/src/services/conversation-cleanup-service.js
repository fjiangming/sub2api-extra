'use strict';

const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { ConversationCleanupStore } = require('../conversation-cleanup-store');
const { AppError } = require('../errors');

class ConversationCleanupService {
  constructor(archive, { canWork = () => true, intervalMs = 250, timeoutMs = 10000 } = {}) {
    this.archive = archive; this.store = new ConversationCleanupStore(archive).initialize();
    this.canWork = canWork; this.intervalMs = intervalMs; this.timeoutMs = timeoutMs;
    this.child = null; this.ready = false; this.busy = false; this.stopped = false; this.lastError = '';
  }
  status(scope = 'models') { return { job: this.store.latest(scope), activeScope: this.store.pending()?.scope || '', workerReady: this.ready, lastError: this.lastError }; }
  mutate(action) {
    const timeout = this.archive.db.pragma('busy_timeout', { simple: true });
    this.archive.db.pragma('busy_timeout = 1');
    try { return action(); }
    catch (error) {
      if (/^SQLITE_(?:BUSY|LOCKED)/.test(error.code || '')) throw new AppError('CONVERSATION_CLEANUP_BUSY', '归档正在写入，请稍后重试', { status: 503 });
      throw error;
    } finally { this.archive.db.pragma('busy_timeout = ' + timeout); }
  }
  request(input) { this.mutate(() => this.store.request(input)); this.wake(); return this.status(); }
  requestAll(input) { const job = this.mutate(() => this.store.requestAll(input)); this.wake(); return { ...this.status('all'), job }; }
  cancel(id, scope = 'models') { this.mutate(() => this.store.cancel(id, scope)); return this.status(scope); }
  start() {
    if (this.timer) return;
    const wake = () => { try { this.wake(); } catch { this.lastError = 'CLEANUP_STORAGE_UNAVAILABLE'; } };
    this.timer = setInterval(wake, 5000); this.timer.unref(); wake();
  }
  schedule(delay) {
    clearTimeout(this.nextStep);
    this.nextStep = setTimeout(() => {
      if (!this.child || !this.ready || this.busy || this.stopped) return;
      try {
        if (!this.store.pending()) return this.child.send({ type: 'stop' }, () => {});
        if (!this.canWork()) return this.schedule(this.intervalMs);
        const child = this.child; this.busy = true;
        this.deadline = setTimeout(() => { this.lastError = 'CLEANUP_TIMEOUT'; child.kill('SIGKILL'); }, this.timeoutMs); this.deadline.unref();
        child.send({ type: 'step' }, () => {});
      } catch { this.lastError = 'CLEANUP_STORAGE_UNAVAILABLE'; this.schedule(1000); }
    }, delay);
    this.nextStep.unref();
  }
  wake() {
    if (this.child || this.stopped || !this.store.pending()) return;
    const child = fork(path.join(__dirname, 'conversation-cleanup-worker.js'), [], {
      execArgv: ['--max-old-space-size=96', '--max-semi-space-size=4'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
    });
    this.child = child; this.ready = false;
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Host may not support priorities. */ }
    const startup = setTimeout(() => { if (!this.ready) child.kill('SIGKILL'); }, 10000); startup.unref();
    child.on('message', message => {
      if (this.child !== child) return;
      if (message?.type === 'ready') { clearTimeout(startup); this.ready = true; this.lastError = ''; this.schedule(0); }
      if (message?.type === 'idle') {
        clearTimeout(this.deadline); this.busy = false; this.lastError = '';
        this.schedule(message.busy ? 1000 : this.intervalMs);
      }
      if (message?.type === 'failure') this.lastError = 'CLEANUP_STORAGE_UNAVAILABLE';
    });
    child.on('error', () => { this.lastError = 'CLEANUP_WORKER_UNAVAILABLE'; });
    child.once('exit', code => {
      clearTimeout(startup); clearTimeout(this.nextStep); clearTimeout(this.deadline); if (this.child !== child) return;
      this.child = null; this.ready = false; this.busy = false;
      if (code !== 0 && !this.stopped && !this.lastError) this.lastError = 'CLEANUP_WORKER_UNAVAILABLE';
    });
    child.send({ type: 'initialize', directory: path.dirname(this.archive.directory), timezone: this.archive.timezone }, () => {});
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); clearTimeout(this.nextStep); clearTimeout(this.deadline);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ type: 'stop' }, () => {}); else child.kill();
    });
  }
}

module.exports = { ConversationCleanupService };
