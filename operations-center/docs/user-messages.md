# 定向用户消息

运营中心的“用户消息”tab 向单个 Sub2API 用户发送站内消息。编辑器支持 Markdown、格式工具栏、内容预览和发送前确认；消息支持草稿、普通通知或强制弹窗、开始/结束时间、编辑、撤回、删除和已读状态。

## 为什么需要公告接口网关

核对当前 Sub2API 的 `AnnouncementTargeting`、用户公告接口和前端公告 store 后，原生公告仅支持按余额或订阅筛选，不支持用户 ID。空 targeting 会命中所有用户，因此不能用“普通公告加一个 user_id”实现私信，也不能用余额相等替代身份隔离。

运营中心独立保存消息，仅接管主站的两个**用户端**公告接口：

| 接口 | 行为 |
| --- | --- |
| `GET /api/v1/announcements` | 用请求者自己的 Bearer Token 向直连 Sub2API 校验身份、读取原生公告，再合并该用户当前可见的定向消息 |
| `POST /api/v1/announcements/:id/read` | 正数 ID 使用请求者 Token 转发到原生接口；负数 ID 仅允许目标用户标记自己的有效消息已读 |

定向消息使用 JavaScript 安全整数范围内的负数 ID，与原生正数 ID 隔离。用户端响应保留原生 `{code, message, data}` 结构及 `notify_mode`、`read_at` 等字段，复用 Sub2API 现有公告铃铛、Markdown 渲染和未读弹窗。管理员公告接口、登录、其他 API 不经过此网关。

网关每次请求都在线校验 Token，不信任前端传来的 userId，不使用管理员 Token 获取用户公告。草稿、尚未开始、已到结束时间和已撤回消息均不可见，也不能标记已读。未经授权访问与不存在的定向消息统一返回 404。

## 配置

1. 保留现有 `SUB2API_BASE_URL`、`SUB2API_PUBLIC_URL` 和管理员 SSO 设置。运营中心使用本地登录时，还需配置已有的持久 Sub2API 管理员凭据，用于搜索并验证收件人。
2. 在运营中心 `.env` 中设置直连上游地址。此地址必须直接到达 Sub2API，不能经过下面的公告转发规则。例如宿主机部署使用 `http://host.docker.internal:8080`；已经接入 Sub2API Docker 网络时使用对应的服务名和内部端口。

```dotenv
OPERATIONS_CENTER_USER_MESSAGES_ENABLED=true
SUB2API_ANNOUNCEMENTS_UPSTREAM_URL=http://host.docker.internal:8080
```

`SUB2API_ANNOUNCEMENTS_UPSTREAM_URL` 留空时使用 `SUB2API_BASE_URL`。网关不会回退到 `SUB2API_PUBLIC_URL` 或认证缓存的公开地址，以避免公告请求再次进入网关。主站启用了会话绑定时，遵循[部署手册](deployment-operations.md)中的 SSO 要求。

3. 在 **Sub2API 主站域名**的 Nginx `server` 中增加以下规则。下面示例假设 Nginx 在宿主机运行，运营中心端口为 `9872`；Nginx 在容器内时，改成该容器实际可达的运营中心地址。

```nginx
location = /api/v1/announcements {
    proxy_pass http://127.0.0.1:9872;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Authorization $http_authorization;
    proxy_cache off;
}

location ~ ^/api/v1/announcements/-?[0-9]+/read$ {
    proxy_pass http://127.0.0.1:9872;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Authorization $http_authorization;
    proxy_cache off;
}
```

将上面的正则规则放在现有通用 API 正则规则之前。若现有 `/api/` 或 `/api/v1/` location 使用 `^~`，需要调整该规则，使已读接口能够匹配这里的正则；只转发列表而遗漏已读接口会导致定向消息无法关闭为已读。不要转发 `/api/v1/admin/announcements` 或整个 `/api/`。

4. 重启运营中心，检查 Nginx 配置后重新加载。使用 Compose：

```bash
docker compose --env-file compose.services.env up -d --no-build operations-center
nginx -t
nginx -s reload
```

## 验证与操作

使用主站已登录用户访问公告接口，响应头 `X-Operations-Announcements: 1` 表示列表经过了运营中心。不要把实际 Token 粘贴到工单或日志。启用变量只表示允许发布，不会自动更改或验证主站的反向代理配置。

在“用户消息”中新建消息，按邮箱、用户名或精确用户 ID 搜索，点击明确的收件人后输入标题和正文。勾选“强制弹窗”使用原生 `popup` 模式；未勾选时显示在公告列表中。时间按管理员浏览器本地时区输入，保存为 UTC；留空表示立即生效或永不过期。点击发送后核对收件人和预览，再确认发布。

先向测试用户发送一条消息，再分别使用目标用户和另一个用户验证：目标用户能看到并标记已读，另一个用户看不到该消息；原有公告及其已读操作仍然正常。运营中心列表可查看已读时间。消息一旦建立就不能更换收件人；修改既有消息保留已读记录，需要再次提醒时新建消息。撤回或删除停止后续展示，已经打开的页面需等下次刷新公告才更新。

“强制弹窗”沿用主站原有的未读确认弹窗，并非实时推送或每次访问重复弹窗。当前主站公告 store 在会话内去重，最多展示最近 20 条，并有 20 分钟请求节流；用户重新登录、刷新或主站主动刷新公告后按原有机制接收消息。不要将发布成功等同于用户在线收到，已读时间才表示用户已确认。

## 数据与接口

消息及阅读状态保存到 `OPERATIONS_CENTER_DATA_DIR/user-messages.json`，使用串行写入和原子替换，随现有 `operations-center-data` 卷持久化；不修改 Sub2API 业务表或数据库角色。文件包含收件人邮箱与消息正文，应随运营中心数据卷备份并限制文件访问。当前适用于运营中心单实例，每条正文最多 16,000 字符、标题最多 200 字符、最多 10,000 条消息；到达上限后可删除旧记录。

管理员接口沿用运营中心登录与 CSRF：

| 接口 | 用途 |
| --- | --- |
| `GET /api/user-messages/status` | 读取投递开关与总数 |
| `GET /api/user-messages/users?search=...` | 搜索单个收件人候选，最多 20 人 |
| `GET /api/user-messages` | 按 search、status、userId、page、pageSize 筛选分页 |
| `POST /api/user-messages` | 新建消息，必须带 UUID 格式的 `Idempotency-Key` 防止重复创建 |
| `PUT /api/user-messages/:id` | 更新内容、状态、通知方式和生效时间，收件人不可变 |
| `POST /api/user-messages/:id/archive` | 撤回 |
| `DELETE /api/user-messages/:id` | 删除消息及阅读状态 |

未启用投递时可保存草稿，不能发布；接入后仍需保留数据卷，避免丢失消息与已读记录。恢复原生公告链路时，先停用消息发布，再恢复主站的两个转发规则。
