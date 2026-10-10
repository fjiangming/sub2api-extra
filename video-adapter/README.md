# Video Adapter

独立的视频入口与资金结算服务。支持灵速、XCM 和可配置的异步 JSON 视频供应商，不修改 sub2api 源码。通过原中转站域名的反向代理接入，复用原有 API Key、用户余额、Key 额度、分组和渠道定价，并把成功任务写入 sub2api 的用量记录。

## 接入方式

```text
客户端 ──原域名 /v1/videos──> video-adapter ──供应商 API──> 灵速 / XCM / 其他供应商
                                  │
                                  ├── sub2api PostgreSQL：鉴权、价格、冻结、结算、用量
                                  └── sub2api Redis：余额和鉴权缓存失效
客户端 ──聊天等其他路径──> 原 sub2api
```

本服务是独立视频入口，**不要把它配置成 sub2api 的 Grok 上游**。纯上游桥拿不到可靠的客户身份，也无法弥补原生视频创建不冻结资金、依赖客户轮询扣费的问题。视频请求经过本服务后不再经过原生 Grok 视频扣费，避免重复收费。

## 已实现

- 原生 Key 鉴权、用户/分组状态、专属分组权限、IP ACL、模型白名单、Key 到期检查。
- PostgreSQL 原子冻结余额、总额度与 5h/1d/7d 额度；并发任务、原生共享 RPM、单笔成本和供应商/全局滚动预算限制。
- 分组逐模型视频价、视频模型族分辨率价、旧版视频档位价、渠道按条/按秒价；用户专属倍率、独立视频倍率和高峰倍率。
- 精确十进制计算、人民币换算、手续费、汇率和成本缓冲、充值折扣与最低利润检查。
- 强制幂等键、保存原始供应商请求、加密凭证快照、跨实例任务租约、主动轮询、重启恢复。
- 未知创建不换供应商、不换 Key；只有供应商明确保证幂等才有限重试同一操作。
- 灵速资金状态核对；失败但未退款、任务过期、价格超限进入核查，保留冻结资金。
- 有原生资金状态的已结算任务，完成后继续核对 7 天；供应商确认全额退款时自动返还客户原扣款，避免重复退款。
- 归属校验、零余额读取旧任务、GET/HEAD/Range 下载、限量流式传输。
- SSRF 与 DNS 连接地址检查、外域下载不携带供应商凭证、管理认证和审计事件。
- 独立本地演示与真实 PostgreSQL 语义的隔离财务测试，不会调用付费上游。

## 不亏损的边界

服务会在提交前验证：

```text
供应商成本上限 = (供应商单价 × 计价单位 × 手续费倍率 + 固定费) × 保守汇率 × (1 + 成本缓冲)
实际收入下限 = sub2api 最终扣款 × 收入实现系数
实际收入下限 >= (供应商成本上限 + 运营成本) / (1 - 最低毛利率 - 分组安全缓冲)
```

不满足就拒绝生成，不会静默提高对用户的售价。资金冻结和任务入库必须先成功，后台才会请求供应商；用户不轮询也会结算。价格、倍率、成本卡和凭证在创建时锁定，修改配置不重算旧单。

例如单笔成本上限 0.11 USD、运营成本 0.01 USD、收入实现系数 0.8、最低毛利率 20%、无额外安全缓冲时，最终客户扣款至少需要 0.1875 USD。售卖倍率或用户折扣导致低于该金额，服务会拒绝该请求。

**成本卡必须是经核实的上限，不是从网站抄来的“参考报价”。** 样例供应商和型号全部关闭，样例费用不构成上线验收。上游没有承诺价格上限或可验证报价时，无法从技术上保证其不会临时涨价、违规多扣或不退款；这种供应商应保持关闭或人工核查。实际回执超过成本卡会熔断供应商并冻结该任务等待核查，但不能撤销供应商已经发生的扣款。

`VIDEO_ADAPTER_REVENUE_FACTOR` 必须覆盖充值赠送、打折、支付手续费和免费余额带来的现金折损；它不是用户倍率。配置为 1 却大量赠送余额会高估收入。`OVERHEAD_USD` 应覆盖本机计算、存储和允许的下载带宽；默认每单最多 4 次 GET/Range、每次最多 512 MiB，额度包含失败请求，HEAD 不计入。此服务保护自己的视频任务，不修复原 sub2api 其他接口既有的透支行为。

供应商全额退款时客户也获得全额退款，服务不会暗收额外费用。这类退款订单已经消耗的计算、核查和带宽成本，应由成功订单毛利与运营预算覆盖；不能把“未亏损接单”解读为每一笔退款订单都盈利。

## 本地验证

要求 Node.js >= 22.18。

```powershell
cd video-adapter
npm ci
npm test
npm run check
npm run demo
```

演示仅监听 `127.0.0.1:9875`，使用内存中的隔离 PGlite 数据库，重启后重置；不读取生产库或供应商凭证。测试 Key 为 `sk-demo-video-local-only`，模型为 `demo-video`，管理 Token 为 `demo-admin-local-only`。演示下载返回测试字节，不是真实生成的视频。

```bash
curl http://127.0.0.1:9875/v1/videos \
  -H 'Authorization: Bearer sk-demo-video-local-only' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-operation-0001' \
  -d '{"model":"demo-video","prompt":"A test scene","duration":5,"resolution":"480p","aspect_ratio":"16:9"}'
```

## 生产部署

1. 在 sub2api 建立专用、按余额付费的 Grok 视频分组和 Key；打开“允许图片生成”权限。设好售卖价格、模型白名单和视频倍率。订阅和 Composite 组合分组被拒绝。专用分组不要关联可被原生网关调度的真实供应商账号，避免绕过入口。
2. 在 sub2api 建立一个仅用于用量归属的账号并停用调度，把 ID 配到 `VIDEO_ADAPTER_USAGE_ACCOUNT_ID`。日志实际供应商成本写 `account_stats_cost`，账号成本倍率按 1 记录。
3. 创建 `.env` 和 `config/catalog.json`，内容分别参考 [.env.example](.env.example) 和 [catalog.example.json](config/catalog.example.json)。填写专用分组 ID、PostgreSQL/Redis 地址、独立随机管理 Token 和固定的 32 字节 base64 加密密钥。加密密钥必须备份，丢失后旧任务无法恢复。
4. 为数据库账号授予 [最小权限](docs/database-permissions.sql.example)。服务只创建自己的 `video_adapter` schema，不迁移或修改 sub2api 表结构；它会对用户余额、Key 额度、用量记录和缓存失效队列做事务写入。这是资金安全模式的必要接入条件。
5. 逐一核实供应商 Key、型号、时长/素材限制、实际成本、资金状态和下载。更新成本卡的有效期、汇率和证据后才启用具体型号。没有资金状态的供应商默认 `manual`；确认成本上限合同后才改为 `bounded_success`，该模式用上限记成本。
6. 本地构建启动服务：`docker compose -f video-adapter/compose.yaml --profile video-adapter up -d --build`。也可加入根工程 Compose 的 `video-adapter` profile。镜像发布由工程现有 CI 负责，新增镜像尚需首次构建发布。
7. 把 [Nginx 路由](docs/nginx.conf.example) 合并到现有域名配置，覆盖 `/v1/videos` 和根路径 `/videos`；本方案还阻断未适配计价的原生 Seedance task 入口。管理员路径保持内网；按代理实际源地址配置 `TRUST_PROXY`，代理必须覆盖转发 IP，不接受客户端伪造。
8. 先用单个小任务验收余额冻结、自动扣费、用量日志、重复提交、重复查询、失败核查和下载，再逐步放量。配置变更重启服务；已有任务仍使用创建时快照。

按条模型推荐使用专用渠道的 `per_request` 定价，同时清空该型号会命中的分组视频按秒价。否则分组视频价格优先覆盖渠道价格。按秒模型可使用分组 `video_model_prices` 或渠道 `video` 定价。任一层未配置价格、零价格或 token 计费都会拒绝，不会回退到 Grok 官方价格。

本服务对完整请求时长计价，不沿用原生 Grok 的 15 秒截断；30 秒和 2K/4K 必须有已验收规格及显式价格。不要将同一 Key 同时用于另一套视频扣费入口。

## API

| 接口 | 用途 |
|---|---|
| `GET /healthz` / `GET /readyz` | 存活 / 数据库和 Redis 就绪 |
| `GET /v1/models` | 可用视频型号及参数范围；原域名可映射 `/video-api/v1/models` |
| `POST /v1/videos/quote` | 只读报价，不冻结、不新建任务 |
| `POST /v1/videos` 或 `/v1/videos/generations` | 冻结并创建，必须携带 `Idempotency-Key` |
| `GET /v1/videos/{id}` | 查询自己的任务及资金状态 |
| `GET /HEAD /v1/videos/{id}/content` 或 `/download` | 已结算任务下载，支持单段 Range |
| `GET /admin/overview` | 任务、成本、熔断、缓存失效积压 |
| `GET /admin/jobs?state=review` | 需要核查的任务与定价快照 |
| `GET /admin/jobs/{id}/events` | 审计记录 |
| `POST /admin/jobs/{id}/reconcile` | 核查后释放、结算或恢复轮询 |
| `POST /admin/providers/{id}/pause` | 暂停供应商 |
| `POST /admin/providers/{id}/resume` | 更新成本卡、重启加载并核查后恢复供应商 |

管理接口使用独立 `Authorization: Bearer ADMIN_TOKEN`。创建请求的 `model`、`prompt`、`duration`/`seconds`、`resolution`、`aspect_ratio`/`ratio`、`references[]` 都经过校验；未知参数被拒绝，不能通过附加选项逃避计价。素材项为 `{type, source, role?, duration_seconds?}`；URL 必须 HTTPS，图片也可使用 data URI。灵速特价模型要求图片 data URI。默认拒绝未核实素材费用的请求，确认成本上限涵盖所有允许素材后才能设置 `cost.referencesIncluded=true`。

同一次操作必须保留同一客户 Key、幂等键和原始请求字节，包括 JSON 空格与顺序。返回 202 表示本服务已持久化并冻结资金，不表示供应商已经受理。后续只查任务，不能靠换幂等键解决超时。

启用 `idempotentCreate` 的供应商还必须设置已核实的 `idempotencyRetentionSeconds`，表示供应商承诺至少保留幂等结果的秒数。未知创建只能在这个时限内有限重试，过期后保留资金转人工核查；样例不猜测真实供应商的保留时限。重启或轮换凭证不会延长旧任务的重试时限。

核查输入示例：

```json
{
  "version": 4,
  "outcome": "released",
  "note": "Supplier confirmed this exact task was not charged",
  "evidence": "Supplier refund receipt number or ticket reference"
}
```

`released` 只能在已确认供应商没有扣款或已经退款后使用。`captured` 需要填写 `supplierCostUsd` 且任务已经找回上游 ID；不得超过冻结金额或成本上限。`resume` 用 `upstreamId` 恢复原单，不能创建替代任务。核查请求带版本号防止并发误操作。

## 扩展与运维

普通异步 JSON 协议通过 [configured.example.json](config/configured.example.json) 配置端点、字段路径和状态枚举；只允许数据映射，不执行表达式。Multipart、签名鉴权、轮询形状特殊的供应商通过 `ProviderRegistry.register(type, driver)` 增加驱动，同时扩展配置 schema 并补协议/资金测试。通用意味着统一接口和资金状态机，不意味着未知协议或未经验收模型自动开放。

后台任务使用 PostgreSQL 租约，多实例共享数据库可运行。预算按滚动 24 小时累计，并额外计入跨日未结任务，避免未结成本通过跨日绕过。对无法确认的任务保留冻结，超过任务最长等待时间进入人工核查，不按超时退款。

每天检查 `review` 任务、缓存队列积压和供应商熔断。备份 sub2api 数据库、`video_adapter` schema、加密密钥和成本卡。不能在存在冻结任务时删除用户/Key/日志归属账号或随意清空 `frozen_balance`。加密原始请求在旧任务下载时仍需要，清理需覆盖供应商文件保留期和审计要求。

有额外供应商手续费的资金状态型模型，必须确认这些费用也随退款退回，并设置 `cost.feesRefundable=true`；否则禁止启用自动退款链路，使用人工对账。资料里没有说明的费用不能假定会退回。

当前 schema 校验针对官方 sub2api v0.2.15（`3a6fd1c9db07203ca308aaba69e502bc1f35b307`）所需列；升级后先在副本执行测试与单笔财务验收。不支持订阅扣费、Composite 组合分组、用户平台配额、channel 模型重映射、token 分时价格、视频编辑/扩展、取消与回调，这些请求明确拒绝或没有对应入口。

RPM 复用原生 Redis 服务端时间、`rpm:ug:*` / `rpm:u:*` 计数和 120 秒 TTL；用户分组 `rpm_override` 覆盖分组上限，用户全局上限仍然生效。与原站聊天共享计数；Redis 故障拒绝新增视频花费。同一幂等操作重放不再次消耗 RPM。原生 `user_platform_quotas` 的用量由 Redis 权威缓存与异步快照维护，目前尚未适配这一体系，因此同平台存在日/周/月限额时会拒绝创建，不影响既有任务查询与下载。不要为了启用视频自动清空用户既有配额。

供应商只有明确返回 `funds_status=refunded` 才触发已扣款退款；无资金接口或超过 7 天的退款应另行对账。sub2api 原始用量日志保留历史扣款，不改写或删除；净退款在适配服务审计账本中记录，原生统计页不是扣除退款后的净收入报表。不能把失败状态当退款。

详细设计见 [architecture.md](docs/architecture.md)，上线验收见 [acceptance.md](docs/acceptance.md)。
