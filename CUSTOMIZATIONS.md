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
