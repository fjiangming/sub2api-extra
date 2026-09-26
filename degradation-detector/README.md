# 降智检测

降智检测是 Sub2API Extra 的独立服务。当前登录用户的短期 Token 只用于校验身份，以及读取该用户通过 `GET /api/v1/groups/available` 有权查看的分组；模型检测统一使用管理员配置的分组专用 Key，不会读取、创建或消费登录用户的 Key。

## 权限边界

| 能力 | 管理员 | 普通用户 |
|---|---:|---:|
| 查看自己有权分组的共享检测结果 | 是 | 是 |
| 在结果页修改配置或发起检测 | 否 | 否 |
| 在管理页立即检测 | 是 | 否 |
| 访问 `/admin/config` 及其页面资源 | 是 | 否 |
| 读取或修改检测配置 | 是 | 否 |

结果页与管理页是两个独立入口。`/results` 对所有已登录用户保持同一套只读界面，即使管理员打开结果页也不会收到配置入口、专用 Key 状态或手动检测能力。`/admin/config`、管理脚本和所有 `/api/admin/*` 接口都在服务端执行登录校验与实时管理员角色复核。所有配置写入和手动检测还要求当前会话的 CSRF Token，并受请求频率限制。

Sub2API 菜单的角色可见性只负责入口展示，不能单独作为安全边界；真正的越权防护由本服务端完成。普通用户即使猜到管理地址、携带自己的 Token 或直接调用管理接口，也会得到 `403`。旧的 `/api/groups/:groupId/runs` 手动检测接口已移除。

结果列表、详情、预览和下载均按以下交集授权：

```text
管理员已启用的分组 ∩ 当前登录用户在 Sub2API 中有权访问的分组
```

随机预览 Token 只是结果定位符，不能替代登录态与分组权限。HTML 作品使用 sandbox iframe 和独立 CSP 展示，禁止联网、表单、对象和外层页面访问。

### 只读页面的剩余风险

- 检测结果是分组内共享数据：任何当前仍有该分组权限的用户都可以查看管理员专用 Key 生成的答案和文件。检测提示词不得包含密码、Token、个人信息或其它不应向分组成员公开的内容。
- Sub2API 自定义菜单会在首次跳转 URL 中携带短期 Token。服务会立即换取本地会话、清理地址栏并设置 `Referrer-Policy: no-referrer`，但反向代理仍可能记录首个请求的完整查询串。生产环境必须使用 HTTPS，并在代理访问日志中隐藏或删除 `token`、`access_token` 参数。
- 只读不等于匿名：结果、详情、预览和下载仍要求有效登录态，并在每次访问时重新计算用户可见分组。用户被移出分组或管理员停用分组后，旧预览地址也不再可访问。

## 可视化配置

管理员从 Sub2API 的“降智检测管理”菜单直接进入管理页。管理页支持：

- 启用需要检测的平台；
- 为平台配置模型、请求协议、提示词、输出类型、最大输出量和判定规则；
- 查看该平台下 Sub2API 返回的全部分组，并选择允许检测的分组；
- 为每个启用分组填写独立的完整专用 Key；
- 配置 `Asia/Shanghai` 时区下每天固定的自动检测时间；
- 使用已经保存的题目和分组专用 Key 发起单次立即检测。

支持 OpenAI Responses、Chat Completions、Anthropic Messages、Gemini generateContent 和 Images Generations。输出可以是直接答案、HTML、图片或通用 Base64 文件；图片、文本、JSON、PDF、音视频可预览，其它文件可下载。

取消选择分组并保存后，该分组会停止调度，其专用 Key 会被清除，历史轻量判定继续保留。手动检测不会改变每天固定的下一次执行时间。

## 专用 Key

每个目标分组应使用独立服务账号创建一个专用 Key。Sub2API Key 与分组绑定，不同分组不能复用同一个 Key。

Key 提交后使用 AES-256-GCM 加密写入 SQLite，并绑定对应分组 ID；加密主密钥首次启动时随机生成在数据目录的 `.credential-key` 文件中，文件权限会收紧为仅服务进程可读写。浏览器只会收到“已配置/未配置”，后端不会回显、记录日志或把明文 Key 写入数据库。

备份时必须同时保护数据库和 `.credential-key`。丢失 `.credential-key` 后已有 Key 无法解密，服务会停止对应检测并要求管理员重新配置；仅泄漏数据库文件不会直接得到明文 Key。

## 环境变量

从模板创建环境文件：

```bash
cp degradation-detector/.env.example degradation-detector/.env
```

环境文件只需配置服务可访问的 Sub2API 地址：

```dotenv
SUB2API_BASE_URL=http://host.docker.internal:8080
```

平台、检测题、分组、专用 Key 和每日检测时间不再从环境变量读取。旧版 `DEGRADATION_DETECTOR_GROUP_KEYS_JSON`、`DEGRADATION_DETECTOR_SUPPORTED_PLATFORMS`、`DEGRADATION_DETECTOR_TESTS_JSON` 和间隔配置会被忽略，需要由管理员在配置页重新保存。

## 部署

```bash
docker compose --env-file compose.services.env --profile degradation-detector up -d degradation-detector
```

服务固定映射到 `127.0.0.1:9873`。通过 HTTPS 反向代理后，在 Sub2API 自定义菜单中分别配置两个入口。

普通用户模块：

```text
标签：降智检测结果
URL：https://detector.example.com/results?token={token}&theme={theme}
可见角色：全部已登录用户
```

管理员模块：

```text
标签：降智检测管理
URL：https://detector.example.com/admin/config?token={token}&theme={theme}
可见角色：仅管理员
```

两个入口都兼容 `token` 与 `access_token` 参数名，并在换取本地短期会话后立即从地址栏移除上游 Token。管理入口会先在服务端验证 Token 对应用户确实仍为管理员，再创建本地会话和返回页面。生产环境使用 Secure 和 Partitioned Cookie；反向代理必须保留 HTTPS 协议信息。

首次部署时结果页为空是正常状态。管理员从独立管理入口保存至少一个平台、分组及其专用 Key 后，该分组才会出现在只读结果页并进入每日调度。

当前会话、SQLite 写入和调度器按单实例设计，请只运行一个服务副本。数据卷 `sub2api-extra_degradation-detector-data` 必须持久化。

## 本地开发

```bash
cd degradation-detector
npm ci
npm test
```

仅用于界面检查的演示模式不能在生产环境启用：

```powershell
$env:NODE_ENV='development'
$env:DEGRADATION_DETECTOR_DEMO_MODE='true'
$env:PORT='9873'
node src/server.js
```

管理员管理页演示入口为 `http://127.0.0.1:9873/admin/config?demo=1`，只读结果页演示入口为 `http://127.0.0.1:9873/results?demo=readonly`。
