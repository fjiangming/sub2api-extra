'use strict';

const cron = require('node-cron');
const { AppError } = require('../errors');
const { poolConfigured } = require('./retention-service');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scheduleExpression(time) {
  const [hour, minute] = String(time).split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

class CleanupScheduler {
  constructor({ retention, config, cronImpl = cron, sleepImpl = sleep, logger = console }) {
    this.retention = retention;
    this.config = config;
    this.cron = cronImpl;
    this.sleep = sleepImpl;
    this.logger = logger;
    this.task = null;
    this.running = false;
    this.phase = 'idle';
    this.lastAttempt = null;
  }

  start() {
    if (this.task || !this.config.automaticCleanup.enabled) return;
    this.task = this.cron.schedule(
      scheduleExpression(this.config.automaticCleanup.time),
      () => this.runScheduled(),
      {
        timezone: this.config.sub2apiTimezone,
        noOverlap: true,
        name: 'sub2api-operations-center-cleanup'
      }
    );
    this.logger.info(JSON.stringify({
      event: 'operations_center_cleanup_schedule_started',
      schedule: this.config.automaticCleanup.time,
      timezone: this.config.sub2apiTimezone,
      targets: this.config.automaticCleanup.targets,
      nextRunAt: this.nextRunAt()
    }));
  }

  stop() {
    this.task?.stop();
    this.task = null;
  }

  reconfigure() {
    this.stop();
    this.start();
    return this.getStatus();
  }

  nextRunAt() {
    const next = this.task?.getNextRun?.();
    return next ? next.toISOString() : null;
  }

  getStatus() {
    const automaticRunId = this.lastAttempt?.runId || null;
    const cleanupRunning = Boolean(automaticRunId && this.retention.activeRunId === automaticRunId);
    let cleanup = null;
    if (automaticRunId && typeof this.retention.getRun === 'function') {
      try {
        const run = this.retention.getRun(automaticRunId);
        cleanup = {
          id: run.id,
          status: run.status,
          deletedRows: run.deletedRows,
          finishedAt: run.finishedAt,
          error: run.error
        };
      } catch {
        // In-memory run history is bounded; the scheduling attempt remains available.
      }
    }
    return {
      enabled: this.config.automaticCleanup.enabled,
      ready: Boolean(
        this.config.automaticCleanup.enabled &&
        this.config.cleanupEnabled &&
        poolConfigured(this.retention.maintenancePool) &&
        this.retention.sub2api?.configured()
      ),
      running: this.running || cleanupRunning,
      phase: this.running ? this.phase : cleanupRunning ? 'cleanup' : 'idle',
      activeRunId: cleanupRunning ? automaticRunId : null,
      schedule: {
        time: this.config.automaticCleanup.time,
        timezone: this.config.sub2apiTimezone,
        nextRunAt: this.nextRunAt()
      },
      targets: this.config.automaticCleanup.targets.slice(),
      backupWaitMinutes: this.config.automaticCleanup.backupWaitMinutes,
      freshBackupRequired: true,
      lastAttempt: this.lastAttempt ? { ...this.lastAttempt, cleanup } : null
    };
  }

  async runScheduled() {
    const attempt = await this.runOnce('scheduled');
    this.logger.info(JSON.stringify({ event: 'operations_center_automatic_cleanup', ...attempt }));
    return attempt;
  }

  async runOnce(trigger = 'scheduled') {
    if (!this.config.automaticCleanup.enabled) {
      return { status: 'disabled', trigger, finishedAt: new Date().toISOString() };
    }
    if (this.running || this.retention.activeRunId) {
      const skipped = {
        status: 'skipped',
        trigger,
        reason: '已有清理任务正在执行',
        finishedAt: new Date().toISOString()
      };
      this.lastAttempt = skipped;
      return { ...skipped };
    }

    const attempt = {
      trigger,
      status: 'running',
      phase: 'preview',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      previewId: null,
      runId: null,
      eligibleRows: 0,
      backup: null,
      error: null,
      reason: null
    };
    this.running = true;
    this.phase = 'preview';
    this.lastAttempt = attempt;

    try {
      const preview = await this.retention.createPreview(this.config.automaticCleanup.targets);
      attempt.previewId = preview.id;
      attempt.eligibleRows = preview.targets.reduce((sum, target) => sum + Number(target.eligibleRows || 0), 0);
      if (preview.blockers.length) {
        attempt.status = 'blocked';
        attempt.reason = preview.blockers.join('；');
      } else if (!preview.executable || attempt.eligibleRows === 0) {
        attempt.status = 'skipped';
        attempt.reason = '没有超过保留期限的数据';
      } else {
        this.phase = 'backup';
        attempt.phase = 'backup';
        await this.retention.startNativeBackup();
        attempt.backup = await this.waitForFreshBackup(preview.createdAt);

        this.phase = 'execute';
        attempt.phase = 'execute';
        const run = await this.retention.execute({
          previewId: preview.id,
          confirmationPhrase: preview.confirmationPhrase,
          acknowledgeImpact: true,
          acknowledgeDownstream: true,
          actor: 'automatic-cleanup'
        });
        attempt.runId = run.id;
        attempt.status = 'started';
      }
    } catch (error) {
      attempt.status = 'failed';
      attempt.error = { code: error.code || 'AUTOMATIC_CLEANUP_FAILED', message: error.message };
    } finally {
      attempt.phase = 'finished';
      attempt.finishedAt = new Date().toISOString();
      this.phase = 'idle';
      this.running = false;
      this.lastAttempt = attempt;
    }
    return { ...attempt };
  }

  async waitForFreshBackup(previewCreatedAt) {
    const timeoutMs = this.config.automaticCleanup.backupWaitMinutes * 60000;
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() <= deadline) {
      latest = await this.retention.getBackupStatus({ previewCreatedAt });
      if (latest.satisfied) return latest;
      await this.sleep(Math.min(10000, Math.max(deadline - Date.now(), 0)));
    }
    throw new AppError('AUTOMATIC_BACKUP_TIMEOUT', '自动清理等待预览后的原生备份超时', {
      status: 409,
      details: { previewCreatedAt, timeoutMinutes: this.config.automaticCleanup.backupWaitMinutes, latest }
    });
  }
}

module.exports = { CleanupScheduler, scheduleExpression };
