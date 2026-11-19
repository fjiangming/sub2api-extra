# 三层检测配置 Demo

本轮仅制作独立配置交互原型，等待用户确认后才调整正式功能。不修改正式页面、服务端 API、配置表或凭据，不提交 GitHub 或部署服务器。保留此前的原型与正式页面预览，方便对照。

结构为“检测平台 → Sub2API AI 平台 → 分组”：

1. 满血 AI / TestLLM 各有一份接口地址，供其下所有 AI 平台使用。
2. 检测平台下分别选择 ChatGPT、Claude、Gemini 等 AI 平台，配置该检测平台所需的共享参数。满血 AI 仅出现模型、上游、思考等级、服务档位和糖果 / 鹈鹕项目；TestLLM 仅出现模型、上游、请求协议和推理 / 缓存 / 思考签名项目，当前只展示其支持的 ChatGPT、Claude。两家第三方的参数互相独立，同一第三方的 AI 平台也互相独立。
3. AI 平台下的分组可单独启停，设置其专用 Key、参与项目，选择继承平台参数或独立配置模型、上游、检测选项及超时。分组覆盖只影响该检测平台下的该组，恢复继承会重新跟随共享参数。

运行设置与计划位于对应 AI 平台的折叠区；本原型演示一份 AI 平台计划运行已启用的项目和分组。只有手动触发才产生虚构的检测回执，不存在后台真实任务或调度。历史明细保存模拟执行当时的有效参数，后续配置不修改旧快照。上述是待确认的交互方案，不代表正式服务已经支持新配置结构。

保存使用独立 LocalStorage 名称 `sub2api-provider-hierarchy-demo-v1`，只保存演示参数和 Key 的“已配置”状态。Key 原文在应用弹窗后立即丢弃，不写 LocalStorage / SessionStorage 或服务器。接口与上游地址修改不清除 Key 状态；网站不同，分组 Key 状态也分别保留。界面不实现生产鉴权、加密或真实检测契约验证。

```powershell
node degradation-detector/scripts/provider-hierarchy-demo/preview.cjs 19964
node degradation-detector/scripts/provider-hierarchy-demo/browser-check.cjs
```

打开 `http://127.0.0.1:19964/admin/config`。支持 `?provider=testllm&platform=anthropic`，可追加 `&group=2` 直接查看分组配置。

预览只绑定 127.0.0.1、服务固定静态资源、所有写请求返回 405，没有正式 API 或数据库依赖；CSP 禁止联网。Chrome / Playwright 检查桌面、390px、320px 和深色模式，可通过 `PLAYWRIGHT_MODULE`、`CHROME_PATH` 指定现有依赖。
