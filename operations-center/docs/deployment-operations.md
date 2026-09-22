# 部署与操作手册

## 1. 先看结论

运营中心必须能够连接 Sub2API 使用的 PostgreSQL，才能读取统计、检查容量和生成清理预览；但不强制数据库中事先存在一个特定名称的账号。

生产环境建议使用两个独立的最小权限角色：

| 角色 | 用途 | 权限边界 |
| --- | --- | --- |
| 只读角色 | 统计、Schema 检查、容量测量和清理预览 | `CONNECT`、`public` Schema 的 `USAGE`、业务表 `SELECT`；可选 `pg_monitor` |
| 清理角色 | 执行已经预览并通过备份闸门的批量清理 | 仅清理白名单表的 `SELECT/DELETE`，以及删除触发器需要的汇总水位 `SELECT/UPDATE` |

这两个角色可以在“系统设置 -> 数据库访问”中自动创建，不需要登录服务器、运行 `psql` 或手写 SQL。运营中心只在创建过程中临时使用 PostgreSQL 管理员密码，不会把该密码保存到文件、数据库、日志或响应中。

## 2. 部署前准备

需要准备：

1. 一个可访问的 Sub2API 实例和其管理员账号。
2. Sub2API 使用的 PostgreSQL 主机、端口、数据库名，以及一个能够创建角色并为现有表授权的数据库管理员账号。
3. Docker Compose，或 Node.js `>=20.18.1`。
4. 生产访问使用 HTTPS 反向代理。

使用 Sub2API 自定义菜单 SSO 时，需要关闭 Sub2API 的“会话绑定”，然后退出并重新登录。会话绑定开启时，独立服务端无法代替浏览器校验该 Token。

## 3. 最小配置

复制 `.env.example` 为 `.env`。首次部署不需要填写数据库连接：

```dotenv
NODE_ENV=production
OPERATIONS_CENTER_AUTH_MODE=sub2api
OPERATIONS_CENTER_ADMIN_PASSWORD=

SUB2API_BASE_URL=http://host.docker.internal:8080
SUB2API_PUBLIC_URL=https://sub2api.example.com

SUB2API_DATABASE_URL=
SUB2API_MAINTENANCE_DATABASE_URL=
ADMIN_EMAIL=
ADMIN_PASSWORD=
SUB2API_ADMIN_TOKEN=
```

`SUB2API_BASE_URL` 是运营中心容器访问 Sub2API 的首选地址；`SUB2API_PUBLIC_URL` 是浏览器访问 Sub2API 的公开地址。两者可能不同。首选地址发生 DNS、连接或超时故障时，认证与只读请求会回退到已配置的公开地址，并记住成功地址供后续写操作直接使用；响应不确定的写操作不会跨地址重放。如果服务器不能通过 `host.docker.internal:8080` 访问 Sub2API，可以直接把两项都设为 Sub2API 的公开 HTTPS 地址。

使用独立登录时，把认证模式改为 `local`，并设置至少 16 位的 `OPERATIONS_CENTER_ADMIN_PASSWORD`。该密码属于运营中心，不是 Sub2API 邮箱密码。

## 4. 启动

### Docker Compose

```bash
docker compose --env-file compose.services.env pull operations-center
docker compose --env-file compose.services.env up -d --no-build operations-center
```

Compose 会创建 `operations-center-data` 命名卷，用于保存加密后的运行配置和本机配置密钥。容器根文件系统仍为只读，不挂载 Docker socket。

### Node.js

```bash
cd operations-center
npm ci
npm start
```

本地运行默认把加密配置保存在 `operations-center/data`，可以通过 `OPERATIONS_CENTER_DATA_DIR` 改变位置。

## 5. 接入 Sub2API 菜单

在 Sub2API 管理后台的“设置 -> 自定义菜单”中添加运营中心公开地址，并把可见性限制为管理员。管理员从菜单打开后，运营中心会：

1. 接收自定义菜单附带的临时访问 Token。
2. 调用 Sub2API `/api/v1/auth/me` 校验登录状态和管理员角色。
3. 换成运营中心自己的短期内存会话。
4. 从地址栏移除 Sub2API Token。

交互式使用不要求配置 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 或固定管理员 Token。

## 6. 页面初始化数据库

首次登录会自动打开“系统设置”。在“数据库访问”中填写：

- 数据库主机和端口。
- Sub2API 使用的数据库名。
- PostgreSQL 管理员账号和密码。
- SSL 模式。
- 只读角色名和清理角色名。
- 是否授予只读监控能力、是否同时创建清理角色。
- 是否在检测到旧默认权限时撤销 `PUBLIC` 的 `public` Schema 建表权。

先点击“测试管理员连接”。通过后点击“创建受限账号并连接”。系统会在一个事务中：

1. 验证当前账号具有 `CREATEROLE`，并能管理现有业务表的所有者权限。
2. 创建随机强密码的只读角色和可选清理角色。
3. 确认待轮换的受管角色不拥有数据库对象，再清除其原有的直接表权限、角色参数和角色成员关系。
4. 检查受限角色是否通过 `PUBLIC` 继承了 `public` Schema 建表权；未获得页面明确确认时整笔回滚。
5. 为只读角色授予当前表读取权限和当前表所有者的未来表默认读取权限。
6. 为清理角色只授予当前存在的固定清理白名单权限。
7. 使用新角色建立连接并检查 Sub2API Schema。
8. 加密保存新角色连接并立即热切换，不重启服务。

PostgreSQL 14 及更早版本创建数据库时，可能默认允许 `PUBLIC` 在 `public` Schema 建表。只撤销具体角色的直接权限无法消除这项继承权限，因此初始化会默认阻断。勾选页面中的 Schema 安全加固后，系统才会在该数据库执行 `REVOKE CREATE ON SCHEMA public FROM PUBLIC`。这个变更会影响同一数据库内所有依赖该旧默认权限的普通角色；已有对象、对象读取权限和其他 Schema 不受影响。若有其他应用需要在 `public` Schema 建表，应先为其专用角色直接授予 `CREATE`，或不要勾选并由数据库管理员完成等效的权限设计。

同名角色已存在但没有运营中心受管标记时，系统会拒绝接管，避免误改企业已有账号。可以换一个角色名后重试。

带有运营中心受管标记的角色如果已经拥有表、Schema 或数据库，系统同样拒绝自动轮换，避免因重置权限影响额外用途。请改用新的角色名；不要把运营中心生成的角色用于创建业务对象。

Sub2API 升级后如果新增了统计表或白名单表，可以再次执行同一操作。受管角色会轮换密码并补齐授权；未知业务表不会自动获得清理权限。

## 7. 系统设置

### 依赖检查

“运行检查”会检测：

- 只读数据库连接和延迟。
- Sub2API 必需表及字段兼容性。
- 独立清理连接及白名单删除权限。
- Sub2API 管理 API 与管理员认证。
- 最近一次满足时效的 Sub2API 原生备份。

检查不会写业务数据，也不会创建备份或执行清理。

### Sub2API 管理 API

有三种认证方式：

| 方式 | 保存内容 | 适用场景 |
| --- | --- | --- |
| 仅当前 SSO 会话 | 不保存 Sub2API 凭据 | 手动查看、手动清理；服务重启后重新从菜单进入 |
| 持久管理员 Token | 加密保存 Token | 无人值守自动清理；管理员启用 2FA 时优先 |
| 管理员邮箱和密码 | 加密保存邮箱和密码 | 未启用 2FA、无法使用受管 Token 的部署 |

保存前会调用 Sub2API 验证管理员身份。切回“仅使用当前 SSO 会话”会清除页面托管的持久凭据；部署环境变量中的旧凭据也会被运行配置显式覆盖。

### 清理与保留设置

页面可以配置：

- 是否允许执行清理。
- 是否启用每日自动清理和执行时间。
- 自动清理目标。
- 请求明细、小时汇总、日汇总、系统日志、错误日志和运维指标保留天数。
- 等待预览后原生备份完成的时长。

页面配置始终强制新鲜备份闸门。未配置独立清理角色时不能启用执行；自动清理未获得 Sub2API 管理认证时会在备份阶段失败，不会进入删除阶段。

## 8. 加密配置与备份

运行配置包含受限数据库连接和可选 Sub2API 管理凭据，使用 AES-256-GCM 加密。数据目录中有两个配套文件：

- `settings.enc.json`：密文配置。
- `settings.key`：本实例随机生成的 256 位密钥。

迁移或备份运营中心配置时必须同时保护并迁移整个数据卷。只有密文没有密钥无法恢复；同时泄露密文和密钥等同于泄露其中的受限凭据。数据卷不包含 Sub2API 业务数据或数据库备份。

Sub2API 数据库备份和覆盖恢复继续使用 Sub2API 原生功能。运营中心只触发或核验原生备份，不另外复制数据库。

## 9. 必须保留为部署配置的项目

以下项目发生在页面可登录之前，或属于主机网络安全边界，不能安全地由页面自修改：

- 监听地址和端口。
- HTTPS 证书及反向代理。
- `SUB2API_BASE_URL`、`SUB2API_PUBLIC_URL` 和首次 SSO 可达性。
- `local` 模式的初始管理员密码。
- Docker 数据卷、网络、防火墙和 PostgreSQL `pg_hba.conf`。
- Sub2API 自身的会话绑定和原生聚合保留环境变量。

运营中心不会挂载 Docker socket、修改 Sub2API 容器、编辑 Sub2API 配置或修改其源码。这样可以避免一个网页管理服务获得整台服务器控制权。

## 10. 日常操作

### 手动清理

1. 在“系统设置”运行依赖检查。
2. 在“数据清理”选择固定目标并生成预览。
3. 核对行数、截止点、聚合覆盖和影响。
4. 触发并等待一份晚于预览创建时间的 Sub2API 原生备份。
5. 完成两项确认并输入预览专属短语。
6. 执行后下载 JSON 报告。

### 自动清理

先配置独立清理角色和持久 Sub2API 管理认证，再在系统设置中启用。默认自动目标不包含请求明细、小时汇总和日汇总；这些关键目标必须由管理员主动勾选。

### 轮换数据库角色密码

重新填写 PostgreSQL 管理员连接并使用原角色名执行“创建受限账号并连接”。系统只允许轮换带有运营中心受管标记的角色，完成后立即切换到新密码。

## 11. 故障排查

| 现象 | 检查 |
| --- | --- |
| 页面显示等待数据库配置 | 打开系统设置完成数据库访问初始化 |
| 容器连接不到宿主机数据库 | 主机使用 `host.docker.internal`；确认 PostgreSQL 监听和防火墙 |
| 管理员连接成功但不能创建角色 | 使用具有 `CREATEROLE` 且能管理全部现有表所有者的账号 |
| 提示 `PUBLIC` 仍有 Schema 建表权限 | 评估同库其他角色后勾选 Schema 安全加固；该操作会撤销同库所有普通角色继承的旧默认建表权 |
| 提示角色已存在且不受管 | 更换新角色名，不要让运营中心接管未知角色 |
| 提示受管角色拥有数据库对象 | 更换新角色名；不要使用受管只读或清理角色创建对象 |
| Schema 不兼容 | 确认连接的是 Sub2API 当前数据库，并完成 Sub2API 数据库迁移 |
| SSO 返回会话绑定不兼容 | 关闭 Sub2API 会话绑定并重新登录，或使用 `local` 模式 |
| SSO 或账号登录提示无法连接 Sub2API | 从运营中心容器检查 `SUB2API_BASE_URL`；若 `host.docker.internal` 不可达，将其改为与 `SUB2API_PUBLIC_URL` 相同的公开 HTTPS 地址并重建容器 |
| SSO 提示登录状态无效，但供应商监控可用 | 分别向两个服务的 `/api/auth/sso` 提交无效测试 Token；运营中心返回 `AUTH_UPSTREAM_UNAVAILABLE` 表示网络/地址问题，返回 `AUTH_FAILED` 才表示已连通且 Token 被 Sub2API 拒绝 |
| 自动清理在备份阶段失败 | 配置持久 Token/账号，检查原生备份权限、2FA 和最近备份状态 |
| 删除后宿主机空间没有立即增加 | PostgreSQL 已获得内部可复用空间；普通 `DELETE` 不等于文件立即缩小 |

`/healthz` 只表示进程存活。`/readyz` 在数据库尚未初始化时返回 `503 setup_required`，配置完成后返回数据库名和连接延迟。
