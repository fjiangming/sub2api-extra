'use strict';

const { z } = require('zod');
const { AppError } = require('../errors');
const { hash } = require('./billing-import-csv');

const requestSchema = z.object({ id: z.string().uuid(), kind: z.enum(['preview', 'confirm']), input: z.unknown() }).strict();
const publicTask = task => { const { payloadHash, ...result } = task; return result; };

// The worker belongs to this process. Only receipts and progress are durable;
// browser credentials are never persisted or replayed after a restart.
class BillingImportTasks {
  constructor(service) { this.service = service; this.store = service.store; this.work = null; this.stopping = false; }
  start() { this.store.interruptTasks(); }
  get(batchId, taskId) {
    const task = this.store.task(taskId);
    if (task.batchId !== batchId) throw new AppError('NOT_FOUND', '后台任务不存在', { status: 404 });
    return publicTask(task);
  }
  latest(batchId) { const task = this.store.latestTask(batchId); return task ? publicTask(task) : null; }
  submit(batchId, input, accessToken) {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', '后台任务参数无效', { status: 400 });
    const { id, kind } = parsed.data, body = this.service.operationInput(kind, parsed.data.input);
    const payloadHash = hash([batchId, kind, body]);
    let existing;
    try { existing = this.store.task(id); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    if (existing) {
      if (existing.batchId !== batchId || existing.payloadHash !== payloadHash) throw new AppError('PREVIEW_CONFLICT', '任务编号已用于其他操作，请刷新核对', { status: 409 });
      return publicTask(existing);
    }
    if (this.stopping || this.work) throw new AppError('PREVIEW_CONFLICT', '已有后台任务正在处理，请等待完成后再操作', { status: 409 });
    this.service.validateOperation(batchId, kind, body);
    this.service.assertAvailable(batchId);
    const total = kind === 'preview' ? new Set(body.rowIds).size : body.rows.length;
    const task = this.store.createTask(id, batchId, kind, payloadHash, total);
    this.work = new Promise(resolve => setImmediate(resolve)).then(() => this.execute(task, body, accessToken))
      .catch(error => { console.error(`billing import task receipt unavailable: ${error.code || 'INTERNAL_ERROR'}`); })
      .finally(() => { this.work = null; });
    return publicTask(task);
  }
  async execute(task, body, accessToken) {
    let progress = task.progress;
    const report = patch => {
      progress = { ...progress, ...patch };
      this.store.updateTask(task.id, { status: 'running', progress });
    };
    try {
      report({ phase: 'rechecking' });
      const result = await this.service[task.kind](task.batchId, body, accessToken, { taskId: task.id, report });
      this.store.updateTask(task.id, { status: 'succeeded', result: { results: result.results },
        progress: { ...progress, phase: 'complete', completed: result.results.length, total: result.results.length }, finished_at: this.service.now() });
    } catch (error) {
      this.store.updateTask(task.id, { status: 'failed', error: { code: error.code || 'INTERNAL_ERROR',
        message: error instanceof AppError && error.expose !== false ? error.message : '后台处理失败；已保存的预览和回执保留，请刷新核对原记录。' },
      finished_at: this.service.now() });
    }
  }
  async stop() { this.stopping = true; await this.work; }
}

module.exports = { BillingImportTasks };
