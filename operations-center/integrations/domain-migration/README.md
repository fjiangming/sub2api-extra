# 旧域名迁移提示页接入

## 当前上线记录

用户于 2026-11-13 明确要求连接服务器更新。本次已在 `154.36.173.220` 完成备份、整份候选配置检查、独立 Nginx 实测、平滑重载和公网浏览器验收。

- 旧站：`https://epoint2api.fjmooo.cn`。普通 HTML GET / HEAD 导航展示提示，手动跳转至 `https://yunhop.cc` 的相同路径 / 查询参数 / 片段；新旧地址显式显示 `https://`。
- 实际修改：`/etc/nginx/conf.d/migrated-services.conf`，仅增加专用 map、旧域名资源 location 和旧 `location /` 内的提示条件。原所有代理指令逐字保留，其他 Nginx 配置散列相同。
- 静态发布：`/var/www/epoint-domain-migration/800041c3766bd4e844a2/`，四个静态文件，固定资源前缀 `/__domain-migration/`，`no-store`。源自运营中心的独立 Demo 和本地 Lucide，不启动新服务、不修改运营中心或主站容器。
- 安装工具：`/root/sub2api-deploy/tools/domain-migration-20261113-210936/`。
- 实际应用的备份：`/root/sub2api-deploy/backups/epoint-domain-migration-20261113-211911-656979/`。其 `manifest.json` 为 `applied=true`；更早的预检目录不代表已应用。
- 配置原 SHA-256：`01ea47e65735e6947c50eecbe8a434b9e99556a3c86ef74114a7675673a401fb`。安装后 SHA、四个资源 SHA、进程 / 容器基线及源站验证均保存在清单。

主站、运营中心等全部现有容器 ID / StartedAt 相同；Nginx 主 PID 和 x-ui 主 PID 相同。没有改 Sub2API 源码、业务数据库、Cloudflare、证书、443 / 8443 端口或 Xray 配置，没有发起付费调用、真实充值或用户通知。本轮不提交 / 推送 GitHub。

## 保留的流量

API / Codex / 根级 Responses / WebSocket、OAuth 与支付回调 / 返回、邮箱验证 / 重设密码、原有静态资源，以及含 Authorization / Upgrade 的请求保持原代理。未声明 HTML 或不是 GET / HEAD 的请求也保持原行为。提示条件仅在旧站原根 location 内执行，不修改新域名和其他站点。

原服务器维护开关也保持原样；它已使用 418 / 419，本提示独立使用内部 470，避免冲突。若开启原维护开关，维护页仍优先。

提示页自身不识别登录用户。只有继续到达主站并存在可信关联证据的 API 请求，才可能由已启用采集的“域名访问”模块归类；不能把页面访问者直接认领成注册账号。

## 验证

- 生效前 / 后整份 `nginx -t` 通过；在独立 loopback Nginx 进程验证 10 项页面 / HEAD / 资源 / 404 行为，以及 15 项 API、回调、请求方法和新站响应对照。
- 公网旧站首页与深路径返回迁移页，`Cache-Control: no-store, max-age=0`，Cloudflare 为 DYNAMIC；新站仍返回原应用。
- 公网公开设置仍为 200 JSON，未携带 Key 的 `/v1/models`、`/responses`、`/backend-api/codex/responses` 仍为 401 JSON。
- Chrome / Playwright 在 1440 / 390 / 320 像素验证实际页面、样式 / 图标、原路径保留、复制反馈和真实按钮跨域导航；无页面异常、失败资源或整页溢出。复制使用模拟剪贴板，未覆盖用户系统剪贴板；没有使用真实用户登录态或 Key。
- 公网证据为应用备份目录内的 `verification-public.json`。本机截图位于临时 `sub2api-domain-migration-public-vAdJG5`，已复核桌面及手机。

这些检查不等于完成真实付费请求、第三方支付或 OAuth 登录交易的端到端验收；相关代码、代理和业务流程未作修改。

## 回滚

在服务器使用 root 执行：

```bash
python3 /root/sub2api-deploy/tools/domain-migration-20261113-210936/rollback-nginx.py /root/sub2api-deploy/backups/epoint-domain-migration-20261113-211911-656979
```

工具核对当前配置仍等于本次安装结果，并校验原备份，才恢复旧配置、检查和平滑重载。发现后续维护差异会拒绝覆盖。保留静态发布目录和审计文件，不需要停止容器。

## 重新准备

`install-nginx.py` 默认只准备版本目录 / 备份并进行预检，显式 `--apply` 才修改线上配置。必须传入最新只读审查所得的 `--expected-sha256` 和包含四个原始文件的 `--assets-dir`；工具会机械替换 Demo 的资源引用。

已安装站点不会被重复覆盖。后续修改页面 / 路由需重新审查现网并准备增量更新，不能重复执行初次安装命令，也不要覆盖后续配置。手工接入说明见 [`DEPLOYMENT.md`](../../scripts/domain-migration-demo/DEPLOYMENT.md)。
