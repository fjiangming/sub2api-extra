# 用户用量排行

面向 Sub2API 用户的独立排行子服务，默认端口 `9876`。页面沿用确认的 Demo：前三名领奖台、Top 10 表格、个人排名、与上一名差距、近 7 天 Token 趋势和常用模型。支持今日、本周、本月、累计，以及 Token / 调用次数排序。用户名称统一使用脱敏的注册邮箱。自动跟随系统主题，无 Logo、主题切换和底部系统名。

## 数据与资源

- **没有自己的数据库**：直接只读查询 Sub2API 现有 PostgreSQL 的 `public.users`、`public.usage_logs`，不创建表、索引、迁移、归档或逐日快照。
- **没有数据卷**：排行缓存、个人统计缓存和短期会话都只在内存中；重启会清空，用户重新从主站菜单进入即可。
- 全局榜缓存最多 8 项，个人缓存默认 256 项，默认 TTL 60 秒；各缓存最多 8 个并发加载，会合并相同请求。会话默认最多 1,000 个，过期自动清理。限流桶最多 4,096 个。
- PostgreSQL 默认最多 3 个连接，查询超时 15 秒；超过并发上限立即返回繁忙，不积累连接等待队列。连接固定启用 `default_transaction_read_only=on`，推荐再使用受限只读数据库账号。
- 容器只读文件系统，默认内存上限 192 MB、CPU 0.5，无持久挂载；Docker 日志最多 `5 MB × 3`。服务不写访问日志、Token、SQL、数据库连接串或业务数据文件。
- 页面、Lucide 图标与风景头像均为本地静态资源，不依赖 CDN；风景是固定分配的装饰图片，不是用户上传的头像。

服务不另外保留历史。**累计榜表示主站现存用量记录的累计**，不承诺主站已清理明细后的完整终身排名。站点原生的日/小时活跃用户表没有用户级 Token 和费用，不能用它们补出被删除的排行。所有周期都在页面注明“现存记录”；数据缺少上期起点时隐藏排名变动和增长率。最早记录检查无法证明中间从未清理过数据。

统计在数据库内完成，不把全部用户或请求明细加载到 Node.js。用户排名计算仍需要聚合所选时间范围的明细，大站和累计查询的开销取决于主站保留量与已有索引。可调高缓存 TTL、降低并发；本服务不会为了提速在主站创建新索引。

## 部署

要求 Node.js 22.18+，或 Docker Compose 2.24+。数据库结构已与本地 Sub2API `d2e319b2a` 源码核对；运行时检查所需字段。更早版本没有 `requested_model` 时，常用模型使用 `model`。本服务仅使用主站的 `/api/v1/auth/me` 验证普通用户，无需管理员 API Key 或密码。

```bash
cp usage-leaderboard/.env.example usage-leaderboard/.env
```

编辑 `.env`，至少配置以下值：

| 配置 | 用途 |
| --- | --- |
| `SUB2API_BASE_URL` | 服务端可达的主站 HTTP(S) 根地址，如 `http://host.docker.internal:8080` |
| `SUB2API_PUBLIC_URL` | 用户浏览器可达的主站 HTTPS 根地址，同时是允许嵌入页面的父站来源 |
| `SUB2API_DATABASE_URL` | 主站数据库的只读连接串；密码中的特殊字符需 URL 编码 |
| `SUB2API_DATABASE_SSL` | `disable` / `require` / `verify-full`；远程数据库优先使用 `verify-full` |
| `SUB2API_TIMEZONE` | IANA 时区，默认 `Asia/Shanghai` |

数据库连接串不接受查询参数，SSL 和超时由单独配置设置。可以复用运营中心的只读连接。不要将数据库开放到公网；使用内网或已有受限网络通道。主站 PostgreSQL 若仅绑定宿主机 `127.0.0.1`，容器的 `host.docker.internal` 不一定能访问，需要为容器提供实际可达的受限地址。

从源码构建并启动此模块：

```bash
docker compose --env-file compose.services.env --profile usage-leaderboard up -d --build usage-leaderboard
```

无需启用其他模块，也不会改写 `compose.services.env`。长期启用时，把 `usage-leaderboard` 追加到现有 `COMPOSE_PROFILES` 列表；保留原先需要的模块。镜像 CI 已登记 `usage-leaderboard-latest` 标签，待流水线发布后可以用 `--no-build` 部署已发布镜像。

服务仅在宿主机 `127.0.0.1:9876` 发布端口。用独立 HTTPS 域名反代，示例 Nginx `server` 中的配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:9876;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    # 主站自定义菜单会把短期 Token 放到首次页面 URL，避免代理记录它。
    access_log off;
}
```

上例省略域名和证书配置。代理需允许最长 60 秒响应时间，且不要缓存 `/api/`。如果用其他访问日志方案，应只记录不含查询参数的 `$uri`；同样检查 CDN/网关日志。生产环境的排行页面与主站均使用 HTTPS，保留 Secure Cookie。推荐独立域名并在根路径 `/` 提供服务。

使用上述单层可信代理时，保持示例中的 `USAGE_LEADERBOARD_TRUST_PROXY=true`，让限流按真实客户端 IP 计数；否则所有用户可能一起受到代理 IP 的限流。直接访问 Node 服务时设置为 `false`。该选项只信任最近的一层代理，不适用于未经确认的多层代理链。

## 添加到主站菜单

在 Sub2API 管理后台的自定义菜单中添加用户可见条目，名称为“用量排行”，URL 填排行服务的 HTTPS 根地址，使用 iframe 页面。主站的自定义页面会自动追加 `token`、`user_id` 等参数，**不要把永久 Token 写在菜单 URL 中**。

页面会立即移除地址中的原始 Token，只通过同源 POST 的 `Authorization: Bearer` 头交换短期内存会话。用户身份以主站 `/api/v1/auth/me` 为准，不相信 URL 的 `user_id` 或 JWT 中自称的身份。后续请求使用 HttpOnly Cookie；跨站 iframe Cookie 被限制时，使用当前标签页的短期 `Session` 令牌兜底。原始主站 Token 不写入浏览器存储，服务端只在会话期限内存于内存，每 60 秒重新验证主站状态。会话固定到期，不滚动延长，且不超过主站 Token 的到期时间。

如果主站开启了会话绑定，需要确保两条路径看到一致的真实客户端 IP 和 User-Agent：

1. 在一个可信反向代理后设置 `USAGE_LEADERBOARD_TRUST_PROXY=true`。
2. 该代理覆盖传入的转发头；容器端口保持仅限可信代理访问。
3. 设置 `SUB2API_FORWARD_CLIENT_FINGERPRINT=true`，并使主站信任排行服务所在的代理路径。

未满足以上条件时，不要开启转发指纹。`SESSION_BINDING_MISMATCH` 会作为登录失败展示，不会通过伪造身份或跳过校验绕过绑定。

## 统计口径

| 项目 | 口径 |
| --- | --- |
| Token | `input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens`，与主站用户统计一致；不重复加 5m / 1h 缓存细分字段 |
| 调用次数 | 所选区间中的用量记录数；不额外声称所有记录都是成功请求 |
| 参与者 | 未删除且 `status=active`，所选周期有用量记录；默认排除 `admin` / `root`，可配置包含 |
| 同值 | SQL `RANK()` 并列，随后按用户 ID 稳定排序；最多展示 10 人，个人排名可超过 10 |
| 周期 | 配置时区的今日零点、周一零点、每月 1 日零点，到缓存生成时刻；不包含未来记录 |
| 上期 | 上日、上周、上月截至同一日历进度；上月天数不足则截止月末；累计无上期 |
| 百分位 | 排名依据严格低于当前用户的参与者比例；并列者不算被超过 |
| 近 7 天 | 独立于榜单周期，今天及之前 6 个自然日，无请求的日期补零 |
| 常用模型 | 当前用户、所选周期，优先 `requested_model`；最多 4 个模型加“其他”，按 Token 占比，零 Token 请求按次数 |

用户名称统一取注册邮箱 `users.email`，由服务端脱敏：邮箱本地部分最多保留前 2 个字符，其余以固定 `***` 隐藏，域名保留。例如 `apricity@example.com` 显示为 `ap***@example.com`；`ab@example.com` 显示为 `a***@example.com`；`a@example.com` 显示为 `***@example.com`。`+` 别名整体隐藏，短地址仍至少隐藏一个字符；邮箱缺失或无效时使用稳定匿名名称。会话展示信息从主站 `/api/v1/auth/me` 的 `email` 字段获取，使用相同脱敏规则。顶部、领奖台、榜单、个人栏、详情和悬浮提示均使用脱敏结果，完整邮箱不会传到浏览器。

API 只向已登录用户返回 Top 10 的脱敏邮箱及汇总用量，不提供完整邮箱、消费金额、余额、Key、逐笔请求或其他用户的模型分布。个人统计仅由当前服务会话中的身份选择，客户端不能请求其他账号。不查询费用字段，也不接受 `metric=cost`。旧 `USAGE_LEADERBOARD_NAME_MODE` 配置已移除，历史配置不会改变邮箱脱敏规则。

## 最小只读权限

可直接复用已有只读角色。要创建独立角色，由数据库管理员执行以下 SQL；这只创建主站的访问角色，不创建新业务数据库或表。按实际数据库名称替换 `sub2api` 和密码：

```sql
CREATE ROLE sub2api_leaderboard LOGIN PASSWORD 'replace-with-a-random-password';
GRANT CONNECT ON DATABASE sub2api TO sub2api_leaderboard;
GRANT USAGE ON SCHEMA public TO sub2api_leaderboard;
GRANT SELECT (id, email, role, status, deleted_at)
    ON public.users TO sub2api_leaderboard;
GRANT SELECT (user_id, created_at, model, input_tokens, output_tokens,
    cache_creation_tokens, cache_read_tokens)
    ON public.usage_logs TO sub2api_leaderboard;
ALTER ROLE sub2api_leaderboard SET default_transaction_read_only = on;
```

如果 `usage_logs` 有 `requested_model`，额外授权：

```sql
GRANT SELECT (requested_model) ON public.usage_logs TO sub2api_leaderboard;
```

服务通过 `information_schema.columns` 检查该账号可读的字段，兼容普通表与通过父表读取的分区表。只读角色需要 `users.email` 的 SELECT 权限；原先仅授权 `username` 的账号需补充此权限。完整邮箱仅在服务端用于脱敏，不读取密码或费用字段。

## 本地开发与验证

```bash
cd usage-leaderboard
npm ci --ignore-scripts
npm run check
npm test
npm run preview
```

预览地址 `http://127.0.0.1:9877/`，仅监听本机。预览使用测试专用的 PGlite 内存 PostgreSQL 和模拟主站身份，页面标注“示例数据”，不会读取 `.env` 或连接真实数据库。PGlite 只属于开发依赖，Docker 生产镜像不安装它，也不包含预览入口或测试数据。

可验证空榜、未入前十、服务故障、未登录和长邮箱（含无效邮箱兜底）：

```bash
node scripts/preview.js empty
node scripts/preview.js outside
node scripts/preview.js unavailable
node scripts/preview.js signed-out
node scripts/preview.js long-names
```

每次启动一个场景；可通过 `USAGE_LEADERBOARD_PREVIEW_PORT` 更换预览端口。真实本地运行使用 `npm start` 并读取 `.env`；HTTP 开发时设置 `NODE_ENV=development` 和 `USAGE_LEADERBOARD_COOKIE_SECURE=false`。

测试包含临时内存 PostgreSQL 上的实际查询，覆盖四类 Token、Token/次数并列、邮箱脱敏与费用排除、时区/夏令时/周月边界、历史清理、空榜、榜外个人排名、只读事务、缓存上限和身份隔离。没有测试生成的持久数据库文件。

## 接口与排查

| 接口 | 用途 |
| --- | --- |
| `GET /healthz` | 进程存活；不代表已连通主站或数据库 |
| `GET /readyz` | 数据库连接与必需字段检查；不返回连接信息 |
| `GET /api/auth/config` | 主站浏览器地址、时区及公开展示配置 |
| `POST /api/auth/sso` | 用 Bearer 主站 Token 交换内存会话 |
| `GET /api/auth/me` | 当前会话的展示信息 |
| `POST /api/auth/logout` | 撤销当前会话 |
| `GET /api/leaderboard?period=month&metric=tokens` | Top 10 和当前用户统计；必须已登录 |

`DATABASE_NOT_CONFIGURED` / `DATABASE_UNAVAILABLE` 表示连接未配置或不可达；`SCHEMA_INCOMPATIBLE` 表示字段或权限不足；`QUERY_TIMEOUT` 表示源库聚合超时；`AUTH_REQUIRED` 表示需从主站重新打开页面；`SERVICE_BUSY` / `SESSION_CAPACITY` 表示资源上限已达到。错误不会回退为示例数据，也不会把 SQL 或凭据返回页面。
