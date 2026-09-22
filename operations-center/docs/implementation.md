# 独立服务实现与运行边界

## 1. 架构

`operations-center` 已实现为独立 Node.js 20+、Express 5 服务。它不导入 `account-manager` 或 `provider-monitor` 内部模块，不共用 SQLite，也不挂业务数据卷。

```text
浏览器
  -> Sub2API 管理员 SSO 或本地管理员、CSRF、限流
  -> operations-center:9872
       -> PostgreSQL 只读连接：统计、schema、容量、预览
       -> PostgreSQL 维护连接：仅固定白名单 DELETE
       -> Sub2API 管理 API：版本、原生备份记录、创建备份
       -> 每日调度器：可选，复用同一预览/备份/执行链路
       -> 加密运行配置：受限连接、清理设置、可选持久 API 凭据
       -> 有上限内存：会话、查询缓存、容量样本、预览和运行报告
```

业务事实始终留在 Sub2API。服务没有迁移文件、业务表、消息队列或额外 Redis。加密运行配置不包含运营统计或清理历史数据。

## 2. 目录

```text
operations-center/
  public/                    # 单页管理工作台
  src/
    app.js                   # HTTP、安全中间件与 API
    auth.js                  # Sub2API SSO、本地内存会话和 CSRF
    config.js                # 环境变量验证
    db.js                    # 只读/维护连接池
    runtime-settings-store.js # AES-256-GCM 运行配置
    schema-inspector.js      # 表、列和分区能力识别
    sub2api-client.js        # 固定路径的版本/备份 API 客户端
    services/
      metrics-service.js     # 用户、用量和资金统计
      storage-service.js     # 关系大小与容量诊断
      retention-service.js   # 保留策略、预览和批量清理
      cleanup-scheduler.js   # 可选每日自动清理编排
      system-settings-service.js # 角色初始化、依赖检查与运行配置
    server.js
  tests/
  docs/
  Dockerfile
  compose.yaml
  package.json
```

## 3. 身份与安全

- `sub2api` 模式校验自定义菜单附带的访问 Token 是否仍有效且属于管理员，再换取运营中心会话；登录页临时输入的 Sub2API 凭据不保存。
- `local` 模式保留独立管理员账号，登录比较使用定长哈希和 timing-safe 比较。
- 自定义菜单 Token、会话 ID 与 CSRF token 仅存在内存；原始 Token 在首次交换后从 URL 删除。只有管理员在系统设置中明确启用无人值守认证时，所选 Token 或账号凭据才会进入 AES-256-GCM 加密运行配置。
- HTTPS iframe 同时设置 `SameSite=Lax` Cookie、`SameSite=None; Partitioned` Cookie，并用 URL fragment 返回运营中心短期会话作为第三方 Cookie 受限时的兜底。
- CSP `frame-ancestors` 只允许本服务和 `SUB2API_PUBLIC_URL`，不开放任意嵌入来源。
- 登录接口每 IP 15 分钟最多 10 次。
- Helmet 设置 CSP，并禁止对象和跨源脚本。
- 所有写接口要求登录和 CSRF；响应禁止缓存。
- 数据库初始化接口额外限流；同名未知角色拒绝接管，高权限数据库密码不持久化。
- 页面托管连接和可选 Sub2API 管理凭据使用实例随机密钥进行 AES-256-GCM 加密。
- Sub2API 客户端只暴露固定版本和备份路径，不是通用管理 API 代理。

容器默认非 root、只读根文件系统、无 Linux capabilities、不挂 Docker socket，并限制 PID、CPU、内存和日志大小。只有 `/app/data` 命名卷可写。

## 4. 数据库连接

### 4.1 只读连接

只读连接用于所有报表、容量和预览查询，最大 4 个连接。查询超时默认 15 秒。连接可由系统设置创建和加密保存，也可用 `SUB2API_DATABASE_URL` 提供。未配置时服务保持可登录并返回 `setup_required`，统计接口明确失败，不创建兼容表。

### 4.2 维护连接

维护连接池大小固定为 1。系统设置可以自动创建只能 `SELECT/DELETE` 清理白名单以及 `SELECT/UPDATE usage_group_rollup_state` 的独立角色；也可以通过 `SUB2API_MAINTENANCE_DATABASE_URL` 接入已有角色。没有该连接时执行接口硬阻断。

维护连接开始运行后显式调用 `set_config('TimeZone', SUB2API_TIMEZONE, false)`，保证日期桶和 Sub2API 删除触发器使用同一时区。

### 4.3 schema 识别

检查关键业务、聚合、支付和运维表，记录：

- 表是否存在
- 普通表或分区父表
- 当前列清单
- 检查时间

清理前刷新 schema。目标表或时间列不存在时该表跳过；核心表不完整时整个预览不可执行。

## 5. HTTP 接口

| 方法与路径 | 功能 |
| --- | --- |
| `GET /healthz` | 进程存活 |
| `GET /readyz` | 数据库就绪与延迟 |
| `GET /api/auth/config` | 公开的认证模式和返回地址 |
| `POST /api/auth/sso` | 校验 Sub2API 管理员 Token 并交换本地会话 |
| `POST /api/auth/login` | 当前模式下的本地或 Sub2API 凭据登录 |
| `GET /api/auth/me` | 当前会话和 CSRF token |
| `POST /api/auth/logout` | 注销 |
| `GET /api/overview` | 运营概览 |
| `GET /api/metrics/usage` | 任意日期范围站点用量 |
| `GET /api/metrics/usage/dimensions` | 近 30 天维度统计 |
| `GET /api/metrics/users` | 用户活跃、激活和留存 |
| `GET /api/metrics/finance` | 实收、退款估算和额度入账 |
| `GET /api/storage` | 容量、关系和维护信号 |
| `GET /api/capabilities` | schema、版本和执行能力 |
| `GET /api/settings` | 脱敏的连接、认证和清理配置状态 |
| `POST /api/settings/checks` | 运行数据库、Schema、API 和备份检查 |
| `POST /api/settings/database/test` | 临时测试 PostgreSQL 管理连接 |
| `POST /api/settings/database/provision` | 创建受限角色、加密保存并热切换连接 |
| `PUT /api/settings/sub2api-credentials` | 验证并保存或清除持久管理认证 |
| `PUT /api/settings/cleanup` | 更新保留周期和自动清理配置 |
| `GET /api/retention/policy` | 固定保留策略与保护范围 |
| `GET /api/retention/automation` | 自动调度配置、下次运行和最近尝试 |
| `POST /api/retention/previews` | 生成有时效的清理预览 |
| `POST /api/retention/backups` | 可选触发原生备份 |
| `POST /api/retention/runs` | 双确认后执行预览 |
| `POST /api/retention/runs/:id/cancel` | 请求批次间取消 |
| `GET /api/retention/runs/:id/report` | 下载 JSON 报告 |

## 6. 清理实现

### 6.1 预览

预览 ID 为 UUID，默认 15 分钟过期，进程内最多保留 20 个。预览固定记录：

- 创建和过期时间
- 每个目标的保留天数与精确截止点
- 表是否可用、符合行数、最早/最晚时间
- 包含分区子表的关系总大小和逻辑体积估算
- 功能影响
- 聚合覆盖、水位、原生任务和备份状态
- 专属确认短语

### 6.2 覆盖检查

删除 `usage_logs` 前，服务从 730 天窗口起点到 30 天截止日，按 `SUB2API_TIMEZONE` 的完整自然日核对原始日志和日汇总。检查请求、四类 Token、两类费用、账号成本、总耗时、日汇总活跃数和日活集合。

水位不存在、落后超过 24 小时或任一日期不一致都会阻断。起始边界按完整自然日比较，不会把半天原始数据错误地与整日日桶比较。

### 6.3 备份硬闸门

执行要求原生成功备份的 `finished_at` 不早于预览 `createdAt`。先前的日常备份只用于状态提示，不能满足本次执行条件。若显式关闭此闸门，页面和报告会标记，但生产环境不建议关闭。

### 6.4 批量删除

- 单个维护连接和数据库 advisory lock。
- 每批独立事务，默认 5,000 行。
- 先按时间排序选取 `tableoid, ctid`，使用 `FOR UPDATE SKIP LOCKED`。
- 按 `tableoid + ctid` 删除，兼容从分区父表选出的同名 `ctid`。
- 每批锁等待最多 5 秒，默认间隔 250 ms。
- 单次运行默认上限 5,000,000 行。
- 取消在当前事务结束后生效；失败只回滚当前批。
- 连接建立失败也会把运行标为失败并释放进程内活动状态。

不执行 DDL、TRUNCATE、VACUUM FULL、shell 或文件删除。

### 6.5 自动调度

- 只支持按 `SUB2API_TIMEZONE` 每日一个 `HH:mm` 时间点，不接受任意高频 cron 表达式。
- 默认关闭，且自动目标默认只有普通日志、错误事件和运维指标。
- 启用时强制要求全局清理开关、独立维护连接、Sub2API 管理 API 和新鲜备份硬闸门。
- `sub2api` 模式可由当前有效 SSO Token 提供备份认证，因此邮箱密码不是启动必填项；Token 过期或重启丢失后，该场次会在备份前失败。长期无人值守需配置管理员 Token 或账号密码。
- 每次先调用相同的 `createPreview`；无数据则跳过，任何 blocker 都直接终止。
- 有超期数据时触发原生备份，轮询至出现完成时间不早于预览的成功记录，再调用相同的 `execute`。
- 手动任务或另一个自动任务正在执行时跳过，不排队叠加。
- `node-cron` 负责时区调度与单进程重叠保护，PostgreSQL advisory lock 仍是删除阶段的最终并发保护。
- 重启后重新计算下一次计划时间，不补跑错过的场次；自动状态不写入业务数据库。

## 7. 状态持久化边界

下列状态只在内存：

- 登录会话
- 查询缓存
- 容量增长样本
- 最近 20 个预览
- 最近 50 个清理运行
- 最近一次自动调度尝试与当前阶段

清理报告同时输出为结构化 stdout。服务重启后不会恢复或继续未完成的批次，也不会保留页面中的旧运行列表。需要长期审计时应接入现有日志平台，而不是在本服务新建无限增长表。

## 8. 备份复用

最新版 Sub2API 已有 gzip PostgreSQL 备份、S3、定时策略、下载和覆盖恢复。本服务只调用 `GET/POST /api/v1/admin/backups`。恢复、S3 配置、下载和删除备份继续在 Sub2API 原生页面完成。

创建备份属于 step-up 保护操作。Sub2API 开启 step-up 2FA 时，运营中心后台调用可能被拒绝；用户在原生页面完成备份后，运营中心可通过读取备份记录满足硬闸门。

## 9. 部署与发布

- 根 Compose 已 include `operations-center/compose.yaml`。
- profile 为 `operations-center`，默认不会随其他模块自动启用。
- 镜像标签为 `operations-center-latest`、`operations-center-<version>`、分支和 SHA 标签。
- GitHub Actions 构建 `linux/amd64` 和 `linux/arm64`。
- 容器对宿主机默认只开放 `127.0.0.1:9872`。
- `/healthz` 不访问数据库；`/readyz` 会验证数据库连接。

## 10. 有意不实现

- 不复制明细或永久总消费。
- 不实现任意 SQL 控制台。
- 不提供高频或任意 cron 表达式；自动清理仅允许按配置时区每日一次。
- 不自动修改 Sub2API 配置或源码。
- 不把数据库大小冒充文件系统可用空间。
- 不管理 Redis、WAL、Docker、对象存储和备份文件生命周期。
- 不提供任意备份文件上传或自建恢复流程。
- 不宣称退款估算是支付渠道结算结果。

这些边界避免扩展服务成为第二个业务数据库或高权限宿主机代理。详细删除影响见[清理范围报告](cleanup-scope-report.md)。
