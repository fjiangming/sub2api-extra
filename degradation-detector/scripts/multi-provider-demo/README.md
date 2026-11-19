# 多第三方降智检测 Demo

本目录是确认界面与交互用的独立原型，不载入正式业务服务，也不进行真实检测、认证、计费或生产配置写入。

在 `degradation-detector` 目录执行：

```powershell
node scripts/multi-provider-demo/preview.cjs 19960
```

默认仅监听 `127.0.0.1:19960`；传入其它空闲端口可同时保留已有预览。

- 糖果检测：`http://127.0.0.1:19960/results`
- 鹈鹕检测：`http://127.0.0.1:19960/results?test=pelican`
- TestLLM：`http://127.0.0.1:19960/results?provider=testllm`
- 后台配置：`http://127.0.0.1:19960/admin/config`

前台一级 Tab 按满血 AI / TestLLM 拆分；满血 AI 下再分糖果 / 鹈鹕。糖果与鹈鹕沿用原卡片、倍率、5h 缓存、历史柱状图形式，绿色通过、红色答案不符 / 疑似降智、黄色异常。统计依据当前可见样本计算，异常不计入通过率。TestLLM 参考用户截图分 GPT / Claude 两区，以列表呈现推理、测试缓存、首字耗时、状态和 24 小时记录。

后台有第三方接入、分组与模型、检测计划三个页面。各第三方和检测类别独立启停、保存默认参数、分组 Key 模拟状态 / 参数覆盖、定时计划。分组开关保存后会影响相应前台结果；历史继续展示执行时的模型和参数。手动任务仅演示队列与回执，没有后台定时器或真实外部请求。

配置保存在该浏览器同一 origin 下的专用 `degradation-multi-provider-demo-v1` LocalStorage 条目；不写 `.env`、正式数据库或配置文件。表单输入的模拟 Key 只用于切换“已配置”状态，原文不保存。不同浏览器的配置互相独立。顶部的前台 / 后台导航只用于 Demo 评审，不代表正式普通用户可访问管理功能。

满血 AI 接口字段根据其公开 API 文档制作：糖果 benchmark=candy，鹈鹕 benchmark=pelican，独立任务与结果状态。TestLLM 的缓存测试在官方站有单独的入口；本原型只演示用户要求的汇总形式，不声称 `/model-iq-test` 单一接口会同时返回三列数据。正式开发须另行核实接口、请求模式、缓存 / 延迟口径、模型兼容性、Key 传递与权限边界。本轮没有创建或调用任何第三方检测任务。

`pelican.html` 是静态虚构作品；同文件同时生成 iframe 预览及源码文本。CSP 禁止脚本建立网络连接，服务端只白名单提供静态资源；外链在用户点击时打开官方页面。

浏览器验收：

```powershell
node scripts/multi-provider-demo/browser-check.cjs
```

依赖本机 Chrome / Playwright；可用 `CHROME_PATH`、`PLAYWRIGHT_MODULE` 指定安装位置。检查使用临时端口、全新浏览器上下文和虚构数据，覆盖 1440px、390px、320px、深色模式、所有 Tab、筛选、历史 / 作品 / 提示词、配置保存与独立继承、计划与手动任务、无外网请求及页面 / 弹窗无横向溢出。截图仅保存在系统临时目录，验收结束关闭专属浏览器及临时服务。
