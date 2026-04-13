# Sub2API Extra: 独立账号管理模块

这是一个为 Sub2API 系统开发的独立账号管理页面。它旨在作为 Sub2API 的补充，允许普通管理员或多用户环境下添加和管理**自己的**账号，同时与 Sub2API 原生代码**完全解耦**，无惧原项目后续更新。

## ✨ 核心特性

- **完全解耦**：作为一个独立的微服务运行，不修改 Sub2API 的任何原始代码。
- **无缝集成**：完美兼容 Sub2API 的“自定义菜单”功能，通过 iframe 嵌入。
- **UI 风格统一**：样式和主题完全参考 Sub2API，支持亮/暗色主题，跟随原平台自动切换。
- **用户隔离**：
  - 添加账号时，账号名称会自动增加 `{username}-` 前缀。
  - 在 `notes` (备注) 字段隐式增加 `[added-by:{user_id}]` 标签。
  - 列表页面只会展示**当前登录用户**自己添加的账号。
- **全平台支持**：支持 Anthropic, OpenAI, Gemini, Antigravity 等平台，涵盖 OAuth, API Key, Setup Token 等全量鉴权类型。
- **零额外存储**：后端服务仅做 API 代理和过滤逻辑，真正的账号数据原封不动写入 Sub2API 数据库中（网关调度完全不受影响）。

---

## 🚀 部署指南

### 环境要求
- Node.js (如果你想直接运行)
- Docker & Docker Compose (推荐)

### 方式一：使用 Docker 部署 (推荐)

1. 进入项目目录：
   ```bash
   cd e:\workspace\interestspace\sub2api-extra
   ```

2. 配置文件：
   打开项目中的 `docker-compose.yml` 文件，修改 `SUB2API_BASE_URL` 环境变量。它必须能够从这个新容器内访问到 Sub2API 的后端服务。
   
   *提示：如果它们部署在同一台机器上，通常使用 `http://host.docker.internal:8080` (Mac/Windows 或 Docker Bridge) 或实际的内网 IP。*

3. 启动服务：
   ```bash
   docker compose up -d --build
   ```
   服务将默认在 `9880` 端口运行。

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
         - "9880:3100"
       environment:
         - PORT=3100
         # 改为你的 Sub2API 后端地址
         - SUB2API_BASE_URL=http://host.docker.internal:8080
   ```
2. 在该文件所在目录执行：
   ```bash
   docker compose up -d
   ```

### 方式三：本地 Node.js 部署

1. 安装依赖：
   ```bash
   cd e:\workspace\interestspace\sub2api-extra
   npm install
   ```

2. 设置环境变量并运行：
   ```bash
   # Windows (CMD)
   set SUB2API_BASE_URL=http://localhost:8080
   node server.js
   
   # Linux / macOS
   SUB2API_BASE_URL=http://localhost:8080 node server.js
   ```

---

## ⚙️ 在 Sub2API 中集成

部署成功后，你需要在 Sub2API 管理后台配置。

1. 登录你的 Sub2API 管理后台。
2. 导航到 **设置 (Settings) -> 自定义菜单 (Custom Menu)**。
3. 点击 **添加自定义菜单**。
4. 填写如下信息：
   - **标签 (Label)**: 账号管理 (或我的账号)
   - **URL**: `http://<部署sub2api-extra的IP或域名>:3100`  (请确保用户浏览器能访问这个URL)
   - **可见性 (Visibility)**: 建议设为 `admin` (根据需求决定，但后端接口现阶段要求管理员权限)
5. 保存设置。

此时，左侧边栏就会出现一个“账号管理”菜单，点击即可无缝嵌入加载这个独立服务。

---

## 🛠 开发与修改

前端页面均为纯纯的原生 HTML/CSS/JS (Vanilla JS)，无须复杂的编译和构建，修改即生效：

- `server.js`: 代理接口、身份校验和权限隔离逻辑。
- `public/index.html`: 整个页面的 UI 骨架和弹窗。
- `public/style.css`: 样式表（内含暗黑模式定义）。
- `public/app.js`: 所有核心业务逻辑（API调用、列表渲染、按平台切换表单）。
