const crypto = require('crypto');
const { nowIso, parseJson, stringifyJson } = require('../db');
const { resolvePagination } = require('../pagination');
const { redactText } = require('../security/redaction');

function isSqliteContention(error) {
  return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class JobQueue {
  constructor({ db, concurrency = 5, perConnectionConcurrency = 2, pollIntervalMs = 750 }) {
    this.db = db;
    this.concurrency = concurrency;
    this.perConnectionConcurrency = perConnectionConcurrency;
    this.pollIntervalMs = pollIntervalMs;
    this.workerId = `${process.pid}-${crypto.randomUUID()}`;
    this.handlers = new Map();
    this.active = new Map();
    this.activeConnections = new Map();
    this.timer = null;
    this.soonTimer = null;
  }

  register(type, handler) {
    this.handlers.set(type, handler);
  }

  enqueue(type, options = {}) {
    const connectionId = options.connectionId || null;
    if (options.dedupe !== false) {
      const duplicate = connectionId
        ? this.db.prepare(`
            SELECT id FROM jobs WHERE type = ? AND connection_id = ?
              AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1
          `).get(type, connectionId)
        : this.db.prepare(`
            SELECT id FROM jobs WHERE type = ? AND connection_id IS NULL
              AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1
          `).get(type);
      if (duplicate) return duplicate.id;
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO jobs(
        id, type, connection_id, payload_json, status, priority, run_after,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      id,
      type,
      connectionId,
      stringifyJson(options.payload || {}),
      options.priority || 0,
      options.runAfter || now,
      now,
      now
    );
    this.#scheduleSoon();
    return id;
  }

  start() {
    this.db.prepare(`
      UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL,
        updated_at = ? WHERE status = 'running'
    `).run(nowIso());
    if (this.timer) return;
    this.timer = setInterval(() => this.#poll(), this.pollIntervalMs);
    this.timer.unref?.();
    this.#poll();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonTimer = null;
    await Promise.allSettled(this.active.values());
  }

  list(options = 100) {
    const paginated = options != null && typeof options === 'object' &&
      (options.page != null || options.pageSize != null);
    let rows;
    let pagination;
    if (paginated) {
      const total = this.db.prepare('SELECT COUNT(*) AS total FROM jobs').get().total;
      const resolved = resolvePagination({
        page: options.page,
        pageSize: options.pageSize,
        total
      });
      pagination = resolved.pagination;
      rows = this.db.prepare(`
        SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
      `).all(resolved.limit, resolved.offset);
    } else {
      const limit = options != null && typeof options === 'object' ? options.limit : options;
      rows = this.db.prepare(`
        SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(Math.min(500, Math.max(1, Number(limit) || 100)));
    }
    const items = rows.map((row) => ({
      ...row,
      payload: parseJson(row.payload_json, {}),
      payload_json: undefined
    }));
    return paginated ? { items, pagination } : items;
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? { ...row, payload: parseJson(row.payload_json, {}), payload_json: undefined } : null;
  }

  #scheduleSoon() {
    if (!this.timer || this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      if (this.timer) this.#poll();
    }, 0);
    this.soonTimer.unref?.();
  }

  #claim() {
    return this.db.transaction(() => {
      const candidates = this.db.prepare(`
        SELECT * FROM jobs WHERE status = 'pending' AND run_after <= ?
        ORDER BY priority DESC, created_at ASC LIMIT 1000
      `).all(nowIso());
      const row = candidates.find((candidate) => !candidate.connection_id ||
        (this.activeConnections.get(candidate.connection_id) || 0) < this.perConnectionConcurrency);
      if (!row) return null;
      const result = this.db.prepare(`
        UPDATE jobs SET status = 'running', attempt = attempt + 1,
          locked_at = ?, locked_by = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(nowIso(), this.workerId, nowIso(), row.id);
      return result.changes === 1
        ? { ...row, attempt: row.attempt + 1, payload: parseJson(row.payload_json, {}) }
        : null;
    })();
  }

  #poll() {
    while (this.active.size < this.concurrency) {
      let job;
      try {
        job = this.#claim();
      } catch (error) {
        // Another Provider Monitor process may briefly own SQLite's write lock.
        if (isSqliteContention(error)) return;
        throw error;
      }
      if (!job) break;
      if (job.connection_id) {
        this.activeConnections.set(
          job.connection_id,
          (this.activeConnections.get(job.connection_id) || 0) + 1
        );
      }
      const promise = this.#run(job).catch(async (error) => {
        console.error(JSON.stringify({
          level: 'error',
          component: 'job_queue',
          jobId: job.id,
          message: redactText(error?.message || error)
        }));
        try {
          await this.#writeWithRetry(() => this.db.prepare(`
            UPDATE jobs SET status = 'pending', run_after = ?, locked_at = NULL,
              locked_by = NULL, last_error = ?, updated_at = ?
            WHERE id = ? AND status = 'running' AND locked_by = ?
          `).run(
            new Date(Date.now() + 2000).toISOString(),
            redactText(error?.message || error).slice(0, 1000),
            nowIso(),
            job.id,
            this.workerId
          ));
        } catch (recoveryError) {
          console.error(JSON.stringify({
            level: 'error',
            component: 'job_queue_recovery',
            jobId: job.id,
            message: redactText(recoveryError?.message || recoveryError)
          }));
        }
      }).finally(() => {
        this.active.delete(job.id);
        if (job.connection_id) {
          const remaining = (this.activeConnections.get(job.connection_id) || 1) - 1;
          if (remaining > 0) this.activeConnections.set(job.connection_id, remaining);
          else this.activeConnections.delete(job.connection_id);
        }
        this.#scheduleSoon();
      });
      this.active.set(job.id, promise);
    }
  }

  async #writeWithRetry(operation, attempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        if (!isSqliteContention(error)) throw error;
        lastError = error;
        if (attempt < attempts - 1) await delay(50 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async #run(job) {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.#writeWithRetry(() => this.db.prepare(`
        UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
      `).run(`No handler registered for ${job.type}`, nowIso(), job.id));
      return;
    }
    let handlerError = null;
    try {
      await handler(job);
    } catch (error) {
      handlerError = error;
    }
    if (!handlerError) {
      await this.#writeWithRetry(() => this.db.prepare(`
        UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL,
          updated_at = ? WHERE id = ?
      `).run(nowIso(), job.id));
      return;
    }
    const retryable = Boolean(handlerError?.retryable) && job.attempt < 3;
    const delayMs = Math.min(60000, 2000 * 2 ** Math.max(0, job.attempt - 1));
    await this.#writeWithRetry(() => this.db.prepare(`
      UPDATE jobs SET status = ?, run_after = ?, locked_at = NULL, locked_by = NULL,
        last_error = ?, updated_at = ? WHERE id = ?
    `).run(
      retryable ? 'pending' : 'failed',
      retryable ? new Date(Date.now() + delayMs).toISOString() : nowIso(),
      redactText(handlerError?.message || handlerError).slice(0, 1000),
      nowIso(),
      job.id
    ));
  }
}

module.exports = {
  JobQueue
};
