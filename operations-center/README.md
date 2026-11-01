# Sub2API 运营数据与存储管理中心

`operations-center` 是 `sub2api-extra` 中的独立服务，默认监听 `9872`。它直接读取 Sub2API PostgreSQL 业务表与原生聚合表，不创建新的扣费账本；本地保存加密运行配置、手工收支、经营核算所需来源快照及审计、定向用户消息与已读记录，以及可选的有界请求诊断数据。

当前实现基于 Sub2API `d2e319b2a17006122cd2d53d828c44a0bf21bd9b` 之后的最新 schema 完成核对。线上接入时仍会检查实际表结构；未知或缺失 schema 会阻断清理。

“计费核查”页配套 fork dev 的恢复 API。未知结果可查上游业务样本，比较用量并附历史价格凭据；补记先保存使用记录、人工确认后，再由 Sub2API 原生事务结算。已结算记录追加差额记录，不直接修改用户余额。自动恢复每 30 秒处理持久待办，重启后继续；配置 `OPERATIONS_CENTER_BILLING_RECOVERY_ENABLED=false` 可暂停后台。自动执行需要已有的持久管理员认证，浏览器 SSO 仅供当前会话操作。查单无法唯一匹配、缺历史价格或最终用量时保留待核查。完整改动和集成约定见根目录 `CUSTOMIZATIONS.md`。

后台会发现未知结果、待核查以及已结算但观察不完整的请求，按用户 / Key / 上游账号保留已知 Token 和查单证据；缺少业务样本时定向读取供应商监控的上游日志，不重发推理。最终标准 Token 与冻结的历史售价均有效时生成 review 草稿，仍需管理员确认。上游支出不等于用户售价，不按时间相近或估算用量扣款。[数据来源、自动范围与操作步骤](docs/billing-recovery-behavior.md)；[现有 Docker 部署更新与回滚](docs/billing-recovery-update.md)。

核查队列及证据持久化在 `OPERATIONS_CENTER_DATA_DIR/billing-recovery/billing-recovery.sqlite`，沿用已有数据卷。在线备份须用 SQLite 备份 API，或停止服务后归档完整数据目录；不能只复制运行中的主库文件。配套升级还须更新供应商监控镜像，其 schema 33 将旧样本的最终用量完整性保留为未知。

“计费核查 → CSV 补记”默认流程为导入 → 分析账单 → 选择并生成扣费预览 → 核对确认。映射上游 Key 到主站账号后，按 CSV 请求时间和耗时读取相应时段证据，优先排除已正确计费的请求、定位唯一用户，再自动读取主站价格和用户 / 原分组倍率；有历史快照时优先使用，没有时标明“当前主站价格”及报价时间，无需手工配置售卖规则。可按“可补记 / 待核查 / 已计费 / 已补记”查看，待核查支持按用户集中筛选；确认后先补记原生使用记录再结算。上游支出只作比较，批次、冻结预览和回执持久化，重复确认不重复扣费。[导入步骤与边界](docs/billing-csv-import.md)。

CSV 预览和确认在运营中心后台逐块执行，页面用短请求轮询进度，避免整块串行核价 / 结算超过 Cloudflare 等待时限触发 524。刷新原批次可继续查看当前块；未提交的后续块不在离开页面后自动执行。进度与回执保存在原 SQLite 卷，不保存浏览器凭据；服务重启标记中断、保留原记录，管理员核对后续办，原生防重继续有效。本次只需更新运营中心，不改变匹配算法、主站源码或生产超时配置。

CSV 默认用独立原生完整用量校准开始 / 结束时间，重复 Token 组合先按时间缩小候选，再进行已计费 / 待补记两阶段一对一分析；有记录但扣费未确认单列核查。版本 6 在关联来源和观察 Token 排除基础上，增加 2–20 笔同用户 / Key / 分组 / 账号的余额历史请求整组核查：来源完整覆盖、无组外可能请求、每种对应方式的主站报价均等价，且没有 Key 滚动限额或账号配额，才能生成整组预览。跨页完整展示，确认时主站事务认领全组再逐笔原生结算；中断按原案件续办，重复导入读取原认领，不重复收费。无法证明覆盖、持久案件、订阅、不同归属或缺价仍待核查，稳定记账分配不冒充逐笔历史对应。可选只读 `OPERATIONS_CENTER_BILLING_LOG_DIR` 继续支持完整文件来源，不伪造错误表。未开始的旧匹配须重分析，已开始的版本 3 / 4 / 5 按冻结预览恢复。本次须同时更新主站和运营中心，主站新增整组回执表迁移及两个管理员接口；无新增机器、独立服务或生产依赖。

运营概览、用量、用户分析、用户画像、资金与成本分析的所有用户指标统一排除 ID 1 管理员，包括比例和留存的分子、分母。请求、Token、费用和耗时读取排除管理员后的保留明细；明细已清理时显示不完整提示，趋势留空，无法从无用户维度的站点汇总恢复历史非管理员用量。存储容量、清理行数和聚合完整性核验仍按实际源数据计算。

## 已实现能力

- 运营概览：DAU、MAU、近 7/30 日活跃、新增用户、请求量、本月用户消费与支付实收，全部排除 ID 1 管理员。
- 用量统计：按任意自然日范围查询请求、四类 Token、输入与输出合计 Token、费用、账号成本、耗时、区间去重活跃用户和日趋势；Token 达到百万/十亿用 M/B 展示，全部用户指标排除 ID 1 管理员，已清理明细的区间明确提示用量可能不完整。
- 慢请求：按账号、用户、模型、推理档位、请求 ID、首输出和总耗时筛选，展示 P50/P95、慢记录分布、错误记录与分页；复用供应商监控的账号/Key 映射核对上游同一次请求，并提供重试分段时间线、实时阶段和资源历史。[完整接入与统计口径](docs/slow-requests.md)。历史日志查询无需修改主服务，新增分段采集需接入随附的 Sub2API 插桩代码。
- 近 30 天维度统计：模型、用户、API Key、分组、账号与计费类型。
- 用户分析：活跃/新增趋势、首次观测活跃、7 日激活、D1/D7/D30 注册 cohort。
- 用户画像：按日期、平台和余额/订阅计费筛选，展示活跃用户、实际消费、人均消费、多平台率、平台/模型请求与 Token/消费占比、消费集中度、活跃下降与低余额关注；支持用户搜索、分层、排序、服务端分页、全量筛选 CSV，以及单用户模型、四类 Token、趋势、活跃日历和当前余额详情。
- 用户消息：搜索并选择单个收件人，编辑与预览 Markdown，支持草稿、强制弹窗、定时生效、过期、编辑、撤回、删除和已读状态；通过用户公告接口网关复用 Sub2API 现有消息列表与弹窗，不向原生公告表写入全站公告。首次启用需要[配置主站公告接口转发](docs/user-messages.md)，未接入时仅允许保存草稿。
- 资金分析：支付实收、退款估算、净额、余额入账来源、异常订单提示；现金与额度不会相加。
- 成本分析：经营分析、现金收支、余额与核对三视图；支持付费消费收入确认、订阅及费用跨期分摊、上游实际成本、现金关联去重、退款、期初核验和审计，按日 / 周 / 月 / 年展示趋势与利润，不再从本期利润减当前余额。[操作与核算规则](docs/cost-accounting.md)。
- 存储诊断：数据库和关系大小、索引/TOAST、分区、死行、长事务、复制槽/WAL 占用及有上限的进程内容量样本。
- 清理控制：固定白名单预览、精确行数、逻辑体积估算、聚合完整性复核、原生备份硬闸门、双重确认、小批事务、取消和 JSON 报告。
- 原生能力复用：只核验或触发 Sub2API 已有 `.sql.gz`/S3 备份；不重复实现上传、下载或覆盖恢复。
- 管理员 SSO：从 Sub2API 管理员自定义菜单打开时自动校验当前登录态，不要求在运营中心保存邮箱密码。
- CSV 补记：字段映射、UTF-8 / GB18030、时间自动校准、缺失请求与用户匹配、主站自动报价及历史快照优先、冻结扣费预览、确认后原生使用记录与扣费、重复导入和中断续办。
- 系统设置：页面创建最小权限数据库角色、加密保存受限连接、运行依赖检查，并管理保留周期、自动清理和可选持久 API 认证。

## 用户画像口径

画像使用 `usage_logs.actual_cost` 的实际消费额度，排除用户 ID 1；不与充值现金、标准计价或账号成本相加。模型优先 `requested_model`，旧记录回退 `model`。平台沿用 Sub2API 的分组优先、账号回退规则，复合分组使用实际账号平台；无法归属时保留“未知平台”，不凭模型名推测。平台关联使用当前配置，不保证历史快照。

明细查询限定在配置的请求日志保留期内，单次最多 366 个自然日，默认近 30 天；起止日期均包含，使用 `SUB2API_TIMEZONE`。平台与计费筛选影响全页；搜索、排序与用户分层只影响用户列表，不改变消费占比分母。已删除或缺失用户仍保留独立 ID 与消费，未知平台不计入多平台数量。

活跃下降使用包含今天的固定最近 14 天，最近 7 天比前 7 天下降至少 50%，且前 7 天至少 100 次请求；遵循平台和计费筛选。关注列表包含当前所选范围已经无请求的用户。余额寿命使用当前 `users.balance` / 最近 7 天所有平台日均余额计费消费（`billing_type = 0`）；同一用户的订阅消费（`billing_type = 1`）不参与估算。余额为当前可用余额，不重复扣除已移入冻结余额的金额；没有近期余额消费时不估算。

通过站点日汇总和聚合水位核验明细覆盖；缺失记录时只展示保留明细，近期覆盖未核验时不生成下降与余额寿命标签。当天数据持续更新，请求数表示用量记录数，不表示成功率。列表采用服务端分页，整体模型 Top 5 与个人模型 Top 50 以外汇总为“其他模型”，保留完整分母。CSV 导出所有符合当前筛选的用户（最多 50,000 人，超限报错），使用 UTF-8 BOM 并防止电子表格公式注入。

只读管理员接口：`GET /api/user-profiles/options`、`GET /api/user-profiles`、`GET /api/user-profiles/users`、`GET /api/user-profiles/users/:userId`、`GET /api/user-profiles/export`。复用现有认证、参数校验、TTL 缓存与只读 PostgreSQL 快照；不创建或修改业务表。读取角色需要 `users`、`usage_logs`、`groups`、`accounts`、`usage_dashboard_daily` 和 `usage_dashboard_aggregation_watermark` 的 SELECT 权限，系统设置生成的读取角色已覆盖这些表。

画像 SQL 测试使用开发依赖 PGlite 验证 PostgreSQL 聚合与时区边界，不读取真实数据库。

## 数据保留结果

| 数据 | 默认期限 | 清理后能力 |
| --- | ---: | --- |
| 单次请求及请求级扣费明细 `usage_logs` | 30 天 | 30 天后不再保证逐请求、用户、Key、模型、分组或渠道维度查询 |
| 小时用量及小时活跃集合 | 30 天 | 超期小时趋势消失 |
| 站点日用量及日活集合 | 730 天 | 原生站点总量仍保留；排除 ID 1 的 DAU/MAU 继续可查，其他非管理员用量依赖未清理明细 |
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
| `OPERATIONS_CENTER_USER_MESSAGES_ENABLED` | `false` | 完成主站公告接口转发后启用定向消息发布与接收；未启用时仅允许草稿 |
| `SUB2API_ANNOUNCEMENTS_UPSTREAM_URL` | 同 `SUB2API_BASE_URL` | 用户公告网关直连的 Sub2API 地址，必须绕过主站公告接口转发，不能形成回环 |
| `SUB2API_ADMIN_TOKEN` | 无 | 可选的 Sub2API 管理员 JWT 或原生 `admin-` 管理员 API Key |
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

成本分析现分为“经营分析 / 现金收支 / 余额与核对”，默认本月截至今天、按日展示，统一 CNY。经营利润 = 已履约确认收入 - 供应商实际成本 - 本期其他运营费用，不再扣当前用户余额。充值、消费额度、现金、预收余额分别核算；[完整规则与操作](docs/cost-accounting.md)。

付费余额按每位用户额度池的实收价值做每日加权分摊，例如付 100 得 120、消费 60 确认 50 收入，余值跨月延续。订阅依据实际售价与核验服务期按日分摊。费用独立保存付款日和所属期间，支持年付、跨月、应付未付及自然日分摊；赠送或测试额度不创造收入，但实际上游成本保留。所有用户金额排除 ID 1，已删除用户历史仍保留。

“自动收入”改为“自动额度入账”，仅表示已使用 balance / admin_balance 的 value，不直接视作现金。真实在线收款取支付 pay_amount，按唯一同用户充值码关联额度；线下收款须分类或关联原兑换记录，防止重复收款。管理员加余额必须区分实收、赠送或纠错。保留用户分页 / 搜索与逐条兑换记录下钻，使用已同步来源，不因后续删除源记录而抹去原核算历史。

记账抽屉默认 CNY，供应商充值从监控目录选择，只计现金支出，实际消耗才计成本。支持费用、充值收款、订阅、其他服务收入、赠送 / 纠错及退款；退款需原收款依据，累计不超过实收，负向额度记录只能扣一次，订阅终止后不继续确认未提供服务的收入。重复台账可关联已有业务或排除，操作保留原因与审计，不物理删除原凭据。新增日期超出筛选范围时自动切至该日展示。

首次核算起点默认本月一日，可在折叠设置内修改。已有用户需核验该时点的期初额度及待确认实收价值；旧台账导入后逐项分类。缺期初、服务期、实收依据、费用归属或供应商成本时显示待核验，不凭当前余额倒推完整利润。历史没有精确余额快照时显示不可回溯；当前用户余额、删除账户残留及上游预付估值独立展示，不当作所选期间期末余额。

新增 OPERATIONS_CENTER_DATA_DIR/accounting.sqlite 保存分类、来源、期初、规则、经营结果和审计；原 cost-ledger.json 保留，原支出 / 收入先待分类，不能直接重复当成本或收入。日报继续使用 daily-profit.sqlite，增加逐用户 / 计费类型核算来源，升级旧日报缺来源会后台补算。三个文件都须保留；SQLite 备份需一致性备份 API，或停服务后备份完整数据目录，不只复制运行中的主库。

按 FINANCE_TIMEZONE 每天 01:00 归档昨日、当天实时读取、历史直接读取本地来源，漏跑补排和失败退避均持久化。分类、期初和期间修改后使用归档来源重新分配，不重复请求上游；手动刷新仅重算所选上游历史范围。趋势和列表共用经营日报，未知传播至相关整期金额，可查看标注天数的已核验日期小计。源明细清理前未保存的历史无法恢复。

上游成本仅纳入“启用定时检查”的供应商账号，包含其全部 Key；停用账号及旧采购账本不重复叠加。Sub2API 读 total_actual_cost，New API 读消费 quota / quota_per_unit，经完整历史倍率和已确认汇率折算。没有启用账号、认证 / 超时 / 字段错误、缺历史或缺汇率时成本未知。日内最终 CNY 折算系数相同的历史段可合并，真实倍率变化仍待核验。

需同时更新运营中心与供应商监控，无新生产依赖或环境变量。沿用 PROVIDER_MONITOR_BASE_URL、两侧相同的 PROVIDER_MONITOR_INTEGRATION_TOKEN 和资金时区；持久 Token 推荐用于无人值守归档，短期浏览器 SSO 不保证凌晨有效。余额新增只读 /api/integrations/financial-balances（管理员 SSO 为 /api/financial-balances），只读最新启用账号快照，不触发上游同步；重复 / 过期 / 无限余额或缺折算依据时不输出完整估值。

本地安装开发依赖后可执行 npm run preview:accounting 查看模拟用户、模拟上游和真实核算接口，默认 http://127.0.0.1:19881/preview；npm run check:accounting-ui 验证桌面及手机流程，需要 Playwright。预览不连接生产。

### 每日供应商消费不可用的排查

供应商目录使用 `GET /api/integrations/providers`，每日成本使用 `GET /api/integrations/daily-costs?from=YYYY-MM-DD&to=YYYY-MM-DD&currency=CNY&timezone=Asia/Shanghai`（时区应与 `FINANCE_TIMEZONE` 一致）。目录可以来自已保存快照，目录正常不能证明上游消费汇总接口可用。运营中心“同步供应商”只刷新目录；每日消费由监控按需查询上游账号日汇总并短暂缓存，不需要先同步日志。接口返回 `source=upstream_daily_summary`、`scope=account`，旧版账本来源会被拒绝以提示配套升级；管理员 SSO 使用同契约 `/api/daily-costs`。`refresh=1` 可跳过成功缓存，不绕过上游失败冷却。此查询只读取上游统计并保存监控快照，不触发模型、余额变更或账单补记。

| 具体错误或状态 | 处理方法 |
| --- | --- |
| `CURRENCY_RATE_MISSING` / 缺少 CNY 换算汇率 | 在供应商监控“设置与备份 → 运行设置 → 汇率（JSON）”补齐汇率并点击“保存设置”，再刷新运营中心；此项保存在监控数据库，不在运营中心 `.env` 中 |
| HTTP 404 / 405 | 确认供应商监控也已更新到包含每日成本接口的版本，检查反向代理是否正确转发 `/api/*` |
| HTTP 401 / 403 | 核对两侧集成 Token 是否一致，或重新通过管理员 SSO 登录 |
| 数据格式不兼容 | 检查反向代理是否返回了 HTML 登录页或转发到了其他服务，并核对两侧版本 |
| 连接失败、超时或 HTTP 5xx | 从运营中心容器检查监控地址、网络、服务状态及代理日志 |
| 接口成功，但某天“待核验” | 展开供应商明细，检查上游验证码 / Token / 限流、是否支持实际消费汇总、该日历史倍率及源币种汇率；同账号重复配置需合并，不把缺失金额当零 |

监控默认显示币种为 `USD`，默认汇率只有 `{ "USD": 1 }`，因此 CNY 每日成本请求可能返回 HTTP 400。汇率方向是“1 单位该币种等于多少显示币种”，换算公式为 `目标金额 = 原金额 × 原币种汇率 ÷ 目标币种汇率`。仅以 `1 USD = 5 CNY` 演示：显示 USD 时填写 `{ "USD": 1, "CNY": 0.2 }`；显示 CNY 时填写 `{ "CNY": 1, "USD": 5 }`。请按实际确认汇率填写，并保留其他需要的币种；无需为了本报表修改显示币种，也不要用供应商充值倍率代替汇率。

如果所有上游标注的“USD”均为站内额度，实际支付 1 元人民币获得 1 额度，则应明确配置 `{ "USD": 1, "CNY": 1 }`，按业务成本 1:1 计算；不能套用市场美元汇率。充值折扣和赠送由各供应商的充值倍率另外处理，例如支付 100 元获得 200 额度，充值倍率为 2。

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

`SUB2API_ADMIN_TOKEN`、`ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 对交互式 SSO 均非必填。当前有效的 SSO Token 可以触发手动原生备份，也可暂时供自动清理使用；但它会过期且服务重启后丢失。要求每日自动清理长期无人值守时，可在系统设置中验证并加密保存管理员 Token 或邮箱密码，否则认证不可用的场次会在备份阶段安全失败，不会执行删除。开启 2FA 的管理员不能仅凭邮箱密码运行后台；可复用原生 `admin-` 管理员 API Key，按 `x-api-key` 调用管理接口。敏感操作仍受主站 step-up 限制，浏览器 SSO 继续使用管理员 JWT。

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
