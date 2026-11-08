# 已确认页面的正式实现预览

原型已接入正式页面和三渠道实现。旧的运行和验收命令保留，但现在直接复用正式 HTML、CSS、JavaScript 和权限接口，不再动态替换代码或维护另一套模拟渠道。

```powershell
node scripts/fingerprint-demo.cjs
node scripts/fingerprint-demo-check.cjs
```

默认监听 `http://127.0.0.1:19896`，也可通过 `PORT` 指定空闲端口：

- 降智结果：`/results?demo=readonly`
- 模型结果：`/model-results?demo=readonly`
- 管理配置：`/admin/config?demo=1`

使用独立临时 SQLite 和模拟检测记录，不使用真实用户 Key、不请求付费模型、不下载参考数据；参考数据管理的真实下载操作在演示模式下禁用。浏览器验收用拦截响应验证更新进度和反馈，不访问外站。生产配置、渠道协议及参考数据更新步骤见服务 README。

两个结果页独立加载和刷新，均无检测类型 Tab；原 `/results` 始终展示降智结果。模型渠道介绍根据当前用户可见且已启用分组的渠道展示。

运行 `npm run test:model-ui` 同样执行完整页面验收，覆盖桌面、390px / 320px、深色模式、原有降智预览与历史、三渠道完整结果、管理保存和普通用户只读权限。截图仅保存在系统临时目录。
