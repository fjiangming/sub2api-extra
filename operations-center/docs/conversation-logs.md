# 对话日志接入

本模块随 `fjiangming/sub2api-extra` 的 main 发布，配套 `fjiangming/sub2api` 的 dev 采集器。主站负责鉴权后识别用户和旁路读取上游正文，运营中心负责独立归档、策略、脱敏和查询，不写主站业务表，不参与余额或计费。主站新 dev 基于上游新 main，不包含此前旧 dev 的计费恢复定制；运营中心既有模块遇到缺少旧 API 时沿用其不可用 / 降级处理。

## 待确认的接入配置

先更新两个程序，再接入私有网络。以下是参考配置，本次不会应用到服务器。

主站环境变量：

```dotenv
CONVERSATION_LOGS_URL=http://operations-center:9872
CONVERSATION_LOGS_TOKEN=<独立随机值，至少32字符>
```

运营中心环境变量：

```dotenv
CONVERSATION_LOGS_TOKEN=<与主站相同的值>
OPERATIONS_CENTER_DATA_DIR=/app/data
OPERATIONS_CENTER_IMAGE=ghcr.io/fjiangming/sub2api-extra:operations-center-latest
```

`operations-center` 主机名要求两个容器共享可解析的私有 Docker 网络；分开运行时，应先核查网络、服务名和已有挂载。主站 URL 仅允许 HTTPS 或私有 / loopback HTTP，不经系统代理、不跟随重定向。不要向公网额外开放采集端口。现有管理员登录 / SSO 和 CSRF 保护继续适用，采集 token 不具备管理员读取权限。

先在“对话日志 → 保存策略”选择排除用户、保存版本和容量，再启用保存。默认关闭，原文与脱敏双副本、保留 7 天、容量 10 GiB、预留磁盘 2 GiB、单条上限 8 MiB、空间不足停止正文。单条上限最多 16 MiB；磁盘不足会标记正文缺失或拒收，不阻断推理。

排除按主站鉴权用户 ID，覆盖其全部 API Key。采集前、发送前和接收端入库前检查，策略读取失败则停止本次采集。保存排除后，尚未入库的记录也会丢弃；不新增正文、用户元数据、索引、会话和该用户缺口。已存在的历史归档不会隐式删除，仍按当前保留期清理。主站原有业务用量和原生诊断记录属于原有功能，不受本归档开关控制。

## Raw 和完整性

保存的是网关实际发往上游的请求正文、HTTP transport 暴露给网关的响应正文，以及上游 WebSocket 应用消息。保留原字节，不对原文 JSON 解析后重新序列化；未知字段、大整数、数值写法、空白和 SSE 顺序保留。入库 envelope 用 base64 承载字节，下载 `.raw` 时还原原字节，页面附 SHA-256。

这是应用正文归档，不是 TCP / TLS 抓包，不保存 Authorization 等 HTTP Header 或 URL 查询参数。若底层 HTTP transport 已自动解压，保存其解压后的原正文；若仍带 Content-Encoding，则保存压缩字节。查看支持 UTF-8、gzip、br、deflate；不支持的编码和二进制可在“仅原文”模式保存 / 下载。不会为了采集修改原有压缩协商或推理请求。

HTTP 每次真实 RoundTrip 独立保存，包括 TLS 指纹请求、账号切换和 Grok 回退。同次入站共享随机请求编号。WebSocket 在当前租约 / relay 边界归属身份；保留消息方向、次序和相对时间。池化连接不会沿用连接创建者的用户身份；WebSocket Host 无可靠采集值时显示未提供。只保留一个完成事件以内的消息段，连接关闭前未见结束事件会标记不完整。

会话只使用客户端 `session-id` 经按用户、Key 加盐 HMAC 的标识关联，不按文本相似、时间或 IP 猜测。未提供标识的请求仍可独立查询。同会话内同次请求的重试不重复计算请求数。排除 / 策略读取失败的持续 WebSocket 连接需要重连后恢复采集。

“完整采集”表示已读完上游应用字节或见到该 WebSocket 段的结束事件，不代表模型成功或业务计费成功。提前关闭、读取错误、超限、队列满和进程异常均可能缺失。采集总内存预算 64 MiB、单条有界、队列 32、单异步发送 worker，无原文磁盘 spool，不补发推理。每次新尝试及发送前策略读取超时为 200ms，发送超时 2s；异常仅影响归档。采集端累计丢弃数不附用户身份，重启后归零、多个主站实例仅显示最近上报值。

## 脱敏与存储

三种模式：原文 + 脱敏副本、仅脱敏副本、仅原文。默认邮箱、电话、常见密钥字串、IPv4 规则，可配置最多 10 条字面量文本替换。规则并非通用隐私识别器，姓名、地址、自定义凭据等应按实际内容增加规则。相同值使用同一 HMAC 占位符，不落盘保存反向映射。

脱敏定位 JSON 字符串 token，保留字段名、数值写法及未改动部分。保护角色、消息 / 工具关联 ID、工具名、模型和签名字段；OpenAI Responses / Chat、Claude 和 Gemini 的常见流式文本按消息组拼接后脱敏，再映射回原事件。工具 arguments / output 的内嵌 JSON 同样处理，不删除整轮消息。

结构字段命中、无效 / 未支持正文、二进制流或无法安全解析的片段会标记 `redaction_failed`。需要脱敏的模式不回退保存明文，包括双副本模式；此时两版正文均不保存，仅留原因。原文模式按原字节保存，仍受容量 / 单条上限约束。修改规则仅影响新策略版本产生的记录。

归档位于数据卷 `conversation-logs/archive.sqlite`，正文和策略使用 AES-256-GCM，随机 key 位于同目录 `archive.key`；元数据索引用于查询。目录 0700、key / 主库 0600，沿用容器数据卷所有权。**备份必须保留完整目录和 key**；运行中使用 SQLite 备份或停服后复制完整卷，不能只复制主库。已有数据库缺 key 时拒绝初始化，不生成新 key 冒充可读。

保留期每分钟和入库时执行；容量按数据库 / WAL / SHM 实际占用及可用磁盘检查。淘汰为有界批次，不能保证立即回收所有 SQLite 文件空间。缩短保留期或选择淘汰会影响历史记录。管理员原文下载包含敏感内容；本功能不会额外记录管理员原文读取审计。

## 发布与验收

主站 dev 推送触发 Fork Dev Release，单元 / race 测试、前端构建、五平台压缩包及 SHA-256 校验、双架构镜像运行验证通过后发布。GitHub Release 为三段数值版本，兼容原生更新器；镜像为 `ghcr.io/fjiangming/sub2api:<version>`，最新成功版本更新 `dev`、`latest`。主站更新来源、版本菜单和安装脚本均指向本 fork，旧上游缓存不会复用。

本仓库 main 推送沿用 Docker images 流程，运行运营中心完整测试后构建原生 linux/amd64 和 linux/arm64 镜像，检查 SQLite、源码 revision、对话归档模块和导航资源，再发布 `ghcr.io/fjiangming/sub2api-extra:operations-center-latest`、`operations-center-main` 及 `operations-center-sha-<短SHA>`。不再维护本仓库独立 dev 分支或 dev 发布流程；主站仍保留其独立 dev 分支。

主站左上角更新仅升级主站程序。运营中心需要按原 Compose 项目单独更新，保留完整原数据卷及归档 key；沿用 `operations-center-latest` 的部署无需切换镜像通道。新版运营中心即使尚未接入采集也会显示“对话日志”入口，实际保存仍需上面的连接 / token 配置和管理员启用策略。源代码发布不自动操作服务器。

本地 `npm test`、`npm run check`；`npm run preview:conversations` 启动隔离的正式页面预览（默认 `http://127.0.0.1:19907/preview`），仅虚构数据和临时 SQLite。`npm run check:conversations-ui` 通过 Playwright 检查下载原字节、会话、排除保存 / 重载、XSS、退出清理及窄屏布局，可用 `PLAYWRIGHT_MODULE_PATH` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已有运行时。
