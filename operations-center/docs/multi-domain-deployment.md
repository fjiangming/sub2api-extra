# yunhop.cc 新旧域名并存部署

适用服务器 `154.36.173.220`。用户授权给现有服务增加新域名，并保留旧域名；3X-UI、订阅管理与 Xray 节点排除，不修改它们的配置、证书、端口或进程。内部 PostgreSQL 和 Redis 不新增公网入口。本文不包含私钥、服务器密码或业务凭据。

当前按用户最终安排保留 Cloudflare 到源站的 HTTP 回源，不修改 Cloudflare 配置、不切换流量。新域名的 80 与 8443 共用相同 Nginx 路由，80 直接代理业务，避免 HTTP 回源时整站重定向循环；8443 和证书仅为后续 HTTPS 回源做准备。浏览器仍以 HTTPS 访问 Cloudflare，应用来源白名单与 Secure Cookie 以浏览器的 HTTPS 地址为准，与回源协议独立。应用代码由本轮推送至 extra main，镜像更新由用户自行执行。

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

降智检测本来就接受不同主站嵌入；New API、CLIProxyAPI、卡密同步和 Syncthing 已验证可以响应新 Host，不需要为域名变更更新其程序。画布应用使用相对资源路径，此轮只调整 Nginx 的来源白名单和固定旧域名重定向。画布历史保存在浏览器，域名不同的浏览器存储不会自动合并；旧入口继续可用。

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

主站保留 `proxy_ignore_client_abort on`、1860 秒间隔超时、关闭请求 / 响应缓冲、维护开关、`/monitor/` 与 `/canvas/`。新代理保留外部 HTTPS 协议和客户端地址，支持 WebSocket Upgrade。画布静态代理不转发主站 Cookie、Authorization 或 Referer；API 转发仍使用固定本机 Sub2API 后端。

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
| `eshop` | 卡密同步 | 2050 |
| `sync` | Syncthing 管理界面 | 8384 |

2. 在“规则 → 源站规则”创建规则，使用以下表达式匹配本次明确增加的入口，将目标端口重写为 **8443**；不要改 Host、SNI 或浏览器 URL。

```text
http.host in {"yunhop.cc" "www.yunhop.cc" "newapi.yunhop.cc" "cpa.yunhop.cc" "monitor.yunhop.cc" "subopc.yunhop.cc" "detector.yunhop.cc" "aihubpay.yunhop.cc" "aihubrank.yunhop.cc" "canvas.yunhop.cc" "eshop.yunhop.cc" "sync.yunhop.cc"}
```

3. 将该区域的 SSL/TLS 加密模式设为 **完全（严格）/ Full (strict)**，可开启 Always Use HTTPS。对主站动态 API、后台、充值和排行榜不配置 Cache Everything；页面原有 no-store 规则继续生效。
4. 服务端和浏览器都通过公开 HTTPS 地址逐一验收，核对新站正常、旧站仍正常、登录 / 嵌入 / CSRF / 重定向和静态资源。保留 Syncthing 原文件同步端口，HTTPS 入口只代理管理界面。

只有 DNS 解析或站点首页成功不代表完整业务验收。未经实际付款不宣称支付端到端完成；不通过付费模型请求验证本次域名兼容。

参考：[Cloudflare Origin Rules](https://developers.cloudflare.com/rules/origin-rules/)、[支持的代理端口](https://developers.cloudflare.com/fundamentals/reference/network-ports/)。

## 当前执行记录

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
