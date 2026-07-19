# Sub2API Extra

Sub2API 的可插拔扩展服务集合。每个功能作为独立模块存在于自己的目录中，通过根目录的 `docker-compose.yml` 统一编排，按需启用。

## 📦 功能模块

| 模块 | 目录 | 预构建镜像标签 | 默认端口 |
|------|------|--------------|:--------:|
| **账号管理** | `account-manager/` | `ghcr.io/fjiangming/sub2api-extra:latest` | `9870` |
| **供应商监控** | `provider-monitor/` | `ghcr.io/fjiangming/sub2api-extra:provider-monitor-latest` | `9871` |

> 💡 后续新增的功能模块会持续补充到此表中。

---

## 🚀 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/fjiangming/sub2api-extra.git
cd sub2api-extra
```

### 2. 配置环境变量

每个模块只读取自己目录中的配置：

- `account-manager/.env`：账号管理的镜像、端口、Sub2API 地址和管理员凭据。
- `provider-monitor/.env`：供应商监控的镜像、端口、存储、认证和全部启动参数。

首次部署先从模块模板创建实际配置：

```bash
cp account-manager/.env.example account-manager/.env
cp provider-monitor/.env.example provider-monitor/.env
```

`.env` 含敏感信息并已被 Git 忽略；`.env.example` 只包含安全默认值和占位符，会提交到 Git。现有部署继续编辑各自 `.env` 即可。

根目录的 `compose.services.env` 控制需要部署的服务，服务名使用逗号分隔：

```dotenv
# 只部署供应商监控
COMPOSE_PROFILES=provider-monitor

# 同时部署两个服务
# COMPOSE_PROFILES=account-manager,provider-monitor
```

查看当前配置实际启用的服务：

```bash
docker compose --env-file compose.services.env config --services
```

模块化编排使用 Compose `include`，需要 Docker Compose `2.20.0` 或更高版本。

### 3. 从预构建镜像启动服务（推荐）

```bash
docker compose --env-file compose.services.env pull
docker compose --env-file compose.services.env up -d --no-build --remove-orphans
```

Compose 只会拉取并启动 `compose.services.env` 中配置的服务。修改服务列表后重新执行上述命令即可；`--remove-orphans` 会移除先前启动但本次未选择的服务容器，不会删除其绑定目录或命名卷。镜像支持 `linux/amd64` 与 `linux/arm64`。

账号管理的扩展设置持久化在 `account-manager/data/`，镜像升级和容器重建不会删除该目录。

### 4. 停止服务

```bash
docker compose --env-file compose.services.env down
```

---

## ⚙️ 模块配置

| 模块 | 参数文件 | Compose 定义 | 参数说明 |
|------|----------|--------------|----------|
| 账号管理 | `account-manager/.env` | `account-manager/compose.yaml` | [账号管理 README](account-manager/README.md) |
| 供应商监控 | `provider-monitor/.env` | `provider-monitor/compose.yaml` | [供应商监控 README](provider-monitor/README.md) |

根目录的 `docker-compose.yml` 仅使用 Compose `include` 聚合模块，`compose.services.env` 选择启用的服务。模块 `.env` 同时用于 Compose 插值、容器运行和本地 `npm start`，修改后需重建容器或重启本地进程。

```bash
# 只启动 Provider Monitor
printf 'COMPOSE_PROFILES=provider-monitor\n' > compose.services.env
docker compose --env-file compose.services.env up -d

# 同时启动
printf 'COMPOSE_PROFILES=account-manager,provider-monitor\n' > compose.services.env
docker compose --env-file compose.services.env up -d
```

> ⚠️ Docker 容器内的 `127.0.0.1` 指向容器自身，如果 Sub2API 在宿主机上运行，请使用 `host.docker.internal`。Linux 服务器需在 `docker-compose.yml` 中配合 `extra_hosts` 使用（已预配置）。

---

## 📁 项目结构

```
sub2api-extra/
├── docker-compose.yml        # 仅聚合各模块 Compose 定义
├── compose.services.env      # 根 Compose 需要启用的服务列表
├── README.md                 # 本文件
│
├── account-manager/          # 功能模块：账号管理
│   ├── .env                  # 模块参数（不提交到 Git）
│   ├── .env.example          # 可提交的配置模板
│   ├── compose.yaml          # 模块 Compose 定义
│   ├── Dockerfile
│   ├── server.js
│   ├── package.json
│   ├── data/                 # 扩展设置数据（不提交到 Git）
│   ├── public/               # 前端页面
│   ├── protection/           # 扩展混淆打包工具
│   ├── epoint-gpt-autoreg-extension/  # 浏览器扩展源码
│   ├── scripts/              # 辅助脚本
│   └── README.md             # 模块详细文档
├── provider-monitor/         # 功能模块：供应商监控与基座倍率对照
│   ├── .env                  # 模块参数（不提交到 Git）
│   ├── .env.example          # 可提交的配置模板
│   ├── compose.yaml          # 模块 Compose 定义
│   ├── Dockerfile
│   ├── src/
│   ├── public/
│   ├── data/                 # 本地运行数据（不提交到 Git）
│   └── README.md
```

---

## 🧩 新增功能模块指南

想要添加新的扩展功能？按以下步骤操作：

### 1. 创建模块目录

```bash
mkdir my-new-feature
```

### 2. 编写模块代码和 Dockerfile

在模块目录中编写你的服务代码，并创建独立的 `Dockerfile`。

### 3. 创建模块 `.env`

把镜像、端口、构建参数和运行时参数集中写入 `my-new-feature/.env`，不要放入根目录或其他模块。

### 4. 创建模块 `compose.yaml`

```yaml
services:
  my-new-feature:
    profiles: [my-new-feature]          # ← 声明 profile 名
    build:
      context: .
    container_name: sub2api-my-new-feature
    restart: unless-stopped
    ports:
      - "${MY_NEW_FEATURE_PORT:-9871}:3000"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      - SUB2API_BASE_URL=${SUB2API_BASE_URL:-http://host.docker.internal:8080}
    env_file: ./.env
    volumes:
      - ./data:/app/data
```

### 5. 在根 Compose 中注册

```yaml
include:
  - ./account-manager/compose.yaml
  - ./provider-monitor/compose.yaml
  - ./my-new-feature/compose.yaml
```

### 6. 启动模块

```bash
docker compose up -d my-new-feature
```

---

## 🐳 Docker 镜像自动构建

仓库中的 [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) 会构建两个模块并发布到同一个公开 GHCR 包：

- 推送到 `main` 或 `master`：构建并推送分支标签和提交 SHA 标签；默认分支（当前为 `main`）同时更新 `latest`、`provider-monitor-latest`。
- 推送 `v*.*.*` 标签：额外生成账号管理的版本标签（如 `1.2.3`）和供应商监控标签（如 `provider-monitor-1.2.3`）。
- Pull Request：只执行双架构构建校验，不推送镜像。
- Actions 页面可通过 `workflow_dispatch` 手动触发。

工作流使用仓库自带的 `GITHUB_TOKEN`，并声明 `packages: write`，不需要额外配置 GHCR 密钥。现有 `sub2api-extra` GHCR 包为公开包，因此部署机器可以匿名拉取；若 fork 到其他账号，请确认新包已设为 Public，或先执行 `docker login ghcr.io`。

> 只有推送到上述分支或版本标签后才会发布镜像。功能分支上的普通 push 不会发布；合并到 `main` 后会自动构建。

---

## 🔄 部署与更新

### 从源码构建

```bash
git pull
docker compose --env-file compose.services.env build --pull
docker compose --env-file compose.services.env up -d --no-build --pull never
```

### 使用预构建镜像

```bash
docker compose --env-file compose.services.env pull
docker compose --env-file compose.services.env up -d --no-build --pull never --remove-orphans
docker image prune -f  # (可选) 清理旧镜像
```

`docker compose pull` 只更新本地镜像，不会自动替换正在运行的容器；后续的 `docker compose up -d` 会在镜像变化时重建容器，并保留绑定目录和命名卷中的数据。

如需固定版本而不是跟随 `latest`，分别修改模块 `.env`：

```bash
# account-manager/.env
ACCOUNT_MANAGER_IMAGE=ghcr.io/fjiangming/sub2api-extra:1.2.3

# provider-monitor/.env
PROVIDER_MONITOR_IMAGE=ghcr.io/fjiangming/sub2api-extra:provider-monitor-1.2.3
```

---

## 📖 各模块详细文档

每个功能模块在自己的目录中包含独立的 `README.md`，详细说明功能特性、API 接口、集成方式等：

- [账号管理模块](account-manager/README.md) — 独立账号管理页面，OAuth 授权代理，用户隔离
- [供应商监控模块](provider-monitor/README.md) — 供应商资产、基座渠道倍率对照、告警与自动化

---

## 📄 License

请参阅各模块目录中的 LICENSE 文件。
