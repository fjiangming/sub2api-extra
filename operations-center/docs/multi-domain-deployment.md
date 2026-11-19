# yunhop.cc 新旧域名并存部署

适用服务器 `154.36.173.220`。用户授权给现有服务增加新域名，并保留旧域名；3X-UI、订阅管理、Xray 节点、Eshop 和 Syncthing 排除，不修改它们原有配置、证书、端口或进程。内部 PostgreSQL 和 Redis 不新增公网入口。本文不包含私钥、服务器密码或业务凭据。

用户已确认方案：直接在原 4 份 Nginx 服务文件的 `server_name` 追加新域名，复用原 server 的全部业务属性，删除独立 `yunhop-services.conf` 和无用的 `yunhop-proxy.conf`。完整文件、差异与结构核对在 [`original-files/README.md`](../integrations/multi-domain/original-files/README.md)。Eshop 和 Syncthing 保留原 IP + 端口方式，不新增域名；默认 TLS 拒绝入口移至原 migrated-services.conf 末尾。实际应用结果见文末执行记录。

用户已在排查525后自行将 yunhop.cc 区域设为自动 SSL/TLS，公开 HTTPS 已恢复200；本次没有由工具更改 Cloudflare。此前保留HTTP回源的服务器准备继续有效：新域名的80与8443共用相同 Nginx 路由，80直接代理业务，避免 HTTP 回源时整站重定向循环。尚未配置目标端口8443的源站规则，独立8443证书入口仍用于后续明确切换加密回源。浏览器以 HTTPS 访问 Cloudflare，应用来源白名单与 Secure Cookie 以浏览器的 HTTPS 地址为准，与回源协议独立。应用代码此前已推送 extra main，镜像更新由用户自行执行。

## 应用兼容

充值中心、供应商监控、运营中心和排行榜新增可选 `SUB2API_PUBLIC_URLS`，使用逗号分隔明确的主站 Origin，自动保留旧 `SUB2API_PUBLIC_URL`。生产别名必须是 HTTPS 根地址，不支持通配符、账号、路径、查询和片段。列表只用于页面嵌入权限，不修改 `SUB2API_BASE_URL`、后台认证或自动计费编排；供应商监控的跨域 API 仍由原独立配置管理。

四个服务在各自 `.env` 中追加：

```dotenv
SUB2API_PUBLIC_URLS=https://yunhop.cc,https://www.yunhop.cc,https://epoint2api.fjmooo.cn,https://aihubdirect.fo2.us.ci
```

充值中心另追加：

```dotenv
RECHARGE_CENTER_PUBLIC_URLS=https://aihubpay.yunhop.cc
```

原 `RECHARGE_CENTER_PUBLIC_URL` 自动保留，继续用于生成标准付款中转地址，避免影响已有二维码；别名域名同样能打开原订单路径。别名请求仍需合法来源、本人会话、CSRF 和原角色权限。Cookie 不设置共享 Domain，用户在新域名重新进入主站菜单完成 SSO。二维码仅接受白名单域名和原高熵订单路径。

降智检测本来就接受不同主站嵌入；New API 和 CLIProxyAPI 可以响应新 Host，不需要为域名变更更新其程序。画布应用使用相对资源路径，保留原 Nginx 静态 / 模型代理规则。画布历史保存在浏览器，域名不同的浏览器存储不会自动合并；旧入口继续可用。Eshop 和 Syncthing 不新增域名。

服务镜像保持 `ghcr.io/fjiangming/sub2api-extra:<服务名>-latest` 的 fork 发布通道。用户已授权本轮提交推送到 extra `main`，镜像更新由用户自行操作；须等对应完整 SHA 的 Actions / 镜像成功，再只拉取并更新这四个服务。不得直接替换正在运行的容器源码、伪造官方镜像标签或绕过构建门禁。主站与画布镜像无需为本次变更升级。

用户更新时先查看本次提交的 [Docker images 工作流](https://github.com/fjiangming/sub2api-extra/actions/workflows/docker-publish.yml)，确认对应 SHA 成功，再在服务器执行拉取：

```bash
cd /root/sub2api-extra
docker compose --env-file compose.services.env pull recharge-center provider-monitor operations-center usage-leaderboard
docker image inspect ghcr.io/fjiangming/sub2api-extra:recharge-center-latest ghcr.io/fjiangming/sub2api-extra:provider-monitor-latest ghcr.io/fjiangming/sub2api-extra:operations-center-latest ghcr.io/fjiangming/sub2api-extra:usage-leaderboard-latest --format '{{json .RepoTags}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

核对四个 revision 均为本次提交 SHA 后更新这四个服务，保留其他正在运行的服务：

```bash
docker compose --env-file compose.services.env up -d --no-deps --no-build --pull never --wait --wait-timeout 180 recharge-center provider-monitor operations-center usage-leaderboard
docker compose --env-file compose.services.env ps recharge-center provider-monitor operations-center usage-leaderboard
```

服务器已备好本轮 `.env`，无需修改 Cloudflare 或主站设置。服务重建后浏览器会话需重新从主站进入；持久数据卷和原标准 URL 保留。若拉取 / 健康检查失败，应先检查本次镜像和日志，不重复执行未限定服务的全量更新。

环境安装工具 `operations-center/integrations/multi-domain/install-app-env.py` 默认仅生成根用户可读候选、原文件备份及清单；先解析完整生产 Compose 和候选覆盖，要求唯一差异为上述四服务的指定环境白名单。`--apply` 才原子更新四份 `.env`，保留原属主 / 权限，遇到已有不同别名或并发修改立即停止；校验失败恢复本次 env。不打印完整 Compose / 环境值，不重启容器，运行中的旧进程不会因此提前取得新配置。备份位于 `/root/sub2api-deploy/backups/yunhop-app-env-<北京时间>/`。

```bash
python3 /root/sub2api-extra/domain-compat-nginx/install-app-env.py
python3 /root/sub2api-extra/domain-compat-nginx/install-app-env.py --apply
```

## 独立源站 TLS

用户在 Cloudflare 签发的源站证书覆盖 `yunhop.cc` 和 `*.yunhop.cc`，只用于新 Nginx 入口。服务器路径：

- `/etc/nginx/ssl/yunhop.cc/origin.pem`：公开证书。
- `/etc/nginx/ssl/yunhop.cc/origin.key`：配套私钥，目录 0700、文件 0600。
- `/etc/nginx/ssl/yunhop.cc/cloudflare-origin-ca.pem`：Cloudflare 官方 Origin RSA CA。

上传前核对证书 / 私钥配对和 CA 签名；上传后用 OpenSSL 校验主机名及有效期。此前生成的备用私钥及 CSR 已按用户要求删除。Cloudflare 源站证书用于边缘到源站验证，浏览器通过 Cloudflare 边缘证书访问普通 HTTPS 地址。

新入口同时支持 Nginx 80 HTTP 与 8443 TLS，二者共用明确 Host、后端与路径规则；80 不强制跳转 HTTPS，443 仍由既有 Xray 监听。模板及安装工具位于 `operations-center/integrations/multi-domain/`；服务器工具副本位于 `/root/sub2api-extra/domain-compat-nginx/`。

```bash
# 默认只生成候选和校验记录，不替换生产 Nginx 文件。
python3 /root/sub2api-extra/domain-compat-nginx/install-nginx.py
# 用户已授权后安装：先备份，校验整份候选，再原子替换并平滑重载。
python3 /root/sub2api-extra/domain-compat-nginx/install-nginx.py --apply
```

工具保存旧文件、权限、散列、容器身份和排除服务配置散列，失败时回滚本次安装的文件；不重启容器。备份位于 `/root/sub2api-deploy/backups/yunhop-domain-<北京时间>/`。`manifest.json` 的 applied 字段才代表应用过配置，候选校验目录本身不表示已上线。未来回滚前应比对 after 散列，避免覆盖后续维护。

主站保留 `proxy_ignore_client_abort on`、1860 秒间隔超时、关闭请求 / 响应缓冲、维护开关、`/monitor/` 与 `/canvas/`。各站的 HTTP 版本、转发头、Connection / Upgrade、缓存和日志按对应旧站原值保留；画布静态代理不转发主站 Cookie、Authorization 或 Referer，API 转发仍使用固定本机 Sub2API 后端。

## 在原文件追加域名

直接在下列原 server 中追加域名，并引入此前要求的独立 8443 TLS include。原有 proxy_pass、请求头、超时、缓存、日志和接口限制不复制到另一套 server；新旧域名自然复用同一份业务指令。4 份原文件的其他业务内容和全局设置保持原值，旧域名完整保留。用户已确认执行，安装工具先比对原文件散列，备份并校验后才应用。

| 旧 Nginx 站点 | 对应新入口 |
| --- | --- |
| `aihub.fo2.us.ci` | `yunhop.cc`、`www.yunhop.cc` |
| `aihub.fo1.us.ci` | `newapi.yunhop.cc` |
| `cpa.fjmooo.cn` | `cpa.yunhop.cc` |
| `monitor.fo2.us.ci` | `monitor.yunhop.cc` |
| `subopc.fo2.us.ci` | `subopc.yunhop.cc` |
| `detector.fo2.us.ci` | `detector.yunhop.cc` |
| `aihubpay.fo2.us.ci` | `aihubpay.yunhop.cc` |
| `aihubrank.fo2.us.ci` | `aihubrank.yunhop.cc` |
| `canvas.fo2.us.ci` | `canvas.yunhop.cc` |

比较范围包括所有嵌套 location / if / limit_except、include、body 限制、proxy_pass、请求头、HTTP 版本、超时、缓冲 / 缓存、日志路径 / 格式 / 级别、响应头、维护和重定向。保留 New API 的 `/api/setup` 仅 GET、充值与排行榜的 no-store / private 和原命名 upstream。主站以原 aihub 站点为基线；epoint 与直连站点原有不同参数保持原值。TLS snippet 仅保留证书、8443 监听、TLS 协议 / 会话及 `port_in_redirect off`，防止回源端口进入公开 Location。

Eshop 与 Syncthing 保留原 IP + 端口访问，移除先前新增的两个域名代理。独立 `yunhop-services.conf` 整体删除，原 9 个域名 server 并入上述原文件，默认 TLS 拒绝入口移至 migrated-services.conf 末尾，专用于独立代理的 map / yunhop-proxy.conf 不再保留。主站 `/monitor` 相对跳转保留原值，HTTP / TLS 分别采用对应原协议，TLS 不暴露 8443。原旧域名业务指令完整结构比较必须通过后才能安装。

## 画布渠道模型列表

从新主站菜单打开的画布，可能仍位于旧主站 `https://aihub.fo2.us.ci/canvas/`；配置接口 `https://yunhop.cc/` 是合法地址，末尾斜杠会被规范化。需要填写本人 Sub2API API Key，不能用网页登录 Token 代替；OpenAI 兼容格式读取 `/v1/models`，Gemini 格式读取 `/v1beta/models`。

为保留旧菜单和浏览器作品，Nginx 模型 API 使用明确的 HTTPS Origin 白名单兼容跨域：旧主站、直连、epoint、新主站 / www 和旧新独立画布共7项。范围仅主站与独立画布的 `/v1/`、`/v1beta/`，不涉及登录管理 API。允许的预检返回204，真实模型请求仍须 API Key 鉴权，不开启跨域 Cookie、通配符 Origin 或站点共用 Key；外域 / null 来源不获授权。

主站原代理指令由 `sub2api-main-proxy.conf` 复用，`canvas-api-cors.conf` 仅管理上述 API 的 CORS。原上游、Host、请求头、超时、缓冲、防取消及独立画布安全头保持；无需更新画布或主站镜像。模型列表成功不代表已执行付费生成，实际可见模型仍取决于 Key 所属分组。

## 后续切换 Cloudflare HTTPS 回源

以下仅为未来切换步骤，当前不执行、不要求用户立即更改。届时由用户在 `yunhop.cc` 区域操作，保留原域名区域。切换前重新验证证书有效、8443 可连及目标应用镜像 / 白名单已更新；切换后仍保留 80 入口，因此回退只需恢复该区域原回源模式 / 端口规则，业务程序无需随协议切换再次修改。

1. DNS 中给下列名称添加 A 记录，地址均为 `154.36.173.220`，代理状态为橙云。若已有同名记录，核对 / 更新，不重复创建；源站没有可用 IPv6 时不要添加指向源站的 AAAA 记录，橙云自动返回的 IPv6 不属于源站 AAAA。

| DNS 名称 | 服务 | 本机后端端口 |
| --- | --- | --- |
| `@`、`www` | Sub2API 主站 | 9000 |
| `newapi` | New API | 3000 |
| `cpa` | CLIProxyAPI | 8317 |
| `monitor` | 供应商监控 | 9871 |
| `subopc` | 运营中心 | 9872 |
| `detector` | 降智检测 | 9873 |
| `aihubpay` | 充值中心 | 9874 |
| `aihubrank` | 用量排行 | 9876 |
| `canvas` | 画布 | 9877 |

2. 在“规则 → 源站规则”创建规则，使用以下表达式匹配本次明确增加的入口，将目标端口重写为 **8443**；不要改 Host、SNI 或浏览器 URL。

```text
http.host in {"yunhop.cc" "www.yunhop.cc" "newapi.yunhop.cc" "cpa.yunhop.cc" "monitor.yunhop.cc" "subopc.yunhop.cc" "detector.yunhop.cc" "aihubpay.yunhop.cc" "aihubrank.yunhop.cc" "canvas.yunhop.cc"}
```

3. 将该区域的 SSL/TLS 加密模式设为 **完全（严格）/ Full (strict)**，可开启 Always Use HTTPS。对主站动态 API、后台、充值和排行榜不配置 Cache Everything；页面原有 no-store 规则继续生效。
4. 服务端和浏览器都通过公开 HTTPS 地址逐一验收，核对新站正常、旧站仍正常、登录 / 嵌入 / CSRF / 重定向和静态资源。Eshop 与 Syncthing 维持原 IP / 端口访问，不在切换范围。

只有 DNS 解析或站点首页成功不代表完整业务验收。未经实际付款不宣称支付端到端完成；不通过付费模型请求验证本次域名兼容。

参考：[Cloudflare Origin Rules](https://developers.cloudflare.com/rules/origin-rules/)、[支持的代理端口](https://developers.cloudflare.com/fundamentals/reference/network-ports/)。

## 当前执行记录

以下含前期部署历史；最新的原文件合并替代前期独立模板，最终仅保留上述 10 个新主机名，Eshop / Syncthing 不新增域名。

- 2026-11-08，已修复旧域画布请求新域 API 的 CORS403：主站及独立画布模型路径增加明确来源的预检 / 响应许可，实际备份 `/root/sub2api-deploy/backups/yunhop-domain-20261108-140303-355769/`，候选 / 生效 nginx -t及平滑重载通过。116项 HTTP / TLS / 公网检查全通过，真实浏览器旧画布→新 API和反向均可读取401 INVALID_API_KEY，外域仍被浏览器拦截；只使用无效诊断 Key，未代用真实用户 Key 或进行付费请求。原代理业务 / 安全头等价比较通过；容器、主进程、排除配置保持。诊断详情在备份 verification-canvas-cors.json 及 browser-before / after.json。

- 最新525状态更新：用户自行将区域设为自动 SSL/TLS 后，yunhop.cc、aihubpay / monitor / subopc / aihubrank / canvas.yunhop.cc 及旧主站 aihub.fo2.us.ci 共7个公开 HTTPS 入口全部200。此前525时已抓包确认 Cloudflare 的 HTTPS 请求到达源站443而非8443；此次恢复仅做只读验证，无额外服务器改动，也未配置8443源站规则。下列525观测保留为历史，不再代表当前公网状态。

- 最新合并已于北京时间 2026-11-07 23:32 应用。4 份原文件仅追加域名 / TLS include，并在 migrated-services.conf 末尾接收默认 TLS 拒绝入口；完整业务指令树与新鲜原文件快照一致。TLS snippet 已去除通用业务覆盖，`/etc/nginx/conf.d/yunhop-services.conf` 与无用 `/etc/nginx/snippets/yunhop-proxy.conf` 已删除，服务器操作目录的对应旧模板也已备份后删除。
- 本次原文件备份：`/root/sub2api-deploy/backups/yunhop-domain-20261107-233235-631714/`。`manifest.json` 为 applied=true，`verification-original-files.json` 保存 64 项访问检查及运行状态，`operator-cleanup.json` 记录旧模板清理。预演备份 `yunhop-domain-20261107-233037-718192` 仅校验，不表示安装。
- 候选和生效 `nginx -t` 均通过，无重复域名，已平滑重载。64 项检查全部通过：10 新主机名 HTTP / TLS 各 1 次、11 旧 Host 源站、10 原公网入口、主站监控 / 画布及资源、无 8443 的跳转、New API 初始化接口限制及充值 / 排行不缓存响应。TLS 校验使用官方 Origin CA 和实际 SNI，不使用跳过证书验证；外部客户端连接真实 IP8443，验证 TLS1.3 和 HTTP200 成功。安装工具再次运行返回 already_applied，不重复重载或重建独立文件。
- 15 个容器 ID / 启动时间 / 配置散列、Nginx master1008、Xray3934993 的 443 监听、排除服务配置保持不变。Eshop2050 和 Syncthing8384 原入口前后均 200；未注册两个新域名，8443 对其 SNI 默认拒绝。不更新应用容器、镜像、Cloudflare 或业务数据；未进行付款或付费推理验收。
- 最新公开观测 yunhop.cc 仍为 Cloudflare 525，源站 HTTP80 / TLS8443 已通过。此任务按用户要求仅准备兼容，Cloudflare 端未变；后续须按上文切换流程处理并完成公开 HTTPS 及浏览器业务验收。

- 2026-11-07，证书已安装并通过配对、官方 CA 签名、主机名和有效期验证；备用私钥 / CSR 已删除。
- 原始配置备份：`/root/sub2api-deploy/backups/yunhop-domain-20261107-203355-411132/before/`。完整清单在对应目录 `manifest.json`；该目录中的 before 才是改造前配置。
- TLS 阶段补充备份：`/root/sub2api-deploy/backups/yunhop-domain-20261107-203549-931904/`，修复相对跳转暴露 8443 的问题；这个目录的 before 是第一次安装后的状态，不可当作改造前备份。
- 用户确认保留 HTTP 回源后的最终备份：`/root/sub2api-deploy/backups/yunhop-domain-20261107-220441-826433/`，80 与 8443 共用路由，取消新域名 80 的整站 HTTPS 跳转，保留明确的 HTTPS 子路径 / 参数清理跳转。该目录 `verification-dual-protocol.json` 记录 34 项真实源站检查全部通过；12 主机名页面和两项主站子路径分别在两种协议返回 200，三类跳转分别在两种协议指向相同、无 8443 的 HTTPS 地址。
- 五份 Nginx 文件已经安装和平滑重载，Nginx master PID 保持 1008，Xray PID 保持 3934993、仍监听 443；15 个容器均未重启，排除服务的配置 / 证书散列保持一致。
- 12 个新主机名逐一通过源站 SNI + 官方 CA 验证；主站 `/canvas/`、`/monitor/` 返回 200。外部客户端到服务器 8443 验证 TLS 1.3 成功。`/canvas`、`/monitor` 和画布参数清理的 Location 均为无 8443 的普通 HTTPS 地址。旧主站、epoint、画布、运营 / 充值健康接口返回 200。
- 本地四服务完整测试共 958 项通过（充值 160、运营 376、监控 341、排行 81）；三服务 check 和监控变更文件语法检查通过。没有实际付款或收费推理请求。
- 环境候选预演备份：`/root/sub2api-deploy/backups/yunhop-app-env-20261107-204456-438825/`；实际 env 安装备份：`/root/sub2api-deploy/backups/yunhop-app-env-20261107-204600-493551/`。四份 env 已追加指定域名白名单，完整 Compose 比较仅目标变量变化，原属主 / 0600 权限保持，15 个容器均未重启。回滚配置应比对 after 散列后从 before 恢复，单独恢复 env 不会恢复运行镜像。
- 四个生产应用仍是旧 revision `4c87e2bbdde3336eaf806d8a36647d2fef97a15d`，运行中的旧进程尚未取得新增环境白名单；主站 / 画布镜像未更新。用户授权本轮提交推送，随后自行更新镜像；更新前按本轮完整 SHA 核验四个新镜像。
- 用户明确暂不修改 Cloudflare，保留当前 HTTP 回源，仅准备未来 HTTPS。新域名 80 入口同步修正为直接代理，避免回源跳转循环，8443 继续可用。主站菜单保留旧域名绝对地址；源站成功不等于尚未切换的边缘和浏览器业务已成功。
- 最终公网复核原主站 / epoint / New API / CLIProxyAPI / 监控 / 运营 / 检测 / 充值 / 排行 / 画布共 10 个现有入口全部 200；新根域 yunhop.cc 当时仍为边缘 525，当前未修改其 Cloudflare 配置，不能声称新域公网已完成验收。应用四服务代码验证沿用已通过的 958 项测试；双协议适配未再次改动应用源码。
