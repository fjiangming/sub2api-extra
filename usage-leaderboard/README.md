# 用户用量排行

面向 Sub2API 用户的独立排行子服务，默认端口 `9876`。页面包含前三名领奖台、Top 10 表格、个人排名、与上一名差距、近 7 天 Token 趋势和常用模型。支持今日、本周、本月、累计，展示与排名仅使用 Token 用量，不展示调用次数。用户名称统一使用脱敏的注册邮箱，页面自动跟随系统主题。

已实现独立的管理员「排行设置」页面 `https://排行域名/settings`。展示页不包含设置入口、管理脚本或后台操作；管理员页可分别设置榜单与单人模拟 Token 范围、预览四个周期、保存草稿、发布、恢复真实榜单或回退上一版。先按榜单下限优先纳入真实用户，再用模拟用户补足十位，按 Token 用量混排；任何真实用户的 Token 用量超过榜尾都可入榜，不受 Token 下限排除。真实用户不受上限限制，模拟用户带「示例」标识。详见[实现规则与设置说明](docs/admin-settings-design.md)。

## 数据与资源

- **没有自己的数据库**：直接只读查询 Sub2API 现有 PostgreSQL 的 `public.users`、`public.usage_logs`，以及可用时的 `public.user_avatars`，不创建表、索引、迁移、归档或逐日快照。
- **默认没有数据卷**：排行缓存、个人统计缓存、短期会话和后台设置只在内存中；重启会清空并恢复真实榜单。可选只持久化一个不超过 64 KiB 的设置文件，不保存逐日历史。
- 全局榜缓存最多 8 项，每项额外保留首次请求者的个人排名结果；个人缓存默认 256 项，默认 TTL 60 秒。各缓存最多 8 个并发加载，会合并相同请求。会话默认最多 1,000 个，过期自动清理。限流桶最多 4,096 个。
- PostgreSQL 默认最多 3 个连接，查询超时 15 秒；超过并发上限立即返回繁忙，不积累连接等待队列。连接固定启用 `default_transaction_read_only=on`，推荐再使用受限只读数据库账号。
- 容器只读文件系统，默认内存上限 192 MB、CPU 0.5，无持久挂载；Docker 日志最多 `5 MB × 3`。服务不写访问日志、认证 Token、SQL 或数据库连接串。开启可选设置目录时，只覆盖写入有大小上限的设置文件。
- 用户头像只读取主站 `public.user_avatars.url` 和登录接口的 `avatar_url`，支持主站保存的上传图片或头像链接；未设置、加载失败、旧版无头像表或模拟账号均显示统一的默认用户图标，不分配装饰头像。页面与 Lucide 图标为本地资源，远程头像按主站保存的链接加载。

服务不另外保留历史。**累计榜表示主站现存用量记录的累计**，不承诺主站已清理明细后的完整终身排名。站点原生的日/小时活跃用户表没有用户级 Token 和费用，不能用它们补出被删除的排行。所有周期都在页面注明“现存记录”；数据缺少上期起点时隐藏排名变动和增长率。最早记录检查无法证明中间从未清理过数据。

统计在数据库内完成，不把全部用户或请求明细加载到 Node.js。今日、本周、本月查询使用明确的时间上下界，让已有时间索引直接跳过窗口外的记录；首次请求的榜单和本人排名共享一次全站聚合。缓存命中后，其他用户的个人排名仍需独立聚合；大站和累计查询的开销取决于主站保留量与已有索引。可调高缓存 TTL、降低并发；本服务不会为了提速在主站创建新索引。

## 部署

已有其他子服务、希望只创建 Compose 和环境文件再拉取镜像时，参照[镜像增量部署手册](docs/image-deployment.md)。手册已结合本工程历史会话，包含数据库共享网络、主站认证连接和 Compose 项目名的检查步骤。[纯镜像 Compose 模板](deploy/compose.yaml)不含构建配置，放到服务器的 `usage-leaderboard/compose.yaml` 使用；外部网络默认采用历史验证过的 `sub2api-deploy_sub2api-network`，使用前按实际 PostgreSQL 网络确认。`usage-leaderboard-latest` 已发布；2026-10-13 已核验匿名拉取权限及 amd64/arm64 支持。

要求 Node.js 22.18+，或 Docker Compose 2.24+。数据库结构已与本地 Sub2API `d2e319b2a` 源码核对；运行时检查所需字段。更早版本没有 `requested_model` 时，常用模型使用 `model`。身份和管理员角色均通过主站 `/api/v1/auth/me` 验证，无需额外管理员 API Key 或密码。推送到 `main` 后由 GitHub Actions 构建并发布镜像，待对应提交的排行构建成功后再拉取更新；历史镜像可拉取不代表已包含新功能。

```bash
cp usage-leaderboard/.env.example usage-leaderboard/.env
```

编辑 `.env`，至少配置以下值：

| 配置 | 用途 |
| --- | --- |
| `SUB2API_BASE_URL` | 容器实际可达的主站 HTTP(S) 根地址，如主站公开 HTTPS 地址；同网可使用实际容器名 |
| `SUB2API_PUBLIC_URL` | 用户浏览器可达的主站 HTTPS 根地址，同时是允许嵌入页面的父站来源 |
| `SUB2API_DATABASE_URL` | 主站数据库的只读连接串；密码中的特殊字符需 URL 编码 |
| `SUB2API_DATABASE_SSL` | `disable` / `require` / `verify-full`；远程数据库优先使用 `verify-full` |
| `SUB2API_TIMEZONE` | IANA 时区，默认 `Asia/Shanghai` |

数据库连接串不接受查询参数，SSL 和超时由单独配置设置。可以复用已知凭据的运营中心只读连接。不要将数据库开放到公网；使用内网或已有受限网络通道。容器化主站 PostgreSQL 未发布宿主端口时，应永久加入其网络并使用数据库容器名，不能假设 `host.docker.internal:5432` 可达。用量排行不会在 `SUB2API_BASE_URL` 连接失败时自动回退到 `SUB2API_PUBLIC_URL`，部署时需要分别验证主站认证和数据库。

从源码构建并启动此模块：

```bash
docker compose --env-file compose.services.env --profile usage-leaderboard up -d --build usage-leaderboard
```

无需启用其他模块，也不会改写 `compose.services.env`。长期启用时，把 `usage-leaderboard` 追加到现有 `COMPOSE_PROFILES` 列表；保留原先需要的模块。使用已发布镜像时，仅拉取该服务，然后以 `--no-build --no-deps --pull never` 启动，具体命令见镜像增量部署手册。

服务仅在宿主机 `127.0.0.1:9876` 发布端口。使用独立 HTTPS 域名，下面是可直接保存为排行站点文件的完整 [Nginx 配置](docs/nginx.conf.example)，包含 HTTP 跳转、HTTP-01 续期入口、HTTPS 证书和反代。将所有 `rank.example.com` 替换为实际排行域名，两个证书路径替换为服务器现有的实际证书路径。配置作为独立站点由 Nginx 的 `http {}` 加载，不粘到已有 `server {}` 内。

```nginx
# Replace rank.example.com and the certificate paths before use.
# The HTTP-01 webroot must match your ACME client's renewal configuration.
server {
    listen 80;
    server_name rank.example.com;
    access_log off;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files $uri =404;
    }

    location / {
        return 301 https://rank.example.com$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name rank.example.com;

    ssl_certificate /etc/letsencrypt/live/rank.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rank.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 32k;
    access_log off;

    # The app's CSP uses SUB2API_PUBLIC_URL to allow the main site's iframe.
    location / {
        proxy_pass http://127.0.0.1:9876;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_connect_timeout 5s;
        proxy_send_timeout 65s;
        proxy_read_timeout 65s;
        proxy_cache off;
        proxy_intercept_errors off;
        access_log off;
    }
}
```

证书路径是 Certbot 示例；使用宝塔时改为该排行站点的实际证书路径，并整份替换该站点的配置文件。HTTP-01 客户端使用的 webroot 要与 `/var/www/letsencrypt` 一致，宝塔用户可改为排行站点原有的网站目录。创建目录、签发证书和检查重载的完整步骤见[镜像增量部署手册](docs/image-deployment.md#8-配置排行-https-域名和用户菜单)。

配置关闭访问日志，避免首次页面 URL 的 Token 写入日志；若使用其他日志方案，只记录不含查询参数的 `$uri`，同样检查 CDN/网关日志。模板保留服务自己的 iframe CSP，`SUB2API_PUBLIC_URL` 填主站的实际 HTTPS 来源。生产环境的排行页面与主站均使用 HTTPS，保留 Secure Cookie，页面提供在排行域名根路径 `/`。

使用上述单层可信代理时，保持示例中的 `USAGE_LEADERBOARD_TRUST_PROXY=true`，让限流按真实客户端 IP 计数；否则所有用户可能一起受到代理 IP 的限流。直接访问 Node 服务时设置为 `false`。该选项只信任最近的一层代理，不适用于未经确认的多层代理链。

## 添加到主站菜单

在 Sub2API 管理后台的自定义菜单中添加用户可见条目，名称为“用量排行”，URL 填排行服务的 HTTPS 根地址，使用 iframe 页面。主站的自定义页面会自动追加 `token`、`user_id` 等参数，**不要把永久 Token 写在菜单 URL 中**。

页面会立即移除地址中的原始 Token，只通过同源 POST 的 `Authorization: Bearer` 头交换短期内存会话。用户身份以主站 `/api/v1/auth/me` 为准，不相信 URL 的 `user_id` 或 JWT 中自称的身份。后续请求使用 HttpOnly Cookie；跨站 iframe Cookie 被限制时，使用当前标签页的短期 `Session` 令牌兜底。原始主站 Token 不写入浏览器存储，服务端只在会话期限内存于内存，每 60 秒重新验证主站状态。会话固定到期，不滚动延长，且不超过主站 Token 的到期时间。

如果主站开启了会话绑定，需要确保两条路径看到一致的真实客户端 IP 和 User-Agent：

1. 在一个可信反向代理后设置 `USAGE_LEADERBOARD_TRUST_PROXY=true`。
2. 该代理覆盖传入的转发头；容器端口保持仅限可信代理访问。
3. 设置 `SUB2API_FORWARD_CLIENT_FINGERPRINT=true`，并使主站信任排行服务所在的代理路径。

未满足以上条件时，不要开启转发指纹。`SESSION_BINDING_MISMATCH` 会作为登录失败展示，不会通过伪造身份或跳过校验绕过绑定。

## 管理员设置与真实用户优先

在主站分别添加两个自定义菜单：「用量排行」指向 `https://实际排行域名/`，可见角色选普通用户；「排行设置」指向 `https://实际排行域名/settings`，可见角色选管理员。页面由 Sub2API 自定义页面自动以 iframe 打开并附加当前登录信息，无需手填 Token。使用现有 Nginx，无需新增端口或反代路由。展示页不包含设置入口、后台脚本或后台表单；管理页先通过受保护接口单独获取管理员 CSRF Token，再加载设置表单。所有 `/api/admin/*` 都在服务端重新验证 `role === 'admin'`，降权或认证失败立即拒绝后台访问。写接口还校验同源 Origin 和会话 CSRF Token。

1. 选择模拟榜单，分别设置「榜单 Token 范围」「单人模拟 Token 范围」及分布，点击「随机生成」。榜单下限用于优先纳入真实用户，上限仅约束模拟用户；模拟用户还需符合单人模拟范围，两者取交集。真实用户超过上限仍展示实际用量；低于下限但 Token 用量超过榜尾也能入榜。只有服务端生成的候选可以发布，不接收浏览器自编用量。
2. 切换今日、本周、本月、累计，查看按 Token 用量合并排名后的真实效果。修改参数后必须重新生成，才能发布。
3. 「保存草稿」不影响用户端；「发布榜单」确认后原子切换所有周期。可恢复真实榜单，或回退至唯一的上一发布版本；重复提交旧修订号返回 409，不会重复覆盖。

新名单使用增强后的随机分布：自然梯度允许局部接近和明显断层，头部集中随机形成 1～2 位高用量用户与长尾，差距接近保持较小跨度但不使用固定间隔。今日用量与历史活跃程度按用户分别采样，仍遵守单人和榜单范围交集。旧名单继续保留原时间线；取消「保留身份与历史」后重新生成并发布，即可应用新规则。

| 边界 | 实际行为 |
| --- | --- |
| 真实用户达到榜单下限 | 按当前周期真实 Token 判断，包含下限；在 SQL 截取前筛选，与单人模拟区间无关 |
| 真实用户超过榜单上限 | 仍参与排序，显示完整实际用量；不截断或缩小数值 |
| 达到下限的真实用户不足 10 位 | 先纳入，从符合两个区间交集的固定模拟名单中补足 10 位；再让 Token 用量超过榜尾的其他真实用户竞争，重新排序取十位 |
| 真实用户 Token 低于下限 | 若 Token 用量超过榜尾，仍能入榜 |
| 达到下限的真实用户至少 10 位，或模拟名额全部被真实用户替代 | 不补模拟用户，恢复真正的全站真实 Top 10、全站概览和个人实际名次 |
| 排名与并列 | 真实和模拟统一按 Token 用量降序，同值并列；并列位置按固定随机种子决定，不优先安排真实用户，刷新不重抽 |
| 比较、合计与个人信息 | 混合榜只合计当前 10 行，不显示全站增长率；个人用量、趋势和模型统计保持真实，上榜时显示榜内名次及定位按钮，不提供混合榜的全站百分位和追赶差距 |
| 四个周期 | 基于同一组日级模拟桶聚合；同一模拟补位顺序用于各周期，相同统计窗口与真实名单得到相同榜单；今日属于周、月，周、月分别属于累计 |
| 保留身份重新生成 | 沿用同一时间线，生成操作本身不重抽历史；用量随时间正常增长。扩大有效区间可保留；收紧有效区间或修改分布须取消保留身份生成新名单 |
| 自动增长 | 每 5 分钟复算各用户的活跃时段和 Token 增量，同一时间段结果一致，允许短暂停顿，不随访问次数重抽 |
| 跨天与上限 | 按 `SUB2API_TIMEZONE` 自动切换今日、周、月，累计延续；累计空间无法容纳后续日用量时换用新的示例身份，旧身份不下调用量 |
| 页面刷新 | 展示页每 60 秒后台请求，隐藏、离线及打开详情期间暂停；手动刷新保留当前内容，切回已查看的周期时先显示当前页面内 5 分钟内且同一自然日的缓存，再请求更新，最多保留四个周期；失败保留已有榜单并退避重试，登录失效清空页面缓存并停止轮询，不持久化个人用量到浏览器 |
| 迟到用量与一致性 | 发现本人数字与缓存榜单行、入榜候选或模型汇总不一致时，使共享缓存失效并重新读取；最多重试两次，持续变化时返回稍后重试，不输出冲突数字 |
| 失败与更新 | 数据库失败显示错误；文件写入失败保留已发布版本；发布清理缓存，并防止旧的在途查询重新覆盖新版本 |

原始 Token 是整数计数；新名单初次生成避开 `.00M` 和四舍五入成 `1000.00M`。后续新增用量不为凑展示小数而改写历史。两个区间的配置均允许 1M～1B，默认均为 1.37M～980.83M，按每个周期分别判断，不约束十人合计；真实用量可超过配置上限及 1B。区间无交集、过窄或不能保留原时间线时拒绝生成，不静默扩大模拟边界。新模拟邮箱在 `qq.com`、`gmail.com`、`163.com` 中随机生成并脱敏显示，QQ 邮箱前缀为数字，与脱敏真实身份冲突时自动换名；跨天更换身份同样使用这三种域名。旧的 `example.com` 名单继续兼容，取消「保留身份与历史」后重新生成并发布即可切换。真实用量在收到请求时按缓存 TTL 更新，默认 60 秒，配置范围 10～600 秒；正常在线且查询成功时，默认缓存与页面轮询叠加，变化可能接近两分钟才显示，不能承诺秒级更新。示例时间显示当前复算时间。旧版 1～3 已发布快照当天继续兼容，跨天恢复真实榜单；升级后在 `/settings` 重新生成并发布一次才启用版本 4 的自动增长与跨天续接。真实用户上限豁免及超过榜尾的入榜规则对已有发布配置同样生效，无需重新生成。选择「真实用量」时保持原始全站排行。

四个周期共享一个可复算的示例时间线。版本 4 保存固定大小的版本 3 起点和当前候选，按身份、日期和 5 分钟时间段在内存复算，不保存逐日明细，不向数据库写入，也不因轮询写设置文件。各身份有独立的活跃节奏；跨月、跨周重置对应周期，累计继续增加。UTC 上的本地日界限用于处理夏令时，重复小时不会让用量倒退。有限累计上限与每日正下限不能无限期同时满足，因此按剩余累计空间计算身份展示周期，最后一日使用剩余额度，下一日以新身份补位；不沿用旧身份重抽历史。每日下限作为示例当天的初始额度，再叠加该日时段增量。仅扩大区间时沿用原节奏；收紧区间或修改分布须生成新名单，否则返回 `SIMULATION_HISTORY_CONFLICT`，草稿和发布保持不变。

## 可选：重启后保留后台设置

默认内存模式无需增加文件。需要重启保留草稿与发布设置时，在服务器现有 `sub2api-extra` 根目录执行：

```bash
sudo install -d -m 700 -o 1000 -g 1000 usage-leaderboard/settings
```

在 `usage-leaderboard/.env` 增加：

```dotenv
USAGE_LEADERBOARD_SETTINGS_DIR=/app/settings
```

在 `usage-leaderboard/compose.yaml` 的 `usage-leaderboard` 服务内取消模板中的挂载注释：

```yaml
    volumes:
      - ./settings:/app/settings
```

然后从原项目根目录按原项目参数重建仅排行服务：

```bash
docker compose --env-file compose.services.env --profile usage-leaderboard up -d --no-build --no-deps --pull never usage-leaderboard
```

配置目录按官方镜像的 UID/GID `1000:1000` 设置权限；自定义镜像用户不同则相应调整。只新增 `leaderboard-settings.json`，上限 64 KiB，包含一份草稿、当前发布和唯一上一版；原子写入时使用同名 `.tmp`，也最多 64 KiB。不保存请求、历史序列或长期审计日志。其余文件系统仍只读，文件损坏会恢复真实模式并仅在管理员页提示。重启后会话失效，重新登录后版本 4 根据原种子与当前时间继续复算；旧版快照仍只在生成当天有效。只支持单个排行进程管理该文件，不让多个副本并发挂载同一目录。

## 统计口径

| 项目 | 口径 |
| --- | --- |
| Token | `input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens`，与主站用户统计一致；不重复加 5m / 1h 缓存细分字段 |
| 兼容统计 | 后端保留用量记录数及 `metric=requests` 兼容接口，页面不展示也不提供该排序入口；已有发布配置无需重新生成 |
| 参与者 | 未删除且 `status=active`，所选周期有用量记录；默认排除 `admin` / `root`，可配置包含 |
| 同值 | SQL `RANK()` 并列，随后按用户 ID 稳定排序；最多展示 10 人，个人排名可超过 10 |
| 周期 | 配置时区的今日零点、周一零点、每月 1 日零点，到缓存生成时刻；不包含未来记录 |
| 上期 | 上日、上周、上月截至同一日历进度；上月天数不足则截止月末；累计无上期 |
| 百分位 | 排名依据严格低于当前用户的参与者比例；并列者不算被超过 |
| 近 7 天 | 独立于榜单周期，今天及之前 6 个自然日，无请求的日期补零 |
| 常用模型 | 当前用户、所选周期，优先 `requested_model`；最多 4 个模型加“其他”，只显示有 Token 用量的模型并按 Token 计算占比，零 Token 显示空态 |

用户名称统一取注册邮箱 `users.email`，由服务端脱敏：邮箱本地部分最多保留前 2 个字符，其余以固定 `***` 隐藏，域名保留。例如 `apricity@example.com` 显示为 `ap***@example.com`；`ab@example.com` 显示为 `a***@example.com`；`a@example.com` 显示为 `***@example.com`。`+` 别名整体隐藏，短地址仍至少隐藏一个字符；邮箱缺失或无效时使用稳定匿名名称。会话展示信息从主站 `/api/v1/auth/me` 的 `email` 字段获取，使用相同脱敏规则。顶部、领奖台、榜单、个人栏、详情和悬浮提示均使用脱敏结果，完整邮箱不会传到浏览器。

API 只向已登录用户返回 Top 10 的用户头像、脱敏邮箱及汇总用量，不提供完整邮箱、消费金额、余额、Key、逐笔请求或其他用户的模型分布。个人统计仅由当前服务会话中的身份选择，客户端不能请求其他账号。不查询费用字段，也不接受 `metric=cost`。旧 `USAGE_LEADERBOARD_NAME_MODE` 配置已移除，历史配置不会改变邮箱脱敏规则。

## 最小只读权限

可直接复用已有只读角色。要创建独立角色，由数据库管理员执行以下 SQL；这只创建主站的访问角色，不创建新业务数据库或表。按实际数据库名称替换 `sub2api` 和密码：

```sql
CREATE ROLE sub2api_leaderboard LOGIN PASSWORD 'replace-with-a-random-password';
GRANT CONNECT ON DATABASE sub2api TO sub2api_leaderboard;
GRANT USAGE ON SCHEMA public TO sub2api_leaderboard;
GRANT SELECT (id, email, role, status, deleted_at)
    ON public.users TO sub2api_leaderboard;
GRANT SELECT (user_id, created_at, model, input_tokens, output_tokens,
    cache_creation_tokens, cache_read_tokens)
    ON public.usage_logs TO sub2api_leaderboard;
ALTER ROLE sub2api_leaderboard SET default_transaction_read_only = on;
```

如果 `usage_logs` 有 `requested_model`，额外授权：

```sql
GRANT SELECT (requested_model) ON public.usage_logs TO sub2api_leaderboard;
```

如果主站有 `user_avatars` 表，为真实头像额外授权：

```sql
GRANT SELECT (user_id, url) ON public.user_avatars TO sub2api_leaderboard;
```

服务通过 `information_schema.columns` 检查该账号可读的字段，兼容普通表与通过父表读取的分区表。只读角色需要 `users.email` 的 SELECT 权限；原先仅授权 `username` 的账号需补充此权限。头像表不存在或没有上述读取权限时，榜单仍可用并显示默认用户图标。完整邮箱仅在服务端用于脱敏，不读取密码或费用字段。

## 本地开发与验证

```bash
cd usage-leaderboard
npm ci --ignore-scripts
npm run check
npm test
```

PGlite 只属于开发依赖，用于测试专用的内存 PostgreSQL；Docker 生产镜像不安装它，也不包含测试数据。本地运行使用 `npm start` 并读取 `.env`；HTTP 开发时设置 `NODE_ENV=development` 和 `USAGE_LEADERBOARD_COOKIE_SECURE=false`。

测试包含临时内存 PostgreSQL 上的实际查询，覆盖四类 Token、并列、邮箱脱敏与费用排除、时区和历史清理、空榜、双区间交集、真实与模拟混排、个人统计隔离、管理员降权、CSRF、历史重放、跨周期包含关系、整日增长与暂停、跨年及夏令时、长期身份补位、旧版跨天失效、动态发布续接、固定大小文件重启及写入失败。没有测试生成的持久数据库文件。

## 接口与排查

| 接口 | 用途 |
| --- | --- |
| `GET /healthz` | 进程存活；不代表已连通主站或数据库 |
| `GET /readyz` | 数据库连接与必需字段检查；不返回连接信息 |
| `GET /api/auth/config` | 主站浏览器地址、时区及公开展示配置 |
| `POST /api/auth/sso` | 用 Bearer 主站 Token 交换内存会话 |
| `GET /api/auth/me` | 当前会话的展示信息 |
| `POST /api/auth/logout` | 撤销当前会话 |
| `GET /api/leaderboard?period=month&metric=tokens` | Top 10 和当前用户统计；必须已登录 |
| `GET /api/admin/session` | 实时验证管理员身份并提供会话 CSRF Token |
| `GET /api/admin/view` / `GET /api/admin/settings` | 管理员表单、草稿、发布状态及修订号 |
| `POST /api/admin/simulation/preview` | 服务端生成候选；不发布 |
| `GET /api/admin/leaderboard/preview?source=simulation&period=month&metric=tokens` | 草稿与真实用户合并预览；`source=real` 预览真实榜 |
| `PUT /api/admin/settings/draft` | 保存当前草稿 |
| `POST /api/admin/leaderboard/publish` | 发布选定来源 |
| `POST /api/admin/leaderboard/restore-real` / `POST /api/admin/leaderboard/rollback` | 恢复真实 / 回退上一发布 |

`DATABASE_NOT_CONFIGURED` / `DATABASE_UNAVAILABLE` 表示连接未配置或不可达；`SCHEMA_INCOMPATIBLE` 表示字段或权限不足；`QUERY_TIMEOUT` 表示源库聚合超时；`AUTH_REQUIRED` 表示需从主站重新打开页面；`SERVICE_BUSY` / `SESSION_CAPACITY` 表示资源上限已达到。错误不会回退为示例数据，也不会把 SQL 或凭据返回页面。
