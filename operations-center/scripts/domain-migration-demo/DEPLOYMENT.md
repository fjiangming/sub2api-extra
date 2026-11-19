# 迁移提示页的服务器接入步骤

目标：浏览器访问旧域名 `https://epoint2api.fjmooo.cn` 的普通网页时展示提示，手动前往 `https://yunhop.cc` 的对应路径；API、静态资源及第三方回调继续按原规则处理。

用户随后明确授权，已于 2026-11-13 使用独立安装工具完成部署及公网验收。实际版本、完整规则、备份与受控回滚命令见 [上线记录](../../integrations/domain-migration/README.md)。**不要向已经生效的站点重复添加下方规则。**

下方保留手工接入原理，供新的环境审查参考。生产实际使用扩展的 API / 回调放行范围和 Authorization / Upgrade 保护；原维护开关已占用 418 / 419，因此提示页使用独立 470。当前静态文件也采用版本目录，以实际清单为准。

之前只读排查记录的旧域名配置位于 `/etc/nginx/conf.d/migrated-services.conf`，其 `server_name epoint2api.fjmooo.cn;` 有独立的 `location /`，转发到 `127.0.0.1:9000`。先检查当前文件是否仍如此；不整份覆盖该文件，其中还有其他服务。

## 1. 上传静态页面

在本机 Windows PowerShell 执行。`ssh` / `scp` 会交互请求密码，不把密码写进命令。

```powershell
$migrationDemo = 'E:\workspace\interestspace\sub2api-extra\operations-center\scripts\domain-migration-demo'
$migrationIcons = 'E:\workspace\interestspace\sub2api-extra\operations-center\node_modules\lucide\dist\umd\lucide.min.js'
ssh root@154.36.173.220 'install -d -m 755 /var/www/epoint-domain-migration'
scp "$migrationDemo/index.html" "$migrationDemo/demo.css" "$migrationDemo/demo.js" root@154.36.173.220:/var/www/epoint-domain-migration/
scp "$migrationIcons" root@154.36.173.220:/var/www/epoint-domain-migration/
ssh root@154.36.173.220
```

上传前确认本机四个文件存在；Lucide 来自运营中心已安装的依赖。若服务器上该目录已被其他用途占用，换一个专用目录并同步调整下方 `alias`。上传不等于切换旧站，只有最后重载配置后才生效。

## 2. 在服务器处理资源路径

以下都是服务器上的 Bash 命令。把页面的 CSS、JS 和图标引用改成固定路径，这样旧域名的 `/dashboard`、`/users/123` 等深路径也能正常加载。不会改变浏览器地址栏，因此原路径、查询参数及片段仍能由页面脚本保留。

```bash
sed -i \
  -e 's|href="demo.css"|href="/__domain-migration/demo.css"|' \
  -e 's|src="demo.js"|src="/__domain-migration/demo.js"|' \
  -e 's|src="../../node_modules/lucide/dist/umd/lucide.min.js"|src="/__domain-migration/lucide.min.js"|' \
  /var/www/epoint-domain-migration/index.html

chmod 755 /var/www/epoint-domain-migration
chmod 644 /var/www/epoint-domain-migration/index.html /var/www/epoint-domain-migration/demo.css /var/www/epoint-domain-migration/demo.js /var/www/epoint-domain-migration/lucide.min.js
```

这是独立静态目录，不需要安装 Node、运行页面服务或更新 Docker 镜像。

## 3. 检查并备份现有 Nginx 配置

```bash
nginx -t
migration_backup="/root/epoint-migration-backup-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$migration_backup"
cp -a /etc/nginx/conf.d/migrated-services.conf "$migration_backup/migrated-services.conf"
printf 'Backup: %s\n' "$migration_backup"
nano /etc/nginx/conf.d/migrated-services.conf
```

如果修改前 `nginx -t` 已报错，先解决原有配置问题。记下输出的备份目录，回滚时需要。检查当前旧域名是否还有其他生效的 HTTP / HTTPS server；只对实际承接旧域名网页流量的块增加接入，避免漏配或重复定义。

## 4. 增加网页判定及静态目录

在该文件的顶层、所有 `server {}` 外，增加以下 map。它们处于 Nginx 的 `http` 上下文，不放进 `server` 或 `location`。

```nginx
map "$request_method:$http_accept" $epoint_migration_html {
    default 0;
    ~*^(GET|HEAD):.*text/html 1;
}

map $uri $epoint_migration_exempt {
    default 0;
    ~^/(api|v1|v1beta|backend-api|responses|chat|images|realtime|openai|antigravity|gemini|auth|oauth|payment|pay|payments|webhooks?|notify|callback|assets|static)(/|$) 1;
    ~^/(email-verify|reset-password)(/|$) 1;
    ~^/__domain-migration/ 1;
    ~*(callback|webhook|notify) 1;
}

map "$http_authorization:$http_upgrade" $epoint_migration_credentials {
    default 1;
    ":" 0;
}

map "$epoint_migration_html:$epoint_migration_exempt:$epoint_migration_credentials" $epoint_migration_show {
    default 0;
    "1:0:0" 1;
}
```

放行列表是接入示例，必须对照实际业务核对。尤其检查支付平台通知 / 返回地址、OAuth 回调、订阅服务、WebSocket 及全部模型协议路由；不在列表内的路径应先补充明确的放行规则。不要仅凭 URL 是否包含 `callback` 推断已经覆盖所有第三方回调。

找到且只修改 `server_name epoint2api.fjmooo.cn;` 所属的 server。在其内部，和原 `location /` 平级，增加静态资源入口：

```nginx
location ^~ /__domain-migration/ {
    alias /var/www/epoint-domain-migration/;
    add_header Cache-Control "no-store" always;
}
```

然后在该 server **已有的** `location / {` 内、原代理指令之前增加：

```nginx
error_page 470 =200 /__domain-migration/index.html;
if ($epoint_migration_show) { return 470; }
```

保留原 `location /` 中的全部 `proxy_pass`、请求头、超时、缓冲和其他代理指令，不新建第二个 `location /`。这里只使用 `if + return`；错误页在 Nginx 内部切换到独立静态入口，不向浏览器发送跨域 301 / 302。

普通浏览器导航通常发送 `Accept: text/html`。非 HTML 请求和非 GET / HEAD 请求不展示中间页；被放行的 API / 回调仍走原代理。故意请求 HTML 的非标准 API 客户端仍需由路径放行规则保护。这里不提供“任何 HTTP 请求都替换成 HTML”的策略。

不要将规则加进 `yunhop.cc` 的 server，也不要修改共用主站代理 snippet。保留旧域名 DNS、Cloudflare 和 HTTPS 入口；既有记录显示源站 443 由 Xray 使用，本方案不新增 443 监听、不更换证书或 Cloudflare SSL 模式。

## 5. 检查后平滑生效

先查看差异，确认只增加上述 map 和旧域名规则，没有删除其他服务配置：

```bash
diff -u "$migration_backup/migrated-services.conf" /etc/nginx/conf.d/migrated-services.conf
nginx -t
```

`diff` 在有变化时返回 1 属正常；`nginx -t` 必须明确成功。失败则不要重载，按第 7 步恢复。成功后执行：

```bash
systemctl reload nginx
systemctl is-active nginx
```

这是平滑重载，不重启 Sub2API、运营中心或其他 Docker 容器。

## 6. 验证源站和公网

先在服务器验证本地 HTTP 入口：

```bash
curl -sS -H 'Host: epoint2api.fjmooo.cn' -H 'Accept: text/html' http://127.0.0.1/dashboard
curl -sSI -H 'Host: epoint2api.fjmooo.cn' http://127.0.0.1/__domain-migration/demo.css
curl -sSI -H 'Host: epoint2api.fjmooo.cn' http://127.0.0.1/__domain-migration/demo.js
curl -sSI -H 'Host: epoint2api.fjmooo.cn' http://127.0.0.1/__domain-migration/lucide.min.js
curl -sS -D - -H 'Host: epoint2api.fjmooo.cn' -H 'Accept: text/html' http://127.0.0.1/api/v1/settings/public
curl -sS -D - -H 'Host: epoint2api.fjmooo.cn' -H 'Accept: text/html' http://127.0.0.1/v1/models
```

预期普通网页是迁移页，三个资源是正确的 CSS / JavaScript 内容类型而非 HTML；公开设置仍按主站原接口返回，未携带 Key 的模型列表应按原鉴权规则拒绝，不能返回迁移页。这里不使用真实用户 Key、不发起付费模型调用。

再在浏览器打开：

- `https://epoint2api.fjmooo.cn/`
- `https://epoint2api.fjmooo.cn/dashboard?tab=usage#today`
- `https://yunhop.cc/`

旧域名首页及深路径都应有完整样式 / 图标；点击前往应到新站相同路径、查询参数及片段；复制是完整 HTTPS 地址。新域名应继续打开主站。检查开发者工具没有资源 404 或 CSP 阻断，并用桌面及手机验收。

另对照真实回调路径完成不产生资金变更的检查。不要为验收发起真实充值或伪造有效支付通知。若边缘仍显示旧缓存，只清理旧域名相关缓存；源站校验通过不等于公网或业务链路已通过。

## 7. 回滚

使用第 3 步保存的确切备份目录；下方变量仅在原 SSH 会话中存在。另开会话时先将其设置为之前输出的目录。

```bash
cp -a "$migration_backup/migrated-services.conf" /etc/nginx/conf.d/migrated-services.conf
nginx -t
```

恢复配置检查成功后：

```bash
systemctl reload nginx
```

本次没有修改其他配置文件，恢复这份文件即可撤下迁移提示规则，旧域名重新按原代理工作。静态目录可以先保留，不必删除。若备份后已有其他维护改动，应只撤回本次增加的规则，不能用旧备份覆盖后续变更。

## 与访问统计的关系

这个提示页本身不识别用户。域名访问模块的可信身份来自到达主站并产生关联证据的请求。保留 API 代理，才能继续观察哪些 API 用户仍在使用旧域名；只加载迁移页的浏览器访问通常仍是匿名线索，不能因此认定为某个注册用户。
