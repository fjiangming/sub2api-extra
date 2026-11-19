# 原配置追加新域名

用户已确认将新域名直接并入原 Nginx 文件，Eshop 和 Syncthing 维持原 IP + 端口访问，不新增域名。独立 `yunhop-services.conf` 及不再使用的 `yunhop-proxy.conf` 删除。Cloudflare 和应用容器不在本次更新范围内。

## 完整候选文件

| 本目录文件 | 对应的服务器文件 | 修改内容 |
| --- | --- | --- |
| [migrated-services.conf](migrated-services.conf) | `/etc/nginx/conf.d/migrated-services.conf` | 在 6 个原 server 追加新域名和 TLS include，末尾增加 8443 默认 TLS 拒绝入口；epoint / 直连 server 保留原值。 |
| [recharge-center.conf](recharge-center.conf) | `/etc/nginx/conf.d/recharge-center.conf` | 充值中心追加新域名和 TLS include。 |
| [usage-leaderboard.conf](usage-leaderboard.conf) | `/etc/nginx/conf.d/usage-leaderboard.conf` | 排行榜追加新域名和 TLS include。 |
| [infinite-canvas.conf](infinite-canvas.conf) | `/etc/nginx/conf.d/infinite-canvas.conf` | 画布追加新域名和 TLS include。 |
| [yunhop-tls.conf](yunhop-tls.conf) | `/etc/nginx/snippets/yunhop-tls.conf` | 仅放证书和 8443 相关配置，不覆盖原业务属性。 |
| [sub2api-main-proxy.conf](sub2api-main-proxy.conf) | `/etc/nginx/snippets/sub2api-main-proxy.conf` | 复用原主站全部代理指令，保持 UI / API 的上游、请求头、超时、缓冲和防取消属性一致。 |
| [canvas-api-cors.conf](canvas-api-cors.conf) | `/etc/nginx/snippets/canvas-api-cors.conf` | 仅在模型 API 位置放行明确站点的跨域访问，保留 API Key 鉴权，不启用跨域 Cookie。 |

完整差异见 [changes.diff](changes.diff)，原始 / 候选散列和结构核对见 [validation.json](validation.json)。这些文件不含私钥或服务器密码，不能将本目录直接加入 Nginx include。更新后的 `install-nginx.py` 同时校验并处理全部相关文件，删除独立入口和无用代理 snippet，避免重复域名和错误的公用属性继承；生产基线变化时停止，不覆盖其他维护改动。

本目录的候选 `.conf` 通过仓库 `.gitattributes` 保留原始字节和换行，包括原配置已有的空白；`changes.diff` 保留统一差异的上下文空行。不要自动格式化这些文件，否则安装工具的散列校验会拒绝执行。修改候选必须重新审查并更新对应验证记录。

## 域名变更内容

```nginx
# migrated-services.conf：在各自原 server 中替换该行。
server_name cpa.fjmooo.cn cpa.yunhop.cc;
server_name aihub.fo2.us.ci yunhop.cc www.yunhop.cc;
server_name monitor.fo2.us.ci monitor.yunhop.cc;
server_name subopc.fo2.us.ci subopc.yunhop.cc;
server_name aihub.fo1.us.ci newapi.yunhop.cc;
server_name detector.fo2.us.ci detector.yunhop.cc;

# recharge-center.conf
server_name aihubpay.fo2.us.ci aihubpay.yunhop.cc;

# usage-leaderboard.conf
server_name aihubrank.fo2.us.ci aihubrank.yunhop.cc;

# infinite-canvas.conf
server_name canvas.fo2.us.ci canvas.yunhop.cc;
```

每个上述 server 的 `server_name` 之后增加一行：

```nginx
include /etc/nginx/snippets/yunhop-tls.conf;
```

此 include 只延续此前要求的 8443 HTTPS 回源准备，不改变各站原 80 监听、业务超时、上传限制、日志、请求头或缓存规则。证书覆盖 `yunhop.cc` / `*.yunhop.cc`；旧域名继续使用现有 HTTP 回源，当前不修改 Cloudflare。

## 画布模型 API 跨域兼容

主站菜单仍可能指向旧画布 origin；在新域主站打开菜单后，接口填 yunhop.cc 会从旧画布跨域请求模型 API。migrated-services.conf 中明确列出7个主站 / 画布 HTTPS 来源，CORS snippet 仅用于主站和独立画布的 `/v1/`、`/v1beta/` 路径。白名单预检返回204，外域仍由原主站返回403；真实请求继续验证用户 API Key，空 Key 或错误 Key 不会得到模型或调用权限。来源限定和端点限定同时生效，不为后台登录管理 API 开放 CORS。

主站原 location / 代理指令提取为 sub2api-main-proxy.conf，在 API 和原兜底位置复用。独立画布 API 明确保留原 Referrer-Policy、nosniff、CSP 和 no-store，避免新增 add_header 影响父级继承。最终配置结构比较应允许这项明确 CORS 增量，其他代理和安全指令保持原值；changes.diff 对应本轮安装前的新鲜快照，初次域名合并记录见部署台账。

## 已核对范围

初次域名合并在4份原文件追加上述 server_name / TLS include，将默认 TLS 拒绝入口移至 migrated-services.conf 末尾；规范化这些明确增量后，原完整指令树相同。本轮在此基础上增加前述 CORS 兼容：展开主站共享代理、剔除 API CORS 配置及其映射后，其他完整指令树仍与新鲜生产快照一致；独立画布显式安全头与原父级逐项相等。比较包括所有未改动的原 server、upstream、日志格式和嵌套规则。Eshop / Syncthing 不创建新域名代理，原服务与端口保持。

候选保留原 New API 初始化接口限制、充值 / 排行的命名 upstream 与不缓存响应头、原日志格式 / 级别、主站 60 秒连接和 1860 秒读写超时，以及维护、画布和监控路径。安装工具默认仅生成私有候选和运行完整 `nginx -t`，`--apply` 才备份、原子替换和平滑重载，校验失败回滚。实际验收另记部署文档和生产备份清单；本目录 validation.json 是审核候选，生产 manifest.json 的 applied 字段才表示已安装。
