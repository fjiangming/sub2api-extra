# Infinite Canvas 子服务

独立运行 [fjiangming/infinite-canvas](https://github.com/fjiangming/infinite-canvas) 的静态画布，镜像为 `ghcr.io/fjiangming/infinite-canvas:latest`，宿主机仅监听 `127.0.0.1:9877`。基础画布不需要数据库、数据卷或 Canvas Agent；作品、素材、生成记录和 API 配置仍保存在访问者的浏览器中。

## 在现有 Extra 中启用

根 `docker-compose.yml` 已登记 `./infinite-canvas/compose.yaml`。生产目录只需新增此模块的 `compose.yaml`，在原 `compose.services.env` 的 `COMPOSE_PROFILES` 中追加 `infinite-canvas`，保留原来的所有服务名。

```bash
cd /root/sub2api-extra
docker compose --env-file compose.services.env pull infinite-canvas
docker compose --env-file compose.services.env up -d --no-build --no-deps infinite-canvas
```

需要直接执行不带 `--env-file` 的根目录命令时，先确认根目录没有既有 `.env`，再建立 `.env -> compose.services.env` 相对软链接，使两种命令读取同一份启用列表。本次生产部署使用此方式；其他部署已有 `.env` 时，保留原文件并按自身配置合并启用项。

## 独立域名与模型接口

[Nginx 配置](docs/nginx.conf.example) 适用于当前服务器已有的 Cloudflare HTTPS 到 Nginx 80 端口入口。独立域名为 `canvas.fo2.us.ci`，不会占用现有 443 端口或改变其他站点；其他环境自行配置 HTTPS，不能将此 HTTP 源站模板误当通用 TLS 方案。

将配置作为独立站点放入 `/etc/nginx/conf.d/infinite-canvas.conf`，核对主站内部端口后执行 `nginx -t`，通过后平滑重载。模板把 `/v1/`、`/v1beta/` 固定转发到已有主站 `127.0.0.1:9000`，保留用户自己的 Authorization / Gemini 请求头，禁用请求和流式响应缓冲，沿用现有主站的 100m 请求体与 600 秒反代超时；Cloudflare 自身的等待时限不由此设置延长。其余请求转发到画布。不会使用站点共用 Key、创建资金记录或直接扣余额。

用户打开 `https://canvas.fo2.us.ci/canvas?baseUrl=https%3A%2F%2Fcanvas.fo2.us.ci`，在渠道配置中填自己的 Sub2API Key，拉取并选择该 Key 所在分组实际支持的模型。文本使用 Responses 协议，图片与视频可用性取决于主站分组和上游；成功打开网页不等于已验证收费模型调用。

该页面不接 SSO。主站自定义菜单会附加登录 Token，Nginx 在转发前将包含 `token` / `access_token` / `user_id` 的入口重定向到同路径无查询地址，因此主站凭据不会进入画布容器。入口会一并移除 `baseUrl` 等其他查询参数；从主站菜单进入时用户首次手动填写接口地址即可。站点关闭访问日志，设置 no-referrer，并限制可嵌入的主站来源。主站侧也需要允许该域名的 iframe，使用原生自定义菜单登记会更新相应来源。

当前仍没有按主站账号隔离的浏览器数据，也不会自动跨设备同步；同一浏览器切换主站账号仍会使用原工作区。可选 WebDAV 保持上游行为。

## 当前部署结果

已在 `/root/sub2api-extra` 部署 `sub2api-infinite-canvas`，独立入口为 [无限画布](https://canvas.fo2.us.ci/canvas)。主站自定义菜单已追加用户可见“无限画布”，复用现有菜单功能和 iframe 白名单，不需要修改主站源码；原有菜单、主站设置和其他容器保持原状。

发布来源为 fork 提交 `7676c01526119080f5a373aff3c3cd861cc422e2`，对应 [镜像构建](https://github.com/fjiangming/infinite-canvas/actions/runs/41474449809) 已成功。已验证容器健康、公网页面及静态资源、无 Key 的 API 鉴权、入口参数清理、桌面画布操作 / 刷新保存和内嵌加载。手机能加载及保存，但原版编辑侧栏和工具栏较拥挤，建议电脑使用。没有使用真实 Key 调用收费模型，实际模型能力需按用户分组配置。

原生产配置及菜单备份位于 `/root/sub2api-deploy/backups/infinite-canvas-20261102`；其中包含敏感原配置，保持目录权限 0700、文件 0600，不对外分发。

## 后续统一更新

fork 的 `main` 提交会自动构建 Linux amd64 / arm64 镜像；两种架构构建成功后发布 `latest`、短提交标签及 `sha-<完整提交>`。GHCR 包需公开，服务器无需保存 GitHub Token。服务器不会自动跟随上游原作者，需先将希望采用的更新同步到自己的 fork 并等待 Actions 成功。

在生产 Extra 根目录执行以下命令即可覆盖所有已启用的子服务，包括画布：

```bash
docker compose pull
docker compose up -d --no-build
```

`pull` 只下载镜像，后续 `up` 才会应用更新。没有根 `.env` 链接的部署，两条命令均显式添加 `--env-file compose.services.env`。

只更新画布可使用第一节的两条命令。回滚时，在根环境配置中设置 `INFINITE_CANVAS_IMAGE=ghcr.io/fjiangming/infinite-canvas:sha-<目标完整提交>`，再拉取并仅重建 `infinite-canvas`。
