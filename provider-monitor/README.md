# Provider Monitor

Provider Monitor 是 Sub2API Extra 的供应商资产、余额、密钥分组和预算监控模块。以独立服务运行，数据保存在自带的 SQLite 中，不修改 Sub2API 数据库。

## 功能概览

| 功能领域 | 说明 |
|---|---|
| **资产同步** | 供应商连接探测、凭据验证、定时同步和持久化重试；同连接同步互斥、单供应商并发上限、随机调度抖动和连续失败熔断 |
| **余额与密钥** | 账户余额、多币种余额、密钥额度、到期时间和路由分组 |
| **趋势分析** | SQLite 历史快照、小时/日降采样、余额趋势、日均消耗与可用天数预测 |
| **异常检测** | 余额/用量异常、Key 健康、资产与分组漂移、价格目录和模型推荐 |
| **签到与对账** | 自动签到、Sub2API 分组映射、用量对账和 Channel Monitor 健康联动 |
| **倍率对照** | 基座 Sub2API 渠道/分组目录、供应商上游分组倍率对照和偏差预警 |
| **告警** | 低余额、同步失败、数据陈旧、密钥到期、异常与自动化失败告警 |
| **通知** | Webhook、Telegram、Gotify、Bark、邮件、企业微信、钉钉和飞书 |
| **自动化** | Sub2API 渠道启停与备用映射自动化，默认演练模式，支持动作回滚和动作限额 |
| **数据管理** | JSON/CSV/环境变量/All API Hub 兼容导入、配置导出、加密灾备包、SQLite 在线备份、WebDAV 与 S3 兼容备份 |
| **凭据安全** | 凭据先验证后轮换、短期回滚、主 Secret 重加密和敏感操作二次认证 |
| **可观测性** | Prometheus 指标、结构化请求日志、request ID 与示例 Grafana Dashboard |
| **安全防护** | AES-256-GCM 凭据加密、DNS 固定 SSRF 防护、管理员会话和 CSRF 防护 |

配置 JSON、加密灾备包和 SQLite 备份的用途不同：

- **导出配置**不会包含密码、Token 或 API Key。导入到空实例时会恢复供应商配置，但缺少凭据的供应商保持停用，补齐并验证凭据后才能启用。
- **加密灾备包**包含供应商凭据，适合跨实例迁移供应商；凭据由单独的灾备密码加密。
- **SQLite/远端备份**包含完整运行数据，适合整实例恢复。

## 支持的适配器

| 类型 | 余额 | 密钥 | 分组/团队 | 主要凭据 |
|---|:---:|:---:|:---:|---|
| Sub2API | 是 | 是 | 是 | 邮箱密码、Token 对 |
| New API / One API | 是 | 是 | 视分支而定 | 系统令牌、用户 ID |
| One Hub / Done Hub | 是 | 是 | 从 Key 主组/备用组引用推导 | 系统令牌、用户 ID |
| Veloera | 是 | 是 | 是 | 系统令牌、用户 ID |
| DeepSeek | 多币种 | 否 | 否 | API Key |
| OpenRouter | Management Key | 是 | 否 | Management Key 或 API Key |
| LiteLLM Proxy | 全局预算 | 是 | Team Budget | Master Key |
| VoAPI v2 | 是 | 是 | 是 | API Key、用户 ID |
| Custom | 是 | 可配置 | 可配置 | 自定义 Header 与受限 JSONPath |

Sub2API 会同步普通用户可见的默认倍率和用户有效倍率，并保留峰值倍率、图片固定价等分组计价信息。站点启用用户侧 `channels/available` 功能时，还会同步渠道模型价格并按有效分组倍率计算实际价格；未启用时目录同步会明确标记为"仅倍率"。

不同分支可能关闭或改写密钥、分组端点。同步会把这类情况标记为"部分成功"，并继续保存已经确认的余额，不会伪造缺失能力。

### Sub2API 供应商认证

添加 Sub2API 供应商时支持两种模式：

- **账号登录**：填写 Sub2API 本地邮箱和本地密码。编辑已有连接时，凭据留空会复用加密保存的值；重新填写邮箱或密码会丢弃旧会话 Token，避免旧 Token 覆盖新账号凭据。
- **OAuth Token 对**：填写 Sub2API 当前会话的 Access Token 和 Refresh Token，适用于通过 Linux.do 等第三方 OAuth 快捷注册、没有本地密码的账号。Provider Monitor 会在刷新时保存服务端返回的新 Token 对。

Sub2API 当前源码会为直接创建的 Linux.do OAuth 账号使用 `linuxdo-<subject>@linuxdo-connect.invalid` 合成邮箱，并生成一个不会展示给用户的随机本地密码。因此 Linux.do 邮箱和 Linux.do 密码都不能用于“账号登录”。优先在 Sub2API 的“个人资料 -> 账号绑定”中绑定真实邮箱并设置本地密码；无法绑定时再使用 OAuth Token 对。

Token 对可以在一个单独的浏览器会话登录 Sub2API 后，从浏览器开发者工具读取：

```js
localStorage.getItem('auth_token')
localStorage.getItem('refresh_token')
```

Token 对模式有两项上游约束：

1. 必须先关闭 Sub2API 的“系统设置 -> 安全设置 -> 会话绑定”，然后重新登录生成不绑定浏览器 IP/UA 的 Token。
2. Sub2API 的 Refresh Token 每次刷新后立即轮换，不能让浏览器和 Provider Monitor 长期共用同一个 Refresh Token。建议使用独立浏览器会话取得 Token，录入后直接关闭该会话窗口，不要点击退出登录。

若 Sub2API 开启 Turnstile 或登录 TOTP，Provider Monitor 无法用纯邮箱密码完成交互验证，会分别返回 `CAPTCHA_REQUIRED` 或 `MFA_REQUIRED`；此时应使用上述 Token 对或为该账号调整交互登录策略。

---

## 快速开始：Docker Compose 拉取镜像部署

> 推荐的生产部署方式。直接从 GitHub Container Registry 拉取预构建镜像，无需本地构建。

### 前提条件

- Docker Engine ≥ 20.10 且已安装 Docker Compose V2
- 可以访问 `ghcr.io`（GitHub Container Registry）

### 第一步：准备配置文件

从仓库下载或复制 `provider-monitor/` 目录下的三个关键文件：

```
provider-monitor/
├── compose.yaml       # Docker Compose 编排文件
├── .env.example       # 环境变量模板
└── .env               # 实际配置（从 .env.example 复制而来）
```

复制模板并生成加密密钥：

**Linux / macOS：**

```bash
cp .env.example .env
openssl rand -hex 32
```

**Windows (PowerShell)：**

```powershell
Copy-Item .env.example .env
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

### 第二步：编辑 `.env`

把生成的随机值写入 `PROVIDER_MONITOR_SECRET`，并根据部署环境调整必要参数：

```dotenv
# === Compose 部署参数 ===
PROVIDER_MONITOR_IMAGE=ghcr.io/fjiangming/sub2api-extra:provider-monitor-latest
PROVIDER_MONITOR_PORT=9871

# === 基础运行参数 ===
NODE_ENV=production
PORT=9871
PROVIDER_MONITOR_BIND_HOST=127.0.0.1

# === 加密密钥（必填，至少 32 字符） ===
PROVIDER_MONITOR_SECRET=<粘贴上一步生成的随机值>

# === Provider Monitor 认证方式 ===
# sub2api：使用基座 Sub2API 管理员 SSO 登录
# local：使用本地管理员账号登录
# 只决定本模块登录方式，不控制基座 Sub2API 联动
PROVIDER_MONITOR_AUTH_MODE=sub2api

# === 基座 Sub2API 连接 ===
# 容器内实际调用的 API 地址
SUB2API_BASE_URL=http://host.docker.internal:8080
# 管理员浏览器实际访问的地址
SUB2API_PUBLIC_URL=https://sub2api.example.com

# 联动使用的 Sub2API 管理员凭据，local 模式下同样生效
SUB2API_ADMIN_TOKEN=
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<Sub2API 管理员密码>
```

> 完整的配置项说明参见 `.env.example` 文件内注释。

### 第三步：启动服务

在包含 `compose.yaml` 和 `.env` 的 `provider-monitor/` 目录中执行：

```bash
docker compose --profile provider-monitor up -d
```

或从仓库根目录（包含 `docker-compose.yml`）执行：

```bash
docker compose --profile provider-monitor up -d
```

根 `docker-compose.yml` 使用 `include` 引入 `provider-monitor/compose.yaml`，效果完全相同。

### 第四步：验证部署

```bash
# 存活探针
curl http://localhost:9871/healthz

# 就绪探针（含数据库连通性检查）
curl http://localhost:9871/readyz

# Prometheus 指标（默认开启）
curl http://localhost:9871/metrics
```

默认访问地址为 `http://localhost:9871`。Grafana 示例面板位于 `grafana/provider-monitor-dashboard.json`。

---

## 版本更新

### 拉取最新镜像并重启

```bash
# 进入 provider-monitor 目录
cd provider-monitor

# 拉取最新镜像
docker compose --profile provider-monitor pull

# 用新镜像重建并启动容器（数据卷自动保留）
docker compose --profile provider-monitor up -d
```

如果从仓库根目录操作：

```bash
docker compose --profile provider-monitor pull
docker compose --profile provider-monitor up -d
```

### 指定版本

`.env` 中的 `PROVIDER_MONITOR_IMAGE` 默认使用 `provider-monitor-latest` 标签。如需锁定到特定版本：

```dotenv
# 按语义化版本号
PROVIDER_MONITOR_IMAGE=ghcr.io/fjiangming/sub2api-extra:provider-monitor-1.0.0

# 按 Git commit SHA
PROVIDER_MONITOR_IMAGE=ghcr.io/fjiangming/sub2api-extra:provider-monitor-sha-abc1234
```

修改后执行：

```bash
docker compose --profile provider-monitor up -d
```

### 回滚到旧版本

如果更新后出现问题，将 `PROVIDER_MONITOR_IMAGE` 改回之前的版本标签，然后重新启动即可。SQLite 数据库包含版本化迁移（当前 Schema 版本 8），**向前兼容但不保证向后兼容**，回滚前建议先备份数据卷：

```bash
# 备份数据卷
docker run --rm -v sub2api-extra_provider-monitor-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/provider-monitor-data-backup.tar.gz -C /data .

# 回滚镜像
# 修改 .env 中的 PROVIDER_MONITOR_IMAGE 为旧版标签
docker compose --profile provider-monitor up -d
```

### 清理旧镜像

```bash
docker image prune -f
```

---

## 从源码构建部署

如需自行构建镜像（例如使用自定义 NPM 镜像源），在 `provider-monitor/` 目录或仓库根目录执行：

```bash
docker compose --profile provider-monitor up -d --build
```

Dockerfile 采用多阶段构建：第一阶段安装编译依赖并执行 `npm ci --omit=dev`，第二阶段只复制运行时文件。构建参数 `NPM_REGISTRY` 可在 `.env` 中配置（默认为 `https://registry.npmmirror.com/`）。

镜像支持 `linux/amd64` 和 `linux/arm64` 双架构。

---

## Compose 编排参数

以下参数在 `.env` 中配置，由 `compose.yaml` 读取：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROVIDER_MONITOR_IMAGE` | `ghcr.io/fjiangming/sub2api-extra:provider-monitor-latest` | Docker 镜像地址 |
| `PROVIDER_MONITOR_CONTAINER_NAME` | `sub2api-provider-monitor` | 容器名称 |
| `PROVIDER_MONITOR_RESTART_POLICY` | `unless-stopped` | 重启策略 |
| `PROVIDER_MONITOR_PORT` | `9871` | 宿主机映射端口 |
| `PROVIDER_MONITOR_DATA_VOLUME` | `sub2api-extra_provider-monitor-data` | 数据卷名称 |
| `PORT` | `9871` | 容器内监听端口 |
| `PROVIDER_MONITOR_BIND_HOST` | `127.0.0.1` | 本地运行监听地址；容器内由 Compose 覆盖 |
| `NPM_REGISTRY` | `https://registry.npmmirror.com/` | 构建时 NPM 镜像源 |

Compose 只把业务端口发布到宿主机回环地址，外部访问需要经过本机反向代理。容器自动添加 `host.docker.internal:host-gateway` 映射，以便访问宿主机上的 Sub2API。数据目录挂载为 Docker 命名卷，容器重建不会丢失数据。

容器内置健康检查：每 30 秒调用 `/healthz`，启动等待 15 秒，连续 3 次失败标记为不健康。

---

## 基座 Sub2API 与单点登录

Provider Monitor 把部署中的 Sub2API 作为"基座实例"。`PROVIDER_MONITOR_AUTH_MODE` 只决定谁来认证 Provider Monitor 管理页面；渠道、分组、倍率、用量、Channel Monitor 和自动化写入始终独立使用基座连接与管理员凭据：

```dotenv
# 容器内实际调用的 API 地址
SUB2API_BASE_URL=http://host.docker.internal:8080

# 管理员浏览器实际访问的地址，用于 iframe 来源白名单和返回链接
SUB2API_PUBLIC_URL=https://sub2api.example.com

SUB2API_ADMIN_TOKEN=
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<Sub2API 管理员密码>

# 可独立选择 local 或 sub2api，不会启停上述联动
PROVIDER_MONITOR_AUTH_MODE=local
```

在 Sub2API 管理后台的"设置 -> 自定义菜单"中添加 Provider Monitor 地址，例如 `https://provider-monitor.example.com`，并把可见性限制为管理员。Sub2API 自定义菜单附带的管理员 Token 会被远端 `/api/v1/auth/me` 校验，然后换成本模块自己的短期会话；不会要求再次输入密码，也不会把上游 Token 写入数据库。

Sub2API 的"系统设置 -> 安全设置 -> 会话绑定"会把访问 Token 绑定到登录浏览器的 IP 和 User-Agent，因此无法由独立部署的 Provider Monitor 服务端验证。使用自定义菜单 SSO 时必须关闭会话绑定，然后退出并重新登录 Sub2API 以建立新会话。如果必须保留会话绑定，请将 `PROVIDER_MONITOR_AUTH_MODE` 改为 `local`，使用 Provider Monitor 独立管理员登录。

HTTPS iframe 会同时设置普通 Cookie 和分区 Cookie，并在 URL Fragment 中返回一个本模块的临时会话令牌作为第三方 Cookie 受限时的兜底。原始 Sub2API Token 在首次请求后立即从地址栏移除。

如果 `SUB2API_BASE_URL` 使用 `host.docker.internal` 或内网域名，必须单独配置浏览器可访问的 `SUB2API_PUBLIC_URL`。需要允许其他前端来源时，在"设置与备份 -> 系统参数"中维护准确的浏览器 Origin。

---

## 分组与倍率对照

1. 先同步供应商，使上游 Key、分组和倍率进入本地资产库。
2. 在"Sub2API 联动"中添加映射，选择基座分组、供应商、Key 和上游分组。
3. Provider Monitor 比较基座分组有效倍率与供应商上游分组倍率，并按全局或映射级容差标记结果。
4. 可创建"Sub2API 倍率偏差"告警规则。每条分组映射独立触发和恢复，系统每 5 分钟刷新一次，也可在页面手动刷新。

自动映射查找名称中包含供应商名的 Sub2API API Key 账号，直接为账号关联的每个 Sub2API 分组匹配供应商 Key，不要求分组与渠道建立关系。系统使用脱敏 Key 指纹确认上游 Key。读取账号 Key 需要可执行敏感操作的 Sub2API 管理员会话；当配置账号启用登录 TOTP 或 Sub2API 要求敏感操作 step-up 时，Provider Monitor 会弹出 TOTP 验证框，完成验证后自动重试。配置账号取得的访问/刷新 Token 只保存在内存中并自动轮换；服务重启后可能需要重新完成登录 TOTP。管理员 API Key 不能代替敏感操作 step-up。

检查状态会区分倍率偏差、基座分组缺失、供应商分组缺失、倍率缺失和供应商倍率无效。

---

## 本地启动

```powershell
Set-Location provider-monitor
npm ci
npm start
```

`npm start` 自动读取同级 `.env`。实际监听端口由其中的 `PORT` 决定，默认仅监听 `127.0.0.1`。

本地认证模式首次使用环境变量中的管理员密码。之后可在"设置与备份 -> 管理员安全"中修改密码；新密码只以 scrypt 哈希保存在 SQLite 中，并优先于环境变量中的初始密码。修改成功后，除当前浏览器外的其他管理员会话会立即失效。

`PROVIDER_MONITOR_DATA_DIR` 和 `PROVIDER_MONITOR_DATABASE` 支持相对路径，并始终相对于 `provider-monitor/` 目录解析。统一配置使用 `./data` 和该目录中的数据库文件，因此项目移动到其他目录后无需修改文件路径。

---

## 系统参数

所有启动默认值都集中列在 `provider-monitor/.env`。自动化总开关、浏览器 Origin、私网访问、主机白名单、会话时长、请求限制、默认刷新、数据陈旧阈值、Key 检测并发和数据保留周期也可通过"设置与备份 -> 系统参数"修改；网页保存值持久化在 SQLite `settings` 表中，并在运行时优先于 `.env` 默认值。

监听地址、端口、认证模式、基座 Sub2API 地址、加密密钥、任务队列并发、时区和 Metrics 初始化仍属于启动参数，修改后需要重启服务。

### 运行时参数一览

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROVIDER_MONITOR_SESSION_TTL_MINUTES` | `480` | 管理员会话有效期（分钟） |
| `PROVIDER_MONITOR_QUERY_TIMEOUT_MS` | `15000` | 上游 HTTP 请求超时 |
| `PROVIDER_MONITOR_MAX_RESPONSE_BYTES` | `2097152` | 上游响应体最大字节 |
| `PROVIDER_MONITOR_CONCURRENCY` | `5` | 全局任务队列并发 |
| `PROVIDER_MONITOR_PROVIDER_CONCURRENCY` | `2` | 单供应商并发上限 |
| `PROVIDER_MONITOR_KEY_HEALTH_CONCURRENCY` | `3` | Key 健康检测并发 |
| `PROVIDER_MONITOR_REFRESH_MINUTES` | `15` | 默认同步间隔 |
| `PROVIDER_MONITOR_STALE_MINUTES` | `60` | 数据陈旧阈值 |
| `PROVIDER_MONITOR_RAW_SNAPSHOT_RETENTION_DAYS` | `30` | 原始快照保留天数 |
| `PROVIDER_MONITOR_SNAPSHOT_RETENTION_DAYS` | `180` | 聚合快照保留天数 |
| `PROVIDER_MONITOR_JOB_RETENTION_DAYS` | `90` | 任务记录保留天数 |
| `PROVIDER_MONITOR_AUDIT_RETENTION_DAYS` | `365` | 审计日志保留天数 |
| `PROVIDER_MONITOR_NOTIFICATION_RETENTION_DAYS` | `180` | 通知记录保留天数 |
| `PROVIDER_MONITOR_ALLOWED_HOSTS` | 空 | 私网主机限制名单（逗号分隔；留空放行全部） |
| `PROVIDER_MONITOR_ALLOW_PRIVATE_NETWORKS` | `false` | 非空名单存在时，是否忽略名单并允许全部私网访问 |
| `PROVIDER_MONITOR_ALLOWED_ORIGINS` | 空 | 额外 CORS Origin（逗号分隔） |
| `PROVIDER_MONITOR_METRICS_ENABLED` | `true` | 启用 Prometheus 指标 |
| `PROVIDER_MONITOR_AUTOMATION_ENABLED` | `false` | 允许真实自动化 |
| `PROVIDER_MONITOR_LOG_LEVEL` | `info` | 日志级别 |
| `PROVIDER_MONITOR_TIMEZONE` | `Asia/Shanghai` | 定时任务时区 |

---

## 定时任务

| 调度时间 | 任务 |
|---|---|
| 每分钟 | 检查到期的供应商并入队同步、告警评估 |
| 每 5 分钟 | 刷新 Sub2API 映射比较 |
| 每天 02:25 | 价格目录同步 |
| 每天 03:17 | 快照数据保留清理 |
| 每天 03:35 | 远端备份 |
| 每天 03:45 | 自动对账 |
| 每天 09:15 | 到期供应商自动签到 |

所有定时任务使用 `PROVIDER_MONITOR_TIMEZONE` 配置的时区。

---

## 私有网络供应商

已知云元数据地址始终拒绝访问。`PROVIDER_MONITOR_ALLOWED_HOSTS` 或"设置与备份 -> 系统参数"中的私网主机限制留空时，其他私网、回环和链路本地地址全部放行；填写主机后，仅允许名单中的私网主机。开启"忽略私网主机限制"可在保留名单的同时临时允许全部私网访问。

---

## 自动化写入

自动化必须同时满足以下条件才会真实修改 Sub2API 渠道：

1. "设置与备份 -> 系统参数"中的"允许真实自动化"已开启
2. 规则的"演练模式"已关闭
3. 当前存在有效的管理员 SSO 会话，或配置了 `SUB2API_ADMIN_TOKEN`，或可用的 `ADMIN_EMAIL` / `ADMIN_PASSWORD`

每次动作保存变更前后的渠道状态。服务端强制执行连续命中、冷却、每日动作上限和 Contract 变化暂停；备用映射切换与渠道启停均可回滚。

SSO Token 和配置账号取得的 Token 都只保存在内存中，刷新 Token 会按 Sub2API 协议轮换。需要无人值守地持续执行倍率检查、告警或自动化时，建议配置具备所需权限的 `SUB2API_ADMIN_TOKEN`；也可以使用管理员邮箱密码，启用 TOTP 时需在服务重启后完成一次交互验证。

邮件通知的 SMTP `host`、`port`、`secure`、`user` 和 `from` 写入邮件通知通道的配置 JSON，密码写入同一通道的凭据 JSON。旧版 `PROVIDER_MONITOR_SMTP_*` 环境变量仍可作为兼容回退，但新部署不再需要配置。

---

## 远端备份

在"设置与备份"中配置目标。配置和凭据必须分开填写：

- 本地目录配置：`{"directory":"D:\\provider-monitor-backups"}`
- WebDAV 配置：`{"url":"https://dav.example/backups/"}`，凭据：`{"username":"...","password":"..."}`
- S3 配置：`{"endpoint":"https://s3.example","bucket":"backups","region":"us-east-1","prefix":"provider-monitor","pathStyle":true}`
- S3 凭据：`{"accessKeyId":"...","secretAccessKey":"...","sessionToken":"..."}`

每天 `03:35` 按配置时区执行远端备份；也可以手动测试单个目标。网络目标沿用 DNS 固定和私网白名单策略。

---

## 项目架构

```
provider-monitor/
├── compose.yaml                # Docker Compose 编排
├── Dockerfile                  # 多阶段构建（node:20-bookworm-slim）
├── .env.example                # 环境变量模板
├── package.json                # Node.js ≥ 20.18.1, Express 5
├── grafana/                    # Grafana 示例 Dashboard
├── public/                     # 前端静态资源（SPA）
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── src/
│   ├── server.js               # 入口：Express 应用、路由、定时任务
│   ├── config.js               # 环境变量解析与校验
│   ├── auth.js                 # 认证服务（SSO / 本地密码）
│   ├── metrics.js              # Prometheus 指标收集
│   ├── errors.js               # 统一错误类型
│   ├── adapters/               # 供应商适配器
│   │   ├── registry.js         # 适配器注册表
│   │   ├── base.js             # 基础适配器接口
│   │   ├── sub2api.js          # Sub2API 适配器
│   │   ├── one-api-family.js   # New API / One API / One Hub / Done Hub / Veloera
│   │   ├── deepseek.js         # DeepSeek
│   │   ├── openrouter.js       # OpenRouter
│   │   ├── litellm.js          # LiteLLM Proxy
│   │   ├── voapi-v2.js         # VoAPI v2
│   │   └── custom.js           # 自定义适配器
│   ├── db/
│   │   └── index.js            # SQLite Schema（版本 8）与迁移
│   ├── http/
│   │   ├── client.js           # 带 SSRF 防护的 HTTP 客户端
│   │   ├── safe-fetch.js       # 安全请求封装
│   │   └── pinned-dispatcher.js # DNS 固定分发器
│   ├── repositories/
│   │   └── provider-repository.js  # 供应商数据访问层
│   ├── security/
│   │   ├── encryption.js       # AES-256-GCM 加解密、scrypt 密码哈希
│   │   ├── ssrf-guard.js       # DNS 解析与私网/元数据端点拦截
│   │   └── redaction.js        # 敏感信息脱敏
│   └── services/
│       ├── sync-service.js     # 供应商同步引擎
│       ├── query-service.js    # 数据查询与聚合
│       ├── alert-service.js    # 告警规则评估
│       ├── notification-service.js  # 多渠道通知下发
│       ├── automation-service.js    # Sub2API 渠道自动化
│       ├── analysis-service.js # 趋势分析与异常检测
│       ├── mapping-service.js  # Sub2API 分组映射与倍率比较
│       ├── key-health-service.js    # Key 健康检测
│       ├── catalog-service.js  # 价格目录同步
│       ├── checkin-service.js  # 供应商自动签到
│       ├── credential-service.js    # 凭据轮换与管理
│       ├── transfer-service.js # 数据导入导出
│       ├── backup-service.js   # 远端备份
│       ├── retention-service.js # 数据保留与清理
│       ├── detection-service.js # 供应商类型探测
│       ├── sub2api-admin-client.js  # Sub2API 管理 API 客户端
│       ├── job-queue.js        # 并发任务队列
│       └── group-store.js      # 分组缓存
└── tests/                      # Node.js 内置测试运行器
```

---

## 测试

```powershell
npm test
```

使用 Node.js 内置 test runner，串行执行。
