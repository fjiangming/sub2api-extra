# Sub2API 运营数据与存储管理中心

`operations-center` 是 `sub2api-extra` 中的独立轻状态服务，默认监听 `9872`。它直接读取 Sub2API PostgreSQL 业务表与原生聚合表，不修改 Sub2API 源码，不建立业务数据副本，也不创建新的永久扣费账本；本地保存加密后的运行配置和独立的手工收支台账。

当前实现基于 Sub2API `d2e319b2a17006122cd2d53d828c44a0bf21bd9b` 之后的最新 schema 完成核对。线上接入时仍会检查实际表结构；未知或缺失 schema 会阻断清理。

## 已实现能力

- 运营概览：DAU、MAU、近 7/30 日活跃、新增用户、请求量、消费与支付实收。
- 用量统计：按任意自然日范围查询请求、四类 Token、费用、账号成本、耗时、区间去重活跃用户和日趋势。
- 近 30 天维度统计：模型、用户、API Key、分组、账号与计费类型。
- 用户分析：活跃/新增趋势、首次观测活跃、7 日激活、D1/D7/D30 注册 cohort。
- 资金分析：支付实收、退款估算、净额、余额入账来源、异常订单提示；现金与额度不会相加。
- 成本分析：按日、周、月、年分开展示自动收入、手工收入、总收入、手工支出、利润与利润率；自动收入取自兑换页面中已使用的余额与管理员余额调整记录，并展示排除 ID 1 后的当前用户总余额、扣除余额后的实际利润及利润率，支持收入完整维护以及按供应商或自定义项维护支出。
- 存储诊断：数据库和关系大小、索引/TOAST、分区、死行、长事务、复制槽/WAL 占用及有上限的进程内容量样本。
- 清理控制：固定白名单预览、精确行数、逻辑体积估算、聚合完整性复核、原生备份硬闸门、双重确认、小批事务、取消和 JSON 报告。
- 原生能力复用：只核验或触发 Sub2API 已有 `.sql.gz`/S3 备份；不重复实现上传、下载或覆盖恢复。
- 管理员 SSO：从 Sub2API 管理员自定义菜单打开时自动校验当前登录态，不要求在运营中心保存邮箱密码。
- 系统设置：页面创建最小权限数据库角色、加密保存受限连接、运行依赖检查，并管理保留周期、自动清理和可选持久 API 认证。

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

要求 Node.js `>=20.18.1` 和可访问的 Sub2API。PostgreSQL 连接可以在服务启动后通过“系统设置”完成。

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
# 编辑认证和 Sub2API 地址；数据库连接可以先留空
# 在 compose.services.env 中加入 operations-center
docker compose --env-file compose.services.env pull operations-center
docker compose --env-file compose.services.env up -d --no-build operations-center
```

默认只绑定宿主机 `127.0.0.1:9872`。需要远程访问时应放在 HTTPS 反向代理后，不建议直接公开管理端口。

## 关键配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPERATIONS_CENTER_AUTH_MODE` | `local` | `sub2api` 使用基座管理员 SSO；`local` 使用独立账号 |
| `OPERATIONS_CENTER_ADMIN_USER` | `admin` | 仅 `local` 模式使用 |
| `OPERATIONS_CENTER_ADMIN_PASSWORD` | 无 | 仅 `local` 模式必填；生产环境至少 16 个字符 |
| `OPERATIONS_CENTER_DATA_DIR` | `./data` | 加密运行配置目录；Compose 使用持久命名卷 |
| `OPERATIONS_CENTER_DATABASE_SETUP_ENABLED` | `true` | 允许管理员从页面创建受限 PostgreSQL 角色 |
| `SUB2API_DATABASE_URL` | 无 | 可选高级覆盖；留空后从系统设置初始化只读连接 |
| `SUB2API_DATABASE_SSL` | `disable` | `disable`、`require` 或 `verify-full` |
| `SUB2API_TIMEZONE` | `Asia/Shanghai` | 必须与 Sub2API 全局 `timezone`/`TZ` 一致 |
| `FINANCE_TIMEZONE` | `Asia/Shanghai` | 支付和入账报表自然日时区 |
| `SUB2API_BASE_URL` | 无 | 认证、原生版本和备份 API 的服务端地址 |
| `SUB2API_PUBLIC_URL` | 同 `SUB2API_BASE_URL` | 管理员浏览器可访问的 Sub2API 地址及 iframe 来源 |
| `SUB2API_ADMIN_TOKEN` | 无 | 可选的 Sub2API 管理员 JWT |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 无 | 可选；无人值守调用需要持久认证时使用 |
| `PROVIDER_MONITOR_BASE_URL` | 无 | 供应商监控服务端地址；Compose 网络通常为 `http://provider-monitor:9871` |
| `PROVIDER_MONITOR_INTEGRATION_TOKEN` | 无 | 可选的只读服务间 Token；Provider Monitor 使用本地认证时需要配置相同值 |
| `OPERATIONS_CENTER_ENABLE_CLEANUP` | `false` | 显式开启破坏性执行 |
| `SUB2API_MAINTENANCE_DATABASE_URL` | 无 | 可选高级覆盖；页面可以自动创建独立受限清理角色 |
| `OPERATIONS_CENTER_REQUIRE_FRESH_BACKUP` | `true` | 要求成功备份的完成时间晚于本次预览 |
| `OPERATIONS_CENTER_CLEANUP_BATCH_SIZE` | `5000` | 单事务最多删除行数 |
| `OPERATIONS_CENTER_CLEANUP_MAX_ROWS` | `5000000` | 单次运行总删除上限 |
| `OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED` | `false` | 启用运营中心每日自动清理；要求全部执行与备份条件就绪 |
| `OPERATIONS_CENTER_AUTO_CLEANUP_TIME` | `03:30` | 自动清理时间，`HH:mm`，按 `SUB2API_TIMEZONE` 解释 |
| `OPERATIONS_CENTER_AUTO_CLEANUP_TARGETS` | `system_logs,error_logs,ops_metrics` | 自动目标 ID；关键用量目标必须显式加入 |
| `OPERATIONS_CENTER_AUTO_CLEANUP_BACKUP_WAIT_MINUTES` | `10` | 等待预览后原生成功备份的最长时间 |
| `RETENTION_USAGE_LOGS_DAYS` | `30` | 请求明细期限，不能小于 30 |
| `RETENTION_USAGE_HOURLY_DAYS` | `30` | 小时汇总期限，不能小于 30 |
| `RETENTION_USAGE_DAILY_DAYS` | `730` | 日汇总期限，不能小于 365 |
| `RETENTION_SYSTEM_LOG_DAYS` | `7` | 普通系统日志期限，不能小于 7 |
| `RETENTION_ERROR_LOG_DAYS` | `30` | 错误和短期事件期限，不能小于 30 |
| `RETENTION_OPS_METRIC_DAYS` | `30` | 运维指标期限 |

其余参数和示例见[.env.example](.env.example)。

## Sub2API 单点登录

推荐把 `OPERATIONS_CENTER_AUTH_MODE` 设为 `sub2api`，然后在 Sub2API 管理后台的“设置 -> 自定义菜单”中添加运营中心公开地址，并将可见性限制为管理员。Sub2API 会把当前访问 Token 附加到 iframe 地址；运营中心向 `/api/v1/auth/me` 校验管理员身份后，立即换成自己的短期内存会话并从地址栏移除原始 Token。Token 和会话都不会写入数据库。

跨域 HTTPS iframe 同时使用分区 Cookie 和页面会话令牌兜底。反向代理应传递 `X-Forwarded-Proto`；当 `SUB2API_BASE_URL` 是 `host.docker.internal` 等容器内地址时，必须另设浏览器可访问的 `SUB2API_PUBLIC_URL`。内部地址发生 DNS、连接或超时故障时，认证与只读管理请求会安全回退到这个已配置的公开地址，并记住成功地址供后续写操作直接使用；收到明确的 HTTP 鉴权错误不会重试，响应不确定的写操作也不会跨地址重放。

## 成本台账与供应商同步

成本台账写入 `OPERATIONS_CENTER_DATA_DIR/cost-ledger.json`，使用原子替换并随运营中心数据卷持久化；它不写入 Sub2API 数据库。手工收入和支出均包含名称、日期、金额、币种和备注，新建时默认币种为 `CNY`。自动收入按 Sub2API `redeem_codes` 中 `status='used'`、`type IN ('balance', 'admin_balance')` 且 `used_at` 在查询范围内的记录汇总带符号的 `value`；并发、管理员并发调整、订阅和邀请记录不是金额，不参与统计。管理员增加余额等正数记录增加收入，管理员扣减余额等负数记录冲减收入，但 `admin_balance` 也可能是赠送或纠错，并不必然代表现金实收。在线充值与兑换码使用最终都只按对应兑换记录统计一次，不再叠加支付订单。若同一笔线下充值此前已录入手工收入，应删除该手工记录以免与管理员余额调整重复；Sub2API 删除源兑换记录后，历史自动收入也会随之减少。兑换记录没有币种字段，因此统一归入 `CNY`。总收入等于自动收入加手工收入，利润等于总收入减手工支出；平均金额只按自动收入计算。用户总余额读取当前未删除用户的 `users.balance` 合计并排除 ID 1，实际利润等于利润减用户总余额；余额是当前快照而非历史日期快照，仅在 `CNY` 报表中参与计算。

供应商记录只保存 ID、名称、适配器、状态和币种快照，不复制供应商凭据。已有支出保留录入时的供应商名称，因此供应商被改名或删除后历史报表仍可复核。旧版 v1 台账会在首次启动时自动迁移到 v2，保留原支出和供应商快照；本次升级不需要新增配置。

Provider Monitor 使用 `sub2api` 认证时，运营中心会用当前管理员 SSO Token 换取短期会话并读取供应商。Provider Monitor 使用 `local` 认证或需要无人值守同步时，在两个服务中配置相同的 `PROVIDER_MONITOR_INTEGRATION_TOKEN`；Token 至少 32 个字符，只能访问脱敏后的供应商列表接口。同步失败时页面保留上次成功快照，自定义支出仍可录入。

### 供应商同步配置

在 Windows CMD 中执行以下单行命令，生成 32 字节随机数对应的 64 位十六进制 Token：

```cmd
powershell -NoProfile -Command "$b=New-Object byte[] 32;$r=[Security.Cryptography.RandomNumberGenerator]::Create();$r.GetBytes($b);$r.Dispose();-join($b|ForEach-Object{$_.ToString('x2')})"
```

Token 应与 `PROVIDER_MONITOR_SECRET` 分开生成，不要复用。把同一个新 Token 分别写入两个服务的配置文件：

```dotenv
# operations-center/.env
PROVIDER_MONITOR_BASE_URL=http://provider-monitor:9871
PROVIDER_MONITOR_INTEGRATION_TOKEN=<生成的64位Token>
PROVIDER_MONITOR_REQUEST_TIMEOUT_MS=10000
```

```dotenv
# provider-monitor/.env
PROVIDER_MONITOR_INTEGRATION_TOKEN=<同一个64位Token>
```

两个服务均使用 Sub2API SSO 时可以不配置共享 Token，但无人值守同步或 Provider Monitor 使用 `local` 认证时必须配置。更换 Token 时需要同时更新两个文件并重启两个服务。

通过仓库根目录的同一个 Compose 项目启动两个服务时，它们共享默认网络，内部地址使用 Compose 服务名和容器内部端口：

```env
COMPOSE_PROFILES=provider-monitor,operations-center
PROVIDER_MONITOR_BASE_URL=http://provider-monitor:9871
```

`9871` 是 Provider Monitor 的容器内部 `PORT`，不是宿主机的 `PROVIDER_MONITOR_PORT` 映射值。如果修改了 `provider-monitor/.env` 中的 `PORT`，这里也要使用修改后的内部端口。可在仓库根目录执行以下命令验证连通性：

```powershell
docker compose --env-file compose.services.env exec operations-center node -e "fetch('http://provider-monitor:9871/healthz').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) }).catch(e => { console.error(e.message); process.exit(1) })"
```

返回 HTTP `200` 即可使用内部地址。`ENOTFOUND` 表示服务名无法解析或两个容器不在同一网络，`ECONNREFUSED` 表示 Provider Monitor 未启动或内部端口不正确。两个服务由不同 Compose 项目启动时，默认不能使用 `provider-monitor`，需要加入同一个外部 Docker 网络，或改用运营中心容器可访问的域名。

域名可以直接作为服务端地址：

```dotenv
PROVIDER_MONITOR_BASE_URL=https://monitor.example.com
```

域名必须能从运营中心容器解析和访问，HTTPS 证书必须有效，反向代理需要把 `/api/*` 转发到 Provider Monitor，并保留 `Authorization` 请求头。两个服务在同一 Compose 网络时优先使用内部地址，避免供应商同步绕行公网和反向代理。

Sub2API 的会话绑定会校验登录浏览器的 IP 和 User-Agent，独立服务无法代替浏览器通过该校验。使用自定义菜单 SSO 时需要关闭会话绑定并重新登录；必须保留会话绑定时，请改用 `local` 模式。

`SUB2API_ADMIN_TOKEN`、`ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 对交互式 SSO 均非必填。当前有效的 SSO Token 可以触发手动原生备份，也可暂时供自动清理使用；但它会过期且服务重启后丢失。要求每日自动清理长期无人值守时，可在系统设置中验证并加密保存管理员 Token 或邮箱密码，否则认证不可用的场次会在备份阶段安全失败，不会执行删除。

## 数据库最小权限

数据库连接是统计功能的必要条件，但不要求部署前手工创建指定账号。默认流程是在首次登录后进入“系统设置 -> 数据库访问”，临时提供一个具有 `CREATEROLE` 和现有表授权能力的 PostgreSQL 管理连接，然后点击按钮自动完成：

- 创建随机密码的只读角色，并授予当前及未来 `public` 业务表的读取权限。
- 可选授予 `pg_monitor`，用于长事务、复制槽和 WAL 等只读诊断。
- 创建独立清理角色，只授予固定白名单表的 `SELECT/DELETE`。
- 为 `usage_group_rollup_state` 授予删除触发器所需的 `SELECT/UPDATE`，但不直接删除该表。
- 加密保存受限连接并热切换；PostgreSQL 管理员密码只存在于本次请求内。

同名未知角色不会被接管，已拥有数据库对象的受管角色也不会被自动轮换。若旧版 PostgreSQL 向 `PUBLIC` 保留了 `public` Schema 建表权，初始化默认阻断；只有管理员明确勾选 Schema 安全加固后才会撤销这项同数据库范围的继承权限。Sub2API 升级新增表后可以再次运行初始化来轮换受管角色密码并补齐授权。已有企业最小权限角色仍可通过 `SUB2API_DATABASE_URL` 和 `SUB2API_MAINTENANCE_DATABASE_URL` 直接接入。

完整首次部署、权限边界、配置备份和故障排查见[部署与操作手册](docs/deployment-operations.md)。

## 安全执行流程

1. 选择固定目标并生成预览；请求不能提交表名、路径或 SQL。
2. 精确统计截止点以前的行，并显示时间范围、影响与逻辑体积估算。
3. 清理 `usage_logs` 前，按 `SUB2API_TIMEZONE` 逐日核对请求、Token、费用、账号成本、耗时和去重活跃用户。
4. 在预览之后完成一次 Sub2API 原生备份。备份状态不满足时执行接口硬阻断。
5. 确认下游同步和不可逆影响，输入该预览专属确认短语。
6. 执行前再次检查 schema、聚合水位、原生人工用量任务和备份完成时间。
7. 通过 `tableoid + ctid`、`FOR UPDATE SKIP LOCKED` 和小事务分批删除；达到总行数上限或收到取消请求即停止。
8. 运行结果保存在有上限的进程内存并输出到 stdout，可下载 JSON；服务重启后内存记录消失。

手动清理保留上述完整的目标勾选、预览、备份、双确认和专属确认短语。自动清理默认关闭；启用后按每日时间触发，同样先生成预览并执行覆盖检查，随后创建 Sub2API 原生备份，只有该备份完成时间晚于预览才会提交固定白名单清理。自动任务遇到无数据、Schema/聚合阻断、人工清理冲突、备份超时或已有运行时不会扩大删除范围。

自动清理可以在系统设置中启用。系统强制要求独立维护连接和新鲜备份硬闸门；`sub2api` 模式允许暂时使用当前 SSO Token，但无人值守可靠性受 Token 有效期和服务重启影响，建议在同一页面验证并加密保存管理员 Token。默认自动目标不包含关键用量数据；环境变量仍可作为高级部署覆盖：

```dotenv
OPERATIONS_CENTER_AUTO_CLEANUP_ENABLED=true
OPERATIONS_CENTER_AUTO_CLEANUP_TIME=03:30
OPERATIONS_CENTER_AUTO_CLEANUP_TARGETS=usage_logs,usage_hourly,usage_daily,system_logs,error_logs,ops_metrics
OPERATIONS_CENTER_AUTO_CLEANUP_BACKUP_WAIT_MINUTES=10
```

运营中心调度状态只保存在进程内，服务重启后重新计算下次执行时间，不补跑已经错过的场次。持续滚动保留仍建议同时在 Sub2API 中配置，避免运营中心停机期间窗口失控：

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

- [部署与操作手册](docs/deployment-operations.md)
- [清理范围报告](docs/cleanup-scope-report.md)
- [统计口径](docs/metrics.md)
- [成本分析设计与口径](docs/cost-analysis.md)
- [最终保留策略](docs/retention-policy.md)
- [存储与影响分析](docs/storage-retention.md)
- [实现与运行边界](docs/implementation.md)
