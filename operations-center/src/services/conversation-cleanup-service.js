'use strict';

const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { ConversationCleanupStore } = require('../conversation-cleanup-store');

class ConversationCleanupService {
  constructor(archive) {
    this.archive = archive; this.store = new ConversationCleanupStore(archive).initialize();
    this.child = null; this.ready = false; this.stopped = false; this.lastError = '';
  }
  status() { return { job: this.store.latest(), workerReady: this.ready, lastError: this.lastError }; }
  request(input) { this.store.request(input); this.wake(); return this.status(); }
  cancel(id) { this.store.cancel(id); return this.status(); }
  start() {
    if (this.timer) return;
    const wake = () => { try { this.wake(); } catch { this.lastError = 'CLEANUP_STORAGE_UNAVAILABLE'; } };
    this.timer = setInterval(wake, 5000); this.timer.unref(); wake();
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
      if (message?.type === 'ready') { clearTimeout(startup); this.ready = true; this.lastError = ''; }
      if (message?.type === 'failure') this.lastError = 'CLEANUP_STORAGE_UNAVAILABLE';
    });
    child.on('error', () => { this.lastError = 'CLEANUP_WORKER_UNAVAILABLE'; });
    child.once('exit', code => {
      clearTimeout(startup); if (this.child !== child) return;
      this.child = null; this.ready = false;
      if (code !== 0 && !this.stopped && !this.lastError) this.lastError = 'CLEANUP_WORKER_UNAVAILABLE';
    });
    child.send({ type: 'initialize', directory: path.dirname(this.archive.directory), timezone: this.archive.timezone }, () => {});
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ type: 'stop' }, () => {}); else child.kill();
    });
  }
}

module.exports = { ConversationCleanupService };
