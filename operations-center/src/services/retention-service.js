'use strict';

const crypto = require('crypto');
const { AppError } = require('../errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const POLICY_DEFINITIONS = Object.freeze({
  usage_logs: {
    label: '单次请求与请求级扣费明细',
    daysKey: 'usageLogsDays',
    tables: [{ table: 'usage_logs', column: 'created_at', type: 'timestamp' }],
    critical: true,
    coverageRequired: true,
    effect: '超期逐笔请求、请求级扣费、用户/API Key/模型/分组/渠道明细及导出不可恢复；余额、订单和日汇总不变。'
  },
  usage_hourly: {
    label: '小时用量汇总与小时活跃集合',
    daysKey: 'usageHourlyDays',
    tables: [
      { table: 'usage_dashboard_hourly', column: 'bucket_start', type: 'timestamp' },
      { table: 'usage_dashboard_hourly_users', column: 'bucket_start', type: 'timestamp' }
    ],
    critical: false,
    effect: '超期小时级趋势不可查；日/月站点统计继续由日汇总提供。'
  },
  usage_daily: {
    label: '站点日汇总与日活用户集合',
    daysKey: 'usageDailyDays',
    tables: [
      { table: 'usage_dashboard_daily', column: 'bucket_date', type: 'date' },
      { table: 'usage_dashboard_daily_users', column: 'bucket_date', type: 'date' }
    ],
    critical: true,
    effect: '超期站点请求、Token、消费趋势及 DAU/MAU 无法再查询；默认只清理 730 天以前。'
  },
  system_logs: {
    label: '普通系统日志',
    daysKey: 'systemLogDays',
    tables: [{ table: 'ops_system_logs', column: 'created_at', type: 'timestamp' }],
    critical: false,
    effect: '管理员无法再搜索超期普通运行日志和请求链路信息。'
  },
  error_logs: {
    label: '错误详情及短期运维事件',
    daysKey: 'errorLogDays',
    tables: [
      { table: 'ops_error_logs', column: 'created_at', type: 'timestamp' },
      { table: 'ops_ingress_reject_aggregates', column: 'bucket_start', type: 'timestamp' },
      { table: 'ops_alert_events', column: 'created_at', type: 'timestamp', predicate: "status <> 'firing'" }
    ],
    critical: false,
    effect: '用户错误详情、旧拒绝趋势和已结束告警复盘范围缩短；仍在 firing 的告警事件不会删除。'
  },
  ops_metrics: {
    label: '运维分钟/小时/日指标',
    daysKey: 'opsMetricDays',
    tables: [
      { table: 'ops_system_metrics', column: 'created_at', type: 'timestamp' },
      { table: 'ops_metrics_hourly', column: 'bucket_start', type: 'timestamp' },
      { table: 'ops_metrics_daily', column: 'bucket_date', type: 'date' }
    ],
    critical: false,
    effect: '超期性能、吞吐和错误率曲线不能回放；不影响请求处理和计费。'
  }
});

const PERMANENTLY_PROTECTED = Object.freeze([
  { data: '用户、余额、API Key、认证与安全配置', tables: ['users', 'api_keys', 'auth_identities', 'passkeys'] },
  { data: '订阅、订单、支付审计、充值、退款、兑换与人工调整', tables: ['user_subscriptions', 'payment_orders', 'payment_audit_logs', 'redeem_codes'] },
  { data: '推广、奖励及资产账本', tables: ['user_affiliate_ledger'] },
  { data: '扣费防重热表与归档', tables: ['usage_billing_dedup', 'usage_billing_dedup_archive'] },
  { data: '管理审计、命中审核、prompt 审计与未决申诉证据', tables: ['audit_logs', 'content_moderation_logs', 'prompt_audit_events'] },
  { data: '任务、对象引用、配置、路由、价格及未消费事件', tables: [] }
]);

function cutoffFor(now, days) {
  return new Date(now.getTime() - days * 86400000);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function publicRun(run) {
  const { cancelRequested: _cancelRequested, ...result } = run;
  return result;
}

class RetentionService {
  constructor({ readPool, maintenancePool, inspector, sub2api, config }) {
    this.readPool = readPool;
    this.maintenancePool = maintenancePool;
    this.inspector = inspector;
    this.sub2api = sub2api;
    this.config = config;
    this.previews = new Map();
    this.runs = new Map();
    this.activeRunId = null;
  }

  cleanupExpiredState() {
    const now = Date.now();
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) <= now) this.previews.delete(id);
    }
    while (this.previews.size > 20) this.previews.delete(this.previews.keys().next().value);
    while (this.runs.size > 50) {
      const first = this.runs.keys().next().value;
      if (first === this.activeRunId) break;
      this.runs.delete(first);
    }
  }

  getPolicy() {
    const now = new Date();
    return {
      generatedAt: now.toISOString(),
      cleanupEnabled: this.config.cleanupEnabled,
      maintenanceConnectionConfigured: Boolean(this.maintenancePool),
      requireFreshBackup: this.config.requireFreshBackup,
      executionMode: 'explicit-previewed-batched-database-cleanup',
      automaticSchedule: Boolean(this.config.automaticCleanup?.enabled),
      policies: Object.entries(POLICY_DEFINITIONS).map(([id, definition]) => {
        const retentionDays = this.config.retention[definition.daysKey];
        return {
          id,
          label: definition.label,
          retentionDays,
          cutoff: cutoffFor(now, retentionDays).toISOString(),
          tables: definition.tables.map((item) => item.table),
          critical: definition.critical,
          effect: definition.effect
        };
      }),
      permanentlyProtected: PERMANENTLY_PROTECTED,
      neverAutomated: [
        '文件系统、WAL、PostgreSQL 数据文件、Redis AOF/RDB',
        'Docker 卷、正在运行的容器、当前镜像和唯一回滚镜像',
        '备份集、图片/视频对象、批量任务输入输出',
        '未消费 outbox、进行中任务、有效会话和幂等状态'
      ],
      nativeConfiguration: {
        note: '持续滚动保留仍建议由 Sub2API 原生任务负责；修改以下环境变量并重启 Sub2API 后生效。运营中心不会修改 Sub2API 源码或配置文件。',
        environment: {
          DASHBOARD_AGGREGATION_RETENTION_USAGE_LOGS_DAYS: String(this.config.retention.usageLogsDays),
          DASHBOARD_AGGREGATION_RETENTION_HOURLY_DAYS: String(this.config.retention.usageHourlyDays),
          DASHBOARD_AGGREGATION_RETENTION_DAILY_DAYS: String(this.config.retention.usageDailyDays)
        }
      }
    };
  }

  selectedDefinitions(targetIds) {
    const selected = targetIds == null || targetIds.length === 0 ? Object.keys(POLICY_DEFINITIONS) : targetIds;
    if (!Array.isArray(selected) || selected.some((id) => !POLICY_DEFINITIONS[id])) {
      throw new AppError('INVALID_CLEANUP_TARGET', '清理目标不在固定白名单中', { status: 400 });
    }
    return [...new Set(selected)].map((id) => [id, POLICY_DEFINITIONS[id]]);
  }

  async getBackupStatus({ previewCreatedAt = null } = {}) {
    if (!this.sub2api?.configured()) {
      return { available: false, satisfied: !this.config.requireFreshBackup, reason: '未配置 Sub2API 管理 API 凭据' };
    }
    try {
      const records = await this.sub2api.listBackups();
      const completed = records
        .filter((record) => String(record.status).toLowerCase() === 'completed' && record.finished_at)
        .sort((left, right) => Date.parse(right.finished_at) - Date.parse(left.finished_at));
      const latest = completed[0] || null;
      const minimum = previewCreatedAt
        ? Date.parse(previewCreatedAt)
        : Date.now() - this.config.retention.backupMaxAgeHours * 3600000;
      return {
        available: true,
        satisfied: Boolean(latest && Date.parse(latest.finished_at) >= minimum),
        requirement: previewCreatedAt ? 'completed_after_preview' : `completed_within_${this.config.retention.backupMaxAgeHours}_hours`,
        latest: latest ? {
          id: latest.id,
          status: latest.status,
          fileName: latest.file_name,
          sizeBytes: number(latest.size_bytes),
          finishedAt: latest.finished_at,
          expiresAt: latest.expires_at || null,
          restoreStatus: latest.restore_status || null
        } : null
      };
    } catch (error) {
      return { available: false, satisfied: false, reason: error.message, code: error.code || 'BACKUP_CHECK_FAILED' };
    }
  }

  async startNativeBackup() {
    if (!this.sub2api?.configured()) {
      throw new AppError('BACKUP_API_NOT_CONFIGURED', '未配置 Sub2API 管理 API，不能触发原生备份', { status: 503 });
    }
    return this.sub2api.startBackup();
  }

  async inspectNativeActivity() {
    const state = await this.inspector.inspect();
    const activity = { usageCleanupTasks: [], jobHeartbeats: [] };
    if (state.tables.usage_cleanup_tasks?.exists) {
      const { rows } = await this.readPool.query(`
        SELECT id, status, created_at, started_at, deleted_rows
        FROM usage_cleanup_tasks
        WHERE status IN ('pending', 'running')
        ORDER BY created_at DESC LIMIT 20
      `);
      activity.usageCleanupTasks = rows.map((row) => ({ ...row, deleted_rows: number(row.deleted_rows) }));
    }
    if (state.tables.ops_job_heartbeats?.exists) {
      const { rows } = await this.readPool.query(`
        SELECT job_name, last_run_at, last_success_at, last_error_at, last_error, updated_at
        FROM ops_job_heartbeats
        WHERE job_name IN ('ops_cleanup', 'dashboard_aggregation')
      `);
      activity.jobHeartbeats = rows;
    }
    return activity;
  }

  async checkUsageCoverage(cutoff) {
    const schema = await this.inspector.inspect();
    const required = ['usage_logs', 'usage_dashboard_daily', 'usage_dashboard_daily_users', 'usage_dashboard_aggregation_watermark'];
    const missing = required.filter((name) => !schema.tables[name]?.exists);
    if (missing.length) {
      return { passed: false, missing, reason: '缺少原生日汇总或聚合水位表' };
    }
    const coverageStart = cutoffFor(new Date(), this.config.retention.usageDailyDays);
    const [watermarkResult, comparisonResult, rawBounds] = await Promise.all([
      this.readPool.query(`
        SELECT last_aggregated_at, updated_at,
               EXTRACT(EPOCH FROM (NOW() - last_aggregated_at)) AS lag_seconds
        FROM usage_dashboard_aggregation_watermark WHERE id = 1
      `),
      this.readPool.query(`
        WITH raw AS (
          SELECT (created_at AT TIME ZONE $3)::date AS bucket_date,
                 COUNT(*) AS total_requests,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                 COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                 COALESCE(SUM(total_cost), 0) AS total_cost,
                 COALESCE(SUM(actual_cost), 0) AS actual_cost,
                 COALESCE(SUM(COALESCE(account_stats_cost, total_cost) * COALESCE(account_rate_multiplier, 1)), 0) AS account_cost,
                 COALESCE(SUM(COALESCE(duration_ms, 0)), 0) AS total_duration_ms,
                 COUNT(DISTINCT user_id) AS active_users
          FROM usage_logs
          WHERE (created_at AT TIME ZONE $3)::date >= ($1::timestamptz AT TIME ZONE $3)::date
            AND (created_at AT TIME ZONE $3)::date <= ($2::timestamptz AT TIME ZONE $3)::date
          GROUP BY 1
        ), daily_users AS (
          SELECT bucket_date, COUNT(*) AS active_users
          FROM usage_dashboard_daily_users
          WHERE bucket_date >= ($1 AT TIME ZONE $3)::date
            AND bucket_date <= ($2 AT TIME ZONE $3)::date
          GROUP BY bucket_date
        )
        SELECT raw.bucket_date::text,
               raw.total_requests AS raw_requests,
               dashboard.total_requests AS aggregate_requests,
               raw.active_users AS raw_active_users,
               daily_users.active_users AS aggregate_active_users,
               CASE WHEN dashboard.bucket_date IS NULL THEN 'missing_daily'
                    WHEN daily_users.bucket_date IS NULL THEN 'missing_users'
                    WHEN raw.total_requests <> dashboard.total_requests THEN 'request_mismatch'
                    WHEN raw.input_tokens <> dashboard.input_tokens THEN 'input_token_mismatch'
                    WHEN raw.output_tokens <> dashboard.output_tokens THEN 'output_token_mismatch'
                    WHEN raw.cache_creation_tokens <> dashboard.cache_creation_tokens THEN 'cache_creation_mismatch'
                    WHEN raw.cache_read_tokens <> dashboard.cache_read_tokens THEN 'cache_read_mismatch'
                    WHEN ABS(raw.total_cost - dashboard.total_cost) > 0.000000001 THEN 'total_cost_mismatch'
                    WHEN ABS(raw.actual_cost - dashboard.actual_cost) > 0.000000001 THEN 'actual_cost_mismatch'
                    WHEN ABS(raw.account_cost - dashboard.account_cost) > 0.000000001 THEN 'account_cost_mismatch'
                    WHEN raw.total_duration_ms <> dashboard.total_duration_ms THEN 'duration_mismatch'
                    WHEN raw.active_users <> daily_users.active_users THEN 'active_user_mismatch'
                    WHEN raw.active_users <> dashboard.active_users THEN 'daily_active_user_mismatch'
               END AS mismatch
        FROM raw
        LEFT JOIN usage_dashboard_daily dashboard USING (bucket_date)
        LEFT JOIN daily_users USING (bucket_date)
        WHERE dashboard.bucket_date IS NULL
           OR daily_users.bucket_date IS NULL
           OR raw.total_requests <> dashboard.total_requests
           OR raw.input_tokens <> dashboard.input_tokens
           OR raw.output_tokens <> dashboard.output_tokens
           OR raw.cache_creation_tokens <> dashboard.cache_creation_tokens
           OR raw.cache_read_tokens <> dashboard.cache_read_tokens
           OR ABS(raw.total_cost - dashboard.total_cost) > 0.000000001
           OR ABS(raw.actual_cost - dashboard.actual_cost) > 0.000000001
           OR ABS(raw.account_cost - dashboard.account_cost) > 0.000000001
           OR raw.total_duration_ms <> dashboard.total_duration_ms
           OR raw.active_users <> daily_users.active_users
           OR raw.active_users <> dashboard.active_users
        ORDER BY raw.bucket_date
        LIMIT 51
      `, [coverageStart, cutoff, this.config.sub2apiTimezone]),
      this.readPool.query(`
        SELECT MIN(created_at) AS raw_from, MAX(created_at) AS raw_through,
               COUNT(*) FILTER (WHERE created_at < $1) AS eligible_rows
        FROM usage_logs
      `, [cutoff])
    ]);
    const watermark = watermarkResult.rows[0] || null;
    const lagSeconds = number(watermark?.lag_seconds);
    const mismatches = comparisonResult.rows.slice(0, 50).map((row) => ({
      ...row,
      raw_requests: number(row.raw_requests),
      aggregate_requests: number(row.aggregate_requests),
      raw_active_users: number(row.raw_active_users),
      aggregate_active_users: number(row.aggregate_active_users)
    }));
    const tooMany = comparisonResult.rows.length > 50;
    const passed = Boolean(watermark?.last_aggregated_at) && lagSeconds <= 86400 && mismatches.length === 0;
    return {
      passed,
      timezone: this.config.sub2apiTimezone,
      comparedFrom: coverageStart.toISOString(),
      comparedThrough: cutoff.toISOString(),
      watermark: watermark ? {
        lastAggregatedAt: watermark.last_aggregated_at,
        updatedAt: watermark.updated_at,
        lagSeconds
      } : null,
      rawBounds: {
        from: rawBounds.rows[0]?.raw_from || null,
        through: rawBounds.rows[0]?.raw_through || null,
        eligibleRows: number(rawBounds.rows[0]?.eligible_rows)
      },
      mismatches,
      mismatchListTruncated: tooMany,
      reason: passed ? null : (!watermark?.last_aggregated_at
        ? '聚合水位不存在'
        : lagSeconds > 86400 ? '聚合水位落后超过 24 小时' : '原始用量与日汇总不一致')
    };
  }

  async countTable(item, cutoff) {
    const schema = await this.inspector.inspect();
    const table = schema.tables[item.table];
    if (!table?.exists) return { table: item.table, available: false, reason: '当前 schema 不存在该表' };
    if (!table.columns.includes(item.column)) return { table: item.table, available: false, reason: `缺少时间列 ${item.column}` };
    const cast = item.type === 'date'
      ? '($1::timestamptz AT TIME ZONE $3)::date'
      : '$1::timestamptz';
    const predicate = item.predicate ? ` AND (${item.predicate})` : '';
    const parameters = item.type === 'date'
      ? [cutoff, item.table, this.config.sub2apiTimezone]
      : [cutoff, item.table];
    const { rows } = await this.readPool.query(`
      SELECT COUNT(*) AS eligible_rows,
             MIN(${item.column}) AS earliest,
             MAX(${item.column}) AS latest,
             COALESCE((
               SELECT SUM(pg_total_relation_size(c.oid))
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
               LEFT JOIN pg_class parent ON parent.oid = i.inhparent
               WHERE n.nspname = ANY(current_schemas(false))
                 AND c.relkind IN ('r', 'm')
                 AND (c.relname = $2 OR parent.relname = $2)
             ), 0) AS relation_bytes,
             COALESCE((
               SELECT SUM(GREATEST(c.reltuples, 0))
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
               LEFT JOIN pg_class parent ON parent.oid = i.inhparent
               WHERE n.nspname = ANY(current_schemas(false))
                 AND c.relkind IN ('r', 'm')
                 AND (c.relname = $2 OR parent.relname = $2)
             ), 0) AS estimated_total_rows
      FROM ${item.table}
      WHERE ${item.column} < ${cast}${predicate}
    `, parameters);
    const row = rows[0];
    const eligibleRows = number(row.eligible_rows);
    const estimatedTotalRows = Math.max(number(row.estimated_total_rows), eligibleRows);
    const relationBytes = number(row.relation_bytes);
    return {
      table: item.table,
      available: true,
      eligibleRows,
      earliest: row.earliest,
      latest: row.latest,
      relationBytes,
      estimatedLogicalBytes: estimatedTotalRows > 0 ? Math.round(relationBytes * eligibleRows / estimatedTotalRows) : 0,
      physicalReleaseBytes: null,
      predicate: item.predicate || null
    };
  }

  async createPreview(targetIds) {
    this.cleanupExpiredState();
    const selected = this.selectedDefinitions(targetIds);
    const createdAt = new Date();
    const schema = await this.inspector.inspect({ refresh: true });
    const nativeActivity = await this.inspectNativeActivity();
    const targets = [];
    let usageCoverage = null;
    for (const [id, definition] of selected) {
      const retentionDays = this.config.retention[definition.daysKey];
      const cutoff = cutoffFor(createdAt, retentionDays);
      const tables = [];
      for (const item of definition.tables) tables.push(await this.countTable(item, cutoff));
      if (definition.coverageRequired) usageCoverage = await this.checkUsageCoverage(cutoff);
      targets.push({
        id,
        label: definition.label,
        retentionDays,
        cutoff: cutoff.toISOString(),
        critical: definition.critical,
        effect: definition.effect,
        tables,
        eligibleRows: tables.reduce((sum, table) => sum + number(table.eligibleRows), 0),
        estimatedLogicalBytes: tables.reduce((sum, table) => sum + number(table.estimatedLogicalBytes), 0)
      });
    }
    const id = crypto.randomUUID();
    const expiresAt = new Date(createdAt.getTime() + this.config.previewTtlMinutes * 60000);
    const blockers = [];
    if (!schema.compatible) blockers.push(`schema 不兼容：${schema.missingRequired.join(', ')}`);
    if (selected.some(([id]) => id === 'usage_logs') && !usageCoverage?.passed) blockers.push(`用量聚合覆盖检查失败：${usageCoverage?.reason || '未知原因'}`);
    if (nativeActivity.usageCleanupTasks.length) blockers.push('Sub2API 存在 pending/running 人工用量清理任务');
    if (targets.some((target) => target.tables.some((table) => table.available && table.eligibleRows > 0 && table.estimatedLogicalBytes == null))) {
      blockers.push('部分目标无法估算逻辑体积');
    }
    const preview = {
      id,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      confirmationPhrase: `确认清理 ${id.slice(0, 8)}`,
      executable: blockers.length === 0 && targets.some((target) => target.eligibleRows > 0),
      blockers,
      targets,
      usageCoverage,
      backup: await this.getBackupStatus({ previewCreatedAt: createdAt.toISOString() }),
      backupRequirement: this.config.requireFreshBackup
        ? '执行前必须存在完成时间晚于本预览创建时间的 Sub2API 原生备份。'
        : '部署已显式关闭新鲜备份硬闸门。',
      nativeActivity,
      schemaCheckedAt: schema.checkedAt,
      safeguards: [
        '执行时重新检查 schema、聚合覆盖、原生任务冲突与备份完成时间。',
        `单批最多 ${this.config.cleanupBatchSize.toLocaleString()} 行，批间等待 ${this.config.cleanupBatchDelayMs}ms。`,
        `单次运行最多删除 ${this.config.cleanupMaxRows.toLocaleString()} 行，超出后停止并要求重新预览。`,
        '只允许固定表、固定时间列和固定附加条件；请求不能提交 SQL。',
        '不会执行 VACUUM FULL、TRUNCATE、DROP、文件删除或扣费防重表清理。'
      ]
    };
    this.previews.set(id, preview);
    return preview;
  }

  getPreview(id) {
    this.cleanupExpiredState();
    const preview = this.previews.get(id);
    if (!preview) throw new AppError('PREVIEW_NOT_FOUND', '清理预览不存在或已过期，请重新生成', { status: 404 });
    return preview;
  }

  async execute({ previewId, confirmationPhrase, acknowledgeImpact, acknowledgeDownstream, actor }) {
    if (!this.config.cleanupEnabled || !this.maintenancePool) {
      throw new AppError('CLEANUP_DISABLED', '清理执行未启用或未配置独立维护连接', { status: 409 });
    }
    if (this.activeRunId) throw new AppError('CLEANUP_ALREADY_RUNNING', '已有清理正在执行', { status: 409 });
    const preview = this.getPreview(previewId);
    if (!preview.executable || preview.blockers.length) {
      throw new AppError('PREVIEW_BLOCKED', '该预览未通过安全检查，不能执行', { status: 409, details: { blockers: preview.blockers } });
    }
    if (String(confirmationPhrase) !== preview.confirmationPhrase) {
      throw new AppError('CONFIRMATION_MISMATCH', '确认短语不匹配', { status: 400 });
    }
    if (acknowledgeImpact !== true || acknowledgeDownstream !== true) {
      throw new AppError('ACKNOWLEDGEMENT_REQUIRED', '必须确认不可逆影响和下游同步状态', { status: 400 });
    }
    const schema = await this.inspector.inspect({ refresh: true });
    if (!schema.compatible) throw new AppError('SCHEMA_CHANGED', 'schema 已变化，请重新预览', { status: 409 });
    const activity = await this.inspectNativeActivity();
    if (activity.usageCleanupTasks.length) {
      throw new AppError('NATIVE_CLEANUP_ACTIVE', 'Sub2API 原生人工用量清理任务正在等待或执行', { status: 409 });
    }
    const usageTarget = preview.targets.find((target) => target.id === 'usage_logs');
    let usageCoverage = preview.usageCoverage;
    if (usageTarget) {
      usageCoverage = await this.checkUsageCoverage(new Date(usageTarget.cutoff));
      if (!usageCoverage.passed) {
        throw new AppError('COVERAGE_CHANGED', '执行前聚合覆盖复核失败', { status: 409, details: usageCoverage });
      }
    }
    const backup = await this.getBackupStatus({ previewCreatedAt: preview.createdAt });
    if (this.config.requireFreshBackup && !backup.satisfied) {
      throw new AppError('FRESH_BACKUP_REQUIRED', '必须先完成一次晚于本次预览的 Sub2API 原生数据库备份', {
        status: 409,
        details: backup
      });
    }
    const run = {
      id: crypto.randomUUID(),
      previewId,
      actor,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      deletedRows: 0,
      partial: false,
      targets: preview.targets.map((target) => ({
        id: target.id,
        label: target.label,
        cutoff: target.cutoff,
        eligibleRowsAtPreview: target.eligibleRows,
        deletedRows: 0,
        status: 'pending',
        tables: []
      })),
      checks: {
        schemaCheckedAt: schema.checkedAt,
        backup,
        usageCoverage,
        downstreamAcknowledged: true,
        impactAcknowledged: true
      },
      notes: [
        '删除释放的是数据库内逻辑空间；未执行 VACUUM FULL，文件系统可用空间不保证同比增加。',
        '运行报告保存在有上限的进程内存和 stdout；服务不建立新的业务审计数据库。'
      ],
      error: null
    };
    this.runs.set(run.id, run);
    this.activeRunId = run.id;
    setImmediate(() => this.runCleanup(run, preview).catch((error) => {
      console.error('[retention] unhandled cleanup failure', error);
    }));
    return publicRun(run);
  }

  async runCleanup(run, preview) {
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    let client = null;
    let locked = false;
    try {
      client = await this.maintenancePool.connect();
      await client.query(`SELECT set_config('TimeZone', $1, false)`, [this.config.sub2apiTimezone]);
      const lockResult = await client.query(`SELECT pg_try_advisory_lock(hashtext('sub2api-operations-center-cleanup')) AS locked`);
      locked = lockResult.rows[0]?.locked === true;
      if (!locked) throw new AppError('CLEANUP_LOCK_BUSY', '另一个运营中心清理持有数据库锁', { status: 409 });
      let remainingBudget = this.config.cleanupMaxRows;
      for (const targetResult of run.targets) {
        if (run.cancelRequested || remainingBudget <= 0) break;
        targetResult.status = 'running';
        const definition = POLICY_DEFINITIONS[targetResult.id];
        for (const table of definition.tables) {
          if (run.cancelRequested || remainingBudget <= 0) break;
          const previewTable = preview.targets.find((target) => target.id === targetResult.id)?.tables.find((item) => item.table === table.table);
          if (!previewTable?.available) {
            targetResult.tables.push({ table: table.table, status: 'skipped', reason: previewTable?.reason || 'unavailable', deletedRows: 0 });
            continue;
          }
          const tableResult = { table: table.table, status: 'running', deletedRows: 0, batches: 0, startedAt: new Date().toISOString() };
          targetResult.tables.push(tableResult);
          while (!run.cancelRequested && remainingBudget > 0) {
            const limit = Math.min(this.config.cleanupBatchSize, remainingBudget);
            const deleted = await this.deleteBatch(client, table, new Date(targetResult.cutoff), limit);
            tableResult.deletedRows += deleted;
            targetResult.deletedRows += deleted;
            run.deletedRows += deleted;
            remainingBudget -= deleted;
            tableResult.batches += 1;
            if (deleted < limit) break;
            if (this.config.cleanupBatchDelayMs > 0) await sleep(this.config.cleanupBatchDelayMs);
          }
          tableResult.finishedAt = new Date().toISOString();
          tableResult.status = run.cancelRequested ? 'canceled' : (remainingBudget <= 0 ? 'partial' : 'completed');
        }
        targetResult.status = run.cancelRequested ? 'canceled' : (remainingBudget <= 0 ? 'partial' : 'completed');
      }
      run.partial = remainingBudget <= 0;
      run.status = run.cancelRequested ? 'canceled' : (run.partial ? 'partial' : 'completed');
    } catch (error) {
      run.status = 'failed';
      run.error = { code: error.code || 'CLEANUP_FAILED', message: error.message };
    } finally {
      if (locked && client) {
        try { await client.query(`SELECT pg_advisory_unlock(hashtext('sub2api-operations-center-cleanup'))`); } catch {}
      }
      client?.release();
      run.finishedAt = new Date().toISOString();
      this.activeRunId = null;
      console.info(JSON.stringify({ event: 'operations_center_cleanup_report', ...publicRun(run) }));
      this.cleanupExpiredState();
    }
  }

  async deleteBatch(client, item, cutoff, limit) {
    const cast = item.type === 'date'
      ? '($1::timestamptz AT TIME ZONE $3)::date'
      : '$1::timestamptz';
    const predicate = item.predicate ? ` AND (${item.predicate})` : '';
    const parameters = item.type === 'date'
      ? [cutoff, limit, this.config.sub2apiTimezone]
      : [cutoff, limit];
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      const result = await client.query(`
        WITH victims AS (
          SELECT tableoid, ctid
          FROM ${item.table}
          WHERE ${item.column} < ${cast}${predicate}
          ORDER BY ${item.column}
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM ${item.table} target
        USING victims
        WHERE target.tableoid = victims.tableoid AND target.ctid = victims.ctid
      `, parameters);
      await client.query('COMMIT');
      return result.rowCount || 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  listRuns() {
    this.cleanupExpiredState();
    return Array.from(this.runs.values()).reverse().map(publicRun);
  }

  getRun(id) {
    const run = this.runs.get(id);
    if (!run) throw new AppError('RUN_NOT_FOUND', '清理运行记录不存在或已从内存淘汰', { status: 404 });
    return publicRun(run);
  }

  cancelRun(id) {
    const run = this.runs.get(id);
    if (!run) throw new AppError('RUN_NOT_FOUND', '清理运行记录不存在', { status: 404 });
    if (!['queued', 'running'].includes(run.status)) {
      throw new AppError('RUN_NOT_ACTIVE', '该任务已结束，不能取消', { status: 409 });
    }
    run.cancelRequested = true;
    return publicRun(run);
  }
}

module.exports = {
  RetentionService,
  POLICY_DEFINITIONS,
  PERMANENTLY_PROTECTED,
  cutoffFor,
  publicRun
};
