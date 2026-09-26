'use strict';

const { AppError } = require('./errors');
const { publicRun } = require('./store');

class Scheduler {
  constructor({ config, store, runner }) {
    this.config = config;
    this.store = store;
    this.runner = runner;
    this.queue = [];
    this.active = new Map();
    this.queuedMonitors = new Set();
    this.closed = false;
    this.timer = null;
  }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.tick().catch((error) => {
      console.error(JSON.stringify({ event: 'scheduler_tick_failed', message: error.message }));
    }), this.config.schedulerPollSeconds * 1000);
    this.timer.unref?.();
    setTimeout(() => this.tick().catch(() => {}), 250).unref?.();
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.length = 0;
    await Promise.allSettled([...this.active.values()]);
  }

  enqueue(monitor, triggerType = 'manual') {
    if (this.closed) throw new AppError('SCHEDULER_CLOSED', '检测调度器正在关闭', { status: 503 });
    const existing = this.store.activeRun(monitor.user_id, monitor.group_id);
    if (existing) return publicRun(existing);
    const test = this.store.getPlatformTest(monitor.platform);
    if (!test) {
      throw new AppError('PLATFORM_NOT_SUPPORTED', `平台 ${monitor.platform} 未配置检测题`, { status: 409 });
    }
    if (!monitor.enabled || !monitor.key_cipher || !monitor.key_fingerprint) {
      throw new AppError('GROUP_NOT_CONFIGURED', '该分组未启用检测或缺少专用 Key', { status: 409 });
    }
    const run = this.store.createRun(monitor, test, triggerType);
    this.queue.push({ runId: run.id, monitorId: monitor.id });
    this.queuedMonitors.add(monitor.id);
    this.drain();
    return publicRun(run);
  }

  async tick() {
    if (this.closed) return;
    for (const monitor of this.store.listDueMonitors(this.config.concurrency * 10)) {
      if (this.active.has(monitor.id) || this.queuedMonitors.has(monitor.id)) continue;
      try {
        this.enqueue(monitor, 'scheduled');
      } catch (error) {
        console.error(JSON.stringify({
          event: 'scheduler_enqueue_failed',
          monitorId: monitor.id,
          code: error.code || 'UNKNOWN'
        }));
      }
    }
  }

  drain() {
    while (!this.closed && this.active.size < this.config.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.queuedMonitors.delete(job.monitorId);
      const monitor = this.store.getMonitorById(job.monitorId);
      if (!monitor) continue;
      const promise = this.runner.execute(job.runId, monitor)
        .catch((error) => {
          console.error(JSON.stringify({
            event: 'detection_job_failed',
            runId: job.runId,
            monitorId: job.monitorId,
            code: error.code || 'UNKNOWN'
          }));
        })
        .finally(() => {
          this.active.delete(job.monitorId);
          this.drain();
        });
      this.active.set(job.monitorId, promise);
    }
  }
}

module.exports = { Scheduler };
