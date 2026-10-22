# 个性化功能维护台账

## 2026-10-23：运营中心计费核查

配套 `fjiangming/sub2api` dev，核心基线 `dba770d56a0ee0ae5bad1b3dc5e11614d323163c`。
后续 AI 修改源码/配置/测试时同步记录，禁止用原作者更新覆盖本功能。核心事务、发行源和可靠性边界见相邻 `sub2api/CUSTOMIZATIONS.md`。

| 文件 | 需保留的功能 |
| --- | --- |
| `operations-center/src/services/billing-recovery-service.js` | 原生 admin API 代理、查单与用量差异、版本 CAS、补记/确认/结算编排、后台单飞、重启恢复；不写余额、不重发推理。 |
| `operations-center/src/app.js` | 管理员会话和所有变更的 CSRF，复用现有 SSO/持久认证。 |
| `operations-center/src/server.js` | 已有进程中启停恢复线程，无额外服务。 |
| `operations-center/src/config.js`、`.env.example` | OPERATIONS_CENTER_BILLING_RECOVERY_ENABLED 默认 true；没有持久管理员认证则后台不运行。 |
| `operations-center/public/index.html`、`public/app.js` | 计费核查 tab 与现有导航、刷新、退出生命周期。 |
| `operations-center/public/billing-recovery-ui.js`、`.css` | 异常列表、详情、查单差异、历史价格凭据、原生多模态记录、核查确认、结算、审计历史及手机布局。 |
| `operations-center/tests/billing-recovery.test.js` | 会话/CSRF、唯一性/历史映射、拒绝余额差额、单飞、失败隔离、重启读取持久待办。 |
| `operations-center/tests/frontend-layout.test.js` | 新增 tab 对应的导航计数。 |
| `operations-center/package.json` | 新源码纳入语法检查。 |
| `operations-center/README.md` | 入口、配置与操作边界。 |
| `AGENTS.md`、`CUSTOMIZATIONS.md` | 未来集成时维护个性化改动。 |

每 30 秒读取核心 state=pending 的到期待办，最多 100 条。重复执行依靠核心原生 dedup 防止重复扣费；重试次数/退避在核心数据库中，12 次失败转人工核查。
只拥有浏览器 SSO 时可人工重试，后台需要持久管理员认证。查单复用 provider-monitor 的业务同步样本，不发测试推理。唯一 request ID、历史映射、未截断才确定匹配；相似时间/模型/token 不能授权扣费。
首次补记为 review，确认后 prepared，再调用原生事务写 usage_logs 和扣费。已结算案例提交最终累计用量，由核心生成差额子记录；进一步差额基于最新已结算子节点继续。没有历史价格时运营填写并提供证据。
验证：运营中心 npm test、npm run check；桌面及 390px 手机验证保存→确认→结算，无未捕获脚本错误和整页横向溢出。本次不连接生产，不补扣真实用户。
