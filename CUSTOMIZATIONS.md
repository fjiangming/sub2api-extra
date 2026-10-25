# 个性化功能维护台账

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
