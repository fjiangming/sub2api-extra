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
| `SUB2API_BASE_URL` | ✅ | `http://localhost:8080` | Sub2API 后端地址（从容器内可达） |
| `ADMIN_EMAIL` | ✅ | `admin@sub2api.local` | Sub2API **管理员**邮箱，用于 OAuth 代理 |
| `ADMIN_PASSWORD` | ✅ | *(空)* | Sub2API **管理员**密码，用于 OAuth 代理 |
| `PORT` | ❌ | `3100` | 本服务监听端口 |
| `EXT_SECRET` | ❌ | *(内置默认)* | 扩展配置加密密钥 |

#### 🔐 配置方式 (推荐)

本项目提供了一个 `.env.example` 模板文件，你可以直接复制它来创建自己的配置文件。这种方式最安全，因为 `.env` 已经被加入 `.gitignore`，即使误操作也不会把真实凭据提交到公开仓库中。

```bash
cp .env.example .env
```

创建 `.env` 后，你需要使用文本编辑器去修改里面真实的账号与密码。后续运行 Docker 或 Node 服务时，程序将自动读取你在 `.env` 文件里写的配置。

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
- Node.js (如果你想直接运行)
- Docker & Docker Compose (推荐)

### 方式一：使用 Docker 部署 (推荐)

1. 进入项目目录：
   ```bash
   cd sub2api-extra
   ```

2. 创建 `.env` 文件（推荐）或直接修改 `docker-compose.yml`：
   ```bash
   # .env 文件内容
   SUB2API_BASE_URL=http://host.docker.internal:8080
   ADMIN_EMAIL=admin@sub2api.local
   ADMIN_PASSWORD=你的管理员密码
   ```

   > 💡 也可以直接在 `docker-compose.yml` 的 `environment` 中修改，但推荐使用 `.env` 文件来管理敏感信息，并确保 `.env` 不被提交到 Git。

3. 配置 Sub2API 地址：
   
   > ⚠️ **注意**：Docker 容器内的 `127.0.0.1` 指的是容器自身，而非宿主机。如果 Sub2API 部署在同一台机器上，需要通过 `host.docker.internal` 来访问宿主机端口。Linux 服务器必须搭配 `extra_hosts: ["host.docker.internal:host-gateway"]` 配置才能生效（Mac/Windows 的 Docker Desktop 默认已支持）。

4. 启动服务：
   ```bash
   docker compose up -d --build
   ```
   服务将默认在 `9870` 端口运行。

### 方式二：直接拉取镜像部署 (无需源码)

如果你不想拉取源码，可以直接使用预构建的 Docker 镜像部署。

**💡 关于数据安全与更新的说明：**
由于本服务是完全**无状态 (Stateless)** 的设计，没有任何本地数据库（所有账号数据都会通过 API 直接持久化储存在你原有的 Sub2API 数据库中）。因此，**未来每次拉取新镜像重启（`docker pull` + `docker compose up -d`），绝对不会造成任何数据丢失或数据库重置**，请放心更新！

1. 创建一个 `docker-compose.yml` 文件：
   ```yaml
   services:
     account-manager:
       image: ghcr.io/fjiangming/sub2api-extra:latest
       container_name: sub2api-extra
       restart: unless-stopped
       ports:
         - "9870:3100"
       extra_hosts:
         - "host.docker.internal:host-gateway"  # Linux 必须，使容器能访问宿主机
       environment:
         - PORT=3100
         # 改为你的 Sub2API 后端地址（端口号改为你实际的 Sub2API 后端端口）
         - SUB2API_BASE_URL=http://host.docker.internal:9000
         # Sub2API 管理员凭据（OAuth 授权流程必需）
         - ADMIN_EMAIL=admin@sub2api.local
         - ADMIN_PASSWORD=你的管理员密码
       volumes:
         - ./data:/app/data
   ```
2. 在该文件所在目录执行启动服务：
   ```bash
   docker compose up -d
   ```

3. **如何拉取更新：**
   来到 `docker-compose.yml` 所在的目录，运行以下命令即可完成无缝更新（对原生数据库零影响）：
   ```bash
   docker compose pull
   docker compose up -d
   docker image prune -f  # (可选) 清除旧版本闲置镜像以节省空间
   ```

4. **如何完全卸载：**
   如果随后不想使用该独立面板了，执行以下命令即可清理容器及镜像（同样**完全不影响**你加在原有 Sub2API 系统里的任何账号）：
   ```bash
   docker compose down --rmi all
   ```

### 方式三：本地 Node.js 部署

1. 安装依赖：
   ```bash
   cd sub2api-extra
   npm install
   ```

2. 设置环境变量并运行：
   ```bash
   # Windows (CMD)
   set SUB2API_BASE_URL=http://localhost:8080
   set ADMIN_EMAIL=admin@sub2api.local
   set ADMIN_PASSWORD=你的管理员密码
   node server.js
   
   # Linux / macOS
   SUB2API_BASE_URL=http://localhost:8080 \
   ADMIN_EMAIL=admin@sub2api.local \
   ADMIN_PASSWORD=你的管理员密码 \
   node server.js
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
