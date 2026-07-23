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
| **倍率对照** | 基座 Sub2API 渠道/分组目录、供应商上游分组倍率、充值倍率、综合倍率和偏差预警 |
| **告警** | 低余额、同步失败、数据陈旧、密钥到期、异常与自动化失败告警 |
| **通知** | Webhook、Telegram、Gotify、Bark、邮件、企业微信、Server酱个人微信、钉钉和飞书 |
| **自动化** | Sub2API 渠道启停与备用映射自动化，默认演练模式，支持动作回滚和动作限额 |
| **数据管理** | JSON/CSV/环境变量/All API Hub 兼容导入、配置导出、加密灾备包、SQLite 在线备份、WebDAV 与 S3 兼容备份 |
| **凭据安全** | 凭据先验证后轮换、短期回滚、主 Secret 重加密和敏感操作二次认证 |
| **可观测性** | Prometheus 指标、结构化请求日志、request ID 与示例 Grafana Dashboard |
| **安全防护** | AES-256-GCM 凭据加密、DNS 固定 SSRF 防护、管理员会话和 CSRF 防护 |

配置 JSON、加密灾备包和 SQLite 备份的用途不同：

- **导出配置**包含供应商阈值、充值链接、显式告警规则和通知通道定义，但不会包含密码、SendKey、Webhook Key、Token 或 API Key。导入到空实例时会恢复供应商配置，告警定义可用于核对和迁移；缺少凭据的供应商保持停用。
- **加密灾备包**包含供应商凭据、显式告警规则、通知通道及通道凭据，适合跨实例迁移。所有凭据由独立灾备密码二次加密；通过灾备恢复接口导入时，供应商级规则会自动关联到新实例中的供应商 ID。
- **SQLite/远端备份**包含完整运行数据，包括告警事件和通知投递历史，适合整实例恢复。

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

如果更新后出现问题，将 `PROVIDER_MONITOR_IMAGE` 改回之前的版本标签，然后重新启动即可。SQLite 数据库包含版本化迁移（当前 Schema 版本 13），**向前兼容但不保证向后兼容**，回滚前建议先备份数据卷：

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
3. Provider Monitor 比较基座分组有效倍率与供应商综合倍率，并按全局或映射级容差标记结果。
4. 可创建"Sub2API 综合倍率偏差"告警规则。每条分组映射独立触发和恢复，系统每 5 分钟刷新一次，也可在页面手动刷新。

充值倍率按“支付 1 单位可获得多少供应商余额”记录，例如 `1:10` 的倍率为 `10`。New API 系列优先读取当前用户的充值报价，Sub2API 账号模式读取支付配置；从未成功获取过倍率时默认按 `1:1` 计算并标注“默认”，可在供应商编辑中手工覆盖。综合倍率按 `供应商分组倍率 / 充值倍率` 计算，分组汇总行选择综合倍率最高的映射。综合倍率差按 `(基座倍率 - 综合倍率) / 综合倍率` 计算，倍率偏差状态和告警也使用该结果。

New API 供应商可在编辑页面启用“动态路由倍率”。同步任务只读取历史请求日志，不会发送模型请求；系统按 Key 汇总请求实际命中渠道及 `model_ratio × group_ratio`，支持 P50、P90、Token 加权平均和最近一次四种统计口径。启用后联动比较优先使用动态实测倍率；没有成功样本时标记“动态倍率缺失”，不会回退到名义 `default ×1`。该值表示账户实际扣费倍率，不表示供应商内部采购成本。

“缓存”表示远端本次检查失败，但本地保存过此前成功获取的倍率，因此继续使用最后成功值，避免一次网络故障使综合倍率突然消失。缓存值不是默认值；远端恢复后会在下一次同步时自动更新。

自动映射查找名称中包含供应商名的 Sub2API API Key 账号，直接为账号关联的每个 Sub2API 分组匹配供应商 Key，不要求分组与渠道建立关系。系统使用脱敏 Key 指纹确认上游 Key。读取账号 Key 需要可执行敏感操作的 Sub2API 管理员会话；当配置账号启用登录 TOTP 或 Sub2API 要求敏感操作 step-up 时，Provider Monitor 会弹出 TOTP 验证框，完成验证后自动重试。配置账号取得的访问/刷新 Token 只保存在内存中并自动轮换；服务重启后可能需要重新完成登录 TOTP。管理员 API Key 不能代替敏感操作 step-up。

检查状态会区分综合倍率偏差、基座分组缺失、供应商分组缺失、倍率缺失和供应商倍率无效。

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

## 低余额微信提醒与人工充值

该功能用于“自动检测、微信提醒、人工点击充值”，不执行支付，也不需要部署外部充值服务、配置 Sub2API 渠道 ID 或开启“允许真实自动化”。执行流程如下：

1. 定时同步供应商并保存账户余额快照。
2. 告警服务分别比较账户余额与供应商的一级、二级余额阈值。
3. 每跌破一个已配置阈值就创建一条独立告警。
4. 通知服务向所有已启用的通知通道发送余额、阈值和可点击的充值链接。
5. 余额恢复后发送恢复通知；恢复通知不再附带充值链接。

### 配置供应商

进入“供应商”，逐个编辑需要提醒的供应商：

1. 填写“一级余额阈值”，例如 `20`。
2. 按需填写更低的“二级余额阈值”，例如 `5`。
3. 填写与余额快照一致的“币种”，例如 `USD`。
4. 填写“充值链接”，例如 `https://supplier.example/account/recharge`。
5. 保持“启用定时检查”并保存。

充值链接只接受 HTTP 或 HTTPS。链接会出现在微信通知中，不要在 URL 中放置一次性支付凭据、密码或长期有效 Token。

每个供应商级阈值都会生成一条独立的内置低余额规则。一级阈值触发 `warning` 告警，余额继续下降至二级阈值时再触发一条独立的 `error` 告警；余额回升后，两条告警按各自阈值分别恢复。二级阈值必须小于一级阈值，两个级别持续命中时都按每 `60` 分钟最多重复提醒一次。需要“连续多次低余额才提醒”或自定义冷却时间时，可以在“告警 -> 添加规则”中创建显式 `low_balance` 规则；此时应清空同一供应商的两级余额阈值，避免内置规则和显式规则重复通知。

显式低余额规则选择“全部供应商”时，系统会把同一个阈值和币种原样应用到每个供应商，不会根据充值倍率换算余额，也不会自动转换币种。该选项只适合余额币种和计量口径一致、且可以共用同一余额下限的供应商。币种或充值倍率不同时，应为每个供应商分别创建显式规则，或直接使用供应商编辑页中的独立余额预警值。若按统一的充值成本设置下限，可先把目标储备换算到该供应商的支付币种，再按 `余额阈值 = 支付储备 × 充值倍率` 计算；涉及不同法币时，汇率换算需要在系统外完成。

### 普通个人微信

普通个人微信使用“Server酱（个人微信）”通知通道：

1. 登录 [Server酱](https://sct.ftqq.com)，取得 `SCT...` 开头的 Server酱Turbo SendKey。
2. 进入“告警”，在“通知通道”右上角点击添加按钮。
3. 类型选择“Server酱（个人微信）”，配置 JSON 填写 `{}`。
4. 凭据 JSON 填写：

```json
{
  "sendKey": "SCT你的实际SendKey"
}
```

5. 保存后点击通道右侧的“测试”按钮。SendKey 会作为凭据加密保存，不会出现在普通配置导出中。

### 企业微信

企业微信使用群机器人 Webhook：

1. 在目标企业微信群中添加群机器人并复制 Webhook 地址。
2. 进入“告警”添加通知通道，类型选择“企业微信”。
3. 配置 JSON 填写 `{}`，凭据 JSON 填写：

```json
{
  "webhookUrl": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的机器人Key"
}
```

4. 保存后点击“测试”。Webhook 放在凭据 JSON 中才能加密保存；不要放入配置 JSON。

### 验证提醒

通知通道测试只验证消息能否送达。要验证完整的低余额提醒，可先确认供应商已有最新余额快照且余额低于阈值，然后进入“告警”点击“立即评估”。所有已启用通知通道都会接收告警，目前不支持为单条规则选择独立通道。

### 告警配置备份范围

| 导出方式 | 两级预警值与充值链接 | 显式告警规则 | 通知通道定义 | SendKey / Webhook 凭据 | 告警与投递历史 |
|---|:---:|:---:|:---:|:---:|:---:|
| 配置 JSON | 是 | 是 | 是 | 否 | 否 |
| 加密灾备包 | 是 | 是 | 是 | 是，灾备密码加密 | 否 |
| SQLite 本地/远端备份 | 是 | 是 | 是 | 是，主密钥加密 | 是 |

普通配置 JSON 会对通知配置中的敏感字段和 URL 查询密钥脱敏。加密灾备包恢复时会先恢复供应商，再把供应商级告警规则重新关联到新供应商 ID，并使用目标实例的主密钥重新加密通知凭据。SQLite 本地备份及上传到 WebDAV/S3 的远端备份是数据库在线副本，包含上述全部配置和历史记录。

真正无人值守的自动充值仍需要独立服务持有供应商支付凭据，并通过充值 Webhook 接收请求；这与本节的人工充值提醒是两条独立链路。

---

## 自动化写入

自动化必须同时满足以下条件才会真实修改 Sub2API 渠道：

1. "设置与备份 -> 系统参数"中的"允许真实自动化"已开启
2. 规则的"演练模式"已关闭
3. 当前存在有效的管理员 SSO 会话，或配置了 `SUB2API_ADMIN_TOKEN`，或可用的 `ADMIN_EMAIL` / `ADMIN_PASSWORD`

每次动作保存变更前后的渠道状态。服务端强制执行连续命中、冷却、每日动作上限和 Contract 变化暂停；备用映射切换与渠道启停均可回滚。

Sub2API 渠道 ID 只用于渠道启停、备用映射切换等渠道级动作。充值 Webhook 是供应商账户级动作，不需要渠道 ID，每条规则对每个命中的供应商连接只发送一次：

```json
{
  "event": "provider_monitor.recharge_required",
  "connectionId": "供应商连接 UUID",
  "ruleId": "自动化规则 UUID"
}
```

Webhook 仅负责通知外部系统，Provider Monitor 不保存支付凭据，也不直接调用供应商充值或支付接口。

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

远端备份上传的是 SQLite 在线备份文件，因此会同时包含供应商两级预警值、充值链接、显式告警规则、通知通道、加密通知凭据、告警事件和投递历史。恢复数据库时必须同时保留原 `PROVIDER_MONITOR_SECRET`；缺少或更换该主密钥将无法解密数据库中的供应商和通知凭据。

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
│   │   └── index.js            # SQLite Schema（版本 13）与迁移
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
