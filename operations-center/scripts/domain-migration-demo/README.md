# 旧域名迁移提示页 Demo

独立静态页面，保留本机样式及交互预览。直接在浏览器打开同目录 `index.html`，不需要启动服务。图标复用运营中心已安装的本地 Lucide（`operations-center` 执行过 `npm ci` 后可用），无外部字体、CDN、业务 API 或自动跳转。

- 默认展示 `https://epoint2api.fjmooo.cn/` 迁移至 `https://yunhop.cc/`。主标题、地址、前往按钮、客户端提示和页脚均显式显示 `https://`。
- “前往 https://yunhop.cc”需用户点击。复制按钮复制包含路径的完整新地址，有成功 / 失败反馈；深路径额外提供新站首页入口。
- 可通过本地页面的 `from` 参数模拟旧地址，例如 `index.html?from=https%3A%2F%2Fepoint2api.fjmooo.cn%2Fdashboard%3Ftab%3Dusage%23today`。路径、查询参数及片段保持；目标固定为 HTTPS 的 `yunhop.cc`，不接受其他源域名、凭据或非默认端口。
- 仅用 `textContent` 展示模拟来源，无持久化、采集、登录或通知发送。页面声明不发送 Referer；没有 JavaScript 时主按钮仍可打开新站首页。

## 服务器接入

用户确认并授权后，已于 2026-11-13 通过独立安装工具生成不可变发布、接入旧域名 Nginx 并验收。实际配置、保留范围、备份和回滚命令见 [上线记录](../../integrations/domain-migration/README.md)。服务器上传、固定资源路径及手工配置原理见 [DEPLOYMENT.md](DEPLOYMENT.md)。

浏览器导航到旧域名普通网页时由 Nginx 提供迁移页，不必修改 Sub2API 源码。实际规则保留静态资源、API、Webhook、登录 / 支付回调及非 GET / HEAD 方法：API 客户端不会展示 HTML，不能把所有请求无差别替换为此页，也不能假定跨域重定向会保留 Authorization 或 POST 正文。登录态也不会仅因保留路径自动跨域。

本目录继续保持独立预览，不被正式运营中心路由或 Docker 镜像引用。生产静态副本通过固定资源路径发布，默认手动跳转；本机直接打开文件不触发上线或远程操作。
