# 域名访问

模块在运营中心内实现，不修改 Sub2API 源码、前端、业务表结构或扣费流程。首次打开时可展示“尚未配置”；只有完成入口日志配置后，才能记录后续访问。这里提供待上线配置，不会在开发或本地预览时自动连接服务器、重载 Nginx、部署或发布消息。

## 可以确认什么

1. 专用 Nginx JSONL 记录实际请求 Host、入口结束时间、路由分类、HTTP 状态及网关生成的随机编号。
2. Nginx 必须覆盖客户端的 `X-Request-ID`，并从后端原始响应头读取同一编号；不相同则保持“入口未验证”。不使用客户端自报的 `X-Client-Request-ID`、IP、时间相似度、Referer 或 `usage_logs.request_id` 推断身份。
3. 运营中心仅执行 PostgreSQL 只读查询，通过 `sub2api_custom.billing_recovery.request_snapshot.request_id` 精确匹配用户 / Key。多次尝试归属同一用户和 Key 时合并；出现多个身份则隔离为“身份冲突”。缺表、缺权限、查询超时或结果超过上限时保持未知，采集状态显示错误码。
4. 用户列表和通知名单只收录已验证的普通用户，排除管理员、已删除或身份不可用的账号。网页、静态资源、未鉴权或尚未产生主站快照的请求可能永远无法确认用户；HTTP 200 不代表流式输出完整。

兼容当前主站已存在的恢复快照契约，无需新增主站补丁。原版或缺少该表 / 字段的安装仍可按域名统计入口请求，但不能凭空得到用户名单。关联查询每 10 秒至多处理 80 个到期请求，每次最多 2,000 条证据、单语句 5 秒超时、时间范围为当前批请求结束时间的前后 1 小时；先用不执行查询的 EXPLAIN 核验计划，总成本超过 2,500 则不扫描，显示 `IDENTITY_QUERY_PLAN_LIMIT`。来源失败按 1 至 15 分钟退避，避免反复冲击主站数据库。长于该时间窗口、被清理或没有快照的请求保留待关联。未知请求指数退避，最长每天重查一次。

## 入口日志配置（上线时操作）

配套文件均在 `operations-center/integrations/domain-access/`：

- `http.conf`：在 Nginx `http {}` 中 include 一次，定义脱敏路由分类及 JSON 日志格式。
- `server-log.conf`：在每个关注域名及迁移目标的 `server {}` 中 include，保留原日志。Nginx 若在 `location` 内单独定义了 `access_log`，应在那里一并添加，避免继承规则遗漏。
- `proxy-id.conf`：在转发主站请求的每个现有 `location` 内 include，覆盖 `X-Request-ID`。先移除该位置已有的同名 `proxy_set_header`，确保只有一个值；保留现有 Host、转发头及其他请求头。Nginx 的 `proxy_set_header` 不能跨层混合继承，原本仅从父层继承头的 location 需要把原有头列表一起保留。
- `logrotate.conf`：轮转参考，使用 rename + reopen；按服务器实际 Nginx 用户、读取组、PID 路径调整，不覆盖原轮转文件。
- `compose.override.yaml`：只给运营中心增加专用日志目录的只读挂载，无 Docker socket、SSH 密钥或整机日志权限。

旧域名 `epoint2api.fjmooo.cn`、`aihub.fo2.us.ci` 与新域名 `yunhop.cc` 的入口都需配置。不能只按共用日志文件名区分域名；主站所有可绕过该网关的入口不会被统计。模块比较精确域名，不自动把 `www` 或其他别名合并到目标。

日志目录必须真实存在且运营中心容器用户（默认 UID/GID 1000）能遍历目录、读取日志及轮转文件。建议使用专用读取组并在 Compose 配置相应 `group_add`，不要开放写权限给运营中心。Nginx 需要写权限。先使用 `nginx -t` 检查，再按部署流程 reload。

独立运营中心 Compose 示例（从 `operations-center/` 执行；本次开发不执行）：

```bash
docker compose -f compose.yaml -f integrations/domain-access/compose.override.yaml --profile operations-center up -d operations-center
```

如果使用根目录组合部署，应将同等 override 合并进实际 Compose 文件列表，不替换现有网络、环境和数据卷。

环境配置：

```dotenv
OPERATIONS_CENTER_DOMAIN_ACCESS_LOG_DIR=/app/domain-access-logs
OPERATIONS_CENTER_DOMAIN_ACCESS_DOMAINS=epoint2api.fjmooo.cn,aihub.fo2.us.ci
OPERATIONS_CENTER_DOMAIN_ACCESS_TARGET=yunhop.cc
```

域名和保留期首次从环境 / 默认值初始化，之后由页面持久设置优先。更改关注域名只影响后续扫描，不回放已跳过的其他域名。迁移目标必须与关注域名不同。

只读数据库连接需要当前已有 `public.users` 的 SELECT 以及恢复表的以下最小权限。自动数据库初始化仅涵盖原有 public 表，此项须由数据库管理员在上线时授权；本模块不会提升自身权限或创建索引：

```sql
-- 把 operations_reader 替换为运营中心实际使用的只读角色。
GRANT USAGE ON SCHEMA sub2api_custom TO operations_reader;
GRANT SELECT (id, user_id, api_key_id, created_at, request_snapshot)
  ON sub2api_custom.billing_recovery TO operations_reader;
```

若计划成本过高或查询超时，页面显示 `IDENTITY_QUERY_PLAN_LIMIT` / `57014` 并保留未知身份。DBA 可评估 `integrations/domain-access/identity-index.sql` 提供的可选表达式索引；它会新增主站现有表的物理索引，需评估构建负载、磁盘及写入开销并单独安排执行，但不改源码、表列或业务语义。采集器不会自动创建索引、执行迁移或放开超时。本次开发未执行此 SQL。

## 历史日志

将服务器仍保留的旧 access / error 日志副本放到专用目录下的 `history/`（运营中心仅挂载读取，不修改原文件），支持 `*.log`、`*.log.1`、`*.log.1.gz` 和 `*.log.gz`。不要把带令牌、正文的其他业务日志放进该目录。

默认 combined access 日志只提取 Referer 的域名、时间和脱敏路由；error 日志只提取明确的 `host: "..."`。二者均没有可验证用户，不加入通知名单。不保存原始行、IP、UA、Authorization、Cookie、查询字符串或请求 / 响应正文。同一原始行按 SHA-256 去重，数量是线索数，可能少于真实请求数，不能称为历史独立用户数。旧订单及系统日志的容器 host 不自动认领为入口域名证据。

当前已知服务器旧日志混合多个域名且没有请求 Host / 可信关联号，因此不能恢复完整历史名单。模块的历史页展示实际导入结果，不内置之前只读排查的数字或真实用户资料。

## 持久化与边界

数据保存在原运营中心数据卷 `domain-access.sqlite`（包含 WAL），与主站业务库分开。默认明细 30 天、按日用户汇总 / 历史线索 365 天，页面可调整。明细到期后仍保留范围内的日汇总和已确认用户，Key / 逐请求证据可能消失；累计、首次和最后访问均只代表保留记录。缩短保留期立即清理本模块的过期数据，延长不能恢复。

每轮读取预算 4 MiB，单行最多 16 KiB，最多发现并处理 64 个文件。gzip 单文件压缩体最大 32 MiB、解压最大 128 MiB；超限明确报错，需在导入前分拆。断点与当前块记录同事务提交，重启、rename 及压缩副本不重复计入口编号。copytruncate / 原地改写可通过文件长度、头部及断点指纹检测；复制过程仍可能丢写，推荐 rename + reopen。未读文件被删除、目录短暂不可用、采集停止、文件超过预算或空白时段都不能证明流量为零。

采集状态区分目录未配置、读取正常、追赶、失败与中断，展示最近扫描、最近请求、身份源错误、文件断点和已发现缺口；“读取正常”只表示文件扫描成功，不代表覆盖完整或网站实时有流量。历史保留时长及读写预算不是磁盘容量硬配额，上线应预留本地 SQLite 和 Nginx 轮转日志空间，并沿用磁盘监控。

## 通知与接口

用户筛选、跨页选择每批最多 50 位，CSV 最多 10,000 位，超限报错，转义电子表格公式。通知批次及每位收件人的独立 UUID 防重键持久化，部分失败可在同一批重试；中途重启也沿用同一键。生成前再次核对当前主站用户的 ID、普通用户角色和邮箱，变更或不同主站的同号用户保持失败，等待新证据后再重试。无可用管理 API 凭据时保持失败，重新登录后点重试。默认只调用既有用户消息服务生成 `draft` / `silent` 消息，不发布、不自动标记“已通知”。需要在用户消息页检查、编辑、删除或发布；实际投递仍沿用原有用户消息代理配置。域名页展示最近 200 个批次，整个模块最多保存 1,000 批次。

“已通知 / 暂不通知 / 待通知”是有操作者及原因的人工跟进记录，和消息草稿、发布、已读状态分别展示。只生成草稿不会冒充投递成功。所有读取接口复用管理员认证及 `no-store`，写接口复用 CSRF：

```text
GET  /api/domain-access/options | status | report | users | users.csv | history | drafts
GET  /api/domain-access/users/:id | requests | requests/:id
PUT  /api/domain-access/settings
POST /api/domain-access/notifications | drafts | drafts/:id/retry
```

本地正式页面模拟预览：`npm run preview:domain-access`，只监听 loopback，自动选择空闲端口；数据使用临时 SQLite / PGlite 和 example.com 用户，没有生产访问或真实发送。浏览器验收：`npm run check:domain-access-ui`，可指定 `PLAYWRIGHT_MODULE_PATH` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`。服务测试包含真实 PostgreSQL SQL 执行、真实鉴权 / CSRF HTTP 链路、文件轮转及草稿持久化。
