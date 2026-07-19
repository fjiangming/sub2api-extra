# Sub2API Extra: 独立账号管理模块

这是一个为 Sub2API 系统开发的独立账号管理页面。它旨在作为 Sub2API 的补充，允许普通管理员或多用户环境下添加和管理**自己的**账号，同时与 Sub2API 原生代码**完全解耦**，无惧原项目后续更新。

## ✨ 核心特性

- **完全解耦**：作为一个独立的微服务运行，不修改 Sub2API 的任何原始代码。
- **无缝集成**：完美兼容 Sub2API 的"自定义菜单"功能，通过 iframe 嵌入。
- **UI 风格统一**：样式和主题完全参考 Sub2API，支持亮/暗色主题，跟随原平台自动切换。
- **用户隔离**：
  - 添加账号时，账号名称会自动增加 `{username}-` 前缀。
  - 在 `notes` (备注) 字段隐式增加 `[added-by:{user_id}]` 标签。
  - 列表页面只会展示**当前登录用户**自己添加的账号。
- **OAuth 授权支持**：普通用户可直接通过 OAuth 流程（生成授权链接 → 登录 → 回调换取凭据）添加账号，无需管理员手动操作。
- **全平台支持**：支持 Anthropic, OpenAI, Gemini, Antigravity 等平台，涵盖 OAuth, API Key, Setup Token 等全量鉴权类型。
- **零额外存储**：后端服务仅做 API 代理和过滤逻辑，真正的账号数据原封不动写入 Sub2API 数据库中（网关调度完全不受影响）。

---

## 📋 前置条件

使用本模块前，请确保满足以下条件：

### 必需条件

| 条件 | 说明 |
|------|------|
| **Sub2API 已正常运行** | 本模块依赖 Sub2API 后端 API，请确保 Sub2API 可正常访问 |
| **Sub2API 管理员账号** | OAuth 代理功能需要配置管理员邮箱和密码（见下方环境变量说明） |
| **Docker 或 Node.js** | 选择其一作为运行环境 |

### 环境变量

| 变量名 | 必需 | 默认值 | 说明 |
|--------|:----:|--------|------|
| `ACCOUNT_MANAGER_IMAGE` | ❌ | `ghcr.io/fjiangming/sub2api-extra:latest` | Compose 使用的预构建镜像 |
| `ACCOUNT_MANAGER_CONTAINER_NAME` | ❌ | `sub2api-account-manager` | 容器名称 |
| `ACCOUNT_MANAGER_RESTART_POLICY` | ❌ | `unless-stopped` | 容器重启策略 |
| `ACCOUNT_MANAGER_DATA_PATH` | ❌ | `./data` | 宿主机扩展设置目录，相对于本模块 |
| `ACCOUNT_MANAGER_PORT` | ❌ | `9870` | Compose 映射的宿主机端口 |
| `NPM_REGISTRY` | ❌ | — | 源码构建使用的 npm registry |
| `SUB2API_BASE_URL` | ✅ | `http://localhost:8080` | Sub2API 后端地址（从容器内可达） |
| `ADMIN_EMAIL` | ✅ | `admin@sub2api.local` | Sub2API **管理员**邮箱，用于 OAuth 代理 |
| `ADMIN_PASSWORD` | ✅ | *(空)* | Sub2API **管理员**密码，用于 OAuth 代理 |
| `PORT` | ❌ | `3100` | 本服务监听端口 |
| `EXT_SECRET` | ❌ | *(内置默认)* | 扩展配置加密密钥 |

#### 🔐 配置方式 (推荐)

所有 Compose 参数和应用运行参数统一放在与本 README 同级的 `account-manager/.env`。首次部署从安全模板创建：

```bash
cp account-manager/.env.example account-manager/.env
```

`.env` 已加入 `.gitignore`，不会把真实凭据提交到公开仓库；`.env.example` 会被 Git 跟踪。Docker Compose 和 `npm start` 都只读取实际 `.env`。

### ⚠️ 为什么需要管理员凭据？

Sub2API 的 OAuth 相关接口（生成授权链接、交换授权码等）受管理员权限保护。为了让普通用户也能使用 OAuth 流程添加账号，本模块的后端会使用管理员身份代理这些请求。

**安全性说明：**

- 管理员凭据仅存放在**服务器端环境变量**中，不会出现在前端代码或浏览器中
- 管理员 token 仅在 `server.js` 进程内存中缓存，**从未传输给浏览器**
- 代理范围严格限定在 OAuth 流程相关的几个端点（生成链接、交换码），**不会**暴露账号 CRUD、系统设置等管理接口
- 这是标准的 Backend-for-Frontend (BFF) 代理模式，与业界常规做法一致

> 如果你只需要手动粘贴 Session Key / API Key 等方式添加账号，不使用 OAuth 授权流程，则**可以不配置** `ADMIN_EMAIL` 和 `ADMIN_PASSWORD`，其余功能不受影响。

---

## 🚀 部署指南

### 环境要求
- Node.js 20.6+ (如果你想直接运行)
- Docker & Docker Compose (推荐)

### 方式一：使用 Docker 部署 (推荐)

1. 进入项目目录：
   ```bash
   cd sub2api-extra
   ```

2. 编辑 `account-manager/.env`，确认 `SUB2API_BASE_URL`、`ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 正确。

3. 配置 Sub2API 地址：

   > ⚠️ **注意**：Docker 容器内的 `127.0.0.1` 指的是容器自身，而非宿主机。如果 Sub2API 部署在同一台机器上，需要通过 `host.docker.internal` 来访问宿主机端口。Linux 服务器必须搭配 `extra_hosts: ["host.docker.internal:host-gateway"]` 配置才能生效（Mac/Windows 的 Docker Desktop 默认已支持）。

4. 启动服务：
   ```bash
   docker compose up -d --build account-manager
   ```
   服务将默认在 `9870` 端口运行。

### 方式二：直接拉取镜像部署 (无需源码)

根 Compose 默认引用 `account-manager/.env` 中的预构建镜像：

```bash
docker compose pull account-manager
docker compose up -d --no-build account-manager
```

**💡 关于数据安全与更新的说明：**
账号数据通过 API 持久化在原有的 Sub2API 数据库中；本模块只在 `account-manager/data/extension_settings.json` 保存扩展设置。Compose 会将该目录挂载到容器的 `/app/data`，因此拉取新镜像并重建容器不会丢失这些设置。

### 方式三：本地 Node.js 部署

1. 安装依赖：
   ```bash
   cd sub2api-extra/account-manager
   npm ci
   ```

2. 编辑同级 `.env` 后运行：
   ```bash
   npm start
   ```

---

## ⚙️ 在 Sub2API 中集成

部署成功后，你需要在 Sub2API 管理后台配置。

1. 登录你的 Sub2API 管理后台。
2. 导航到 **设置 (Settings) -> 自定义菜单 (Custom Menu)**。
3. 点击 **添加自定义菜单**。
4. 填写如下信息：
   - **标签 (Label)**: 账号管理 (或我的账号)
   - **URL**: `http://<部署sub2api-extra的IP或域名>:9870`  (请确保用户浏览器能访问这个URL)
   - **可见性 (Visibility)**: 可设为 `all`（所有用户可见），本模块已内置用户隔离机制
5. 保存设置。

此时，左侧边栏就会出现一个"账号管理"菜单，点击即可无缝嵌入加载这个独立服务。

---

## 🛠 开发与修改

前端页面均为纯纯的原生 HTML/CSS/JS (Vanilla JS)，无须复杂的编译和构建，修改即生效：

- `server.js`: 代理接口、身份校验、OAuth 代理和权限隔离逻辑。
- `public/index.html`: 整个页面的 UI 骨架和弹窗。
- `public/style.css`: 样式表（内含暗黑模式定义）。
- `public/app.js`: 所有核心业务逻辑（API调用、列表渲染、OAuth流程、按平台切换表单）。
- `public/patch/group-filter.js`: OpenAI 分组过滤补丁（通过 Nginx 注入到 Sub2API 前端）。

---

## 🔒 OpenAI 分组过滤补丁（Nginx 注入）

### 功能说明

在 Sub2API 的 **API 密钥创建/编辑** 页面中，让每个用户在选择 `openai` 平台分组时，**只能看到与自己邮箱同名的分组**，其他平台的分组不受影响。

- ✅ **完全解耦**：不修改 Sub2API 任何源码，升级 Sub2API 零冲突
- ✅ **自动生效**：所有用户自动应用，无需安装浏览器插件
- ✅ **纯前端过滤**：通过 Nginx 注入一段 JS 脚本，拦截 API 响应进行过滤

### 原理

1. Sub2API-Extra 提供一个静态 JS 补丁文件 `/patch/group-filter.js`
2. Nginx 使用 `sub_filter` 指令在 Sub2API 前端页面的 `</head>` 前注入 `<script>` 标签
3. 该脚本 monkey-patch 浏览器的 `fetch` 方法，拦截 `/api/v1/groups/available` 接口的响应
4. 对 `platform === "openai"` 的分组，仅保留 `name` 等于当前用户邮箱的项

### 前提条件

- 管理员需为每个用户创建一个 **platform 为 `openai`、名称为用户邮箱** 的分组（Sub2API-Extra 在用户首次访问时会自动创建）
- Sub2API 和 Sub2API-Extra 均通过 Nginx 反向代理

### Nginx 配置

假设你的 Nginx 配置中：
- Sub2API 运行在 `127.0.0.1:9000`（域名 `epoint2api.example.com`）
- Sub2API-Extra 运行在 `127.0.0.1:9870`

修改 Sub2API 对应的 Nginx server 块：

```nginx
server {
    listen 80;
    server_name epoint2api.example.com;

    # ── 补丁 JS 静态文件，路由到 Sub2API-Extra ──
    location /patch/ {
        proxy_pass http://127.0.0.1:9870;
        proxy_set_header Host $host;
    }

    # ── Sub2API 主服务 ──
    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 关闭上游压缩（sub_filter 不支持处理 gzip 内容）
        proxy_set_header Accept-Encoding "";

        # 在 </head> 前注入补丁脚本
        sub_filter '</head>' '<script src="/patch/group-filter.js"></script></head>';
        sub_filter_once on;
        sub_filter_types text/html;
    }
}
```

> ⚠️ **注意**：`sub_filter` 需要 Nginx 的 `ngx_http_sub_module` 模块，该模块在官方 Nginx 及大多数发行版中**默认包含**。如果使用极简编译版本，请确认已启用。

### 验证

配置完成并重启 Nginx 后：

1. 打开 Sub2API 前端页面，按 `F12` 打开浏览器开发者工具
2. 在 **Console** 面板中应能看到：`[GroupFilter] OpenAI 分组过滤补丁已加载`
3. 在 **Network** 面板中查看 `groups/available` 请求的响应，确认 openai 分组已被过滤
4. 进入 **API 密钥** 页面 → 创建密钥 → 分组下拉列表中，openai 平台应只显示与你邮箱同名的分组
