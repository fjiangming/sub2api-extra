'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { z } = require('zod');
const { AppError } = require('./errors');

const id = z.string().regex(/^[a-zA-Z0-9_.:@-]{1,128}$/);
const number = z.number().finite().nonnegative();
const attrs = z.object({
  accountId: z.string().regex(/^[1-9]\d{0,18}$/).optional(),
  userId: z.string().regex(/^[1-9]\d{0,18}$/).optional(),
  model: z.string().max(120).optional(), effort: z.string().max(24).optional(),
  host: id.optional(), upstreamRequestId: id.optional(), usageRequestId: id.optional(),
  bytes: number.optional(), reused: z.boolean().optional(), protocol: z.string().max(16).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  droppedEvents: z.number().int().nonnegative().optional(),
  errorCode: z.string().regex(/^[A-Z0-9_.-]{1,64}$/i).optional(),
  outcome: z.enum(['completed', 'error', 'cancelled']).optional()
}).strict();
const EVENT_NAMES = ['request_start', 'body_read', 'prepare_start', 'prepare_end', 'queue_start', 'queue_end',
  'attempt_start', 'rewrite_end', 'get_conn', 'got_conn', 'dns_start', 'dns_end', 'tcp_start', 'tcp_end',
  'tls_start', 'tls_end', 'wrote_request', 'response_byte', 'response_headers', 'first_sse',
  'first_semantic', 'first_content', 'downstream_write', 'downstream_flush', 'attempt_end', 'request_end'];
const event = z.object({
  requestId: id, attemptId: id.optional(), sequence: z.number().int().min(0).max(1000000),
  name: z.enum(EVENT_NAMES), at: z.iso.datetime({ offset: true }),
  elapsedMs: number.max(86400000), attributes: attrs.default({})
}).strict();
const resource = z.object({
  type: z.literal('resource'), host: id, at: z.iso.datetime({ offset: true }),
  cpuPercent: number.max(100).optional(), stealPercent: number.max(100).optional(),
  iowaitPercent: number.max(100).optional(), memoryAvailableBytes: number.optional(),
  memoryTotalBytes: number.optional(), swapUsedBytes: number.optional(),
  diskAvailableBytes: number.optional(), diskTotalBytes: number.optional(), inodeAvailable: number.optional(),
  diskReadBytesPerSecond: number.optional(), diskWriteBytesPerSecond: number.optional(),
  networkRxBytesPerSecond: number.optional(), networkTxBytesPerSecond: number.optional(),
  tcpRetransmitsPerSecond: number.optional(), networkDropsPerSecond: number.optional()
}).strict();
const proxy = z.object({
  type: z.literal('proxy'), requestId: id, at: z.iso.datetime({ offset: true }),
  requestTimeMs: number, upstreamConnectMs: number.nullable(), upstreamHeaderMs: number.nullable(),
  upstreamResponseMs: number.nullable(), requestBytes: number, sentBytes: number,
  statusCode: z.number().int().min(100).max(599), cfRayId: id.optional()
}).strict();
const payloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('events'), events: z.array(event).min(1).max(64) }).strict(), resource, proxy
]);

class LatencyTelemetryStore {
  constructor(config, { now = () => Date.now() } = {}) {
    this.options = config.latencyTelemetry || {};
    this.directory = this.options.directory || path.join(config.dataDir, 'latency');
    this.now = now;
    this.db = null;
    this.lastError = null;
    this.droppedEvents = 0;
    this.lastPrune = 0;
    this.lastIngestAt = null;
  }

  initialize() {
    if (!this.options.token) return;
    this.checkMount();
    fs.mkdirSync(this.directory, { recursive: true });
    this.device = fs.statSync(this.directory).dev;
    this.db = new Database(path.join(this.directory, 'telemetry.sqlite'));
    this.db.pragma('auto_vacuum = INCREMENTAL');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('wal_autocheckpoint = 128');
    this.db.pragma('journal_size_limit = 1048576');
    this.maxBytes = (this.options.maxMb || 5120) * 1048576;
    this.db.pragma(`max_page_count = ${Math.floor((this.maxBytes - 8 * 1048576) / 4096)}`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS traces (
      request_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      keep_until INTEGER NOT NULL, outcome TEXT NOT NULL, metadata TEXT NOT NULL,
      events TEXT NOT NULL, dropped INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS trace_updated ON traces(updated_at DESC);
      CREATE INDEX IF NOT EXISTS trace_retention ON traces(keep_until);
      CREATE TABLE IF NOT EXISTS trace_links (request_id TEXT NOT NULL, trace_id TEXT NOT NULL,
        PRIMARY KEY(request_id, trace_id));
      CREATE INDEX IF NOT EXISTS link_trace ON trace_links(trace_id);
      CREATE TABLE IF NOT EXISTS resources (host TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(host, at));
      CREATE INDEX IF NOT EXISTS resource_time ON resources(at);
      CREATE TABLE IF NOT EXISTS proxies (request_id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS proxy_time ON proxies(at);`);
    this.prune();
    this.timer = setInterval(() => {
      try { this.checkMount(); this.prune(); } catch (error) { this.lastError = error.code || 'TELEMETRY_MAINTENANCE_FAILED'; }
    }, 60000);
    this.timer.unref();
  }

  checkMount() {
    if (!this.options.mountPath) return;
    const mount = this.options.mountPath;
    const relative = path.relative(mount, this.directory);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(mount) ||
      fs.statSync(mount).dev === fs.statSync(path.dirname(mount)).dev) {
      throw new AppError('TELEMETRY_MOUNT_MISSING', '诊断数据盘未挂载，已暂停持久化', { status: 503 });
    }
  }

  bytes() {
    if (!this.db) return 0;
    return ['', '-wal', '-shm'].reduce((sum, suffix) => {
      try { return sum + fs.statSync(path.join(this.directory, `telemetry.sqlite${suffix}`)).size; }
      catch { return sum; }
    }, 0);
  }

  checkSpace() {
    this.checkMount();
    if (fs.statSync(this.directory).dev !== this.device) {
      throw new AppError('TELEMETRY_MOUNT_CHANGED', '诊断数据盘已发生变化，已暂停采集', { status: 503 });
    }
    const stat = fs.statfsSync(this.directory);
    const available = stat.bavail * stat.bsize;
    if (available < (this.options.minFreeMb ?? 5120) * 1048576) {
      throw new AppError('TELEMETRY_DISK_LOW', '诊断数据盘剩余空间不足，已暂停采集', { status: 507 });
    }
    if (this.bytes() > this.maxBytes * 0.9) {
      const usedPages = this.db.pragma('page_count', { simple: true }) - this.db.pragma('freelist_count', { simple: true });
      if (usedPages * this.db.pragma('page_size', { simple: true }) > this.maxBytes * 0.85) this.prune(true);
      if (this.bytes() > this.maxBytes) throw new AppError('TELEMETRY_CAPACITY', '诊断存储已达容量上限', { status: 507 });
    }
  }

  ingest(input) {
    if (!this.db) throw new AppError('TELEMETRY_DISABLED', '尚未启用阶段采集', { status: 503 });
    const parsed = payloadSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_TELEMETRY', '诊断数据格式无效或包含非白名单字段', { status: 400 });
    const payload = parsed.data;
    const times = payload.type === 'events' ? payload.events.map((row) => Date.parse(row.at)) : [Date.parse(payload.at)];
    if (times.some((at) => at > this.now() + 300000 || at < this.now() - 31 * 86400000)) {
      throw new AppError('INVALID_TELEMETRY_TIME', '诊断时间超出接收范围', { status: 400 });
    }
    try {
      this.checkSpace();
      if (this.now() - this.lastPrune > 60000) this.prune();
      if (payload.type === 'events') this.db.transaction(() => this.saveEvents(payload.events))();
      else if (payload.type === 'resource') {
        this.db.prepare('INSERT OR REPLACE INTO resources(host, at, data) VALUES (?, ?, ?)')
          .run(payload.host, Date.parse(payload.at), JSON.stringify(payload));
      } else this.db.prepare('INSERT OR REPLACE INTO proxies(request_id, at, data) VALUES (?, ?, ?)')
        .run(payload.requestId, Date.parse(payload.at), JSON.stringify(payload));
      this.lastIngestAt = new Date(this.now()).toISOString();
      this.lastError = null;
      return { accepted: payload.type === 'events' ? payload.events.length : 1, droppedEvents: this.droppedEvents };
    } catch (error) {
      this.lastError = error.code || 'TELEMETRY_WRITE_FAILED';
      if (error instanceof AppError) throw error;
      throw new AppError('TELEMETRY_WRITE_FAILED', '诊断存储写入失败', { status: 503 });
    }
  }

  saveEvents(events) {
    const grouped = Map.groupBy ? Map.groupBy(events, (row) => row.requestId) :
      events.reduce((map, row) => map.set(row.requestId, [...(map.get(row.requestId) || []), row]), new Map());
    for (const [requestId, batch] of grouped) {
      const previous = this.db.prepare('SELECT * FROM traces WHERE request_id = ?').get(requestId);
      const combined = new Map((previous ? JSON.parse(previous.events) : []).map((row) => [row.sequence, row]));
      let dropped = previous?.dropped || 0;
      let terminal = [...combined.values()].some((row) => row.name === 'request_end');
      for (const row of batch) {
        if (combined.has(row.sequence)) continue;
        if ((row.name === 'request_end' && terminal) ||
          (row.name !== 'request_end' && combined.size - Number(terminal) >= 128)) {
          dropped += 1; this.droppedEvents += 1; continue;
        }
        combined.set(row.sequence, row);
        if (row.name === 'request_end') terminal = true;
      }
      const ordered = [...combined.values()].sort((a, b) => a.sequence - b.sequence).slice(0, 129);
      const metadata = Object.assign({}, previous ? JSON.parse(previous.metadata) : {}, ...ordered.map((row) => row.attributes));
      const startedAt = Math.min(previous?.started_at ?? Infinity, ...batch.map((row) => Date.parse(row.at) - row.elapsedMs));
      const end = ordered.find((row) => row.name === 'request_end');
      const outcome = end ? end.attributes.outcome || 'completed' : previous?.outcome || 'active';
      const slow = (end?.elapsedMs >= 300000) || ordered.some((row) => row.name === 'first_semantic' && row.elapsedMs >=
        (['high', 'xhigh', 'max'].includes(metadata.effort) ? 180000 : 60000));
      const retainDays = slow || outcome === 'error' || outcome === 'cancelled' || !end ? 30 : 7;
      this.db.prepare(`INSERT OR REPLACE INTO traces
        (request_id, started_at, updated_at, keep_until, outcome, metadata, events, dropped)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(requestId, startedAt, this.now(), startedAt + retainDays * 86400000, outcome,
          JSON.stringify(metadata), JSON.stringify(ordered), dropped);
      const link = this.db.prepare('INSERT OR IGNORE INTO trace_links(request_id, trace_id) VALUES (?, ?)');
      link.run(requestId, requestId);
      for (const row of ordered) {
        if (row.attributes.upstreamRequestId) link.run(row.attributes.upstreamRequestId, requestId);
        if (row.attributes.usageRequestId) link.run(row.attributes.usageRequestId, requestId);
      }
    }
  }

  prune(pressure = false) {
    if (!this.db) return;
    const cutoff = this.now() - 30 * 86400000;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM traces WHERE keep_until < ?').run(this.now());
      this.db.prepare('DELETE FROM resources WHERE at < ?').run(cutoff);
      this.db.prepare('DELETE FROM proxies WHERE at < ?').run(cutoff);
      for (const [table, order, cap] of [['traces', 'updated_at', 100000], ['resources', 'at', 200000], ['proxies', 'at', 100000]]) {
        this.db.prepare(`DELETE FROM ${table} WHERE rowid IN
          (SELECT rowid FROM ${table} ORDER BY ${order} DESC LIMIT -1 OFFSET ?)`).run(pressure ? Math.floor(cap / 2) : cap);
      }
      if (pressure) {
        for (const table of ['traces', 'resources', 'proxies']) this.db.prepare(`DELETE FROM ${table} WHERE rowid IN
          (SELECT rowid FROM ${table} ORDER BY ${table === 'traces' ? 'updated_at' : 'at'} LIMIT 5000)`).run();
      }
      this.db.exec('DELETE FROM trace_links WHERE trace_id NOT IN (SELECT request_id FROM traces)');
    })();
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.pragma('incremental_vacuum(1024)');
    this.lastPrune = this.now();
  }

  decode(row) {
    const events = JSON.parse(row.events);
    const metadata = JSON.parse(row.metadata);
    return { requestId: row.request_id, startedAt: new Date(row.started_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(), metadata, events, droppedEvents: row.dropped + (metadata.droppedEvents || 0),
      outcome: row.outcome === 'active' && this.now() - row.updated_at > 30 * 60000 ? 'unknown' : row.outcome,
      elapsedMs: row.outcome === 'active' ? Math.max(0, this.now() - row.started_at) : events.at(-1)?.elapsedMs,
      proxy: JSON.parse(this.db.prepare('SELECT data FROM proxies WHERE request_id = ?').get(row.request_id)?.data || 'null') };
  }

  find(requestIds) {
    if (!this.db || !requestIds.length) return [];
    return this.db.prepare(`SELECT DISTINCT t.* FROM traces t JOIN trace_links l ON l.trace_id = t.request_id
      WHERE l.request_id IN (${requestIds.map(() => '?').join(',')}) LIMIT 10`).all(...requestIds).map((row) => this.decode(row));
  }

  recent() {
    if (!this.db) return [];
    return this.db.prepare(`SELECT * FROM traces WHERE COALESCE(json_extract(metadata, '$.userId'), '') <> '1'
      ORDER BY CASE WHEN outcome = 'active' AND updated_at >= ? THEN 0 WHEN outcome = 'active' THEN 1 ELSE 2 END,
        CASE WHEN outcome = 'active' THEN started_at END ASC, updated_at DESC LIMIT 50`)
      .all(this.now() - 30 * 60000).map((row) => this.decode(row));
  }

  resources(input = {}) {
    if (!this.db) return [];
    const to = input.to ? Date.parse(input.to) : this.now();
    const from = input.from ? Date.parse(input.from) : to - 3600000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 86400000 ||
      (input.host && !id.safeParse(input.host).success)) {
      throw new AppError('INVALID_REQUEST', '资源查询窗口应在 24 小时内', { status: 400 });
    }
    return this.db.prepare(`SELECT data FROM resources WHERE at >= ? AND at <= ? ${input.host ? 'AND host = ?' : ''}
      ORDER BY at DESC LIMIT 2000`).all(from, to, ...(input.host ? [input.host] : []))
      .map((row) => JSON.parse(row.data)).reverse();
  }

  status() {
    return { enabled: Boolean(this.db), bytes: this.bytes(), maxBytes: this.maxBytes || null,
      lastIngestAt: this.lastIngestAt, lastError: this.lastError, droppedEvents: this.droppedEvents,
      traces: this.db ? this.db.prepare('SELECT COUNT(*) AS n FROM traces').get().n : 0 };
  }

  close() { clearInterval(this.timer); this.db?.close(); this.db = null; }
}

module.exports = { LatencyTelemetryStore, payloadSchema, EVENT_NAMES };
