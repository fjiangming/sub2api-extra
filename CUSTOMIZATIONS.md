# 个性化功能维护台账

## 2026-10-30：成本分析每日真实收入

用户要求用当前日期范围的每日主站实际消费减各供应商实际消费，替换原周期明细。本轮仅本地实现和隔离验证，保留本文件既有未提交生产维护记录、其他工程与无关文件；不部署、不连接生产或执行资金写入。原计费核查、CSV 后台任务和主站原生资金事务不变。

| 文件 | 改动与必须保留的约定 |
| --- | --- |
| `operations-center/src/services/cost-analysis-service.js` | 新增逐日利润只读报表；主站消费为所选资金日内全部 `usage_logs.actual_cost`，排除用户 ID 1，包含余额与订阅使用记录，不因删除用户抹除消费；与原有余额消费趋势分开。供应商成本来自已同步采购台账，数据或币种未核实时不把成本当零、不推断利润；不重复扣手工台账。 |
| `operations-center/src/provider-monitor-client.js`、`src/app.js` | 复用既有集成 Token 或管理员 SSO，增加供应商每日消费读取与管理员每日利润 API，保留超时和认证边界。 |
| `provider-monitor/src/services/gross-profit-service.js`、`src/server.js` | 复用原有采购台账的 active / comparable 仲裁、历史充值倍率与配置汇率，新增脱敏只读每日成本；按运营中心资金时区聚合，返回供应商拆分、同步覆盖和未确认金额状态，不调用模型或触发同步。新接口严格要求源 / 目标币种有确认汇率，不沿用显示币种变化时的 USD 默认 1；缺费用、负费用或未确认倍率不算已核验。原毛利接口行为保留。 |
| `operations-center/public/index.html`、`public/app.js`、`public/styles.css` | 移除周期明细，固定逐日展示日期、主站消费、供应商消费、利润、利润率、请求数与核验状态，支持供应商拆分复核；粒度不改变每日列表。仅更新本次涉及的资源版本。 |
| `operations-center/tests/cost-consumption.test.js`、`cost-analysis-ui.test.js`、`provider-monitor-client.test.js`、`server.test.js`、`frontend-layout.test.js`；`provider-monitor/tests/gross-profit.test.js` | 验证真实 SQL、日界线 / 时区、管理员排除、订阅与删除用户、供应商去重 / 倍率 / 汇率 / 缺失 / 截断覆盖、鉴权、逐日列表与手机展示；不操作真实余额。 |
| `operations-center/data-preview/daily-profit-qa-20261030.cjs`（忽略的本地验收脚本与截图） | 隔离 PGlite 主站、SQLite 供应商监控、真实只读集成 HTTP 和浏览器端到端核验；只绑定本地临时端口，完成后关闭两个服务并清理临时数据库，不连接生产或发送推理。 |
| `operations-center/README.md`、`docs/cost-analysis.md`、`docs/metrics.md`、`provider-monitor/README.md`、`CUSTOMIZATIONS.md` | 记录每日公式、真实采购成本、同步覆盖与同币种要求、兼容及配套更新范围。验证完成后补充结果。 |

验证：运营中心完整 271 项、供应商监控完整 297 项测试通过；运营中心 npm run check 及本轮新增接口 / 服务文件 node --check 通过；git diff --check 通过。供应商监控原有 key-probe 恢复间隔测试首次全量偶发失败，单独 9 项及第二次完整 297 项均通过，未修改无关探测逻辑。1440px 桌面 / 390px 手机 Playwright 使用真实 PGlite SQL、SQLite 采购账本和新供应商 HTTP 接口验证管理员排除、订阅消费、历史倍率 / 汇率、亏损和零分母、按月查询仍保留日表、供应商详情、截断后利润待核验；无未捕获页面错误或整页横向溢出，手机表格内部滚动，说明和详情默认折叠。截图已复核，保存在忽略的 operations-center/data-preview/daily-profit-*.png；两个验收服务及临时数据库均已关闭 / 清理。

边界：沿用主站 CNY 额度金额约定，列表仅 CNY；监控只能核验已配置供应商，未接入上游无法自动发现。今日日志未覆盖当前时刻或历史日期缺完整覆盖时仍为待核验，不把有一部分账本记录误认为全天完整。需要运营中心与供应商监控配套更新，沿用既有地址、Token / SSO、倍率与汇率配置，无新环境变量或数据库迁移。当前仅本地实现，未提交、推送、发布或部署，不代表生产已更新。

用户随后明确授权提交 GitHub。本次只将本节每日真实收入实现、测试和文档提交并推送 extra main；推送前 fetch 核对远端，沿用原有 Actions 测试与 GHCR 镜像流程，构建 / 发布结果以本次提交 SHA 的 Actions 为准。此前独立生产维护台账、无关工程和文件保留本地，不纳入本次提交；本次不部署或操作生产资金。

## 2026-10-25：修复满血 AI HTML 审核 HTTP 400 与管理员诊断

用户要求修复降智检测审核不可用，并随后授权提交 GitHub。本轮只提交降智检测及对应台账，保留运营中心、独立生产台账及其它无关未提交改动；推送至 main 后沿用现有 Actions 构建镜像，不部署，不改 Sub2API 源码、生产配置或历史记录。

根因：满血 AI 当前公开 API 文档已与旧教程不同。`pelican` 用于上游生成，提交已有作品必须使用 `html` 模式，并携带 `base_url`、`api_key`、固定 `model=gpt-6-astra`。旧格式实际返回 HTTP 400 / `model is required and must be gpt-6-astra for pelican, creative and html`。官方文档明确 HTML 模式是源码分类器，不调用上游、不消耗上游 Token，也不是真正的截图视觉判断。

| 文件 | 本轮改动与后续必须保留的约定 |
| --- | --- |
| `degradation-detector/src/visual-config.js`、`src/config.js` | 仅识别官方 HTTPS origin 与 `/api/v1/tests` 路径，将已有配置自动归一为 HTML 分类与固定模型字段；生成模型不变，非官方兼容接口保留原协议与可配置基准。无新增环境变量或迁移。 |
| `degradation-detector/src/visual-review.js` | 提交已保存 HTML，固定发送非真实的 URL / Key 占位值满足官方格式校验，不转发用户或分组生成凭据，不进入上游生成模式；轮询校验实际 HTML 基准、任务 ID 和最终结论，正常 / 疑似降智 / 无法判定映射不变。HTTP 400 / 422、401、403、404、413、429、重定向与 5xx 分别给出通用错误，不误记正常或降智，不自动重发提交。 |
| `degradation-detector/src/review-http.js` | 非成功响应仅限时 2 秒读取最多 8 KiB JSON，提取错误码和最多 300 字符说明；过滤已知凭据、Key 模式、长令牌、URL、邮箱、控制字符及包含源码的消息。保留 HTTP 状态，不保存整段正文；DNS 固定公网、禁止重定向及原总超时保持。 |
| `degradation-detector/src/server.js`、`src/store.js` | 脱敏审核诊断只加入现有管理员分组历史，沿用实时角色及分组授权；普通用户结果列表、详情及预览不返回诊断。公开结果仅新增安全枚举 `method=source_classifier` 标识实际方法，旧记录的 HTTP 状态可供管理员查看，缺失说明不编造。 |
| `degradation-detector/admin/app.js`、`public/app.js` | 官方接口的基准与模型字段自动填充且只读，其它兼容模型字段可编辑；管理员历史展示转义后的提交 / 查询、状态码及脱敏说明。结果详情明确显示源码分类及其依据，保留原有折叠证据、HTML 预览、人工复核及只读结果页边界。 |
| `degradation-detector/tests/visual-review.test.js`、`tests/server.test.js` | 更新官方真实请求契约与 HTML 基准；覆盖旧配置归一、不发送真实生成凭据、兼容旧异步服务和同步 HTML 服务、两种有效结论、HTTP 分类 / 大小限制 / 脱敏、管理员专有诊断、普通用户隔离与角色撤销；保留任务不匹配、超时与不重复提交回归。 |
| `degradation-detector/README.md`、`CUSTOMIZATIONS.md` | 说明新格式、固定占位值、源码分类的实际能力、旧配置兼容、管理员诊断入口和原历史不自动重判。 |

验证：降智检测完整 117 项测试通过；本机用无真实凭据的示例 HTML 调用公开 API，旧格式得到上述 400，新格式返回 202 并轮询至 succeeded；修复后的实际 VisualReviewer 模块也取得 completed / degraded，生成模型保持不变。仅圆形 SVG 的简化示例被分类为疑似降智符合其输入，不代表用户的真实分组结论。1280px 桌面 / 390px 手机 Playwright 验证固定与自定义模型控件、管理员诊断、源码分类依据、默认折叠证据及 iframe 内 SVG 渲染，无页面错误或横向溢出；使用隔离演示数据库且不发生成请求，测试服务已关闭。截图留在忽略的 `degradation-detector/data-preview/manxue-protocol-20261025/`。生产 SSH 接口探测仍被自动审批拒绝，因此没有生产侧复测或重启；不把本机实测称为服务器已修复。

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
| `operations-center/docs/billing-recovery-update.md` | 基于服务器只读核验的更新步骤：保留冻结数据库/Redis、已有网络及数据卷，修改目标服务镜像与 pull_policy，备份、按主站→运营中心顺序更新及回滚。无密码/Token，不依赖服务器 Git。 |
| `AGENTS.md`、`CUSTOMIZATIONS.md` | 未来集成时维护个性化改动。 |

每 30 秒读取核心 state=pending 的到期待办，最多 100 条。重复执行依靠核心原生 dedup 防止重复扣费；重试次数/退避在核心数据库中，12 次失败转人工核查。
只拥有浏览器 SSO 时可人工重试，后台需要持久管理员认证。查单复用 provider-monitor 的业务同步样本，不发测试推理。唯一 request ID、历史映射、未截断才确定匹配；相似时间/模型/token 不能授权扣费。
首次补记为 review，确认后 prepared，再调用原生事务写 usage_logs 和扣费。已结算案例提交最终累计用量，由核心生成差额子记录；进一步差额基于最新已结算子节点继续。没有历史价格时运营填写并提供证据。
验证：运营中心 npm test、npm run check；桌面及 390px 手机验证保存→确认→结算，无未捕获脚本错误和整页横向溢出。本次不连接生产，不补扣真实用户。

后续推送轮次只读核验了部署环境：实际主站二进制 0.2.17，冻结镜像保留 0.1.160 元数据；运营中心持久管理员认证和供应商监控集成已配置。GitHub 首次 ARM64 构建遇到 QEMU Illegal instruction，重跑已成功，未因此改动源码。更新手册只提供命令，未执行部署、数据库迁移或真实补扣。

## 2026-10-23：构建检查与核查范围说明

`.github/workflows/docker-publish.yml` 在既有测试门禁中加入运营中心 npm ci / check / test，使用与其 Docker 基础镜像相同的 Node 22.20.0；测试失败不发布各服务镜像。

`operations-center/docs/billing-recovery-update.md` 首次切换改用主站 latest 与运营中心 operations-center-latest，增加 OCI revision 与远端分支完整 SHA 核对，明确 latest 代表最新成功发行以及固定版本的可选方式；后续只需 pull / up，不需要服务器源码。`operations-center/docs/billing-recovery-behavior.md` 与 README 明确已同步样本、手动查单、四类 Token 差额、历史价格核定、后台只恢复 prepared / 缓存待办、缺少全量自动对账及金额比较的现状。此次不改变计费或查单代码，不操作生产余额。

验证：运营中心 158 项测试与 npm run check 通过，更新手册全部 6 个 Bash 命令块通过 bash -n，工作流 YAML 的运营中心测试依赖关系通过校验。

更新手册补充 latest 通道的准确回滚：备份运行容器的镜像 ID，回滚时为旧 ID 创建本地标签并将目标服务 image 固定到它、pull_policy=never。不能仅恢复 image:latest 的 Compose 来回退版本。此轮仅文档，6 个 Bash 块继续通过语法检查；未在 VPS 执行这些更新或回滚命令。

## 2026-10-23：正式镜像部署与 2FA 后台认证适配

用户授权更新生产。主站切换到 fork 0.2.17000501 / ad94ed860，配套运营中心沿用原数据卷。备份统一放在 /root/sub2api-deploy/backups/billing-fix-20261023072212，包含原 Compose / env / Nginx 配置、旧镜像身份、数据库与角色、应用和 Redis 数据、校验清单及部署事件。隔离网络的完整数据库副本恢复、迁移和两个镜像的健康检查通过后才暂停流量；在途请求归零并静置后备份和切换。PostgreSQL / Redis 容器没有重建或重启。原生 90 天保留任务在启动时清理了 5 条过期零元历史记录，已从最终备份按原 ID、原字段原样恢复；余额和已计费总额不变，未修改原保留策略，未补扣用户。

实际认证探测发现原持久邮箱密码属于开启 2FA 的账号，配置存在不代表后台能登录。`operations-center/src/sub2api-client.js` 最小增加原生 admin- 管理员 API Key 的 x-api-key 认证；凭据验证和跨来源写入前的只读探测使用受保护 admin/system/version。显式浏览器 Authorization / X-Api-Key 不叠加持久管理员凭据，保留 JWT / SSO 及写请求不跨来源重放的规则。配置沿用 SUB2API_ADMIN_TOKEN，部署复用既有 Key，不轮换其他服务的密钥，不关闭 2FA。README、更新手册同步记录认证要求、90 天保留策略和专用备份路径。6 项认证回归覆盖原生 Key、拒绝无效 Key、凭据恢复、浏览器覆盖隔离以及不重放写入；需运行全部运营中心测试和语法检查后再发布镜像。

验证：运营中心 164 项测试、npm run check 和修改后的更新手册 6 个 Bash 块语法检查通过。新增角色备份及 pg_restore --list 校验步骤，避免仅备份单库后无法在空实例重建运营中心角色权限。主站恢复接单后，生产请求已形成 settled 恢复记录、cache_pending 为 false；unknown 仍等待上游最终结果，不自动按相似请求扣费。

## 2026-10-23：所有上游超时的持久查单、用户归属与核查草稿

此轮仅本地实现，未提交 / 推送 / 发布 / 部署，未补扣真实用户，不重发推理。配套主站新增同步转上游 SSE 和历史价格快照；无供应商 / 域名限定。保留前述核心恢复、人工 review → prepared → 原生使用记录与资金同事务的约定。

| 文件 | 本轮改动及后续必须保留的行为 |
| --- | --- |
| `operations-center/src/billing-recovery-store.js`（新增） | WAL / FULL SQLite 保存异常镜像、用户 / Key / 上游账号归属、观察用量、查单结果、退避、5 分钟租约及各状态发现游标。重启续跑；已验证的部分账单在核心版本 / 用量证据变化后重新核查，原证据不丢。 |
| `operations-center/src/services/billing-recovery-usage.js`（新增） | Anthropic / Chat / Responses / Gemini / xAI / Bedrock 等数值别名、缓存 / thinking 语义；未知不当零，无效维度不当最终用量。仅可信 dispatch / 上游响应 ID 可匹配；拒绝调用方复用 ID 及其回显。 |
| `operations-center/src/services/billing-recovery-service.js` | 用户 / Key / 账号 / 请求 / 超时筛选；后台分页发现 unknown / review / incomplete 并入持久队列。每轮最多查 20 条，按历史映射定向刷新上游日志，保留费用 / 币种 / 覆盖 / 差额；有效最终标准 Token 用历史只读 quote 生成 review 草稿，不批准或扣款。原 prepared / cache_pending 继续原生重试。 |
| `operations-center/src/server.js` | 已有进程中初始化、注入、关闭 `<dataDir>/billing-recovery/billing-recovery.sqlite`，不新建服务或资金账本。 |
| `operations-center/src/provider-monitor-client.js` | 复用集成 Token 或 SSO + CSRF 调用有界的 billing-samples 刷新；不将短期浏览器 token 当后台凭据。 |
| `operations-center/src/app.js` | 新增 `/api/billing-recovery/:id/draft`，保留管理员鉴权和 CSRF；不接受余额差额。 |
| `operations-center/public/index.html`、`billing-recovery-ui.js`、`billing-recovery.css` | 展示用户 / Key / 上游账号 / 分组快照、独立的已观察 Token 与本地使用记录、完整 / 部分状态、同步 / 流式 / 断开元数据、保存的查单证据 / 费用 / 差额；筛选和草稿入口及手机布局。 |
| `operations-center/package.json` | 新增文件进入现有语法检查，无新增运行依赖。 |
| `operations-center/tests/billing-recovery.test.js`、`billing-recovery-durable.test.js`（新增） | 持久重启 / 退避 / 游标 / 租约、用户归属、Token 归一化、反回显误匹配、上游不可用 / 冲突 / 缺价阻止扣费、SSO CSRF、自动发现部分账单；后台生成草稿不审批。 |
| `provider-monitor/src/services/sync-service.js` | 按历史映射 Key 定向读取真实业务日志，串行限量 / 冷却 / 连接互斥，复用原样本与采购成本持久化，不将定向读取冒充全供应商同步。无模型调用。 |
| `provider-monitor/src/adapters/base.js` | 为账单完整性提供严格 Token 整数判定，禁止把小数、布尔、负数和异常字符串变成已确认计数。 |
| `provider-monitor/src/adapters/sub2api.js` | until 窗口、受控并发与分页间隔、按排序窗口提前停止、明确最终用量完整性；不支持的日志端点仍报不可用。 |
| `provider-monitor/src/adapters/one-api-family.js` | until 窗口保留毫秒覆盖语义、分页间隔、定向查询只接受 Key ID 归属，避免同名 Key 混入；无效或未支持的缓存 / 媒体等维度不确认为最终用量。 |
| `provider-monitor/src/services/latency-samples-service.js` | 返回费用、币种、usage_complete 与 billingCoverageComplete；历史映射有效、同步成功且覆盖完整、查询未截断才允许唯一账单匹配。 |
| `provider-monitor/src/server.js` | 集成 Token / 管理员 SSO 边界增加定向刷新接口；SSO 写操作继续受现有 CSRF 保护。 |
| `provider-monitor/src/db/index.js` | schema 33 仅新增可空 usage_complete，旧样本原计数保留而完整性未知，不伪造旧记录已验证。 |
| `provider-monitor/tests/adapter-contracts.test.js`、`billing-recovery.test.js`（新增） | 定向窗口 / 归属 / 无推理、覆盖 / 冷却 / 限流、迁移保旧、授权、严格计数及现有适配器契约回归。 |
| `.github/workflows/docker-publish.yml` | 现有镜像 build 再依赖供应商监控测试 job；使用 Docker 一致的 Node 20，运营中心仍用 Node 22.20.0；不绕过既有检查。 |
| `operations-center/docs/billing-recovery-behavior.md`、`operations-center/README.md`、`provider-monitor/README.md` | 重写已过时的“仅人工 / 仅读缓存 / 不返回金额”说明，写明新自动范围、历史价格 / 特殊维度边界、SQLite 一致性备份与三镜像升级。 |
| `operations-center/docs/billing-recovery-update.md` | 保留原首次部署步骤，补充供应商监控的同目录备份 / 原镜像 / 卷、三服务配套更新、schema 33 及生产现有超时覆盖保留；仅文档未执行。 |
| `CUSTOMIZATIONS.md` | 本节改造清单、验证、边界及后续集成依据。 |

后台查单需要已配置的主站持久管理员凭据和供应商监控集成 Token。每 30 秒原生待办最多 100 条；异常发现每状态一页 100 条，未知请求超过保护期限加 60 秒且最近一分钟无更新才处理，查单退避最长 6 小时。供应商日志定向读取按连接并发 1、分页延迟 300ms、上限 1000 条，普通冷却至少 60 秒 / 限流至少 5 分钟。查询缺覆盖、无唯一 ID、无历史映射或无最终用量均不能自动核定费用。

原生 HTTP / SSE 最终用量可独立于供应商监控生成历史标准 Token 草稿；上游单独提供最终账单时必须唯一可信匹配，且缺少缓存时长、特殊价格 / 多模态或数值冲突则转人工。上游实际费用只作证据，不当售卖费用。已结算但不完整的记录核对出差额时保留原账，由管理员向最后已结算节点补最终累计使用记录，核心生成差额子记录；后台不直接补扣。

运营中心新增 SQLite 位于已有数据卷；运行中备份应使用在线备份 API，或停止写入后归档完整目录，不能只复制主库遗漏 WAL。主站 PostgreSQL、供应商监控 SQLite、运营中心核查 SQLite 三者均需保留。新增列 / 索引不删除历史数据；更新生产只拉三个配套 fork 镜像，不拉源码，不轮换现有 Secret。历史无意图丢单不能凭相近时间 / 模型猜测用户；没有最终上游证据时只能保留已知数值待核查。

验证：运营中心 172 项、供应商监控 287 项全量测试全部通过，运营中心 check 与两服务全部 80 个 JS 源文件语法检查通过；桌面 / 390px 手机的查单 → 草稿 → 核查 → 结算交互使用本地模拟数据通过，无整页横向溢出或未捕获脚本错误。CI YAML 的 Node 20 / build 依赖与更新手册 8 个 Bash 块解析 / 语法验证通过。核心计费回归、真实 PostgreSQL 3 项和 Windows 二进制构建通过，原 service 全量 Windows 时间精度失败如核心台账所述。未运行 Docker 构建、Linux CI、真实上游推理或生产资金操作。保留无关的 `usage-leaderboard/public/assets/leaderboard.svg`，未修改它。

核心最终额外运行与 GitHub CI 相同版本的 golangci-lint 2.14.0，四个相关完整包为 0 issues，随后计费回归与 server 构建通过。两仓库最终 diff --check 通过；保留既有独立生产超时配置文档及其他未提交改动。

## 2026-10-23：CSV 自动匹配、扣费预览与确认补记

此轮仅本地实现，未提交 / 推送 / 发布 / 部署，不连接上游、不重发推理、不操作生产资金。保留此前未提交的所有功能和无关 `usage-leaderboard/public/assets/leaderboard.svg`。核心仅新增历史来源预留和列表日期过滤，见相邻核心台账；运营流程仍由本服务负责。

| 文件 | 本轮改动和后续必须保留的语义 |
| --- | --- |
| `operations-center/src/services/billing-import-csv.js`（新增） | 使用 csv-parse 解析引号 / BOM / 中英文表头及显式映射，Luxon 解析时区 / 起止时间 / 时钟修正；严格整数和大小限制，未知缓存保留未知。供应商身份摘要保留原始时间的小数精度，不随运营时区 / 时钟 / 输入缓存解释变化；重复行保守标记。 |
| `operations-center/src/services/billing-import-source.js`（新增） | 已有只读 PostgreSQL + 主站恢复列表读取原版错误、原生用量和持久意图，按账号 / ID / 模型 / 开始时间生成候选；区分多次尝试、未知耗时，合并同一次请求的多种来源。只读取无正文的关联 / 数值元数据；SQL 对 JSON null / 非数组错误列表安全处理。查询截断失败阻断，多候选不猜用户，同本地请求多行争用标记冲突。已有用量或缺本地关联 / 归属时不能整笔补扣。 |
| `operations-center/src/billing-import-store.js`（新增） | 与既有核查队列共用 SQLite WAL / FULL；新增 import_batches / import_rows，保存原 CSV、选项、轻量元数据、匹配、冻结预览、核心案件及回执。SQL 分页 / 汇总 / 预览占用查询，避免对 15000 行反复完整解析；版本 CAS、5 分钟确认租约，失败 / 已开始确认冻结匹配配置，重启可按原预览续办。没有新增资金表。 |
| `operations-center/src/services/billing-import-service.js`（新增） | 导入 / 匹配 / 预览 / 确认编排；支持手工历史模型价格、缓存时长核定及核心冻结售价只读 quote。Decimal 计算金额，最终金额按原生 float64 乘法后再量化到 8 位，避免半单位边界预览不一致。已有最终观察数值冲突、特殊维度或不支持的快照阻止预览。归属、价格证据和最终用量必须核对；预留 → usage review → prepared → 原生 settle，丢回包后重读状态，绝不直接改余额。 |
| `operations-center/src/server.js` | 初始化导入 store / source / service，复用同一数据库与现有只读池、恢复客户端，没有新服务或计划任务。 |
| `operations-center/src/app.js` | 新增 `/api/billing-imports` 的 inspect / options / detail / match / preview / confirm；保持管理员会话、no-store 和 CSRF。仅上传 / 表头检查使用大 JSON parser，且在鉴权和 CSRF 后执行；其他接口保持原 64 KiB 限制。 |
| `operations-center/src/services/billing-recovery-service.js` | 原有列表代理接受 from / to 日期，用于限定批次源查询；保留此前查单 / 草稿 / 恢复行为。 |
| `operations-center/public/index.html`、`billing-import-ui.js`（新增）、`billing-recovery-ui.js`、`billing-recovery.css` | “计费核查”内新增 CSV 补记子页，编码 / 字段 / 上游账号映射、时间配置、候选详情、历史价、逐笔和按用户汇总预览、确认和续办、筛选 / 分页。显示用户 ID / Key / 账号、原生来源与时间、倍率、余额 / 订阅类型和核心回执；更改配置 / 价格禁用旧确认，退出清除当前 DOM 中的批次信息。供应商字段全部转义，表格手机内滚动不撑开整页。 |
| `operations-center/package.json`、`package-lock.json` | 新增 csv-parse 7.0.3+、Luxon、decimal.js；新源码 / 演示 / 浏览器检查纳入语法检查，增加隔离预览与检查命令。锁文件仅定向升级既有传递依赖 ip-address 到 10.7.4+，修复 GHSA-rxp7-6hxx-x8q5，不关闭审计或执行 force 更新。 |
| `operations-center/tests/billing-import.test.js`、`billing-import-source.test.js`（新增） | CSV 格式 / 时间 / 精度 / 计数 / 未知缓存 / 重复行、125s 本地错误对 174s 上游、并发用户、多次尝试、已有账单、无关联 ID、争用归属、预览无扣费、价格缺失 / 快照冲突、原生结算 / 丢回包 / 重启 / 租约 / CAS / 并发确认、筛选、鉴权及上传 CSRF；源 SQL 用真实 PGlite 验证。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs`（新增） | 只绑定本地的隔离模拟数据预览，无真实 DB / 凭据 / 供应商连接，结算仅改演示状态。可选外部 Playwright 包验证桌面 / 手机导入至确认、重载恢复和无页面溢出，不把浏览器加进生产依赖或镜像。 |
| `operations-center/docs/billing-csv-import.md`（新增）、`docs/billing-recovery-behavior.md`、`README.md` | 操作步骤、Lingsu 导出例子、原版日志与 fork 执行边界、手工历史价格需按实际用户 / 分组分别核定、20 笔批次确认、幂等 / 中断 / 备份 / 部署限制。修正历史“无 CSV 导入”的说明。 |
| `CUSTOMIZATIONS.md` | 本节改动、验证和个性化契约。 |

处理限制：每批 8 MiB / 20000 行 / 100 列 / 单行 64 KiB、31 天、最多 20 个上游 Key 映射；每类原生源 / 持久案件最多 20000 条，超限必须缩小范围，不能把截断样本当完整核对。每次预览 / 确认最多 20 笔，候选超过 30 个不批准。时间匹配即使唯一也需核对；多个候选要明确选择和归属依据。缺缓存 / 时长 / 历史价不能当零猜测。手工模型价格应用于当前所选行，历史用户 / 分组价格不同须分别选取生成预览，不能把一组价格静默套所有用户；核心冻结快照则按请求独立报价。

同内容回到原批次，核心对上游账单与本地请求双重唯一预留，预览摘要不可在确认中变化。已有记录但用量不同只标出核查，不再收整笔；有持久案件的差额继续使用原有累计补记链，仅有原版使用记录的差额不在本轮自动建账。原日志已清理或全部本地关联 ID 丢失时，CSV 不能凭上游 Key 名恢复用户。Lingsu 无逐条日志 API 不影响人工 CSV 输入，但仍需最终账单、可核对本地归属及历史售价；CSV 导入不会自动读取供应商监控。

验证：实际上游导出 15100 行全部解析有效，38 条重复候选保守标记，解析 / SQLite 保存 / 首屏分页约 619ms（未连接生产匹配用户）；运营中心 197 项全量测试通过，包含 25 项 CSV / 原版源 SQL 专项，check 与生产依赖审计通过（0 vulnerabilities）。1440px / 390px 浏览器完成真实本地 HTTP 上传、自动匹配、预览、确认模拟结算、刷新读取回执、筛选和布局验证，无页面横向溢出和未捕获脚本错误，最终截图已复核；截图为本地 Temp/sub2api-csv-billing-ui-qa。主站回归、4 项真实 SQL、server 构建及最终 lint 0 issues 见核心台账，两仓库 diff --check 通过。尚未进行 Docker / Linux CI、真实上游推理和生产补扣，部署必须另行授权。

## 2026-10-23：授权提交与推送计费修复

用户授权提交并推送本轮持久核查、供应商定向查单与 CSV 补记功能，extra 使用 `main`，配套核心使用 `dev`。保留镜像构建前的运营中心和供应商监控等测试门禁；无关的 `usage-leaderboard/public/assets/leaderboard.svg` 继续保留本地，不纳入本轮提交。暂存新增文件后发现并移除 `operations-center/tests/billing-import.test.js` 末尾多余空行，仅调整空白；复核暂存区 diff --check。不连接或更新服务器，不执行生产数据迁移及真实扣费，等待用户后续通知再部署。

## 2026-10-24：修正 CSV 漏计费匹配与历史取消请求归属

用户要求修改匹配逻辑并与此前服务器检测结果自测对比。本轮只改本地运营中心，extra 保持 `main`；核心保持 `dev` 且没有源码改动。未连接或变更生产，没有提交 / 推送 / 发布 / 部署，也没有预留或补扣用户。保留本台账原有生产镜像通道记录、核心已有文档改动，以及无关未跟踪的 `usage-leaderboard/public/assets/leaderboard.svg`。

| 文件 | 改动与后续必须保留的约定 |
| --- | --- |
| `operations-center/src/services/billing-import-matcher.js`（新增） | 从原 source 模块分离纯匹配。先以同账号 / 模型的完整四类 Token、原生用量时间和 ID 排除已有账单，再找未占用的精确时间候选；开始 / 结束两种时间均用于防误补扣。每 Key 至少 3 个有区分度样本、90% 一致才自动校准，显式时间设置冲突阻止补记。缺耗时的四小时区间不再淹没精确候选，也不允许仅靠区间生成扣费预览。区分用户归属唯一与具体 dispatch 唯一；一笔本地收费不能排除多笔不同上游账单。ID 与 Token 矛盾、用量差异及一对多冲突单列核查。算法版本为 2。 |
| `operations-center/src/services/billing-import-source.js` | SQL 只读读取原生 dedup 热表和归档，按 request_id + api_key_id 核实处理证明，缺表不冒充已扣费。保留已有用量的零费 / 未核实状态，区分 prepared 使用草稿与 settled。合并原生使用记录时保留持久意图的真实开始时间，附原生结束时间、三种模型别名及缓存 TTL 明细。读取范围兼容两种 CSV 时间解释；整次源读取失败或截断仍停止。接入可选文件日志并只对同一原生请求归属补全开始时间。 |
| `operations-center/src/services/billing-import-logs.js`（新增） | 可选只读流式读取主站结构化 `.log` / `.log.gz`，只保留时间、请求 ID、用户 / Key / 分组 / 账号、模型、流式和状态元数据，丢弃正文和错误明文；通过同一服务端 ID 的唯一账号选择、用户归属和访问结束关联历史取消请求。不递归 / 不跟随文件链接，128 文件 / 1 GiB 解压数据 / 600000 事件 / 64 KiB 单行上限，超限或损坏失败而非使用部分证据。文件日志不声明完整覆盖；仅文件日志不能伪造原生错误或成为直接扣费来源。 |
| `operations-center/src/services/billing-import-service.js` | 默认自动时间校准，持久化匹配诊断和修正后的开始时间；新增归属 / 未核实扣费筛选。预览前、首次确认前重新读源，阻止已有账单、候选变化、过多候选、时间证据变化和旧算法预览；冻结证据摘要。已开始的新版本确认保留原生预留幂等与失败续办，不增加第二套结算。 |
| `operations-center/src/billing-import-store.js` | 原 JSON 表结构中增加已定位用户 / 扣费待核查 / 时间不足 / 争用记录状态筛选，无数据库迁移或资金表。 |
| `operations-center/src/config.js`、`.env.example`、`src/server.js` | 可选 `OPERATIONS_CENTER_BILLING_LOG_DIR`，未配置不读文件日志，显式挂载不可读则阻断匹配并给出原因；只在现有进程中注入读源。 |
| `operations-center/public/index.html`、`public/billing-import-ui.js` | 展示时间校准证据、各类数量、原生扣费是否核实、零实际费及用户 / Key / 分组，未知费用保留未知；新增已定位 / 扣费待核查筛选，禁止仅文件来源和时间不足项被勾选补扣。旧匹配要求重跑，未匹配不再显示“时间匹配待确认”，退出清理诊断文本。保留价格核定和原生计费流程。 |
| `operations-center/scripts/billing-import-replay.cjs`（新增） | 从外部审计文件离线回放，断言旧误报排除、完整用量保护、文件日志用户一致、完整 Token / 原生扣费证明和一对一排除。没有 DB / API / 预留 / 结算调用，真实源文件不入 Git。 |
| `operations-center/tests/billing-import-matching.test.js`、`billing-import-logs.test.js`（新增）、`billing-import-source.test.js`、`billing-import.test.js` | 匿名回归覆盖错误时间含义、4 条类零费场景、实际 SQL dedup / 归档 / 错 Key 排除、模型别名 / 缓存 TTL、四小时区间、同用户并发与跨 Key / 分组冲突、一笔记录争用、多来源合并、gzip / 损坏 / 限制 / 秘密字段剔除、旧预览、预览后新账单 / 新候选、文件来源禁止预留及原确认幂等 / 重启 / 租约。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 隔离演示扩展已收费 / 文件归属 / 零费用状态，桌面 / 手机验证新增筛选与不可扣费项。浏览器测试使用 OS 分配临时端口；手动演示探测占用端口后递增，避免 Windows 下读到本机旧演示。所有测试创建的服务均关闭，不停止已有演示进程。 |
| `operations-center/package.json` | 新模块和离线脚本纳入原 check，原 test glob 自动运行新测试，无新增依赖或发行工作流改动。 |
| `operations-center/docs/billing-csv-import.md`、`README.md` | 改正实际 Lingsu CSV 的 Time 为结束时间；说明新状态、自动校准、读源 / 确认防重、仅文件日志的原生预留限制、可选只读日志挂载及旧批次重匹配。挂载示例仅文档，本轮不修改生产 Compose 或权限。 |
| `CUSTOMIZATIONS.md` | 本节登记全部改动及验证；不覆盖前轮维护记录。 |

资金边界保持原约定：已有用量但未核实扣费不能按 CSV 再建整笔消费；少计用量在已有原生案件差额链核查。仅文件日志可定位用户，但当前核心导入 API 仅接受原生恢复案件或 ops_error_logs，故保留待核查，不向原生错误表造记录，不改余额。含原生候选的同用户并发也需具体请求归属证据，不能随机选择一个 dispatch。旧算法的已开始确认批次先核对核心预留 / 回执，不绕过冻结另建批次。

验证：运营中心全量 216 项测试、npm run check、1440px / 390px Playwright 导入 → 自动校准 → 新筛选 / 禁选 → 报价预览 → 原生模拟结算 → 刷新回执全部通过，无未捕获脚本错误、按钮溢出或整页横向溢出。使用此前保存的生产快照离线回放 14,480 行：旧 24 条误报全部正确排除；此前 13,045 条已有关联用量全部保护，其中 4 条无扣费证明单列异常；此前 761 条文件日志归属逐条一致。新结果 13,176 已核实扣费、1,111 已定位用户待核查（757 仅文件、354 含原生来源）、5 条唯一原生时间候选、4 条扣费未核实、16 条用量差异、122 条多归属、12 条时间不足、34 条重复。新增排除项也逐条验证四类完整 Token、原生处理证明及一对一关系。上游支出不能当已确认损失或用户补扣金额。只读挂载未配置时不能复现文件归属结果。

详细本机验证报告位于用户 Downloads 的 `sub2api-billing-audit-20261023/MATCHING-FIX-VALIDATION.md`；真实快照仅位于该外部目录，未加入仓库。没有运行 Docker 构建、GitHub CI 或真实资金结算；核心无需新迁移。

用户随后明确授权提交 GitHub。本次仅提交并推送上述运营中心匹配修复、配置示例、文档、匿名测试及离线回放脚本到 `fjiangming/sub2api-extra` 的 `main`，沿用既有测试门禁和镜像自动构建；本地验证结果见上文，发布结果以本次 SHA 的 GitHub Actions 为准。此前生产镜像通道维护记录、核心两份文档及无关 SVG 继续保留本地未提交，真实 CSV、服务器快照、日志和凭据不进入 Git；本次不更新服务器或执行生产补扣。

## 2026-10-24：CSV 扣费预览增加上游余额差额

用户授权实现、验证后提交并推送 GitHub。本轮只修改 `sub2api-extra/operations-center`，保持 `main`；主站核心无需修改、迁移或重新发行。上游多扣余额差额定义为 CSV 的实际上游 USD 支出减本站拟补扣，负差额显示“本站拟多收”；仅为金额比较，不表示已回款或判定供应商错扣，不能把上游费用当作用户补扣金额。

| 文件 | 改动及后续保留要求 |
| --- | --- |
| `operations-center/src/services/billing-import-service.js` | 在详情返回时为已有预览派生 `costComparison`，Decimal 计算并返回 8 位定点金额。接受非负十进制、USD / 美元符号和规范千分位；缺失、负数、其他币种或无法识别的金额返回未知。订阅只返回支出与用量金额，余额差额为空。兼容旧持久预览；不写入预览、摘要或主站，不改变定价 / 预留 / 幂等 / 确认事务。 |
| `operations-center/public/billing-import-ui.js`、`public/index.html`、`public/billing-recovery.css` | 增加逐笔差额列、本页所选合计和按用户汇总的上游支出 / 本站拟补记 / 差额。前端以 8 位定点整数汇总，正负差额明确区分；余额与订阅单列，已知支出与未知条数同时保留，费用不完整则合计差额未知。勾选变化立即更新；表格在手机内部横向滚动，不撑宽整页。 |
| `operations-center/tests/billing-import.test.js` | 增加实际费用与售卖价正负 / 零差额、规范金额 / 非法金额、半单位舍入、未知不当零、订阅不当余额、旧预览重启可读、只读派生不改变原生结算的回归。 |
| `operations-center/scripts/billing-import-browser-check.cjs` | 验证桌面 / 手机及正差额 / 缺上游费用四组隔离模拟流程，核对逐笔、按用户和所选合计、取消勾选、订阅隔离、原生模拟结算及刷新回执。没有新增生产依赖。 |
| `operations-center/docs/billing-csv-import.md`、`CUSTOMIZATIONS.md` | 记录操作、金额公式、范围和验证；保留先前未提交的生产镜像通道维护记录。 |

验证：运营中心完整 219 项测试、`npm run check`、四组 Playwright 模拟流程全部通过，1440px 桌面 / 390px 手机没有整页或按钮溢出、没有未捕获脚本错误，截图已复核。前端和详情读取均未触发补扣；原生模拟确认仍只结算一次。浏览器测试依赖仅安装在本机临时目录，不改锁文件或镜像依赖。沿用 GitHub 既有测试和镜像构建流程，发行结果以本次 SHA 的 Actions 为准；本轮不连接或更新生产、不补扣真实用户，无关 SVG 和核心已有文档继续保留本地。

## 2026-10-24：修复跨日测试和 ARM64 镜像构建失败

用户要求修复 GitHub 构建失败，沿用此前提交 / 推送授权；本轮仅修改 extra 的测试及发布工作流，不更新服务器、不补扣用户、不改变主站源码或资金契约。保留原有未提交的生产镜像通道维护记录、核心文档及无关 SVG。

完整 Actions 日志确认两处不同原因：`b6522e4` 的供应商监控测试在 UTC 00:34 运行，相对当前时间的 40 / 20 / 10 分钟样本跨越 UTC 午夜，趋势实际为 2 天，测试却固定断言 1 天；`9b5ddb8` 的运营中心在 `linux/arm64` 的依赖安装阶段触发 `qemu: uncaught target signal 4 (Illegal instruction)` / 132，AMD64 阶段已成功。不能将测试失败解释为 CSV 计费功能失败，也不能将失败发行的 latest 当作新版本。

| 文件 | 改动及后续保留要求 |
| --- | --- |
| `provider-monitor/tests/account-monitor.test.js` | 将同窗口成本比较用例的完整时钟固定，复用既有断言覆盖白天和实际失败的 UTC 跨午夜时间；核对趋势日期、请求合计和所有原有金额 / 覆盖 / 归属保护。不放宽生产匹配，不移除或重试失败测试。 |
| `.github/workflows/docker-publish.yml` | 四类测试使用固定 Ubuntu 24.04。七个服务分别使用 `ubuntu-24.04` / `ubuntu-24.04-arm` 原生构建 AMD64 / ARM64，移除 QEMU；缓存按服务及架构隔离。先按 digest 推送候选，在各原生 runner 校验 Node 架构、SQLite 原生模块和完整 OCI revision，成功后导出当前运行专用 digest；所有构建完成后再合并双架构并更新原 latest / 分支 / SHA / 版本标签，检查最终架构。PR 保留测试和双架构构建但不推送；测试和构建失败不推进正式标签，保留 provenance 和原有 GHCR 仓库 / 标签契约。 |
| `CUSTOMIZATIONS.md` | 本节记录原因、改动和验证；不纳入此前独立生产维护记录。 |

验证：Linux / Node 20.20.2 完整 288 项供应商监控测试全部通过，Windows 两个固定时钟用例通过；actionlint、14 个原生构建矩阵项 / 7 个发布项 / 原四类测试门禁关系及 14 个 Bash 步骤语法检查通过，diff --check 通过。本机 Docker daemon 未运行，镜像原生构建 / 运行检查及正式标签发布结果以本次 SHA 的 GitHub Actions 为准，推送后继续核验；不能将推送成功声明为发布成功或生产已上线。

## 2026-10-24：简化 CSV 补记并自动读取主站售价

用户同意简化流程，并要求自动读取服务器主站模型价格、尽量不手配售卖规则。本轮 extra 保持 `main`，核心配套改动保持 `dev`，仅本地实现及隔离验证。没有连接生产、推送、发行、部署、预留或补扣真实用户。保留既有未提交的生产镜像通道记录、核心服务器改动清单及无关 SVG。

| 文件 | 本轮改动及后续必须保留的约定 |
| --- | --- |
| `operations-center/src/services/billing-import-service.js` | 默认自动调用原生 imports/quote；历史快照优先，缺失时主站当前模型 / 渠道价及用户 / 原分组倍率，显示来源 / 时间。人工规则仅可选；报价失败不估价。预览只读资金，不再要求先勾选最终确认，确认时统一核对归属 / 最终用量 / 价格来源 / 金额；冻结每行费用与摘要后按原预留 → usage review → prepared → settle 执行。支持管理员核对的完整文件日志来源，保留原生防重与丢回包恢复；匹配证明纳入选定关系及整批唯一分配摘要。 |
| `operations-center/src/services/billing-import-matcher.js` | MATCH_VERSION=3。完整且可用的精确候选按连通分量做整批一对一分析，只选所有完整分配中都必需的边，不选最近请求。分量超过 160 行 / 400 来源、触及不确定来源或无法完整分配保持核查；同用户和跨用户仍存在的歧义不强行解开。 |
| `operations-center/src/services/billing-import-logs.js` | 完整的唯一账号选择 / 访问结束 / 一致用户-Key-分组关联可生成管理员核对来源，含稳定 log:服务端ID、失败状态 / 时间 / 耗时与 sanitized 事件 SHA-256，不伪造原生错误，不保存正文或密钥。 |
| `operations-center/src/services/billing-import-source.js` | 只读核对文件来源对应的现存 Key / 用户 / 原分组，补邮箱、分组名与余额 / 订阅类型；已删除或不一致实体阻断。保留原生已有账单排除及多来源合并。 |
| `operations-center/src/billing-import-store.js` | 从最近 50 个批次读取相同表头 / Key 集合最近成功分析的映射与时间设置，导入后仍展示供核对。已开始批次禁止更改选项；允许原选项重新分析其余未开始行，不覆盖已预留 / 失败 / 结算中 / 已结算行、冻结预览或回执。无新表 / 迁移。 |
| `operations-center/public/index.html`、`public/billing-import-ui.js` | 主操作“分析账单并生成预览”，时间 / 缓存配置及人工售价折叠；默认自动报价，不输入价格。主筛选简化为可补记 / 待核查 / 已核平 / 已补记 / 全部记录；当前页最多 20 条唯一候选自动报价，单个最终确认包含价格来源。展示历史快照 / 当前主站价格与报价时间；报价全失败显示待核查与原因，确认完可查看已补记。保留金额差额、订阅隔离、输入变化后重报及转义。 |
| `operations-center/tests/billing-import.test.js` | 自动原生报价、来源 / 时间与归属、当前价格与历史价格区分、报价失败阻断、确认冻结费用、文件日志原生预留及结算、不制造 ops_error_logs、记忆映射、原选项重分析保留回执；适配预览只读 / 单次确认语义。 |
| `operations-center/tests/billing-import-matching.test.js`、`billing-import-source.test.js` | 只有强制唯一的整批关系才选定，歧义 / 来源不足不猜测；完整日志来源、真实 PGlite 的用户 / Key / 分组核对及订阅类型。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 模拟 2 条原生请求和 1 条完整文件日志的自动报价；验证无需填价格、历史 0.7 与当前分组 0.9 / 账号 0.79 区分、单次最终确认、金额差额、订阅隔离、重载回执及桌面 / 手机布局。只连接本地演示，没有真实 DB 或供应商凭据。 |
| `operations-center/docs/billing-csv-import.md`、`docs/billing-recovery-behavior.md`、`README.md` | 重写简化操作、自动当前价与历史价、整批唯一分配、文件来源的管理员信任边界、未开始行重分析、核心和运营中心同时升级要求。 |
| `CUSTOMIZATIONS.md` | 本节登记改动、验证及当前行为，历史章节中的仅文件不可预留 / 必须手配价格要求以本节为准。 |

本轮没有把 CSV 上游支出当售价，也没有按上游倍率反推下游价格。自动价格由主站复用原生模型、渠道、用户 / 原分组倍率计算；账号倍率不再次乘入用户费用。有不可用的历史价格快照仍阻断，当前报价不冒充历史价格、不写回已有快照；严格历史价可用可选人工规则核定。报价和预览不预留、不写使用记录或资金，最终确认使用冻结金额。未知缓存不能当零，有创建总数但无 TTL 时仍须核定缓存时长，这不需要填写价格。

完整文件日志是运营中心读取并由管理员确认的结构化来源声明，SHA-256 不是签名；核心不独立认证原文件。日志仍须完整关联和唯一匹配，核心在原事务锁下再核对身份、原请求期限、用量、持久意图和 dedup / 归档。没有日志挂载、日志已缺失、同用户并发仍不唯一、缺价格或特殊维度不能强行补扣。部署需配套更新核心和运营中心，现有 CSV schema 无新增迁移；供应商监控原查单流程不受改变。

验证：运营中心完整 225 项测试、npm run check、1440px / 390px / 正差额 / 未知上游费四组 Playwright 流程通过，截图复核无整页溢出或未捕获脚本错误。无需输入售卖价即可分析并预览 3 条模拟补记，确认后仅生成模拟原生结算回执；新预览的价格来源、金额冻结和重复确认行为均验证。

旧生产快照的离线回放保留 13,176 条已核实计费和此前排除的 24 条误报。14,480 行中，147 条唯一时间候选可进入核价（上游支出合计 47.23870787 USD，不是已确认补扣金额）、969 条已定位用户仍待具体请求核查（615 仅文件 / 354 原生）、122 条歧义、16 条用量差异、12 条时间不足、4 条扣费未核实及 34 条重复；此前 13,045 条已有关联用量和 761 条文件归属均通过保护断言。无法把此前 1,111 条全部宣称为可扣费。回放仅读外部快照，自动价格与确认使用隔离模拟；未执行实际服务器价格读取、资金结算、Docker / Linux CI 或 GitHub 发布。

配套核心定价 / 导入 / 结算专项、4 项真实 PostgreSQL 回归、Windows server 构建通过；新增 Key 迁组和报价空依赖回归通过，原 CI 默认配置的三个完整核心包 golangci-lint 为 0 issues。两仓库最终 diff --check 通过。隔离本地预览 HTTP 为 200，确认包含自动分析与主站报价选项；不影响此前运行中的旧预览进程，无新增生产配置或运行依赖。

用户随后授权验证后推送 GitHub。本次仅将上述 CSV 简化、自动报价、完整日志来源、测试与说明提交到 main，核心配套提交到 dev。推送前 fetch 确认与远端同步，复核验证记录与暂存差异；保留现有镜像构建门禁，发布结果以本次 SHA 的 Actions 为准。此前独立生产镜像通道维护台账和无关 usage-leaderboard SVG 继续保留本地未提交，不纳入本轮；没有更新服务器、预留或补扣真实用户。

## 2026-10-24：按 CSV 请求时段重构计费核查匹配

用户要求按最终讨论流程实施，以 CSV 对应请求时段的历史证据为准，不能绑定昨天或以未来新增日志字段补历史。本轮只修改 extra 既有运营中心，保留 main 及主站 dev；没有修改主站源码、数据库迁移、生产文件 / 余额，没有提交、推送、发布或部署。保留此前独立生产镜像通道台账、主站两份文档及无关 SVG。

| 文件 | 改动及后续集成须保留的行为 |
| --- | --- |
| `operations-center/src/services/billing-import-source.js` | 提取共享 `billingImportWindow`，按有效、非重复、已映射 CSV 的时间 / 时钟修正和完整耗时计算证据范围，同时读取两种时间含义；支持任意日期、跨日和超过四小时的请求。未提供耗时仅增加读源余量，不增加归属确定性。原生 SQL、核心案件和文件日志共用范围；返回时间 / 来源诊断，保留原有查询上限及失败阻断。 |
| `operations-center/src/services/billing-import-matcher.js` | MATCH_VERSION=4。相同四类 Token 先按开始 / 结束时间缩小范围，再做已有用量的一对一分析，避免要求全天 Token 唯一而漏排已扣费项。时间校准每个独立原生请求最多一票；已计费与未记账分阶段复用有界强制分配，冲突 / 超限 / 无完整分配的分量转核查，不选择最近请求。返回匹配依据、请求起止及阶段汇总；未知耗时、用量差异、无扣费凭据不当作新整笔消费。 |
| `operations-center/src/billing-import-store.js` | 共用原表与参数化 SQL，增加跨整批的待核查用户分组和分页用户筛选，包含 Key / 上游账号数量；不创建资金表或新迁移，不改变冻结回执和唯一预览约束。 |
| `operations-center/src/services/billing-import-service.js` | 验证用户筛选；报价前和首次确认前复查来源身份、时间 / 状态 / 计费类型及文件摘要，摘要变化即停止。新匹配版本要求未开始预览重跑；已进入 confirming / failed 的版本 3 补记按原冻结预览及原生预留幂等续办，禁止因此另建扣款。自动报价 / 原生使用记录 / review → prepared → settle 资金契约不变。 |
| `operations-center/public/index.html`、`public/billing-import-ui.js`、`public/billing-recovery.css` | 展示 CSV 时间、读取时段 / 时区、来源数量 / 留存范围、每行的请求起止与匹配依据；已核平改名已计费。待核查按用户集中筛选 / 翻页，归属唯一但请求不唯一仍显示待核查；恢复中的版本 3 保留可选确认。沿用自动报价、金额对比和单次最终人工确认，不将候选费用冒充已回收金额。 |
| `operations-center/tests/billing-import-matching.test.js`、`billing-import-source.test.js`、`billing-import.test.js` | 新增重复 Token 跨时段 / 唯一分配、同一本地请求不得提供多票、任意历史日期 / 跨日七小时的真实 PostgreSQL 读源、时钟偏移 / 无效与未映射不扩范围、整批用户分页、文件摘要变化阻断及版本 3 恢复回归。保留已有预览只读、原生幂等、并发确认 / 租约和历史用量保护测试。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 隔离模拟显示同一范围诊断；桌面 / 手机增加按用户筛选及禁选已有账单，桌面验证旧版已开始记录可恢复。演示返回本地服务实例供测试操作，不增加 HTTP 测试接口；不连接真实凭据、DB 或上游。 |
| `operations-center/scripts/billing-import-replay.cjs` | 外部历史快照按与正式源相同的 CSV 范围过滤后回放，保留 24 条误报排除、13,045 条原生用量和 761 条文件归属保护断言。仅读本地文件，无主站 / 供应商请求或资金动作。 |
| `operations-center/docs/billing-csv-import.md`、`README.md`、`CUSTOMIZATIONS.md` | 记录按文件时段、两阶段核对、新状态和按用户核查、旧预览 / 在途兼容及部署范围。具备现有自动报价 / 文件来源接口时，只需更新运营中心。 |

验证：运营中心完整 233 项测试、npm run check 及四组 1440px / 390px Playwright 模拟导入、自动报价、金额差额、用户筛选、确认 / 刷新通过；版本 3 已开始补记的恢复通过，桌面 / 手机截图已复核。真实快照离线回放 14,480 行：13,262 已计费（较前版多排除 86 条）、148 唯一请求候选待报价、961 用户归属已定位但具体请求待核查、9 多归属、27 已有记录争用、8 未记账来源争用、16 用量差异、11 时间不足、4 扣费待核查、34 重复。此前误报 / 原生用量 / 文件归属断言全部通过。148 条上游支出合计 47.47758491 USD，只是报价候选的采购支出，不是确定的用户补扣金额；未执行生产报价或扣费。真实快照不进入 Git。

## 2026-10-24：自动关联候选证据与并发组核查

用户继续要求通过程序自动匹配候选。本轮仍在 extra main 实现，主站 dev 源码不变；沿用现有主站自动报价 / 导入 / 原生使用记录与资金事务，无新服务、配置或数据库迁移。没有提交 / 推送 / 发布 / 部署、连接生产、预留或补扣真实用户。保留既有未提交的前一轮匹配改造、独立生产台账、主站文档和无关 SVG。

| 文件 | 本轮改动及后续必须保留的约定 |
| --- | --- |
| `operations-center/src/services/billing-import-source.js` | 同账号 / 用户 / Key / 分组 / 模型下，用共同服务端请求 ID 或上游请求 ID 关联多份证据，记录来源引用及文件 SHA-256。客户端可复用 ID 和相近时间不能合并；多个 dispatch 案件分别保留，同账号重复尝试缺独立 ID 不压成一个。复用原有 Token 归一化读取已观察标准用量；缓存拆分未知的含缓存输入不假设缓存为零。 |
| `operations-center/src/services/billing-import-matcher.js` | MATCH_VERSION=5。先按可靠的最终计数一致 / 未完成计数下限排除不符候选，再复用整批强制唯一分配；请求 ID 与观察用量冲突时核查。对未解决的连通组自动返回账单数、候选来源数 / 类型、归属是否一致、是否存在完整分配、原始行号及关联 ID 缺口；数量相等不证明实际调用已完整覆盖。不会用同用户或任意完整分配假装逐笔确定，也不自动执行整组补扣。 |
| `operations-center/src/services/billing-import-service.js` | 关联来源摘要、已观察用量、组分析和排除关系纳入冻结匹配证明；预览及首次确认均检查证据变化。未开始的旧预览须重分析；版本 3 / 4 已开始确认可按原冻结预览 / 原生幂等继续，不另建资金事件。原报价和 review → prepared → settle 不变。 |
| `operations-center/public/billing-import-ui.js`、`public/billing-recovery.css` | 展示自动组分析、观察用量排除数量、每行组账单 / 来源数和原因、已关联证据份数与已有观察 Token。结果列最小 220px，表内横向滚动，手机上不把长原因挤成几字一行；不会把待核查组计为可补记。 |
| `operations-center/tests/billing-import-matching.test.js`、`billing-import.test.js` | 共同服务端 / 上游 ID、多 dispatch 保留、同账号多次尝试、复用客户端 ID / 分组隔离、最终 / 部分 / 无效 / 含缓存未知用量、同归属 / 跨归属 / 来源不足组、同组不得自动收费、关联文件和观察用量变化、版本 3 / 4 在途恢复回归。旧的观察用量冲突测试改为核对更早的证据变化阻断，并确认无第二次报价。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 隔离演示增加可关联错误证据和可被观察用量排除的并发案件；浏览器验证组诊断、来源证据份数、自动报价和版本 4 续办，增加桌面 / 手机待核查截图。仅模拟数据，无真实资金或 HTTP 测试后门。 |
| `operations-center/scripts/billing-import-replay.cjs` | 离线输出自动候选组和观察用量排除统计，保留原有误报 / 已扣费 / 历史归属保护断言。 |
| `operations-center/docs/billing-csv-import.md`、`README.md`、`CUSTOMIZATIONS.md` | 记录自动分析和仍需核查的条件、没有整组资金功能、快照实际结果、版本 5 和旧在途兼容、只升级运营中心的条件。 |

验证：运营中心完整 242 项测试及 npm run check 通过，四组桌面 / 手机 Playwright 导入、证据关联、观察 Token 排除、组诊断、自动报价、确认 / 刷新和旧版续办通过；截图复核及最终 diff --check 通过。真实快照 14,480 行回放仍有 13,262 条已计费、148 条唯一候选（上游 47.47758491 USD）、961 条同用户候选（上游 262.18099088 USD，607 仅文件 / 354 含原生）。旧案件缺关联 ID / 最终用量，本次不能编造证据提高可扣费数量。整批自动核查 279 组，其中 274 组归属一致、4 组不同归属、1 组来源不足，组分析不构成扣费许可；1 条原时间不足记录因取消不可靠客户端 ID 合并改为未匹配，其余金额与保护断言保持一致。没有执行生产报价、实际 Docker 构建或 GitHub 发行。

## 2026-10-25：CSV 整组报价等价核查、原子认领与跨批次防重

用户要求改造自动核查和去重。本轮 extra 保持 `main`，主站配套保持 `dev`。仅修改本地代码、文档和隔离测试，不提交、推送、发布、部署、连接生产或补扣真实用户。保留此前版本 4 / 5 的未提交改动、独立生产台账及无关文件。

| 文件 | 本轮增量与后续集成须保留的约定 |
| --- | --- |
| `operations-center/src/services/billing-import-matcher.js` | MATCH_VERSION=6。先按主站认领排除已结算账单、标记未完成原案件；候选来源及关联别名被其他账单认领时清除选择并转核查。完整一对一同归属余额历史组、2–20 独立来源、标准 Token / 缓存时长完整且无组外可能来源才标 group_candidate；稳定分配按账单摘要 / 来源排序，不称为历史精确对应。未接入完整历史认领接口时不开组功能。 |
| `operations-center/src/services/billing-import-source.js` | 按 CSV 证据时段逐账号读取主站 `/imports/claims`，验证账号、账单摘要和完整列表；404 / 503 保留旧逐笔流程并关闭组功能，多账号失败不能残留部分认领。原生异常分页同时检查总数稳定、完整页数及无重复案件，避免缺页被当完整覆盖。无效、截断或其他读取故障阻止匹配，不能降级为无重复。 |
| `operations-center/src/services/billing-import-groups.js`（新增） | 预览只读核对全组，逐账单检查每个可能来源的原生当前报价，计费维度 / 金额不等价或 Key / 账号额度导致时间分配不等价则阻断，不能用人工售价绕过。SQLite 原事务保存全组冻结预览；最终确认须显式包含所有成员，整组取得 CAS 租约，调用主站事务预留后才逐笔原生结算。丢回包、部分结算和重启沿原案件续办；无已提交认领的失败重试必须重新核对证据。 |
| `operations-center/src/services/billing-import-service.js` | 路由整组预览 / 确认；detail 返回触及组的全部 relatedRows 供跨页展示；原逐笔结算提取复用，不直扣余额。确认最多 400 条组成员、逐笔仍最多 20；请求不能混入其他批次。版本 3 / 4 / 5 已开始结算可按旧冻结预览续办，未开始须重分析。 |
| `operations-center/src/billing-import-store.js` | 原筛选包含整组待报价 / 认领状态；复用现有 preview JSON 保存组清单和摘要，无 SQLite 新表或迁移。保留现有双唯一、CAS 和在途记录保护。 |
| `operations-center/public/billing-import-ui.js`、`public/index.html`、`public/billing-recovery.css` | 默认自动分析 / 主站报价，整组选中带齐跨页成员；展示全组 CSV 时间、用户 / Key、模型、输入 / 输出 / 缓存 Token、费用、状态及原预览合计。区分稳定记账分配和历史对应，已成功成员在续办时完整展示但不纳入剩余扣费汇总。表内滚动及组表最小宽度防止手机压缩，确认仍须管理员勾选。 |
| `operations-center/tests/billing-import-groups.test.js`（新增） | 确定排序、隐藏来源 / 订阅 / 缓存 / 大小阻断、认领与别名防重、所有对应报价等价、人工规则不可绕过、跨页完整确认、预览无资金、并发操作、认领回包丢失、重启 / 部分成功续办、重导不重复及失败后证据变化阻断。使用隔离 SQLite 和模拟主站。 |
| `operations-center/tests/billing-import-source.test.js` | 完整多账号认领、旧主站部分响应清空、无效 / 超限结果和读取故障阻断。保留此前真实 PostgreSQL 时段 / 来源测试。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 独立模拟主站组认领 / 回执并加入两笔同用户历史错误；CLI 演示含组，旧四种浏览器场景保留，增加桌面 / 手机整组展示、联动选择、原生认领及确认模拟。无真实凭据、供应商或生产数据。 |
| `operations-center/scripts/billing-import-replay.cjs` | 输出组阻断原因；可选 `--saved-balance-context` 从外部已保存无订阅案件推断文件来源类型，明确标记为离线推断，不能当现存 Key / 配额 / 价格或认领验证。保留此前误报、原生用量及历史归属保护断言，真实数据不进入 Git。 |
| `operations-center/package.json` | npm run check 的 precheck 纳入新增组编排模块语法检查，不改依赖和锁文件。 |
| `operations-center/docs/billing-csv-import.md`、`README.md`、`CUSTOMIZATIONS.md` | 更新版本 6 全组操作、资金 / 非精确分配边界、快照实际结果及主站 / 运营中心配套升级要求，取代前轮“本次只升运营中心”的条件。 |

配套主站仅增加可选整组认领 / 历史认领接口、新组回执表迁移，以及冻结用量和额度保护；详细源码清单位于主站 `CUSTOMIZATIONS.md` 同日章节。主站 PostgreSQL 的账号锁、同账单 / 同来源双唯一和原生 usage + dedup + 资金事务才是最终防重依据，SQLite 并非资金账本。组认领全成或全回滚，资金仍逐笔提交，失败保留原映射，不重新配对或直接扣余额。启用功能需同时更新两个组件，无新增机器、服务、生产依赖或供应商 API 凭据。

历史快照实际回放：14,480 行仍为 13,262 已计费、148 唯一请求报价候选（上游采购支出 47.47758491 USD）、961 同用户待核查（采购支出 262.18099088 USD）、34 重复，其余差异 / 冲突 / 时间不足保持原样。新增可整组报价为 0；原快照缺文件来源的余额类型，即使补入同快照无订阅案件推断，仍有 108 组缺共同关联 ID、170 组有组外无耗时错误重叠、1 组来源不足。原生错误最长四小时范围不能凭数量相等排除。不能宣称 961 条已确定可补扣；补扣金额要以未来实际主站核价和管理员确认为准。24 条旧误报、13,045 条既有关联用量及 761 条文件归属断言全部保持通过。

验证：完整运营中心 252 项测试、npm run check 和两仓库 diff --check 通过。六组 Playwright 覆盖 1440px / 390px、正差额 / 未知上游费、旧版在途恢复和新增整组联动选择 / 全成员展示 / 认领 / 模拟结算；截图复核后将组表和汇总移到确认按钮之前，手机组表保持水平滚动、不压缩长字段。核心计费专项、5 项 PostgreSQL/PGlite SQL、三个完整包的默认配置 golangci-lint 0 issues 和最终 Windows 构建通过。两种历史回放均只读本地快照；没有生产报价、预留或资金写入，没有实际 Docker / Linux CI 或 GitHub 发布。所有本轮改动保留本地待审核，未推送或部署。

用户随后明确授权提交并推送 GitHub。本轮将上述匹配版本 4 / 5 / 6、整组编排、界面、测试和文档提交到 extra main，主站配套原子认领 / 防重接口和迁移提交到 dev。推送前 fetch 确认两仓库均与远端同分支同步；独立生产镜像通道台账、无关 SVG 和其他项目文件继续保留本地。沿用现有测试门禁和 GHCR 镜像发布流程，构建与发布结果以此次提交 SHA 的 Actions 为准；本次不部署服务器、预留请求或补扣真实用户。完整功能升级需主站和运营中心同时更新。

## 2026-10-28：CSV 扣费预览支持整批分批处理

用户希望生成扣费预览时不再只覆盖默认条数。本轮仅修改运营中心，沿用 `main` 分支；不修改主站或结算契约，不连接生产，不报价真实请求、不预留或扣费。用户随后授权提交并推送本节实现；生产部署仍需单独授权。

| 文件 | 改动与保留要求 |
| --- | --- |
| `operations-center/public/billing-import-ui.js` | 自动模式分页读取整批“可补记”记录，筛出已有确定匹配的请求并以最多 20 行分块调用既有预览 API；整组只提交一个入口，避免跨块重复处理成员。显式选择也不再静默 `slice(0,20)` 丢弃其余选择，而是同样分块处理。逐块顺序执行并保留成功结果；批次切换或离开时停止后续请求。单个 API 请求大小和最终确认限制不变。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 添加 21 条可报价样本，验证完整扫描 20 + 1 两个请求并保存所有预览；保持现有桌面 / 手机与整组流程回归。演示数据不连接生产或真实主站。 |
| `operations-center/docs/billing-csv-import.md` | 更新自动整批报价、手动选择分批及确认仍需逐笔分批的说明。 |
| `CUSTOMIZATIONS.md` | 记录本次实现、测试及不可放宽的单次确认界限。 |

API 每请求最多 20 行；前端串行分块以控制负载。最多 20,000 行的批次仍受既有 CSV / 源读取限制。确认端仍只接受每次最多 20 笔逐笔，整组确认上限仍为 400 个成员；“全批生成预览”不代表自动批准或自动扣款。进程中断时已保存的预览保留，重新打开同一批次只会处理仍处于可补记状态的行。验证：运营中心完整 252 项测试、`npm run check`、桌面 / 手机和整组 Playwright 回归通过；21 条待补记样本分成 20 + 1 两批全部生成预览，无预留或结算。未部署生产。

## 2026-10-29：CSV 确认回执与跨页选择

用户要求排查“确认补记并扣费”无反应，并支持跨页选择后生成预览。本轮只改 extra main 的运营中心；主站仍保留 dev 和既有原生资金事务，不改迁移、价格或匹配标准。实现与验证完成后，用户明确要求提交 GitHub，本次据此提交并推送；不部署或补扣生产用户。保留此前独立生产台账、核心两份文档、其他工程和无关 SVG。

生产只读核对：运营中心运行 b77ec22，主站实际二进制 0.2.18001201。北京时间 10/29 00:33 复查的 80 条预览均未过期，重新读取完整来源后 80 条匹配证明全部相同；该 CSV 所有行 case_id 为空，尚无 confirming / failed / settled，确认流程没有留下认领或结算结果。运营中心 Nginx 关闭访问日志，不能从缺少访问记录推断按钮是否发出请求或当次报错原因。代码确认存在长时间自动报价期间无明确说明的禁用状态、仅在上方显示错误、HTTP 200 内逐行失败只提示零成功，以及确认后先自动报价才提示回执的问题；本次修正反馈和调用顺序，不声称已复现生产的某个特定提交错误。

| 文件 | 改动和后续保留要求 |
| --- | --- |
| `operations-center/public/billing-import-ui.js` | 按批次缓存选择与行快照，翻页 / 筛选保留勾选和取消；增加全选当前筛选所有页、清空选择和跨页金额 / 用户汇总。选择变化重置最终确认；切换批次 / 重新分析 / 退出清除，浏览器刷新不持久化选择。普通歧义候选组不合并预览入口；只有已核查整组 / 冻结预览组去重。预览请求只携带当前块的价格和归属，避免大批量请求体超限。 |
| 同上 | 确认前只读刷新跨页行并核对版本 / preview ID；所选须全部有预览，过期 / 在途租约 / 设置变更显示阻断原因。最多 20 个成员一块串行确认，整组始终完整，遇错停止后续块；成功和失败均刷新原回执，不自动重试不确定的资金请求。显示进度、已核实消费笔数、余额金额、订阅用量和失败原因；确认后不启动剩余项目自动报价。保留 preview / failed / confirming 的原冻结金额和核心幂等续办。 |
| `operations-center/public/index.html`、`public/billing-recovery.css` | 增加跨页选择控制、禁用原因和按钮下方的可访问状态 / 错误回执；表内及手机保持既有滚动布局，核查明细仍在确认前展示，无新增弹窗。 |
| `operations-center/src/services/billing-import-service.js`、`src/app.js` | 新增管理员 + CSRF 保护的 POST /billing-imports/:id/rows，只读返回最多 400 个所选行及冻结组完整成员 / 金额，校验所属批次。没有预留、报价、结算或余额写入；原确认 API 限制和原生 review → prepared → settle 保持不变。 |
| `operations-center/tests/billing-import.test.js`、`billing-import-groups.test.js` | 验证跨页读取不扣费、版本 / 回执 / 金额、跨批次拒绝、请求上限、认证 / CSRF 和只选一个入口仍披露全部组成员；保留已有丢回包、租约、幂等、用量 / 证据变化保护。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 纯模拟账本增加独立消费记录、余额和单次扣费计数；浏览器覆盖 21 行跨页选择 / 取消 / 筛选 / 全选、20 + 1 预览 / 确认、跨页完整组、过期重报、双击、部分失败 / 原案件续办、确认 HTTP 回包丢失后读回执。仅隔离本地数据，不连接生产或真实上游。 |
| `operations-center/docs/billing-csv-import.md`、`CUSTOMIZATIONS.md` | 更新跨页步骤、选择生命周期、自动分块确认、原位回执、过期和部分成功行为；此节取代前节需管理员手动拆分确认的 UI 说明。 |

验证：运营中心完整 253 项测试、语法检查及 11 组桌面 / 手机 Playwright 流程通过；21 笔模拟消费 / 余额和重复确认仅扣一次、跨页整组的 19 + 2 完整分批、过期、双击、部分失败及回包丢失场景通过。新增组读取专项通过；截图复核后去除预览 / 确认的浮动长消息，保留原位回执，避免手机提示遮住结果。主站既有 BillingRecovery / BillingImport 专项和 5 项真实 PostgreSQL / PGlite SQL 回归通过，没有修改主站文件。最终 diff --check 通过。独立本地演示 http://127.0.0.1:19879/preview 返回 200，仅模拟数据，可查看新版界面，不连接生产。未进行实际 Docker 构建、GitHub 发布或生产资金结算。

本次提交仅包含上述运营中心源码、测试、文档与本节台账；此前生产镜像通道 / 只读日志挂载 / SQLite 临时目录维护章节保留本地，不纳入源码发行。沿用既有 GitHub 测试门禁和 GHCR 镜像构建流程，发布以本次完整提交 SHA 对应的 Actions 为准；提交 / 推送成功不代表镜像已经发布或服务器已更新。本次无需修改或重新发行主站。

## 2026-10-29：可补记全部展示与显式报价

用户反馈分页 / 自动报价卡顿，要求可补记记录一次展示，全选生成预览后确认原生使用记录与扣费。本轮仅修改 extra main 的运营中心；主站 dev、匹配版本 6、来源核查和原生 reserve → restore → review → settle 契约不变。实现和验证完成后，用户明确要求提交 GitHub，本轮据此提交并推送；未部署或操作生产资金，保留既有独立维护台账和无关文件。

| 文件 | 改动和后续保留要求 |
| --- | --- |
| `operations-center/public/billing-import-ui.js`、`public/index.html` | 可补记筛选使用只读 view=all 一次展示整批可操作记录，表头直接选择全部，不逐页读取。其他筛选保留分页和跨页选择。“分析账单”仅匹配；报价只在显式点击“生成所选扣费预览”时执行，切换筛选 / 打开批次 / 翻页不再隐式报价。保持默认主站自动定价，无需售卖规则。更新静态资源版本。 |
| 同上 | 报价失败转待核查的行取消勾选，避免已隐藏但仍选中的未报价行阻断成功项确认。确认分块后读取原持久回执，核对 settled、核心案件 ID、冻结金额才继续；不完整或失败停止后续块。成功计数和金额仅基于上述回执，保留重复点击、过期、失联和原案件续办保护，不把 HTTP 200 等同结算成功。 |
| `operations-center/public/billing-recovery.css` | 列表在有界高度内滚动、表头固定，避免全量列表把确认操作推到页面末尾；复用既有样式变量及手机水平滚动。 |
| `operations-center/src/services/billing-import-service.js` | 仅 actionable 支持 view=all（最大 20,000 行，等于现有 CSV 行数上限），默认 API 分页兼容。整组关联成员按 ID 读取并检查所属批次，避免为少量成员解析整批 JSON。只读展示不核价、不取主站证据、不预留或扣费。 |
| `operations-center/src/services/billing-import-groups.js` | 普通逐笔预览在确认没有整组入口后直接返回，避免每 20 条都无条件解析整批行；实际整组核查和资金语义不变。 |
| `operations-center/tests/billing-import.test.js`、`scripts/billing-import-browser-check.cjs`、`scripts/billing-import-preview.cjs` | 验证 148 条完整展示、默认分页兼容、列表无报价和资金效果、逐笔不走全库 JSON 解析、显式报价 / 全选 / 失败项移出 / 完整组 / 回执及去重；演示支持指定样本数，桌面 / 手机各验证 148 笔完整报价、使用记录及独立模拟余额，无生产连接。 |
| `operations-center/docs/billing-csv-import.md`、`CUSTOMIZATIONS.md` | 更新简化后的分析 → 全选 → 预览 → 确认步骤和失败 / 回执边界；本节取代前节自动打开时整批报价的界面行为。 |

另外复用 Intl.DateTimeFormat，选择汇总用 ID Set 替代重复扫描整表，降低全部展示时的格式化与勾选开销。每块报价和首次确认仍重新读取对应 CSV 时段的完整主站证据，保留当前全局一对一分配 / 重复计费核查，未为加速复用过期资金证据。真实主站核查和逐笔原生结算仍需等待网络与数据库响应。

验证：运营中心完整 255 项测试、53 项计费专项和 npm run check 通过。15 组 Playwright 场景覆盖桌面 / 390px 手机、148 条一次读取和本地全选、148 笔全量报价 / 模拟使用记录 / 余额变化、20 + 1 / 19 + 2 完整分块、报价失败项移出后继续确认、过期、重复点击、部分失败续办、回包丢失及回执金额不符即停止下一块；每笔模拟余额仅扣一次。148 行模拟切回列表约 55–91ms，全选约 50–110ms，此为本地演示观测，不代表生产主站证据读取或结算延迟。截图保留在本机临时 QA 目录。生产使用效果以部署后原生回执为准，本地模拟不冒充真实用户扣款。

本次只提交上述运营中心实现、测试、操作文档和本节台账；此前生产配置维护章节及无关文件继续保留本地。推送至 fjiangming/sub2api-extra main 后沿用原有 GitHub 测试与 GHCR 构建流程，镜像发布结果须按此次完整提交 SHA 核对；服务器仅需在发布成功后更新运营中心，无需更新主站。本次不部署。

## 2026-10-30：CSV 长时间预览与确认改为后台任务，修复 524

用户反馈新版全选可补记后生成预览仍返回 524。本轮仅改 extra main 的既有运营中心；不改主站 dev、匹配版本 6、价格规则、原生 reserve → restore → review → settle 和数据库资金事务。只读连接生产排查，没有真实预留、补记、扣费或配置改动；没有提交、推送、发布或部署本轮代码。保留此前独立生产维护台账和无关文件。

生产核对运行镜像为 `9d71d32903d3f4cbf7ce1d44e0f8c8cb6922e99c`，不是未更新。Nginx `proxy_read_timeout 600s`、无该站错误日志；站点关闭访问日志，无法引用本次 524 的精确访问轨迹。当前块已保存 16 条预览、4 条缺缓存 TTL 拆分转核查，case_id 全空，尚无补扣。保存时间显示逐笔核价约 6–8 秒；只读测量完整来源读取 13.866 秒、匹配 7.485 秒、单条主站报价 7.214 秒，20 条串行报价加全量复核足以超 Cloudflare 等待时限。前轮快速模拟未覆盖这个生产延迟；本轮补充阻塞读源 / 核价 / 原生结算验证，不通过放宽计费检查或仅增加反代超时解决。

| 文件 | 改动与后续集成须保留的行为 |
| --- | --- |
| `operations-center/src/services/billing-import-tasks.js` | 新增同进程后台任务执行，提交立即 202、短 GET 读取进度与终态。同任务 UUID / 同参数幂等返回，改参数拒绝；单实例一次一个任务，不将凭据 / 操作参数落盘。启动标记旧在途任务中断，不自动重放资金命令；正常退出等待当前块。 |
| `operations-center/src/billing-import-store.js` | 在原 SQLite / 原数据卷新增 import_tasks 与索引，保存身份、参数摘要、进度、终态和结果，同批次仅一条活动任务；不改原导入行、历史预览、原生认领或资金数据。 |
| `operations-center/src/services/billing-import-service.js` | 提取原预览 / 确认校验供任务复用，执行仍走原完整来源复核和资金契约。同步 / 后台操作共用批次互斥，匹配不能覆盖正在处理的预览；detail 披露最后任务以便刷新续看。新增逐笔进度，保留预览过期、版本 CAS、租约、证据变化阻断和原生去重。 |
| `operations-center/src/services/billing-import-groups.js` | 增加整组核价 / 结算进度钩子；每个可能对应的财务等价检查、全组冻结 / 原子认领、完整成员与部分成功续办保持原样。 |
| `operations-center/src/app.js`、`src/server.js` | 同管理员 / CSRF 边界新增提交与状态 API，启动识别中断、退出在关闭 SQLite 前等待任务。旧同步接口兼容保留，新页面不再使用它们执行长任务。 |
| `operations-center/public/billing-import-ui.js`、`public/index.html` | 预览 / 确认每块改提交任务并轮询，显示阶段和逐笔进度；刷新原批次恢复当前块，不新建重复任务。回包丢失只读原任务，轮询短暂失败只重试读取，失败刷新持久行结果；连续失联明确提示核对。运行中禁改匹配 / 归属 / 核价与重复确认，保留完整组、跨页选择、部分成功停止后续块和真实回执校验。静态资源版本更新。 |
| `operations-center/tests/billing-import-tasks.test.js` | 验证读源 / 报价阻塞时快速 202 和可轮询、同 ID 幂等 / 改参数拒绝、认证 / CSRF / 跨批次 / 原上限、原生已提交后回包丢失只扣一次、实际 SQLite 关闭重开后中断恢复、部分成功后异常保留及退出等待 / 拒绝新任务。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 演示加入任务生命周期，原 15 场景适配后台接口；增加桌面 / 390px 手机慢报价与已提交结算期间刷新恢复、无重复提交 / 扣费和进度布局。全部仅隔离模拟，不连接生产。 |
| `operations-center/package.json`、`README.md`、`docs/billing-csv-import.md`、`CUSTOMIZATIONS.md` | 语法门禁纳入新模块，记录后台步骤、同 ID 重读、刷新 / 重启 / 凭据过期与部分成功边界、仅运营中心更新范围，无新依赖或生产配置。 |

多块仍由页面串行提交，当前块不依赖浏览器连接，离开后未提交的后续块不会自动扣费；管理员重新打开后核对原结果再续办。强制终止可能中断当前块，已保存预览 / 主站回执保留，原 5 分钟租约未到期时须等待，不能把任务表当资金账本。新任务本身不会缩短真实主站的核查 / 结算耗时；故障、缺完整 Token / TTL 或证据变化仍须阻断。单实例 / 单进程使用原数据卷，不支持多个运营中心进程共享 SQLite 同时执行。

验证：完整运营中心 261 项测试（含 6 项新增后台任务回归）、npm run check 和 diff --check 通过；17 组 Playwright 覆盖原 15 场景及新增桌面 / 390px 手机后台报价和原生已提交结算期间刷新恢复。148 条一次展示 / 全选、20 + 1 / 19 + 2 完整分块、回包丢失、部分失败 / 原案件续办和回执金额不一致停止后续块仍通过；每笔模拟余额只扣一次。桌面 / 手机进度截图已复核，无页面溢出或遮挡。延迟使用可控阻塞模拟，未将其宣称为真实 Cloudflare 端到端验收；真实生产只进行了前述只读诊断。本轮未进行 Docker / Linux CI、GitHub 发布、生产补扣或部署。

用户随后明确要求提交 GitHub，本次据此将上述 524 后台任务修复、测试、文档和本节台账提交并推送 extra main。推送前 fetch 核对远端和当前分支，沿用现有测试门禁与 GHCR 镜像工作流；构建 / 发布结果须按本次 SHA 的 Actions 核实。此前独立生产配置维护台账、主站已有文档和无关未跟踪文件继续保留本地，不纳入本次提交；不更新服务器或操作真实用户资金。
