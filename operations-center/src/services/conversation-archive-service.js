'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { fork } = require('node:child_process');

class ConversationArchiveService {
  constructor(archive, { timeoutMs = 20000, memoryBudgetBytes } = {}) {
    this.archive = archive; this.timeoutMs = timeoutMs; this.memoryBudgetBytes = memoryBudgetBytes;
    this.child = null; this.port = 0; this.busy = ''; this.stopped = false; this.pending = new Set();
    this.secret = crypto.randomBytes(32).toString('hex');
  }
  start() {
    if (this.starting) return this.starting;
    if (this.stopped || this.child) return Promise.resolve();
    this.starting = this.spawn().finally(() => { this.starting = null; });
    return this.starting;
  }
  async spawn() {
    const child = fork(path.join(__dirname, 'conversation-archive-worker.js'), [], {
      execArgv: ['--max-old-space-size=256', '--max-semi-space-size=8'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
    });
    this.child = child;
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Not available on every host. */ }
    child.on('message', message => {
      if (this.child !== child) return;
      if (message?.type === 'finished' && message.job === this.busy) {
        this.busy = ''; clearTimeout(this.jobTimer);
        if (['capacity', 'storage_failed', 'processor_memory', 'processor_failed'].includes(message.error)) this.archive.lastError = message.error;
        else if (!message.error) this.archive.lastError = null;
      }
    });
    child.on('error', () => { this.archive.lastError = 'processor_failed'; });
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = null; this.port = 0; this.busy = ''; clearTimeout(this.jobTimer);
      this.archive.lastError = 'processor_failed';
      for (const request of this.pending) request.destroy(new Error('ARCHIVE_PROCESSOR_UNAVAILABLE'));
      if (!this.stopped) {
        this.restartTimer = setTimeout(() => this.start().catch(() => {}), 5000);
        this.restartTimer.unref();
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ARCHIVE_PROCESSOR_START_FAILED')); }, 5000);
      const fail = () => { clearTimeout(timer); reject(new Error('ARCHIVE_PROCESSOR_START_FAILED')); };
      child.once('error', fail); child.once('exit', fail);
      const ready = message => {
        if (message?.type !== 'ready' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535 || this.child !== child) return;
        clearTimeout(timer); child.removeListener('error', fail); child.removeListener('exit', fail); child.removeListener('message', ready);
        this.port = message.port;
        resolve();
      };
      child.on('message', ready);
      child.send({ type: 'initialize', directory: path.dirname(this.archive.directory), timezone: this.archive.timezone,
        secret: this.secret, memoryBudgetBytes: this.memoryBudgetBytes }, error => { if (error) { child.kill('SIGKILL'); fail(); } });
    });
  }
  proxy(req, res, next, target = '/ingest', body) {
    if (!this.child || !this.port || this.busy || this.stopped) {
      req.resume();
      return res.status(503).json({ accepted: false, reason: this.busy ? 'processor_busy' : 'processor_failed' });
    }
    this.busy = crypto.randomBytes(16).toString('hex');
    const child = this.child;
    this.jobTimer = setTimeout(() => {
      this.archive.lastError = 'processor_failed'; child.kill('SIGKILL');
    }, this.timeoutMs);
    this.jobTimer.unref();
    const headers = { authorization: 'Bearer ' + this.secret, 'content-type': req.get('content-type') || 'application/json', 'x-archive-job': this.busy };
    if (req.get('content-encoding')) headers['content-encoding'] = req.get('content-encoding');
    if (body) headers['content-length'] = body.length;
    else if (req.get('content-length')) headers['content-length'] = req.get('content-length');
    const upstream = http.request({ host: '127.0.0.1', port: this.port, method: 'POST', path: target, headers, agent: false });
    this.pending.add(upstream);
    upstream.once('close', () => this.pending.delete(upstream));
    upstream.on('response', response => {
      res.status(response.statusCode); res.type('application/json'); response.pipe(res);
      response.once('end', () => this.pending.delete(upstream));
      response.once('error', () => res.destroy());
    });
    upstream.once('error', () => {
      this.pending.delete(upstream);
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      res.status(503).json({ accepted: false, reason: 'processor_failed', error: { code: 'CONVERSATION_PROCESSOR_UNAVAILABLE', message: '归档处理暂不可用' } });
    });
    req.once('aborted', () => upstream.destroy());
    res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
    if (body) upstream.end(body); else req.pipe(upstream);
  }
  async stop() {
    this.stopped = true; clearTimeout(this.restartTimer); clearTimeout(this.jobTimer);
    const child = this.child;
    for (const request of this.pending) request.destroy();
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
    });
  }
}

module.exports = { ConversationArchiveService };
