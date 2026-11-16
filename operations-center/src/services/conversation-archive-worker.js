'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const v8 = require('node:v8');
const crypto = require('node:crypto');
const express = require('express');
const { ConversationLogStore } = require('../conversation-log-store');
const { AppError } = require('../errors');

function availableMemory(override) {
  if (Number.isSafeInteger(override) && override >= 0) return override;
  let available = os.freemem();
  try {
    const maximum = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (maximum !== 'max') available = Math.min(available, Number(maximum) - Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')));
  } catch { /* Older cgroup hosts use the paths below. */ }
  try {
    const maximum = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'));
    available = Math.min(available, maximum - Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8')));
  } catch { /* Non-Linux hosts use the available host memory. */ }
  return Math.max(0, available);
}

process.once('message', async settings => {
  if (settings?.type !== 'initialize' || !settings.secret) return process.exit(1);
  let store, server;
  try {
    const budget = () => Math.max(0, Math.min(availableMemory(settings.memoryBudgetBytes) - 32 * 1024 ** 2,
      v8.getHeapStatistics().heap_size_limit - v8.getHeapStatistics().used_heap_size - 32 * 1024 ** 2));
    store = new ConversationLogStore(settings.directory, { timezone: settings.timezone,
      processingLimits: () => ({ maxOutputBytes: Math.min(256 * 1024 ** 2, Math.floor(budget() / 8)) }) }).initialize();
    store.start();
    const app = express(); app.disable('x-powered-by');
    let busy = false;
    app.use((req, res, next) => {
      const supplied = crypto.createHash('sha256').update(req.get('authorization') || '').digest();
      const expected = crypto.createHash('sha256').update('Bearer ' + settings.secret).digest();
      if (!crypto.timingSafeEqual(supplied, expected)) return res.sendStatus(401);
      if (busy) return res.status(503).json({ accepted: false, reason: 'processor_busy' });
      busy = true;
      let finished = false;
      const done = () => {
        if (finished) return; finished = true; busy = false;
        if (process.connected) process.send({ type: 'finished', job: req.get('x-archive-job'), error: res.locals.archiveError || '' }, () => {});
      };
      res.once('finish', done); res.once('close', done);
      const limit = Math.min(272 * 1024 ** 2, Math.floor(budget() / 8));
      if (limit < 65536 || Number(req.get('content-length')) > limit) {
        res.locals.archiveError = 'processor_memory'; req.resume();
        return res.status(503).json({ accepted: false, reason: 'processor_memory' });
      }
      express.json({ limit, strict: true, inflate: false })(req, res, next);
    });
    app.post('/ingest', (req, res, next) => {
      try {
        const result = store.ingest(req.body); res.locals.archiveError = result.reason || '';
        res.json(result);
      } catch (error) { next(error); }
    });
    app.post('/reprocess/:id', (req, res, next) => {
      try {
        const row = store.db.prepare('SELECT bytes FROM cl_records WHERE id=?').get(req.params.id);
        if (row && row.bytes * 8 > budget()) {
          res.locals.archiveError = 'processor_memory';
          throw new AppError('CONVERSATION_PROCESSOR_MEMORY', '处理内存不足，已保留原文，请稍后重试', { status: 409 });
        }
        res.json(store.retry(req.params.id, req.body));
      } catch (error) { next(error); }
    });
    app.use((_req, res) => res.sendStatus(404));
    app.use((error, _req, res, _next) => {
      if (error.type === 'entity.too.large') {
        res.locals.archiveError = 'processor_memory';
        return res.status(503).json({ accepted: false, reason: 'processor_memory' });
      }
      const safe = error instanceof AppError;
      res.status(safe ? error.status : 503).json({ error: { code: safe ? error.code : 'CONVERSATION_PROCESSING_FAILED',
        message: safe ? error.message : '归档处理暂不可用' } });
    });
    server = http.createServer(app); server.requestTimeout = 20000; server.headersTimeout = 10000;
    server.maxConnections = 2;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    process.send?.({ type: 'ready', port: server.address().port });
    process.once('disconnect', () => { server.close(); store.close(); process.exit(0); });
    process.once('SIGTERM', () => { server.close(); store.close(); process.exit(0); });
  } catch { process.exit(1); }
});
