# Sub2API 运营数据与存储管理中心

`operations-center` 是 `sub2api-extra` 中的独立无状态服务，默认监听 `9872`。它直接读取 Sub2API PostgreSQL 业务表与原生聚合表，不修改 Sub2API 源码，不建立业务数据副本，也不创建新的永久扣费账本。

当前实现基于 Sub2API `d2e319b2a17006122cd2d53d828c44a0bf21bd9b` 之后的最新 schema 完成核对。线上接入时仍会检查实际表结构；未知或缺失 schema 会阻断清理。

## 已实现能力

- 运营概览：DAU、MAU、近 7/30 日活跃、新增用户、请求量、消费与支付实收。
- 用量统计：按任意自然日范围查询请求、四类 Token、费用、账号成本、耗时、区间去重活跃用户和日趋势。
- 近 30 天维度统计：模型、用户、API Key、分组、账号与计费类型。
- 用户分析：活跃/新增趋势、首次观测活跃、7 日激活、D1/D7/D30 注册 cohort。
- 资金分析：支付实收、退款估算、净额、余额入账来源、异常订单提示；现金与额度不会相加。
- 存储诊断：数据库和关系大小、索引/TOAST、分区、死行、长事务、复制槽/WAL 占用及有上限的进程内容量样本。
- 清理控制：固定白名单预览、精确行数、逻辑体积估算、聚合完整性复核、原生备份硬闸门、双重确认、小批事务、取消和 JSON 报告。
- 原生能力复用：只核验或触发 Sub2API 已有 `.sql.gz`/S3 备份；不重复实现上传、下载或覆盖恢复。

## 数据保留结果

| 数据 | 默认期限 | 清理后能力 |
| --- | ---: | --- |
| 单次请求及请求级扣费明细 `usage_logs` | 30 天 | 30 天后不再保证逐请求、用户、Key、模型、分组或渠道维度查询 |
| 小时用量及小时活跃集合 | 30 天 | 超期小时趋势消失 |
| 站点日用量及日活集合 | 730 天 | 任意日范围和自然月的请求、Token、费用、DAU/MAU 继续可查 |
| 普通系统日志 | 7 天 | 超期普通日志和链路搜索消失 |
| 错误详情、拒绝聚合、已结束告警 | 30 天 | 超期排错和复盘范围缩短；`firing` 告警不删除 |
| 运维分钟/小时/日指标 | 30 天 | 超期性能曲线消失，不影响请求和计费 |
| 用户、余额、Key、订单、充值、退款、订阅、资产账本、扣费防重 | 长期保护 | 不属于任何清理目标 |

完整影响见[清理范围报告](docs/cleanup-scope-report.md)。

## 本地运行

要求 Node.js `>=20.18.1`、可访问的 PostgreSQL，以及与当前版本兼容的 Sub2API 数据库。

```bash
cd operations-center
cp .env.example .env
npm ci
npm start
```

浏览器访问 `http://127.0.0.1:9872`。开发模式使用：

```bash
npm run dev
```

默认只读。只要 `OPERATIONS_CENTER_ENABLE_CLEANUP=false`，页面可以统计、诊断和生成预览，但不能执行删除。

## Docker Compose

模块已注册到根目录 `docker-compose.yml`，profile 名为 `operations-center`：

```bash
cp operations-center/.env.example operations-center/.env
# 编辑 operations-center/.env
# 在 compose.services.env 中加入 operations-center
docker compose --env-file compose.services.env pull operations-center
docker compose --env-file compose.services.env up -d --no-build operations-center
```

默认只绑定宿主机 `127.0.0.1:9872`。需要远程访问时应放在 HTTPS 反向代理后，不建议直接公开管理端口。

## 关键配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPERATIONS_CENTER_ADMIN_USER` | `admin` | 本服务独立管理员账号 |
| `OPERATIONS_CENTER_ADMIN_PASSWORD` | 无 | 必填；生产环境至少 16 个字符 |
| `SUB2API_DATABASE_URL` | 无 | 只读 PostgreSQL 连接，必填 |
| `SUB2API_DATABASE_SSL` | `disable` | `disable`、`require` 或 `verify-full` |
| `SUB2API_TIMEZONE` | `Asia/Shanghai` | 必须与 Sub2API 全局 `timezone`/`TZ` 一致 |
| `FINANCE_TIMEZONE` | `Asia/Shanghai` | 支付和入账报表自然日时区 |
| `SUB2API_BASE_URL` | 无 | 原生版本和备份 API 地址 |
| `SUB2API_ADMIN_TOKEN` | 无 | 可选的 Sub2API 管理员 JWT |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 无 | 未提供 token 时用于登录 Sub2API |
| `OPERATIONS_CENTER_ENABLE_CLEANUP` | `false` | 显式开启破坏性执行 |
| `SUB2API_MAINTENANCE_DATABASE_URL` | 无 | 开启执行时必填，必须使用独立受限角色 |
| `OPERATIONS_CENTER_REQUIRE_FRESH_BACKUP` | `true` | 要求成功备份的完成时间晚于本次预览 |
| `OPERATIONS_CENTER_CLEANUP_BATCH_SIZE` | `5000` | 单事务最多删除行数 |
| `OPERATIONS_CENTER_CLEANUP_MAX_ROWS` | `5000000` | 单次运行总删除上限 |
| `RETENTION_USAGE_LOGS_DAYS` | `30` | 请求明细期限，不能小于 30 |
| `RETENTION_USAGE_HOURLY_DAYS` | `30` | 小时汇总期限，不能小于 30 |
| `RETENTION_USAGE_DAILY_DAYS` | `730` | 日汇总期限，不能小于 365 |
| `RETENTION_SYSTEM_LOG_DAYS` | `7` | 普通系统日志期限，不能小于 7 |
| `RETENTION_ERROR_LOG_DAYS` | `30` | 错误和短期事件期限，不能小于 30 |
| `RETENTION_OPS_METRIC_DAYS` | `30` | 运维指标期限 |

其余参数和示例见[.env.example](.env.example)。

## 数据库最小权限

以下示例假设业务表位于 `public`。生产环境应替换密码并按实际 schema 调整；不要给运营中心超级用户、建表或任意写权限。

```sql
CREATE ROLE sub2api_ops_read LOGIN PASSWORD 'replace-me';
GRANT CONNECT ON DATABASE sub2api TO sub2api_ops_read;
GRANT USAGE ON SCHEMA public TO sub2api_ops_read;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sub2api_ops_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO sub2api_ops_read;

CREATE ROLE sub2api_ops_maintenance LOGIN PASSWORD 'replace-me-too';
GRANT CONNECT ON DATABASE sub2api TO sub2api_ops_maintenance;
GRANT USAGE ON SCHEMA public TO sub2api_ops_maintenance;
GRANT SELECT, DELETE ON TABLE
  usage_logs,
  usage_dashboard_hourly,
  usage_dashboard_hourly_users,
  usage_dashboard_daily,
  usage_dashboard_daily_users,
  ops_system_logs,
  ops_error_logs,
  ops_ingress_reject_aggregates,
  ops_alert_events,
  ops_system_metrics,
  ops_metrics_hourly,
  ops_metrics_daily
TO sub2api_ops_maintenance;
GRANT SELECT, UPDATE ON TABLE usage_group_rollup_state
TO sub2api_ops_maintenance;
```

最后一项权限由 Sub2API 的 `usage_logs` 删除触发器需要：删除分组用量后，它会后退原生分组汇总水位。运营中心不会直接删除 `usage_group_daily_rollups` 或 `usage_group_rollup_state`。如果线上尚无这些对象，不要自行创建，先确认迁移版本。

读取 `pg_stat_activity`、`pg_replication_slots` 等诊断视图可能需要额外监控权限。缺少权限只会把相应诊断显示为不可用，不会扩大清理权限。

## 安全执行流程

1. 选择固定目标并生成预览；请求不能提交表名、路径或 SQL。
2. 精确统计截止点以前的行，并显示时间范围、影响与逻辑体积估算。
3. 清理 `usage_logs` 前，按 `SUB2API_TIMEZONE` 逐日核对请求、Token、费用、账号成本、耗时和去重活跃用户。
4. 在预览之后完成一次 Sub2API 原生备份。备份状态不满足时执行接口硬阻断。
5. 确认下游同步和不可逆影响，输入该预览专属确认短语。
6. 执行前再次检查 schema、聚合水位、原生人工用量任务和备份完成时间。
7. 通过 `tableoid + ctid`、`FOR UPDATE SKIP LOCKED` 和小事务分批删除；达到总行数上限或收到取消请求即停止。
8. 运行结果保存在有上限的进程内存并输出到 stdout，可下载 JSON；服务重启后内存记录消失。

服务不会自动定时执行破坏性清理。持续滚动保留建议同时在 Sub2API 中配置：

```dotenv
DASHBOARD_AGGREGATION_RETENTION_USAGE_LOGS_DAYS=30
DASHBOARD_AGGREGATION_RETENTION_HOURLY_DAYS=30
DASHBOARD_AGGREGATION_RETENTION_DAILY_DAYS=730
```

首次从较长窗口缩短时，建议在低峰按阶段执行并观察 WAL、复制延迟、死元组和请求延迟。不要调用 Sub2API 的人工范围用量删除来代替滚动保留；该功能会重算指定历史范围，源明细已经删除时可能把长期汇总重算小或重算为零。

## 原生备份边界

Sub2API 已具备 PostgreSQL `.sql.gz` 备份、S3 存放、下载和覆盖恢复能力。本服务没有再实现一套备份文件、上传或恢复逻辑，只做两件事：

- 查询原生备份记录，确认存在完成时间晚于当前预览的成功备份。
- 可选调用原生“创建备份”接口。

若 Sub2API 开启敏感操作 step-up 2FA，服务端可能拒绝后台触发备份。此时在 Sub2API 原生备份页面完成 TOTP 验证和备份即可，本服务仍可读取完成记录并放行。恢复必须在 Sub2API 原生页面执行并按其密码/2FA 规则确认。

## 空间释放说明

`DELETE` 成功表示数据逻辑上已删除，通常只让空间先在 PostgreSQL 内部复用。普通 `VACUUM` 不保证把相同字节归还操作系统；`VACUUM FULL` 会重写并强锁表，还需要额外临时空间，因此不属于本服务的日常动作。

服务能测量数据库对象占用，但仅靠数据库连接不能可靠知道 PostgreSQL 数据目录、WAL、Redis、Docker、日志和备份所在文件系统的剩余容量。页面会明确显示“不可用”，不会伪造磁盘可用天数。

## 验证

```bash
npm test
npm run check
npm audit --omit=dev
docker compose --env-file compose.services.env config
```

## 文档

- [清理范围报告](docs/cleanup-scope-report.md)
- [统计口径](docs/metrics.md)
- [最终保留策略](docs/retention-policy.md)
- [存储与影响分析](docs/storage-retention.md)
- [实现与运行边界](docs/implementation.md)
