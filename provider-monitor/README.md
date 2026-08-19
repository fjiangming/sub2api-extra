# Provider Monitor

Provider Monitor 是 Sub2API Extra 的供应商资产、余额、密钥分组和预算监控模块。以独立服务运行，数据保存在自带的 SQLite 中，不修改 Sub2API 数据库。

## 功能概览

| 功能领域 | 说明 |
|---|---|
| **资产同步** | 供应商连接探测、凭据验证、定时同步和持久化重试；同连接同步互斥、单供应商并发上限、随机调度抖动和连续失败熔断 |
| **余额与密钥** | 账户余额、多币种余额、密钥额度、到期时间和路由分组 |
| **趋势分析** | SQLite 历史快照、小时/日降采样、余额趋势、日均消耗与可用天数预测 |
| **毛利统计** | 按供应商、Key 或账号汇总基座现金收入、上游现金成本和毛利，支持日、周、月时间线及日期、供应商筛选 |
| **异常检测** | 余额/用量异常、Key 健康、资产与分组漂移、价格目录和模型推荐 |
| **账号质量** | 按平台同步 Sub2API 全量账号与真实请求日志，比较缓存读取率、首字/总耗时分位数、输出速度、主动检测通过率和动态题集能力分；支持手动与定时检测 |
| **签到与对账** | 自动签到、Sub2API 分组映射、用量对账和 Channel Monitor 健康联动 |
| **倍率对照** | 基座 Sub2API 渠道/分组目录、供应商上游分组倍率、充值倍率、综合倍率和偏差预警 |
| **规则与自动化** | 统一管理告警规则与执行型自动化；告警规则创建可确认、可恢复的事件，执行规则支持 Sub2API 账号启停、备用映射切换与定时重建映射、演练、动作限额和回滚 |
| **通知** | Webhook、Telegram、Gotify、Bark、邮件、企业微信、Server酱个人微信、钉钉和飞书 |
| **测试中心** | 按供应商和通知通道模拟低余额告警，验证手机收信、一次性充值入口、适配器登录与直接链接降级 |
| **数据管理** | JSON/CSV/环境变量/All API Hub 兼容导入、配置导出、加密灾备包、SQLite 在线备份、WebDAV 与 S3 兼容备份 |
| **凭据安全** | 凭据先验证后轮换、短期回滚、主 Secret 重加密和敏感操作二次认证 |
| **可观测性** | Prometheus 指标、结构化请求日志、request ID 与示例 Grafana Dashboard |
| **安全防护** | AES-256-GCM 凭据加密、DNS 固定 SSRF 防护、管理员会话和 CSRF 防护 |

配置 JSON、加密灾备包和 SQLite 备份的用途不同：

- **导出配置**包含供应商阈值、充值链接、显式告警规则和通知通道定义，但不会包含密码、SendKey、Webhook Key、Token 或 API Key。导入到空实例时会恢复供应商配置，告警定义可用于核对和迁移；缺少凭据的供应商保持停用。
- **加密灾备包**包含供应商凭据、显式告警规则、通知通道及通道凭据，适合跨实例迁移。所有凭据由独立灾备密码二次加密；通过灾备恢复接口导入时，供应商级规则会自动关联到新实例中的供应商 ID。
- **SQLite/远端备份**包含完整运行数据，包括告警事件和通知投递历史，适合整实例恢复。

## 支持的适配器

| 类型 | 余额 | 密钥 | 分组/团队 | 主要凭据 |
|---|:---:|:---:|:---:|---|
| Sub2API | 是 | 是 | 是 | 邮箱密码、Token 对、一个或多个 API Key |
| New API / One API | 是 | 是 | 视分支而定 | 系统令牌、用户 ID |
| One Hub / Done Hub | 是 | 是 | 从 Key 主组/备用组引用推导 | 系统令牌、用户 ID |
| Veloera | 是 | 是 | 是 | 系统令牌、用户 ID |
| DeepSeek | 多币种 | 否 | 否 | API Key |
| OpenRouter | Management Key | 是 | 否 | Management Key 或 API Key |
| LiteLLM Proxy | 全局预算 | 是 | Team Budget | Master Key |
| VoAPI v2 | 是 | 是 | 是 | API Key、用户 ID |
| Custom | 是 | 可配置 | 可配置 | 自定义 Header 与受限 JSONPath |

Sub2API 会同步普通用户可见的默认倍率和用户有效倍率，并保留峰值倍率、图片固定价等分组计价信息。站点启用用户侧 `channels/available` 功能时，还会同步渠道模型价格并按有效分组倍率计算实际价格；未启用时目录同步会明确标记为"仅倍率"。

不同分支可能关闭或改写密钥、分组端点。同步会把这类情况标记为"部分成功"，并继续保存已经确认的余额，不会伪造缺失能力。

## 毛利统计

“毛利统计”默认展示最近 30 个自然日内全部上游供应商每天产生的毛利。业务维度可切换为上游供应商、Key 或账号，时间粒度可切换为每天、每周或每月，并可限定供应商、日期范围和折算币种。页面同时展示时间线、维度汇总和逐周期明细。

统计直接读取永久费用账本，使用请求发生时冻结的充值倍率计算 `基座现金收入 - 上游现金成本`。日界线、周界线和月界线按 `PROVIDER_MONITOR_TIMEZONE` 切分；累计计数器增量按检查点时间入账，并在页面标出最高时间精度。上游倍率未确认时只返回估算毛利，缺少金额或汇率时标记为数据不完整；未归因账目保留在总账质量提示中，不会静默伪装为精确的维度毛利。

统计模式提供三种专业口径：`标准毛利` 保持现有归因逻辑并包含所有用户的已归因账本；`排除管理员用户账本` 按请求发起者 `user_id = 1` 过滤管理员的基座现金收入；`管理员消费计入费用（纯毛利）` 先采用排除口径，再将该管理员的基座现金消费额作为费用扣除。`account_id` 表示请求使用的上游账号，不能用于判断请求者身份；上游成本继续按供应商永久账本统计，避免把同号的上游账号误当成管理员。第三种模式会在汇总、时间线和可归因的维度明细中单独展示管理员消费支出，无法归属供应商的部分保留在总额并给出数据质量提示。

数据库升级到 schema v27 后会在下一次账号日志同步时全量回补当前观察窗口的请求用户 ID。回补完成前，管理员口径会提示“缺少请求用户 ID”的账本数量；这些历史记录不会被猜测为管理员或普通用户。

API：`GET /api/gross-profit?dimension=provider&granularity=day&from=2026-08-01&to=2026-08-31`。

## Sub2API 账号质量监控

“账号质量”视图把真实业务请求与主动检测分开保存和展示。实现参考了 [禾维 AI](https://www.hvoy.ai/) 公开展示的在线率、模型一致性信号、延迟、样本量和风险提示思路，但检测对象是 Sub2API 基座中的具体上游账号，而不是中转站域名。

### 数据来源

| 来源 | 接口或数据 | 保存内容 |
|---|---|---|
| 账号目录与分组 | `GET /api/v1/admin/accounts?platform=...`、`GET /api/v1/admin/groups/all` | 账号 ID、名称、平台、类型、状态、调度状态、优先级、并发及其 Sub2API 基座分组归属 |
| Sub2API 基座真实请求 | `GET /api/v1/admin/usage?exact_total=true` | 精确分页并按配置窗口回补；读取请求用户 ID、请求模型、上游模型、首字/总耗时、输入/输出/缓存 Token、实际扣费和时间 |
| 供应商上游真实请求 | New API 的 `GET /api/log/self`，或 Sub2API API Key 自鉴权的 `GET /v1/usage/logs`（供应商部署该端点时） | 按映射 Key 归属的请求模型、首字/总耗时、输入/输出/缓存 Token、实际扣费和时间 |
| 供应商累计数据 | 供应商 usage 累计计数器或 Key 已用额度计数器 | 按 Key 身份保存永久检查点和增量账本；记录费用、请求数、Token、采样区间、倍率、映射版本及重置序号 |
| 主动检测 | 基座账号测试接口；手动检测可对无代理 OpenAI API Key 账号直连上游 | 检测结果、首字/总耗时、动态题集得分和最长 500 字符的检测响应摘要 |

真实请求采集不会保存提示词、正常业务响应、用户资料、API Key、IP 或 Sub2API 账号凭据；毛利口径仅额外保留请求用户 ID。主动检测只发送本地生成的无敏感动态题目；响应摘要用于复核评分。手动直测通过 Sub2API TOTP 保护的账号导出接口临时读取所选 API Key，凭据只保存在进程内存中的短期票据里，不写入数据库或任务载荷；账号配置了代理时仍使用基座检测路径，避免绕过真实代理。

列表默认使用“供应商”视图，供应商行汇总该连接下全部当前及历史 Key；点击供应商可在同一列表展开每个 Key。供应商与 Key 行的窗口请求、缓存读取率、首字 P95、输出速度、检测通过率和质量分都分别展示“基座 / 上游”两套计算值，费用列分别展示基座收入和上游现金成本，便于直接核对差异。同一账号映射到该供应商的多个 Key 时，供应商行只汇总一次；Key 行因无法唯一归因而不展示该账号的基座值，避免重复计算。跨供应商映射同样不进入供应商基座汇总。供应商累计已充值金额及币种可在该行直接配置，页面同时展示累计毛利、资金差额和未消费充值余额。左侧还可切换“基座分组”和纯“账号”视图。一个账号属于多个分组时会计入每个对应分组；明确没有关联分组的账号进入“未分组”。账号目录尚未完成包含分组归属的新同步时，已映射账号暂按本地映射快照展示并标记“映射缓存”，其余账号显示“分组待同步”，不会误判为未分组。分组请求数与缓存读取率按账号原始计数和 Token 汇总，检测通过率按检测样本数加权；首字 P95、输出速度、能力分和质量分展示账号维度的加权或覆盖账号均值，并在表头明确标记为均值，避免把账号级分位数误称为请求级分位数。点击分组行会在同一张列表中展开该分组的全部账号及其逐账号指标，再次点击即可收起。

首次同步读取默认观察窗口内的基座日志；供应商同步按映射连接读取上游日志或累计计数器。基座和供应商逐请求费用分别写入只增不减的永久账本，并由 SQLite 在入账时维护累计汇总；短期性能样本按保留策略清理、供应商删除远端日志或 Key 被停用后，已经计算的历史费用仍会保留。后续供应商同步从每个 Key 最近一次入账时间向前重叠一小时增量读取，并按 Key 身份与供应商日志 ID 幂等去重；基座日志仍从最近样本的前一天增量回读并按 Sub2API usage log ID 去重。

只能用指定 Key、且没有逐请求日志的供应商使用永久累计计数器账本。第一次采样写为“期初基线”，用于展示供应商报告的生命周期总额，但不会伪造成当前 7 天费用；从第二次采样开始，系统按相邻检查点计算费用、请求数和 Token 增量，默认同步间隔下时间精度约为 15 分钟。每笔增量冻结当时的充值倍率、上游分组倍率、基座分组倍率和映射版本。累计值回落时会区分重置与修正并维护跨周期偏移；配置槽位更换实际 Key 时按 Key 的 HMAC 身份建立新基线，不会跨 Key 求差。账号映射在两个检查点之间切换时，该段费用保留在供应商总账中并标记为“映射切换”，不强行归给任一账号。上游后来恢复完整逐请求日志时，只替换被日志完整覆盖的计数器区间，避免重复计费；截断日志不参与替换。

Sub2API API Key 模式会自动探测 `/v1/usage/logs`：纯文本或 JSON 404 都记为“不支持”并降级到累计计数器，不会让整次同步失败。基座日志按自然日分页、每天最多读取 50,000 条，供应商日志默认最多读取 10,000 条。一次页面查询固定同一个结束时间，并使用“所选窗口与上游覆盖窗口的交集”作为双源实际窗口；达到采集上限时会显示截断状态。

供应商视图先按供应商分页，再批量读取当前页 Key、映射和指标；累计费用直接读取入账汇总，仅扫描所选窗口内的明细。纯账号视图在常规排序下只为当前页执行昂贵的双源逐请求配对，基座分组和按费用差额排序仍按筛选结果完整计算。这样列表规模增长时不会为不可见账号重复加载和配对历史日志。

### 指标口径

| 指标 | 口径 |
|---|---|
| 请求数 | 同一实际窗口内，基座为 Sub2API usage 记录数，上游为供应商成功请求日志数；该总量用于识别 Key 额外流量 |
| 缓存读取率 | 对同一窗口内已配对请求分别计算：`cache_read_tokens / (input_tokens + cache_creation_tokens + cache_read_tokens)` |
| 缓存命中请求占比 | `cache_read_tokens > 0` 的请求数占比 |
| 首字 P50 / P95 | 对已配对流式请求的 `first_token_ms` 分别计算；基座额外首字先逐请求计算 `base - upstream` 再取 P50/P95 |
| 总耗时 P95 | 对同一批配对请求的 `duration_ms` 分别计算 95 分位数，每侧最多 500 个样本 |
| 输出速度 | 对同一批配对请求分别计算 `sum(output_tokens) / sum(duration_ms - first_token_ms)` |
| 费用对比 | 列表总账：`同窗基座 Σactual_cost / 基座充值倍率 - 同窗 Key 上游 Σactual_cost / 上游充值倍率`；详情另列配对请求的可归因毛差和上游未归因流量 |
| 主动检测通过率 | 当前观察窗口内成功检测数占比 |
| 能力分 | `capability_v2` 按账号和批次动态生成算术、逻辑、数列、排序变换和校验码五类题，每类占 20%；指令遵循分独立显示 |
| 质量分 | 首字延迟 40%、检测通过率 40%、能力分 20%；缺少某一维度时对已有维度重新归一化 |

缓存读取率受请求内容和客户端缓存策略影响，因此只展示，不进入质量分。观察窗口支持向前滚动 24 小时（`24h`，兼容 `days=1`）、按 `PROVIDER_MONITOR_TIMEZONE` 从当天 00:00 到当前时刻（`today`），以及包含今天的最近 N 个自然日（7/30/90 天）；自然日窗口不是向前滚动 N×24 小时。逐请求配对先使用 `request_id`，再使用模型、输入/输出/缓存 Token 与 5 秒时间容差进行一对一指纹匹配。只有成功配对至少 30 条且基座、上游匹配率都不低于 95% 时，性能表和可归因利润才使用配对样本；否则展示同窗聚合指标并标记配对不足。费用总账优先使用统一窗口内映射 Key 的完整日志；没有日志时使用已持久化且可归因的累计计数器增量，`daily_usage` 和普通快照只作为未建账时的降级来源。基座未完成 `exact_total` 精确分页回补时不判断总账盈亏，也不把未匹配上游请求认定为额外流量。Sub2API 的 `actual_cost`/`total_actual_cost` 是实际扣除，`total_cost` 是标准价，`account_stats_cost`/`total_account_cost` 是账号口径成本。供应商没有返回的指标显示“未提供”，不会按 0 计算。Sub2API usage 接口记录成功计费请求，不能据此推导请求错误率；可用性统一来自主动检测，避免把“有日志”误当成“100% 在线”。

Gemini 账号测试接口可以转发自定义提示词。部分 Sub2API 版本的 OpenAI Responses/OAuth 测试路径会忽略传入题目并固定发送 `hi`：监控端会把这种问候响应标记为“能力题未执行 / 未覆盖”，不会误算为 0 分。手动检测无代理的 OpenAI API Key 账号时，监控端在管理员完成 TOTP 后直接请求其 Responses 或 Chat Completions 上游；OAuth、配置代理的 API Key、Anthropic、Grok 等账号继续使用基座路径。定时检测若使用的基座尚未支持 OpenAI 自定义题目，会保留连通性结果但不生成能力分。该分数是可重复的能力代理指标，不是绝对智商结论。

禾维官方文档明确说明当前[不提供外部检测调用的公开 API](https://docs.hvoy.ai/en/docs/hvoyai/verify)，其[内部质量分](https://docs.hvoy.ai/en/docs/hvoyai/rank)还包含未公开的模型不匹配、异常结果、价格、用户行为等信号。因此本模块不会抓取禾维私有接口，也不会把 Sub2API API Key 或账号凭据发送给第三方。`capability_v2` 是依据其公开的可用性、响应质量、延迟和历史一致性维度实现的本地可审计兼容套件，不冒充禾维原始算法。

### 手动与定时检测

- 顶部“同步双源”手动刷新账号目录、Sub2API 基座日志和已映射供应商上游数据。
- 勾选账号后使用“检测所选”，或使用行尾烧瓶按钮检测单个账号。
- “检测设置”分别控制日志同步和主动检测；日志同步默认每 15 分钟启用，主动检测默认关闭，避免未经确认产生 Token 成本。
- 定时检测可选择平台、为每个平台指定模型，并设置 1 到 10 的并发。模型留空时使用 Sub2API 基座默认测试模型。
- 样本默认保留 30 天，可在检测设置中调整为 1 到 3650 天。

定时任务需要可持续使用的 Sub2API 管理员认证。配置账号启用 TOTP 时，服务重启后必须先在界面完成一次二次验证；也可以配置有效的 `SUB2API_ADMIN_TOKEN`。

### API

- `GET /api/account-monitor/config`
- `PUT /api/account-monitor/config`
- `GET /api/account-monitor/accounts`
- `GET /api/account-monitor/accounts/:id`
- `POST /api/account-monitor/sync`
- `GET /api/account-monitor/probes`
- `POST /api/account-monitor/probes`

### Sub2API 供应商认证

添加 Sub2API 供应商时支持三种模式：

- **账号登录**：填写 Sub2API 本地邮箱和本地密码。编辑已有连接时，凭据留空会复用加密保存的值；重新填写邮箱或密码会丢弃旧会话 Token，避免旧 Token 覆盖新账号凭据。
- **OAuth Token 对**：填写 Sub2API 当前会话的 Access Token 和 Refresh Token，适用于通过 Linux.do 等第三方 OAuth 快捷注册、没有本地密码的账号。Provider Monitor 会在刷新时保存服务端返回的新 Token 对。
- **API Key 监控**：适用于实现 `/v1/usage` 和 `/v1/sub2api/billing` 的 Sub2API 兼容网关。Key 来源可选择“远端列表”或“手工配置”；每个选中 Key 独立请求用量和计费信息，并保存为独立的 Key 资产和倍率分组。网关实现 `/v1/usage/logs` 时会自动启用逐请求质量对比，否则保留余额、累计请求、Token、缓存率和实际费用的降级展示。旧版单 `apiKey` 配置继续按手工来源兼容。

账号登录、OAuth Token 对和 Bearer Token 模式可以通过 `/api/v1/keys` 枚举账户下的远端 Key。API Key 认证模式选择“远端列表”时，需要额外填写 Sub2API 邮箱密码或 Access/Refresh Token 作为 Key 列表认证；该会话只用于枚举，运行时仍使用勾选的具体 Key 调用 `/v1/usage`、`/v1/sub2api/billing` 和可选的 `/v1/usage/logs`。如果站点不提供用户会话或列表响应不返回完整 Key，可切换为“手工配置”，逐行录入并勾选监控。两种来源保存后，Key 额度、分组倍率、价格比较和 Sub2API 映射都只处理勾选的 Key。无法登录且没有 Key 列表接口的站点不能自动发现一把从未配置过的新 Key；新增 Key 必须先加入手工配置。配置后系统会自动同步资产，并可通过 HMAC 身份与基座导出的同一 Key 建立精确映射。

Sub2API 当前源码会为直接创建的 Linux.do OAuth 账号使用 `linuxdo-<subject>@linuxdo-connect.invalid` 合成邮箱，并生成一个不会展示给用户的随机本地密码。因此 Linux.do 邮箱和 Linux.do 密码都不能用于“账号登录”。优先在 Sub2API 的“个人资料 -> 账号绑定”中绑定真实邮箱并设置本地密码；无法绑定时再使用 OAuth Token 对。

Token 对可以在一个单独的浏览器会话登录 Sub2API 后，从浏览器开发者工具读取：

```js
localStorage.getItem('auth_token')
localStorage.getItem('refresh_token')
```

Token 对模式有两项上游约束：

1. 必须先关闭 Sub2API 的“系统设置 -> 安全设置 -> 会话绑定”，然后重新登录生成不绑定浏览器 IP/UA 的 Token。
2. Sub2API 的 Refresh Token 每次刷新后立即轮换，不能让浏览器和 Provider Monitor 长期共用同一个 Refresh Token。建议使用独立浏览器会话取得 Token，录入后直接关闭该会话窗口，不要点击退出登录。

若 Sub2API 开启 Turnstile 或登录 TOTP，Provider Monitor 无法用纯邮箱密码完成交互验证，会分别返回 `CAPTCHA_REQUIRED` 或 `MFA_REQUIRED`；此时应使用上述 Token 对或为该账号调整交互登录策略。

### New API 远端 Key 监控

A6API 等 New API 站点使用系统令牌和用户 ID 读取账户下的远端 Key。认证模式选择“API Key”后，供应商编辑页会显示已经同步的远端 Key 列表，可同时勾选多个监控 Key。未配置选择范围的旧连接默认继续监控远端当前返回的全部 Key；保存选择后，同步、Key 余额、动态日志倍率、价格比较和 Sub2API 自动映射都只处理勾选的 Key。未选 Key 会保留历史资产记录但标记为未监控，其旧日志倍率不会继续参与比较。

---

## 快速开始：Docker Compose 拉取镜像部署

> 推荐的生产部署方式。直接从 GitHub Container Registry 拉取预构建镜像，无需本地构建。

### 前提条件

- Docker Engine ≥ 20.10 且已安装 Docker Compose V2
- 可以访问 `ghcr.io`（GitHub Container Registry）

### 第一步：准备配置文件

从仓库下载或复制 `provider-monitor/` 目录下的三个关键文件：

```
provider-monitor/
├── compose.yaml       # Docker Compose 编排文件
├── .env.example       # 环境变量模板
└── .env               # 实际配置（从 .env.example 复制而来）
```

复制模板并生成加密密钥：

**Linux / macOS：**

```bash
cp .env.example .env
openssl rand -hex 32
```

**Windows (PowerShell)：**

```powershell
Copy-Item .env.example .env
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

### 第二步：编辑 `.env`

把生成的随机值写入 `PROVIDER_MONITOR_SECRET`，并根据部署环境调整必要参数：

```dotenv
# === Compose 部署参数 ===
PROVIDER_MONITOR_IMAGE=ghcr.io/fjiangming/sub2api-extra:provider-monitor-latest
PROVIDER_MONITOR_PORT=9871

# === 基础运行参数 ===
NODE_ENV=production
PORT=9871
PROVIDER_MONITOR_BIND_HOST=127.0.0.1

# 余额提醒中的一次性充值入口（须为手机可访问的 HTTPS 地址）
PROVIDER_MONITOR_PUBLIC_URL=https://monitor.example.com
PROVIDER_MONITOR_RECHARGE_LINK_TTL_MINUTES=60

# === 加密密钥（必填，至少 32 字符） ===
PROVIDER_MONITOR_SECRET=<粘贴上一步生成的随机值>

# === Provider Monitor 认证方式 ===
# sub2api：使用基座 Sub2API 管理员 SSO 登录
# local：使用本地管理员账号登录
# 只决定本模块登录方式，不控制基座 Sub2API 联动
PROVIDER_MONITOR_AUTH_MODE=sub2api

# === 基座 Sub2API 连接 ===
# 容器内实际调用的 API 地址
SUB2API_BASE_URL=http://host.docker.internal:8080
# 管理员浏览器实际访问的地址
SUB2API_PUBLIC_URL=https://sub2api.example.com

# 联动使用的 Sub2API 管理员凭据，local 模式下同样生效
SUB2API_ADMIN_API_KEY=
SUB2API_ADMIN_TOKEN=
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<Sub2API 管理员密码>
```

> 完整的配置项说明参见 `.env.example` 文件内注释。

### 第三步：启动服务

在包含 `compose.yaml` 和 `.env` 的 `provider-monitor/` 目录中执行：

```bash
docker compose --profile provider-monitor up -d
```

或从仓库根目录（包含 `docker-compose.yml`）执行：

```bash
docker compose --profile provider-monitor up -d
```

根 `docker-compose.yml` 使用 `include` 引入 `provider-monitor/compose.yaml`，效果完全相同。

### 第四步：验证部署

```bash
# 存活探针
curl http://localhost:9871/healthz

# 就绪探针（含数据库连通性检查）
curl http://localhost:9871/readyz

# Prometheus 指标（默认开启）
curl http://localhost:9871/metrics
```

默认访问地址为 `http://localhost:9871`。Grafana 示例面板位于 `grafana/provider-monitor-dashboard.json`。

---

## 版本更新

### 拉取最新镜像并重启

```bash
# 进入 provider-monitor 目录
cd provider-monitor

# 拉取最新镜像
docker compose --profile provider-monitor pull

# 用新镜像重建并启动容器（数据卷自动保留）
docker compose --profile provider-monitor up -d
```

如果从仓库根目录操作：

```bash
docker compose --profile provider-monitor pull
docker compose --profile provider-monitor up -d
```

### 指定版本

`.env` 中的 `PROVIDER_MONITOR_IMAGE` 默认使用 `provider-monitor-latest` 标签。如需锁定到特定版本：

```dotenv
# 按语义化版本号
PROVIDER_MONITOR_IMAGE=ghcr.io/fjiangming/sub2api-extra:provider-monitor-1.0.0

# 按 Git commit SHA
PROVIDER_MONITOR_IMAGE=ghcr.io/fjiangming/sub2api-extra:provider-monitor-sha-abc1234
```

修改后执行：

```bash
docker compose --profile provider-monitor up -d
```

### 回滚到旧版本

如果更新后出现问题，将 `PROVIDER_MONITOR_IMAGE` 改回之前的版本标签，然后重新启动即可。SQLite 数据库包含版本化迁移（当前 Schema 版本 23），**向前兼容但不保证向后兼容**，回滚前建议先备份数据卷：

```bash
# 备份数据卷
docker run --rm -v sub2api-extra_provider-monitor-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/provider-monitor-data-backup.tar.gz -C /data .

# 回滚镜像
# 修改 .env 中的 PROVIDER_MONITOR_IMAGE 为旧版标签
docker compose --profile provider-monitor up -d
```

### 清理旧镜像

```bash
docker image prune -f
```

---

## 从源码构建部署

如需自行构建镜像（例如使用自定义 NPM 镜像源），在 `provider-monitor/` 目录或仓库根目录执行：

```bash
docker compose --profile provider-monitor up -d --build
```

Dockerfile 采用多阶段构建：第一阶段安装编译依赖并执行 `npm ci --omit=dev`，第二阶段只复制运行时文件。构建参数 `NPM_REGISTRY` 可在 `.env` 中配置（默认为 `https://registry.npmmirror.com/`）。

镜像支持 `linux/amd64` 和 `linux/arm64` 双架构。

---

## Compose 编排参数

以下参数在 `.env` 中配置，由 `compose.yaml` 读取：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROVIDER_MONITOR_IMAGE` | `ghcr.io/fjiangming/sub2api-extra:provider-monitor-latest` | Docker 镜像地址 |
| `PROVIDER_MONITOR_CONTAINER_NAME` | `sub2api-provider-monitor` | 容器名称 |
| `PROVIDER_MONITOR_RESTART_POLICY` | `unless-stopped` | 重启策略 |
| `PROVIDER_MONITOR_PORT` | `9871` | 宿主机映射端口 |
| `PROVIDER_MONITOR_DATA_VOLUME` | `sub2api-extra_provider-monitor-data` | 数据卷名称 |
| `PORT` | `9871` | 容器内监听端口 |
| `PROVIDER_MONITOR_BIND_HOST` | `127.0.0.1` | 本地运行监听地址；容器内由 Compose 覆盖 |
| `NPM_REGISTRY` | `https://registry.npmmirror.com/` | 构建时 NPM 镜像源 |

Compose 只把业务端口发布到宿主机回环地址，外部访问需要经过本机反向代理。容器自动添加 `host.docker.internal:host-gateway` 映射，以便访问宿主机上的 Sub2API。数据目录挂载为 Docker 命名卷，容器重建不会丢失数据。

容器内置健康检查：每 30 秒调用 `/healthz`，启动等待 15 秒，连续 3 次失败标记为不健康。

---

## 基座 Sub2API 与单点登录

Provider Monitor 把部署中的 Sub2API 作为"基座实例"。`PROVIDER_MONITOR_AUTH_MODE` 只决定谁来认证 Provider Monitor 管理页面；渠道、分组、倍率、用量、Channel Monitor 和自动化写入始终独立使用基座连接与管理员凭据：

```dotenv
# 容器内实际调用的 API 地址
SUB2API_BASE_URL=http://host.docker.internal:8080

# 管理员浏览器实际访问的地址，用于 iframe 来源白名单和返回链接
SUB2API_PUBLIC_URL=https://sub2api.example.com

SUB2API_ADMIN_API_KEY=
SUB2API_ADMIN_TOKEN=
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<Sub2API 管理员密码>

# 可独立选择 local 或 sub2api，不会启停上述联动
PROVIDER_MONITOR_AUTH_MODE=local
```

在 Sub2API 管理后台的"设置 -> 自定义菜单"中添加 Provider Monitor 地址，例如 `https://provider-monitor.example.com`，并把可见性限制为管理员。Sub2API 自定义菜单附带的管理员 Token 会被远端 `/api/v1/auth/me` 校验，然后换成本模块自己的短期会话；不会要求再次输入密码，也不会把上游 Token 写入数据库。

Sub2API 的"系统设置 -> 安全设置 -> 会话绑定"会把访问 Token 绑定到登录浏览器的 IP 和 User-Agent，因此无法由独立部署的 Provider Monitor 服务端验证。使用自定义菜单 SSO 时必须关闭会话绑定，然后退出并重新登录 Sub2API 以建立新会话。如果必须保留会话绑定，请将 `PROVIDER_MONITOR_AUTH_MODE` 改为 `local`，使用 Provider Monitor 独立管理员登录。

HTTPS iframe 会同时设置普通 Cookie 和分区 Cookie，并在 URL Fragment 中返回一个本模块的临时会话令牌作为第三方 Cookie 受限时的兜底。原始 Sub2API Token 在首次请求后立即从地址栏移除。

如果 `SUB2API_BASE_URL` 使用 `host.docker.internal` 或内网域名，必须单独配置浏览器可访问的 `SUB2API_PUBLIC_URL`。需要允许其他前端来源时，在"设置与备份 -> 系统参数"中维护准确的浏览器 Origin。

---

## 分组与倍率对照

1. 先同步供应商，使上游 Key、分组和倍率进入本地资产库。
2. 在"Sub2API 联动"中添加映射，选择基座分组、供应商、Key 和上游分组。
3. Provider Monitor 比较基座分组有效倍率与供应商综合倍率，并按全局或映射级容差标记结果。
4. 可创建"Sub2API 综合倍率偏差"告警规则，选择供应商、指定或全部已映射的基座分组，并用 `<`、`<=`、`>`、`>=` 或“绝对偏差大于”设置阈值。每条分组映射独立触发和恢复，系统每 5 分钟刷新一次，也可在页面手动刷新。

充值倍率按“支付 1 单位可获得多少供应商余额”记录，例如 `1:10` 的倍率为 `10`。New API 系列优先读取当前用户的充值报价，Sub2API 账号模式读取支付配置；可在供应商编辑中手工覆盖。综合倍率按 `供应商分组倍率 / 充值倍率` 计算，分组汇总行选择综合倍率最高的映射。综合倍率差按 `(基座倍率 - 综合倍率) / 综合倍率` 计算，倍率偏差状态和告警也使用该结果；例如配置“偏差 `< 0%`”会在基座倍率低于供应商综合倍率时告警。命中事件按冷却时间通过全部已启用的通知通道发送，且不会执行账号启停等写操作。账号质量总账始终保留两侧原始 `actual_cost`，现金等值按 `actual_cost / 充值倍率` 另算；任一侧倍率未确认时不推断盈亏，也不会静默按 `1:1` 代入。

New API 供应商可在编辑页面启用“动态路由倍率”。同步任务只读取历史请求日志，不会发送模型请求。日志先按 `token_id` 匹配远端 Key，并仅归入该 Key 的倍率样本；配置了监控 Key 范围时，未勾选 Key 的日志会被忽略，不同 Key 的命中渠道和日志也不会混算。供应商输入、输出和缓存单价只允许来自日志显式价格字段，或由日志中的 `quota_per_unit`、`model_ratio`、`completion_ratio`、`cache_ratio` 换算，不使用手工供应商价格兜底。每条请求的实测倍率等于供应商日志成本除以同一批 Token 的官方参考成本；成本加权平均等于窗口供应商总成本除以窗口官方总成本。缺少日志价格或官方模型价格时分别标记。统计支持 P50、P90、成本加权平均和最近一次。

官方模型价格在“设置与备份 -> 运行设置 -> 官方模型单价”中统一按 USD / 百万 Token 配置。键默认使用历史日志中的模型名，`input`、`output`、`cachedInput` 分别表示官方输入、输出和缓存读取价格：

```json
{
  "gpt-5.6-sol": {
    "input": 5,
    "output": 30,
    "cachedInput": 0.5
  },
  "gpt-5.5": {
    "input": 5,
    "output": 30,
    "cachedInput": 0.5
  }
}
```

以上是 2026-07-26 OpenAI 官方页面列出的 [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) 和 [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) 标准文本价格；价格变化后应同步更新。日志包含 `upstream_model_name` 时会优先按真实上游模型自动匹配。日志没有真实上游模型时，智能路由别名可以只指向已经配置价格的模型，无需重复价格；按供应商和渠道覆盖时使用 `供应商名/日志模型名@渠道ID`：

```json
{
  "gpt-5.6-sol": { "input": 5, "output": 30, "cachedInput": 0.5 },
  "a6api/codex-auto-review@1164": { "model": "gpt-5.6-sol" },
  "a6api/codex-auto-review@1253": { "model": "gpt-5.6-sol" }
}
```

匹配优先级为 `供应商/模型@渠道ID`、`供应商/模型@渠道名`、`供应商/模型`、`模型@渠道ID`、`模型@渠道名`、`模型`、`*`。保存官方模型价格后，系统会使旧动态倍率失效，并自动排队重新同步所有已启用历史日志实测的 New API 供应商。

“缓存”表示远端本次检查失败，但本地保存过此前成功获取的倍率，因此继续使用最后成功值，避免一次网络故障使综合倍率突然消失。缓存值不是默认值；远端恢复后会在下一次同步时自动更新。

自动映射只处理状态为 `active`（兼容 `enabled`）的 Sub2API API Key 账号，并查找名称中包含供应商名的账号，直接为账号关联的每个 Sub2API 分组匹配供应商 Key，不要求分组与渠道建立关系。停用或异常账号不会参与名称匹配、Key 导出或映射创建；手工添加账号映射或重新启用已有映射时，服务端也会实时校验账号仍处于启用状态。Sub2API API Key 供应商会用本机主密钥生成的 HMAC 标识精确确认两侧为同一 Key，原文不落库；Base URL、计费组和倍率相同不能替代 Key 身份验证。旧的“同源计费验证”自动映射会保留记录但禁止用于账号质量和利润对比，完成基座 TOTP 后应重新构建映射。其他供应商仍按其接口可提供的 Key 指纹匹配，多 Key 供应商会映射到对应的具体 Key。

推荐在“设置与备份 -> Sub2API 管理员 API Key”中配置 Key。保存时系统使用 `x-api-key` 依次实时验证管理员分组、账号列表和 `/api/v1/admin/accounts/data` 账号 Key 导出能力，只有三项全部成功才会加密写入 SQLite。输入框不会回显明文；普通配置导出不包含该 Key，SQLite 备份保留密文，只有带密码加密的灾难恢复包会包含可迁移的凭据。也可通过 `SUB2API_ADMIN_API_KEY` 提供只读的部署回退值。

该方案受 Sub2API 自身安全策略约束：`step_up_enabled=false` 时管理员 API Key 可以访问账号 Key 导出接口，可用于服务重启后的无人值守重建；`step_up_enabled=true` 时 Sub2API 会返回 `STEP_UP_ADMIN_API_KEY_FORBIDDEN`。管理员 API Key 不能修改这个开关，必须先用完成 TOTP step-up 的 Sub2API 管理员会话关闭一次，再回到 Provider Monitor 保存并验证 Key。若保留该开关，只能继续使用短期管理员会话并在过期后重新完成 TOTP，无法保证每次定时重建成功。

自动化规则可选择“按时间运行 / 重建全部 Sub2API 映射”。每次执行先实时读取 Sub2API 账号以确定匹配供应商，强制同步这些供应商的分组、Key、充值倍率和已启用的动态日志倍率；任一映射关键快照不完整都会中止。同步完成后系统再次强制读取最新 Sub2API 分组、分组倍率、账号分组关系和账号 Key，再发现候选并计算 `供应商倍率 / 充值倍率` 综合倍率。只有所有新映射都得到有效综合倍率时，才会在同一个 SQLite 事务中替换映射和比较状态；任一远端读取、同步、校验或写入失败都完整保留旧映射及旧比较状态。

动作记录会保存失败阶段、错误码、HTTP 状态、可重试标志和脱敏后的上游详情，并在“规则与自动化”页面直接显示失败摘要。管理员 Key 被 step-up 策略阻止时会记录 `SUB2API_ADMIN_API_KEY_EXPORT_FORBIDDEN` 和上游 `STEP_UP_ADMIN_API_KEY_FORBIDDEN`；供应商快照或倍率不完整时分别记录 `MAPPING_PROVIDER_SNAPSHOT_INCOMPLETE` 或 `MAPPING_RATE_SNAPSHOT_INCOMPLETE`，便于直接定位失败对象而不破坏现有映射。

定时重建可以继续配置后续条件和命中动作。重建成功后系统使用刚刷新的比较状态，按百分比判断综合倍率偏差，支持 `<`、`<=`、`>`、`>=`；命中映射会按 `account_id` 自动归并，并对每个关联账号执行一次停用或启用。配置“综合倍率偏差 `< 0%` / 停用映射关联账号”即可实现重建后自动停用负偏差账号。演练模式只预览重建与账号动作，不修改映射或账号；未配置后续条件的旧规则仍只执行映射重建。

“规则与自动化”页面统一展示告警规则和执行型自动化规则。告警规则的动作固定为“创建告警事件”，事件继续使用独立的激活、确认、恢复和通知生命周期；执行型自动化继续使用演练、限额、动作记录和回滚生命周期。两类规则共用管理入口，但保留各自的执行内核。

执行型自动化规则可勾选“动作触发时通知”：动作因条件命中而执行后，通过全部启用的通知通道发送告警。定时规则仅在后续条件命中并执行命中动作时通知，周期性的前置重建本身不产生通知；演练模式下的通知带“[演练]”标记并按 info 级别发送。通知投递失败不影响动作本身的执行与记录。

检查状态会区分综合倍率偏差、基座分组缺失、供应商分组缺失、倍率缺失和供应商倍率无效。

---

## 本地启动

```powershell
Set-Location provider-monitor
npm ci
npm start
```

`npm start` 自动读取同级 `.env`。实际监听端口由其中的 `PORT` 决定，默认仅监听 `127.0.0.1`。

本地认证模式首次使用环境变量中的管理员密码。之后可在"设置与备份 -> 管理员安全"中修改密码；新密码只以 scrypt 哈希保存在 SQLite 中，并优先于环境变量中的初始密码。修改成功后，除当前浏览器外的其他管理员会话会立即失效。

`PROVIDER_MONITOR_DATA_DIR` 和 `PROVIDER_MONITOR_DATABASE` 支持相对路径，并始终相对于 `provider-monitor/` 目录解析。统一配置使用 `./data` 和该目录中的数据库文件，因此项目移动到其他目录后无需修改文件路径。

---

## 系统参数

所有启动默认值都集中列在 `provider-monitor/.env`。自动化总开关、浏览器 Origin、私网访问、主机白名单、会话时长、请求限制、默认刷新、数据陈旧阈值、Key 检测并发和数据保留周期也可通过"设置与备份 -> 系统参数"修改；网页保存值持久化在 SQLite `settings` 表中，并在运行时优先于 `.env` 默认值。

监听地址、端口、认证模式、基座 Sub2API 地址、加密密钥、任务队列并发、时区和 Metrics 初始化仍属于启动参数，修改后需要重启服务。

### 运行时参数一览

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROVIDER_MONITOR_SESSION_TTL_MINUTES` | `480` | 管理员会话有效期（分钟） |
| `PROVIDER_MONITOR_QUERY_TIMEOUT_MS` | `15000` | 上游 HTTP 请求超时 |
| `PROVIDER_MONITOR_MAX_RESPONSE_BYTES` | `2097152` | 上游响应体最大字节 |
| `PROVIDER_MONITOR_CONCURRENCY` | `5` | 全局任务队列并发 |
| `PROVIDER_MONITOR_PROVIDER_CONCURRENCY` | `2` | 单供应商并发上限 |
| `PROVIDER_MONITOR_KEY_HEALTH_CONCURRENCY` | `3` | Key 健康检测并发 |
| `PROVIDER_MONITOR_REFRESH_MINUTES` | `15` | 默认同步间隔 |
| `PROVIDER_MONITOR_STALE_MINUTES` | `60` | 数据陈旧阈值 |
| `PROVIDER_MONITOR_RAW_SNAPSHOT_RETENTION_DAYS` | `30` | 原始快照保留天数 |
| `PROVIDER_MONITOR_SNAPSHOT_RETENTION_DAYS` | `180` | 聚合快照保留天数 |
| `PROVIDER_MONITOR_JOB_RETENTION_DAYS` | `90` | 任务记录保留天数 |
| `PROVIDER_MONITOR_AUDIT_RETENTION_DAYS` | `365` | 审计日志保留天数 |
| `PROVIDER_MONITOR_NOTIFICATION_RETENTION_DAYS` | `180` | 通知记录保留天数 |
| `PROVIDER_MONITOR_ASSET_CHANGE_RETENTION_DAYS` | `180` | 配置漂移（资产变化）记录保留天数 |
| `PROVIDER_MONITOR_ALLOWED_HOSTS` | 空 | 私网主机限制名单（逗号分隔；留空放行全部） |
| `PROVIDER_MONITOR_ALLOW_PRIVATE_NETWORKS` | `false` | 非空名单存在时，是否忽略名单并允许全部私网访问 |
| `PROVIDER_MONITOR_ALLOWED_ORIGINS` | 空 | 额外 CORS Origin（逗号分隔） |
| `PROVIDER_MONITOR_METRICS_ENABLED` | `true` | 启用 Prometheus 指标 |
| `PROVIDER_MONITOR_AUTOMATION_ENABLED` | `false` | 允许真实自动化 |
| `PROVIDER_MONITOR_LOG_LEVEL` | `info` | 日志级别 |
| `PROVIDER_MONITOR_TIMEZONE` | `Asia/Shanghai` | 定时任务时区 |

---

## 定时任务

| 调度时间 | 任务 |
|---|---|
| 每分钟 | 检查到期的供应商、账号日志同步与主动账号检测并入队，执行告警评估和定时自动化规则 |
| 每 5 分钟 | 刷新 Sub2API 映射比较 |
| 每天 02:25 | 价格目录同步 |
| 每天 03:17 | 快照数据保留清理 |
| 每天 03:35 | 远端备份 |
| 每天 03:45 | 自动对账 |
| 每天 09:15 | 到期供应商自动签到 |

所有定时任务使用 `PROVIDER_MONITOR_TIMEZONE` 配置的时区。

---

## 私有网络供应商

已知云元数据地址始终拒绝访问。`PROVIDER_MONITOR_ALLOWED_HOSTS` 或"设置与备份 -> 系统参数"中的私网主机限制留空时，其他私网、回环和链路本地地址全部放行；填写主机后，仅允许名单中的私网主机。开启"忽略私网主机限制"可在保留名单的同时临时允许全部私网访问。

---

## 低余额微信提醒与登录后充值

该功能用于“自动检测、微信提醒、自动建立供应商登录会话、人工确认充值”，不执行支付，也不需要部署外部充值服务、配置 Sub2API 渠道 ID 或开启“允许真实自动化”。执行流程如下：

1. 定时同步供应商并保存账户余额快照。
2. 告警服务分别比较账户余额与供应商的一级、二级余额阈值。
3. 每跌破一个已配置阈值就创建一条独立告警。
4. 通知服务向所有已启用的通知通道发送余额、阈值和可点击的充值链接；启用适配器登录后发送一次性中转链接。
5. 余额恢复后仅将告警标记为已恢复，不发送恢复通知；再次跌破阈值时重新通知。

### 配置供应商

进入“供应商”，逐个编辑需要提醒的供应商：

1. 填写“一级余额阈值”，例如 `20`。
2. 按需填写更低的“二级余额阈值”，例如 `5`。
3. 填写与余额快照一致的“币种”，例如 `USD`。
4. 填写“充值链接”，例如 `https://supplier.example/account/recharge`。
5. “充值登录方式”选择“直接打开”或“适配器自动登录”。
6. 保持“启用定时检查”并保存。

充值链接只接受 HTTP 或 HTTPS。链接会出现在微信通知中，不要在 URL 中放置一次性支付凭据、密码或长期有效 Token。

### 自动登录并跳转充值页

自动登录使用 Provider Monitor 自带的一次性中转页，不需要额外部署充值服务。配置步骤如下：

1. 进入“设置与备份 -> 系统参数”，将“Provider Monitor 公开地址”设置为手机能够访问的 HTTPS 地址，例如 `https://monitor.example.com`。反向代理必须把该地址转发到 Provider Monitor。
2. 设置“充值入口有效期”，范围为 `5` 到 `1440` 分钟，默认 `60` 分钟。告警发送时才会签发入口。
3. 编辑供应商，填写该供应商域名下的实际充值页 URL。充值页与供应商“基础地址”必须同源。
4. 将“充值登录方式”改为“适配器自动登录”并保存。
5. 收到提醒后点击链接。中转页的 `GET` 只显示确认页，不消耗票据；浏览器提交确认后票据立即失效，并建立供应商会话后跳转到充值页。

也可以通过环境变量设置公开地址和默认有效期：

```dotenv
PROVIDER_MONITOR_PUBLIC_URL=https://monitor.example.com
PROVIDER_MONITOR_RECHARGE_LINK_TTL_MINUTES=60
```

| 适配器 | 登录方式 | 需要的配置 | 典型充值页 |
|---|---|---|---|
| Sub2API | 获取或刷新短期访问令牌，再进入供应商的 `/auth/callback` | 账号密码或 OAuth Token Pair；API Key 模式不支持网页登录 | `/purchase` |
| New API | 在供应商域名弹出登录窗口调用 `/api/user/login`，建立 Cookie 会话后跳转 | 原有系统令牌、用户 ID，以及“充值网页账号”“充值网页密码” | `/wallet`；旧版本可填写 `/console/topup` |
| One API / One Hub / Done Hub / Veloera | 使用与 New API 相同的兼容登录流程 | “充值网页账号”“充值网页密码” | 以实际部署路由为准 |
| 其他适配器 | 暂无网页登录协议 | 无额外配置 | 自动退回直接打开充值链接 |

供应商启用了验证码、Turnstile、双因素认证、Passkey，登录接口或前端路由经过二次开发，或者充值页与基础地址不同源时，无法保证无人交互登录。系统会保留人工登录能力；签发前发现不兼容条件时直接发送原充值链接，签发后登录失败时中转页提供原充值链接。

一次性票据在数据库中只保存 SHA-256 哈希，原始票据不会写入数据库或应用日志。Sub2API 流程只把短期访问令牌放入供应商页面的 URL Fragment，不发送 Refresh Token。New API 兼容流程必须在一次性、禁止缓存的浏览器响应中解密网页密码并提交给供应商域名，因此收到或转发该链接的人在入口过期前可能获得该账户的登录会话。建议使用独立低权限充值账户、较短有效期并强制 HTTPS，不要把自动登录入口转发给其他人。

每个供应商级阈值都会生成一条独立的内置低余额规则。一级阈值触发 `warning` 告警，余额继续下降至二级阈值时再触发一条独立的 `error` 告警；余额回升后，两条告警按各自阈值分别恢复。二级阈值必须小于一级阈值，两个级别持续命中时都按每 `60` 分钟最多重复提醒一次。需要“连续多次低余额才提醒”或自定义冷却时间时，可以在“规则与自动化 -> 告警规则”中创建显式 `low_balance` 规则；此时应清空同一供应商的两级余额阈值，避免内置规则和显式规则重复通知。

显式低余额规则选择“全部供应商”时，系统会把同一个阈值和币种原样应用到每个供应商，不会根据充值倍率换算余额，也不会自动转换币种。该选项只适合余额币种和计量口径一致、且可以共用同一余额下限的供应商。币种或充值倍率不同时，应为每个供应商分别创建显式规则，或直接使用供应商编辑页中的独立余额预警值。若按统一的充值成本设置下限，可先把目标储备换算到该供应商的支付币种，再按 `余额阈值 = 支付储备 × 充值倍率` 计算；涉及不同法币时，汇率换算需要在系统外完成。

### 普通个人微信

普通个人微信使用“Server酱（个人微信）”通知通道：

1. 登录 [Server酱](https://sct.ftqq.com)，取得 `SCT...` 开头的 Server酱Turbo SendKey。
2. 进入“规则与自动化”，在“通知通道”右上角点击添加按钮。
3. 类型选择“Server酱（个人微信）”，配置 JSON 填写 `{}`。
4. 凭据 JSON 填写：

```json
{
  "sendKey": "SCT你的实际SendKey"
}
```

5. 保存后点击通道右侧的“测试”按钮。SendKey 会作为凭据加密保存，不会出现在普通配置导出中。

### 企业微信

企业微信使用群机器人 Webhook：

1. 在目标企业微信群中添加群机器人并复制 Webhook 地址。
2. 进入“规则与自动化”添加通知通道，类型选择“企业微信”。
3. 配置 JSON 填写 `{}`，凭据 JSON 填写：

```json
{
  "webhookUrl": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的机器人Key"
}
```

4. 保存后点击“测试”。Webhook 放在凭据 JSON 中才能加密保存；不要放入配置 JSON。

### 测试手机提醒与充值跳转

“规则与自动化”页中通知通道右侧的测试按钮只验证固定测试消息能否送达。完整链路可以在“测试 -> 告警充值入口”中模拟，不需要修改余额快照或触发真实告警：

1. 选择一个已配置充值链接的供应商。所有供应商都会列出；未配置充值链接的供应商保留在列表中，但不能执行该项测试。
2. 默认勾选“仅打开移动端预览（不发送通知）”。此模式不要求配置或选择通知通道，不会调用个人微信、Webhook 或任何其他通知服务，只会打开约 `430×860` 的独立预览窗口。
3. 需要测试真实收信时，取消该勾选并选择通知通道，再点击“发送测试告警”。人工测试允许选择当前停用的通道，且不会向其他通道广播。
4. 在手机上打开收到的 `[模拟测试]` 低余额提醒并点击“立即充值”或消息中的充值链接。
5. 两种模式都按供应商的真实配置执行：可用时签发一次性适配器登录入口；配置不完整、地址不安全或适配器不支持时使用原充值链接。测试页会显示实际采用的方式和降级原因。

桌面浏览器阻止自动弹窗时，可在预览结果右上角点击“打开移动端预览”。移动操作系统和微信不允许后台消息在没有用户操作时强制启动浏览器，因此实际发送模式下仍需点击微信通知中的充值链接。适配器入口遵守一次性票据规则：预览页不会消耗票据，确认继续后票据立即失效，再建立供应商会话并跳转充值页。

模拟测试不会创建 `alert_events`、不会触发自动化规则，也不会写入 `notification_deliveries`；会写入不含充值票据的安全审计记录。仅预览模式和实际发送模式互斥，每次只签发当前模式所需的入口，数据库仍只保存票据哈希。模拟余额优先使用供应商一级阈值的一半；未配置一级阈值时仅为消息展示使用模拟阈值 `20`，不会改写供应商配置。

### 告警与充值登录配置备份范围

| 导出方式 | 两级预警值、充值链接与登录模式 | 公开地址与入口有效期 | 网页登录账号/密码 | 通知通道及凭据 | 告警与投递历史 |
|---|:---:|:---:|:---:|:---:|:---:|
| 配置 JSON | 是 | 是 | 仅字段名，不含凭据 | 定义是，凭据否 | 否 |
| 加密灾备包 | 是 | 是 | 是，灾备密码加密 | 是，灾备密码加密 | 否 |
| SQLite 本地/远端备份 | 是 | 是 | 是，主密钥加密 | 是，主密钥加密 | 是 |

普通配置 JSON 会导出 `typeConfig.rechargeLogin.enabled`、公开地址、入口有效期和网页凭据字段名，但不会导出密码，并会对通知配置中的敏感字段和 URL 查询密钥脱敏。加密灾备包恢复时会先恢复供应商，再把供应商级告警规则重新关联到新供应商 ID，并使用目标实例的主密钥重新加密供应商和通知凭据。SQLite 本地备份及上传到 WebDAV/S3 的远端备份是数据库在线副本，包含上述全部配置和历史记录。SQLite 中可能包含未清理的一次性票据哈希，但不包含原始票据，因此仅恢复数据库不能重建可用的旧充值入口。

本功能只自动登录和打开充值页，不会代替用户选择金额、调用支付渠道或确认付款。真正无人值守的自动支付仍需要独立服务持有支付凭据并通过充值 Webhook 接收请求；这与本节的登录后充值是两条独立链路。

---

## 自动化写入

自动化必须同时满足以下条件才会真实修改 Sub2API 账号、渠道或本地映射：

1. "设置与备份 -> 系统参数"中的"允许真实自动化"已开启
2. 规则的"演练模式"已关闭
3. 当前存在有效的管理员 SSO 会话，或配置了 `SUB2API_ADMIN_TOKEN`，或可用的 `ADMIN_EMAIL` / `ADMIN_PASSWORD`；重建映射也可使用已验证且未被 step-up 策略阻止的管理员 API Key

账号启停动作保存变更前后的账号状态并支持回滚。服务端强制执行连续命中、冷却、每日动作上限和 Contract 变化暂停；备用映射切换同样支持回滚。定时重建映射属于整体替换，不提供动作回滚。

“停用账号”和“启用账号”使用 Sub2API 账号 ID，并调用账号更新接口写入 `inactive` 或 `active` 状态。渠道 ID 只用于备用映射切换等仍然明确标记为渠道级的动作。定时重建映射和充值 Webhook 都不需要目标 ID；充值 Webhook 每条规则对每个命中的供应商连接只发送一次：

```json
{
  "event": "provider_monitor.recharge_required",
  "connectionId": "供应商连接 UUID",
  "ruleId": "自动化规则 UUID"
}
```

Webhook 仅负责通知外部系统，Provider Monitor 不保存支付凭据，也不直接调用供应商充值或支付接口。

SSO Token 和配置账号取得的 Token 都只保存在内存中，刷新 Token 会按 Sub2API 协议轮换。需要无人值守地持续重建映射时，优先在“设置与备份”配置并验证管理员 API Key，同时确认 Sub2API 的 `step_up_enabled=false`。其他依赖用户级接口或敏感 step-up 的功能仍可配置 `SUB2API_ADMIN_TOKEN` 或管理员邮箱密码；启用登录 TOTP 时，服务重启后可能仍需完成一次交互验证。

邮件通知的 SMTP `host`、`port`、`secure`、`user` 和 `from` 写入邮件通知通道的配置 JSON，密码写入同一通道的凭据 JSON。旧版 `PROVIDER_MONITOR_SMTP_*` 环境变量仍可作为兼容回退，但新部署不再需要配置。

---

## 远端备份

在"设置与备份"中配置目标。配置和凭据必须分开填写：

- 本地目录配置：`{"directory":"D:\\provider-monitor-backups"}`
- WebDAV 配置：`{"url":"https://dav.example/backups/"}`，凭据：`{"username":"...","password":"..."}`
- S3 配置：`{"endpoint":"https://s3.example","bucket":"backups","region":"us-east-1","prefix":"provider-monitor","pathStyle":true}`
- S3 凭据：`{"accessKeyId":"...","secretAccessKey":"...","sessionToken":"..."}`

每天 `03:35` 按配置时区执行远端备份；也可以手动测试单个目标。网络目标沿用 DNS 固定和私网白名单策略。

远端备份上传的是 SQLite 在线备份文件，因此会同时包含供应商两级预警值、充值链接、显式告警规则、通知通道、加密通知凭据、告警事件和投递历史。恢复数据库时必须同时保留原 `PROVIDER_MONITOR_SECRET`；缺少或更换该主密钥将无法解密数据库中的供应商和通知凭据。

---

## 项目架构

```
provider-monitor/
├── compose.yaml                # Docker Compose 编排
├── Dockerfile                  # 多阶段构建（node:20-bookworm-slim）
├── .env.example                # 环境变量模板
├── package.json                # Node.js ≥ 20.18.1, Express 5
├── grafana/                    # Grafana 示例 Dashboard
├── public/                     # 前端静态资源（SPA）
│   ├── index.html
│   ├── app.js
│   ├── recharge-entry.js      # 一次性充值入口与供应商登录跳转
│   └── styles.css
├── src/
│   ├── server.js               # 入口：Express 应用、路由、定时任务
│   ├── config.js               # 环境变量解析与校验
│   ├── auth.js                 # 认证服务（SSO / 本地密码）
│   ├── metrics.js              # Prometheus 指标收集
│   ├── errors.js               # 统一错误类型
│   ├── adapters/               # 供应商适配器
│   │   ├── registry.js         # 适配器注册表
│   │   ├── base.js             # 基础适配器接口
│   │   ├── sub2api.js          # Sub2API 适配器
│   │   ├── one-api-family.js   # New API / One API / One Hub / Done Hub / Veloera
│   │   ├── deepseek.js         # DeepSeek
│   │   ├── openrouter.js       # OpenRouter
│   │   ├── litellm.js          # LiteLLM Proxy
│   │   ├── voapi-v2.js         # VoAPI v2
│   │   └── custom.js           # 自定义适配器
│   ├── db/
│   │   └── index.js            # SQLite Schema（版本 17）与迁移
│   ├── http/
│   │   ├── client.js           # 带 SSRF 防护的 HTTP 客户端
│   │   ├── safe-fetch.js       # 安全请求封装
│   │   └── pinned-dispatcher.js # DNS 固定分发器
│   ├── repositories/
│   │   └── provider-repository.js  # 供应商数据访问层
│   ├── security/
│   │   ├── encryption.js       # AES-256-GCM 加解密、scrypt 密码哈希
│   │   ├── ssrf-guard.js       # DNS 解析与私网/元数据端点拦截
│   │   ├── redaction.js        # 敏感信息脱敏
│   │   └── configured-api-keys.js  # 手工配置 API Key 的规范化与合并
│   └── services/
│       ├── sync-service.js     # 供应商同步引擎
│       ├── query-service.js    # 数据查询与聚合
│       ├── alert-service.js    # 告警规则评估
│       ├── notification-service.js  # 多渠道通知下发
│       ├── recharge-link-service.js # 一次性票据与充值登录中转
│       ├── simulation-service.js # 隔离的告警与充值链路模拟测试
│       ├── automation-service.js    # Sub2API 账号与映射自动化
│       ├── analysis-service.js # 趋势分析与异常检测
│       ├── mapping-service.js  # Sub2API 分组映射与倍率比较
│       ├── key-health-service.js    # Key 健康检测
│       ├── catalog-service.js  # 价格目录同步
│       ├── checkin-service.js  # 供应商自动签到
│       ├── credential-service.js    # 凭据轮换与管理
│       ├── transfer-service.js # 数据导入导出
│       ├── backup-service.js   # 远端备份
│       ├── retention-service.js # 数据保留与清理
│       ├── detection-service.js # 供应商类型探测
│       ├── sub2api-admin-client.js  # Sub2API 管理 API 客户端
│       ├── account-monitor-service.js # 基座账号日志聚合、质量评分与主动检测
│       ├── job-queue.js        # 并发任务队列
│       └── group-store.js      # 分组缓存
└── tests/                      # Node.js 内置测试运行器
```

---

## 测试

```powershell
npm test
```

使用 Node.js 内置 test runner，串行执行。
