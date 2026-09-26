# Sub2API Extra

Sub2API 的可插拔扩展服务集合。每个功能作为独立模块运行，通过 Docker Compose 统一编排，按需启用。

## 📦 功能模块

| 模块 | 预构建镜像 | 默认端口 | 文档 |
|------|-----------|:--------:|------|
| **账号管理** | `ghcr.io/fjiangming/sub2api-extra:latest` | `9870` | [README](account-manager/README.md) |
| **供应商监控** | `ghcr.io/fjiangming/sub2api-extra:provider-monitor-latest` | `9871` | [README](provider-monitor/README.md) |
| **运营数据与存储管理中心** | `ghcr.io/fjiangming/sub2api-extra:operations-center-latest` | `9872` | [README](operations-center/README.md) |
| **降智检测** | `ghcr.io/fjiangming/sub2api-extra:degradation-detector-latest` | `9873` | [README](degradation-detector/README.md) |

> 💡 后续新增的功能模块会持续补充到此表中。

镜像支持 `linux/amd64` 与 `linux/arm64`，托管在 GitHub Container Registry（公开包），部署机器可匿名拉取。

---

## 🚀 快速开始

> **前置要求**：Docker Compose **≥ 2.20.0**（模块化编排使用了 `include` 指令）。

### 1. 创建部署目录

在服务器上创建以下最小目录结构（只需要配置文件，不需要源码）：

```
sub2api-extra/
├── docker-compose.yml
├── compose.services.env
├── account-manager/
│   ├── compose.yaml
│   └── .env
├── provider-monitor/
│   ├── compose.yaml
│   └── .env
├── operations-center/
│   ├── compose.yaml
│   └── .env
└── degradation-detector/
    ├── compose.yaml
    └── .env
```

```bash
mkdir -p sub2api-extra/account-manager sub2api-extra/provider-monitor sub2api-extra/operations-center sub2api-extra/degradation-detector
cd sub2api-extra
```

### 2. 编写编排文件

#### `docker-compose.yml`（根目录入口）

```yaml
name: sub2api-extra

include:
  - ./account-manager/compose.yaml
  - ./provider-monitor/compose.yaml
  - ./operations-center/compose.yaml
  - ./degradation-detector/compose.yaml
```

#### `compose.services.env`（选择要启用的服务）

```dotenv
# 逗号分隔的服务名；不需要的模块注释掉或去掉即可
COMPOSE_PROFILES=account-manager,provider-monitor,operations-center,degradation-detector
```

> 只部署其中一个模块时，保留对应名称即可，例如 `COMPOSE_PROFILES=provider-monitor`。

#### `account-manager/compose.yaml`

```yaml
services:
  account-manager:
    profiles: [account-manager]
    image: ${ACCOUNT_MANAGER_IMAGE:-ghcr.io/fjiangming/sub2api-extra:latest}
    container_name: ${ACCOUNT_MANAGER_CONTAINER_NAME:-sub2api-account-manager}
    restart: ${ACCOUNT_MANAGER_RESTART_POLICY:-unless-stopped}
    ports:
      - "127.0.0.1:${ACCOUNT_MANAGER_PORT:-9870}:${PORT:-3100}"
    environment:
      ACCOUNT_MANAGER_BIND_HOST: "0.0.0.0"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file:
      - path: ./.env
        required: true
    volumes:
      - ${ACCOUNT_MANAGER_DATA_PATH:-./data}:/app/data
```

#### `provider-monitor/compose.yaml`

```yaml
services:
  provider-monitor:
    profiles: [provider-monitor]
    image: ${PROVIDER_MONITOR_IMAGE:-ghcr.io/fjiangming/sub2api-extra:provider-monitor-latest}
    container_name: ${PROVIDER_MONITOR_CONTAINER_NAME:-sub2api-provider-monitor}
    restart: ${PROVIDER_MONITOR_RESTART_POLICY:-unless-stopped}
    ports:
      - "127.0.0.1:${PROVIDER_MONITOR_PORT:-9871}:${PORT:-9871}"
    environment:
      PROVIDER_MONITOR_BIND_HOST: "0.0.0.0"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file:
      - path: ./.env
        required: true
    volumes:
      - provider-monitor-data:/app/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:${PORT:-9871}/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

volumes:
  provider-monitor-data:
    name: ${PROVIDER_MONITOR_DATA_VOLUME:-sub2api-extra_provider-monitor-data}
```

#### `operations-center/compose.yaml`

```yaml
services:
  operations-center:
    profiles: [operations-center]
    image: ${OPERATIONS_CENTER_IMAGE:-ghcr.io/fjiangming/sub2api-extra:operations-center-latest}
    container_name: ${OPERATIONS_CENTER_CONTAINER_NAME:-sub2api-operations-center}
    restart: ${OPERATIONS_CENTER_RESTART_POLICY:-unless-stopped}
    ports:
      - "127.0.0.1:${OPERATIONS_CENTER_PORT:-9872}:9872"
    environment:
      OPERATIONS_CENTER_BIND_HOST: "0.0.0.0"
      OPERATIONS_CENTER_PORT: "9872"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file:
      - path: ./.env
        required: true
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:9872/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

#### `degradation-detector/compose.yaml`

```yaml
services:
  degradation-detector:
    profiles: [degradation-detector]
    image: ghcr.io/fjiangming/sub2api-extra:degradation-detector-latest
    container_name: sub2api-degradation-detector
    restart: unless-stopped
    ports:
      - "127.0.0.1:9873:9873"
    environment:
      NODE_ENV: "production"
      PORT: "9873"
      DEGRADATION_DETECTOR_BIND_HOST: "0.0.0.0"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file:
      - path: ./.env
        required: true
    volumes:
      - degradation-detector-data:/app/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:9873/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

volumes:
  degradation-detector-data:
    name: sub2api-extra_degradation-detector-data
```

### 3. 配置模块环境变量

每个模块只读取自己目录中的 `.env`，不同模块的配置互不影响。

#### `account-manager/.env`

```dotenv
# Compose 部署参数
ACCOUNT_MANAGER_IMAGE=ghcr.io/fjiangming/sub2api-extra:latest
ACCOUNT_MANAGER_CONTAINER_NAME=sub2api-account-manager
ACCOUNT_MANAGER_RESTART_POLICY=unless-stopped
ACCOUNT_MANAGER_DATA_PATH=./data
ACCOUNT_MANAGER_PORT=9870

# 运行参数
NODE_ENV=production
PORT=3100
ACCOUNT_MANAGER_BIND_HOST=127.0.0.1

# 扩展接口密钥（正式部署建议设置独立随机值）
EXT_SECRET=

# 基座 Sub2API 地址与管理员账号
SUB2API_BASE_URL=http://host.docker.internal:8080
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=替换为你的管理员密码
```

#### `provider-monitor/.env`

```dotenv
# Compose 部署参数
PROVIDER_MONITOR_IMAGE=ghcr.io/fjiangming/sub2api-extra:provider-monitor-latest
PROVIDER_MONITOR_CONTAINER_NAME=sub2api-provider-monitor
PROVIDER_MONITOR_RESTART_POLICY=unless-stopped
PROVIDER_MONITOR_PORT=9871
PROVIDER_MONITOR_DATA_VOLUME=sub2api-extra_provider-monitor-data

# 运行参数
NODE_ENV=production
PORT=9871
PROVIDER_MONITOR_BIND_HOST=127.0.0.1

# 数据存储（容器内路径）
PROVIDER_MONITOR_DATA_DIR=./data
PROVIDER_MONITOR_DATABASE=./data/provider-monitor.db

# 必填：加密密钥，至少 32 个字符，部署后不可更改
PROVIDER_MONITOR_SECRET=替换为至少32个字符的随机字符串

# Provider Monitor 登录方式：local（本地账号）或 sub2api（基座管理员 SSO）
# 该选项不控制基座联动功能。
PROVIDER_MONITOR_AUTH_MODE=local
PROVIDER_MONITOR_LOCAL_ADMIN_USER=admin
PROVIDER_MONITOR_LOCAL_ADMIN_PASSWORD=替换为你的本地管理员密码

# 基座 Sub2API；local 模式下仍需独立配置以下连接与管理员凭据
SUB2API_BASE_URL=http://host.docker.internal:8080
SUB2API_PUBLIC_URL=http://你的服务器地址:8080
SUB2API_ADMIN_TOKEN=
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=替换为你的 Sub2API 管理员密码
```

#### `operations-center/.env`

```dotenv
OPERATIONS_CENTER_IMAGE=ghcr.io/fjiangming/sub2api-extra:operations-center-latest
OPERATIONS_CENTER_CONTAINER_NAME=sub2api-operations-center
OPERATIONS_CENTER_RESTART_POLICY=unless-stopped
OPERATIONS_CENTER_PORT=9872

NODE_ENV=production
OPERATIONS_CENTER_AUTH_MODE=sub2api
# local 模式才需要以下独立账号密码
OPERATIONS_CENTER_ADMIN_USER=admin
OPERATIONS_CENTER_ADMIN_PASSWORD=

# 首次部署可留空，登录后在“系统设置”一键创建受限角色并连接
SUB2API_DATABASE_URL=
SUB2API_DATABASE_SSL=disable
SUB2API_TIMEZONE=Asia/Shanghai
FINANCE_TIMEZONE=Asia/Shanghai

# 用于检查版本并复用 Sub2API 原生备份能力
SUB2API_BASE_URL=http://host.docker.internal:8080
SUB2API_PUBLIC_URL=https://sub2api.example.com
# 从 Sub2API 管理员自定义菜单进入时可全部留空；无人值守任务建议配置 Token 或账号密码
SUB2API_ADMIN_TOKEN=
ADMIN_EMAIL=
ADMIN_PASSWORD=

# 默认只读；系统设置可以创建独立受限维护角色并启用清理
OPERATIONS_CENTER_ENABLE_CLEANUP=false
SUB2API_MAINTENANCE_DATABASE_URL=
OPERATIONS_CENTER_REQUIRE_FRESH_BACKUP=true
```

运营中心数据库连接、权限初始化、依赖检查和清理计划均可在页面完成。若服务器上的运营中心容器不能通过 `host.docker.internal:8080` 访问 Sub2API，请把 `SUB2API_BASE_URL` 改为与 `SUB2API_PUBLIC_URL` 相同的公开 HTTPS 地址；新版的认证与只读请求也会在内部地址发生连接故障时自动回退到该公开地址。详见[部署与操作手册](operations-center/docs/deployment-operations.md)。

#### `degradation-detector/.env`

```dotenv
SUB2API_BASE_URL=http://host.docker.internal:8080
```

被检平台、检测题、分组专用 Key 和每天固定检测时间均由管理员在独立管理页维护；`/results` 是无管理入口和检测按钮的只读结果页，`/admin/config` 由服务端实时限制为管理员访问。两个 Sub2API 自定义菜单的地址、凭据加密及文件预览说明见[降智检测 README](degradation-detector/README.md)。

> 完整参数说明请参阅各模块的 `.env.example` 或模块 README。

### 4. 拉取镜像并启动

```bash
docker compose --env-file compose.services.env pull
docker compose --env-file compose.services.env up -d --no-build --remove-orphans
```

查看当前启用的服务：

```bash
docker compose --env-file compose.services.env config --services
```

> ⚠️ Docker 容器内的 `127.0.0.1` 指向容器自身。如果 Sub2API 在宿主机上运行，请将地址配置为 `host.docker.internal`（已通过 `extra_hosts` 预配置）。

### 5. 停止服务

```bash
docker compose --env-file compose.services.env down
```

---

## 🔄 更新镜像

```bash
docker compose --env-file compose.services.env pull
docker compose --env-file compose.services.env up -d --no-build --pull never --remove-orphans
docker image prune -f  # (可选) 清理旧镜像
```

`docker compose pull` 只更新本地镜像，不会自动替换正在运行的容器；后续的 `up -d` 会在镜像变化时重建容器，并保留绑定目录和命名卷中的数据。

### 固定版本

如需固定版本而不是跟随 `latest`，账号管理、供应商监控和运营中心修改对应模块 `.env` 中的镜像地址；降智检测直接修改 `degradation-detector/compose.yaml` 的 `image`：

```dotenv
# account-manager/.env
ACCOUNT_MANAGER_IMAGE=ghcr.io/fjiangming/sub2api-extra:1.2.3

# provider-monitor/.env
PROVIDER_MONITOR_IMAGE=ghcr.io/fjiangming/sub2api-extra:provider-monitor-1.2.3

# operations-center/.env
OPERATIONS_CENTER_IMAGE=ghcr.io/fjiangming/sub2api-extra:operations-center-1.2.3

# degradation-detector/compose.yaml
image: ghcr.io/fjiangming/sub2api-extra:degradation-detector-1.2.3
```

---

## ⚙️ 模块配置参考

| 模块 | 参数文件 | 详细文档 |
|------|----------|----------|
| 账号管理 | `account-manager/.env` | [账号管理 README](account-manager/README.md) |
| 供应商监控 | `provider-monitor/.env` | [供应商监控 README](provider-monitor/README.md) |
| 运营数据与存储管理中心 | `operations-center/.env` | [运营中心 README](operations-center/README.md) |
| 降智检测 | `degradation-detector/.env` | [降智检测 README](degradation-detector/README.md) |

修改连接环境变量后需重建容器；降智检测页面内的业务配置保存后立即生效：

```bash
docker compose --env-file compose.services.env up -d --no-build --remove-orphans
```

---

## 🐳 Docker 镜像自动构建

仓库中的 [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) 会构建四个模块并发布到同一个公开 GHCR 包：

- 推送到 `main` 或 `master`：构建并推送分支标签和提交 SHA 标签；默认分支同时更新 `latest`、`provider-monitor-latest`、`operations-center-latest`、`degradation-detector-latest`。
- 推送 `v*.*.*` 标签：额外生成四个模块的版本标签，例如 `1.2.3`、`provider-monitor-1.2.3`、`operations-center-1.2.3`、`degradation-detector-1.2.3`。
- Pull Request：只执行双架构构建校验，不推送镜像。
- Actions 页面可通过 `workflow_dispatch` 手动触发。

> 只有推送到上述分支或版本标签后才会发布镜像。功能分支上的普通 push 不会发布；合并到 `main` 后会自动构建。

---

## 🧩 新增功能模块指南

想要添加新的扩展功能？按以下步骤操作：

### 1. 创建模块目录和 Compose 定义

```bash
mkdir my-new-feature
```

在目录中创建 `.env` 和 `compose.yaml`，遵循与现有模块一致的结构：

```yaml
# my-new-feature/compose.yaml
services:
  my-new-feature:
    profiles: [my-new-feature]          # ← 声明 profile 名
    image: ${MY_NEW_FEATURE_IMAGE:-ghcr.io/your-org/your-image:latest}
    container_name: sub2api-my-new-feature
    restart: unless-stopped
    ports:
      - "127.0.0.1:${MY_NEW_FEATURE_PORT:-9872}:3000"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file: ./.env
    volumes:
      - ./data:/app/data
```

### 2. 在根 Compose 中注册

```yaml
include:
  - ./account-manager/compose.yaml
  - ./provider-monitor/compose.yaml
  - ./my-new-feature/compose.yaml
```

### 3. 启用并启动

在 `compose.services.env` 中添加模块名后拉取并启动：

```dotenv
COMPOSE_PROFILES=account-manager,provider-monitor,my-new-feature
```

---

## 📖 各模块详细文档

- [账号管理模块](account-manager/README.md) — 独立账号管理页面，OAuth 授权代理，用户隔离
- [供应商监控模块](provider-monitor/README.md) — 供应商资产、基座渠道倍率对照、告警与自动化

---

## 📄 License

请参阅各模块目录中的 LICENSE 文件。
