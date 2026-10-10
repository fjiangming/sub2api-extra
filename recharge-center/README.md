# Sub2API 独立充值中心

独立运行在 `sub2api-extra` 中，按 Sub2API `0.2.13`（提交 `b8dece9000c68815a5b867ca5a1e6f236e173905`）的原生充值页实现页面结构、金额输入、支付宝方式卡、扫码、倒计时和结果状态。个人码模式固定实收与到账额度 `1:1`，因此对应原生页面的“无优惠、无手续费、倍率 1”状态。支持四种明确隔离的支付模式。

首次部署请先阅读[部署与配置手册](docs/deployment-configuration.md)。该手册逐步说明个人支付宝二维码的取得、宿主机与容器路径、文件权限、每个 `.env` 参数的来源、HTTPS 反向代理、Sub2API 自定义菜单和健康检查。

按照当前 `personal_accountlog_static` 方案部署时，可直接复制 [`.env.minimal.example`](.env.minimal.example) 为 `.env`。它只保留必须显式填写的 19 项；需要调整端口、金额、轮询时效或其他模式时再使用完整的 [`.env.example`](.env.example)。

> **二维码模式不能混用：** `personal_manual` 读取静态图片；`personal_transfer_auto` 由受控设备生成逐单码；`personal_accountlog_static` 配置一个固定通用 `fkx...` 地址，由服务器生成带高熵订单号的中转二维码。静态码模式不能预填金额或备注，用户需在支付宝付款页输入页面显示的应付金额。

| 模式 | 收款依据 | 自动入账 | 适用场景 |
|---|---|---|---|
| `sub2api_official` | 支付宝官方订单、验签回调和主动查询 | 是 | 生产首选 |
| `personal_accountlog_static` | 固定个人收钱码 + 官方账务流水 RSA2 验签 + 唯一金额/时间窗 | 仅唯一匹配时 | 已实际获批账务接口时 |
| `personal_transfer_auto` | 个人转账二维码 + 交易详情监听 + 随机备注 | 仅完整匹配时 | 无官方产品时的实验性方案 |
| `personal_manual` | 个人静态收款码 + 管理员独立核账 | 管理员确认后 | 兼容/应急 |

`personal_accountlog_static` 通过官方接口取得并验签账务流水，但固定个人码仍不会变成“由应用创建的支付宝订单”：充值中心订单号不会进入支付宝账单，同额外部收入仍是无法彻底消除的误归属风险。完整申请、密钥、静态码、Compose、Nginx 和验收步骤见[个人静态码账务流水手册](docs/alipay-accountlog-static-guide.md)，边界见[安全设计](docs/security.md)。

唯一分角保证充值中心内部订单的实际应付金额不冲突，正常付款可按金额和付款时间定位订单。它不能证明付款人：用户误付或故意支付另一订单的应付金额，也可能被匹配到那一单。不能承诺所有错误金额都会转人工；要求任何情况都不会误充时，应使用绑定支付宝官方订单的模式。

## 每日订单次数

所有充值中心模式统一限制：同一 Sub2API 用户每天最多创建 **10 次订单**，按北京时间（`Asia/Shanghai`）每日零点重置，无需新增环境变量。付款须知在“注意”上方显示“今日还可创建 x 次订单（最多10次）”，下一行显示“如果对订单有疑问，请联系客服。”；选择金额时也显示剩余次数，次数用完后不能再创建，已有订单仍可正常付款。

个人模式统计持久化账本里当天成功创建的全部订单，取消、过期、完成或转人工都不会返还次数，升级前当天的历史订单同样计入。金额不合法、监听器未就绪或创建事务回滚不消耗次数。检查与创建使用同一写事务，刷新、换浏览器或并发请求不能绕过；保持原有持久化数据卷，不要删除账本以重置次数。

官方模式在向 Sub2API 发出创建请求前持久化占用一次名额，明确的鉴权失败或 HTTP 4xx 拒绝会释放；超时、网络中断、HTTP 5xx 或无效响应无法排除远端已创建订单，保守保留此次计数。已创建后取消或校验失败停止展示同样不返还。只统计经充值中心提交的官方订单，Sub2API 原生充值入口不受此服务的限制。数据库自动升级到版本 10；无需修改其他扩展服务。

## 个人静态码账务流水模式

### 用户流程

1. 用户选择快捷金额或输入最多两位小数的自定义金额。
2. 服务生成固定三分钟订单和 128 位随机订单号；原金额冲突时才分配 `+0.01..+0.99`。
3. 服务端二维码包含充值中心 `/pay/<订单号>` 中转地址，不需要二维码生成设备。
4. 用户扫码进入固定本人支付宝通用收钱码，并手动输入本单应付金额。
5. 单实例轮询器调用 `alipay.data.bill.accountlog.query`，只接受 RSA2 验签成功的响应。
6. 收入方向、精确分值、三分钟时间窗、唯一候选订单和未使用 `account_log_id` 全部通过后，复用固定兑换码与幂等键自动入账。
7. 完整流水号、支付宝订单号、对方账号和备注不明文落库；Sub2API 兑换备注使用充值中心订单号和流水尾号联动审计。这里的 `RC-...` 不是 Sub2API 官方支付订单号，也不会进入支付宝账单。

订单过期后应付金额继续隔离至少一个账务回看窗口，防止延迟流水匹配下一单。接口首次成功查询前、响应验签失败或最近成功查询过期时，`/readyz` 返回 503 并停止创建新订单。异常流水不放款，转人工并由本服务自己的邮件通道通知。

取消后，同一用户再次输入相同目标金额，可复用自己无付款证据、无异常的已取消订单金额占位，不会从 `1.00` 连续累加成 `1.01`、`1.02`；有其他用户占用原金额时，也优先复用自己先前分配的分角。占位不会转让给其他用户，过期、已完成或待人工处理订单仍保留隔离。静态码复用时会为旧订单记录取消时的匹配截止时间：取消前的延迟流水仍归旧订单人工处理，新窗口付款只在唯一匹配时入账；取消所在秒有歧义则转人工。复用和新旧订单关联均记入审计。

金额分配使用 `BEGIN IMMEDIATE` 事务先取得写锁，再读取最新占位，金额表主键兜底禁止重复。多用户并发和相邻自定义金额都会按实际应付金额避让；部署保持单实例和同一持久化账本，不能用各自独立账本的多个实例接单。

> 支付宝 SDK 将该接口描述为“支付宝商家账户账务明细查询”。个人账号能否获得权限必须以开放平台控制台实际审核为准；浏览器已登录支付宝不能替代 OpenAPI 授权。

## 个人转账自动模式

### 用户流程

1. 用户只选择快捷金额或输入最多两位小数的自定义金额。
2. 服务生成三分钟订单和不可预测的随机备注。
3. 原金额未被占用时，实付与输入金额一致。
4. 同额冲突时，服务从 `+0.01` 到 `+0.99` 分配一个三分钟全局独占金额，并在原生订单区域明确展示实际应付与到账额度。
5. 受控支付宝设备领取订单，在正常页面中设置金额和备注，生成该订单独有的 `fkx...` 收钱码；服务端校验后加密保存 URL 并渲染 PNG。
6. 用户扫码即可付款，不需要再填金额或备注。
7. 独立到账监听器读取支付宝最终交易详情，通过另一把 HMAC 密钥提交。
8. 完整匹配后，充值中心使用固定兑换码和幂等键调用 Sub2API `create-and-redeem`，余额及 `balance/used` 兑换记录同步生成，运营中心可按现有逻辑计入 CNY 自动收入。

自动订单窗口固定为 180 秒。`RECHARGE_CENTER_MAX_ACTIVE_ORDERS` 限制单用户同时活动订单，建议保持 `1`；同一时刻另有不可调高的 100 个全局金额占位硬上限。达到任一上限，或采集器心跳/最近成功轮询过期时，新订单返回“请稍后再试”。付款发生在窗口内但事件稍晚到达时，系统可按支付宝 `paidAt` 恢复处理；事件迟到超过 `RECHARGE_CENTER_LISTENER_MAX_EVENT_AGE_SECONDS` 或付款发生在窗口外时只转人工，永不自动放款。

同一用户取消后可复用自己的无异常、无付款证据占位，每次重建仍生成全新的备注、订单号、兑换码和二维码任务；旧备注的付款只进入旧订单人工处理。复用不增加全局占位数，满 100 个时仍可替换自己的可复用订单，但不能新增占位。

### 关键数据保护

- 完整自动备注仅以 AES-256-GCM 密文保存，并绑定订单 ID；索引使用带密钥 HMAC。
- 每单 `fkx...` URL 同样以 AES-256-GCM 密文保存，只索引 HMAC 指纹；浏览器只取得服务端生成的 PNG。
- 完整支付宝交易号和收款账户不落库，只保存 HMAC 与必要尾号。
- 浏览器订单 API 不返回自动备注、二维码原始 URL或设备租约。
- 二维码代理与到账监听器使用两把不同密钥；签名绑定 HTTP 方法、接口路径、时间戳、nonce 和原始请求体，跨接口使用和重放都会被拒绝。
- 自动履约使用与监听/通知凭据隔离的 `SUB2API_ADMIN_API_KEY`，不使用用户会话或支付宝登录凭据；当前 Sub2API 的该 Key 仍是全局管理员能力，必须仅在受控内网传输并限制充值中心主机访问。
- SMTP 密码与可选 Webhook Token 只由充值中心读取，配置校验禁止它们与账本、监听或 Sub2API 管理凭据复用。
- 通知正文由固定白名单重新构造，只包含订单号、金额、异常代码、交易尾号、备注尾号和时间。

## 部署自动模式

### 1. 配置充值中心独立通知

个人转账自动模式必须启用内置邮件通道；可选再启用一个通用 HTTPS Webhook。通知实现、凭据和重试都位于 `recharge-center`，不会调用、读取或修改 Provider Monitor 等其他服务：

```dotenv
RECHARGE_CENTER_ALERT_CHANNELS=email
RECHARGE_CENTER_ALERT_TIMEOUT_MS=5000
RECHARGE_CENTER_SMTP_HOST=smtp.example.com
RECHARGE_CENTER_SMTP_PORT=587
RECHARGE_CENTER_SMTP_SECURE=false
RECHARGE_CENTER_SMTP_REQUIRE_TLS=true
RECHARGE_CENTER_SMTP_USER=<充值中心专用SMTP账号>
RECHARGE_CENTER_SMTP_PASSWORD=<充值中心专用SMTP密码>
RECHARGE_CENTER_SMTP_FROM=recharge-alerts@example.com
RECHARGE_CENTER_ALERT_EMAIL_TO=operations@example.com
```

使用 465 端口 SMTPS 时设置 `RECHARGE_CENTER_SMTP_SECURE=true`；使用 587 端口时保持 `false` 并强制 `RECHARGE_CENTER_SMTP_REQUIRE_TLS=true`。可选 Webhook 配置见 `.env.example`，生产地址必须是 HTTPS，且 Bearer Token 至少 32 字符。每个通道最多重试三次；任一投递最终失败都会写入充值中心本地审计，但不会改变异常订单停止放款的状态。

### 2. 配置充值中心

先在仅允许测试人员访问的 staging 环境保持验收闸门关闭。`NODE_ENV=production` 与
`RECHARGE_CENTER_AUTO_MODE_VERIFIED=false` 会按设计拒绝启动，因此真实小额验收阶段使用
`NODE_ENV=development`，但仍必须启用 HTTPS、Secure Cookie、关闭密码代理登录，并在反向代理处限制来源 IP：

```dotenv
NODE_ENV=development
RECHARGE_CENTER_PAYMENT_MODE=personal_transfer_auto
RECHARGE_CENTER_SECRET=<账本主密钥，至少48字符>
RECHARGE_CENTER_PUBLIC_URL=https://pay.example.com
RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED=false

RECHARGE_CENTER_TRANSFER_QR_SOURCE=collector
RECHARGE_CENTER_QR_PROVISIONER_SECRET=<独立二维码代理密钥，至少32字符>
RECHARGE_CENTER_LISTENER_SECRET=<独立监听密钥，至少32字符>
RECHARGE_CENTER_LISTENER_COLLECTOR_ID=alipay-ledger-device-1
RECHARGE_CENTER_LISTENER_MAX_STALE_SECONDS=30
RECHARGE_CENTER_LISTENER_SIGNATURE_TOLERANCE_SECONDS=60
RECHARGE_CENTER_LISTENER_MAX_EVENT_AGE_SECONDS=600
RECHARGE_CENTER_ALIPAY_RECIPIENT_ID=<监听详情中稳定出现的精确收款账户标识>
RECHARGE_CENTER_AUTO_MODE_VERIFIED=false

SUB2API_BASE_URL=http://host.docker.internal:8080
SUB2API_PUBLIC_URL=https://api.example.com
SUB2API_ADMIN_API_KEY=<Sub2API生成的admin-前缀管理员API-Key>

RECHARGE_CENTER_ALERT_CHANNELS=email
RECHARGE_CENTER_SMTP_HOST=<SMTP主机名>
RECHARGE_CENTER_SMTP_PORT=587
RECHARGE_CENTER_SMTP_SECURE=false
RECHARGE_CENTER_SMTP_REQUIRE_TLS=true
RECHARGE_CENTER_SMTP_USER=<专用SMTP账号>
RECHARGE_CENTER_SMTP_PASSWORD=<专用SMTP密码>
RECHARGE_CENTER_SMTP_FROM=<发件邮箱>
RECHARGE_CENTER_ALERT_EMAIL_TO=<告警收件邮箱，多个用逗号分隔>
```

`collector` 模式不配置 `RECHARGE_CENTER_TRANSFER_QR_TEMPLATE`。二维码代理只接受支付宝正常页面最终生成的直接 `https://qr.alipay.com/fkx...` 地址，拒绝查询参数、跳转域名、账号凭据、重复 URL 以及金额/备注回读不一致。尖括号和 `replace-with-*` 占位值会被生产配置校验拒绝。

### 3. 接入二维码代理和到账监听器

二维码代理运行在已登录本人支付宝、且由你控制的设备上，不运行在公网充值中心容器里：

```bash
export RECHARGE_CENTER_LISTENER_BASE_URL=https://pay.example.com
export RECHARGE_CENTER_QR_PROVISIONER_SECRET='<与服务端二维码代理密钥相同>'
export RECHARGE_CENTER_LISTENER_COLLECTOR_ID=alipay-ledger-device-1
export RECHARGE_CENTER_QR_ADAPTER_MODULE=/secure/alipay-qr-adapter.js
node tools/qr-provisioner-agent.js
```

适配模块必须导出 `healthCheck()` 和 `generate(job)`；健康检查需回读 `recipientId`，生成方法只能经支付宝正常可见页面生成并回读 `qrUrl`、`observedAmount`、`observedMemo`、`observedRecipientId`、`generatedAt`。当前账号页面完成适配前，代理必须报告 `ready=false`，不能用猜测的 DOM 选择器或私有接口代替。

仓库提供签名客户端：

```bash
cd recharge-center
export RECHARGE_CENTER_LISTENER_BASE_URL=https://pay.example.com
export RECHARGE_CENTER_LISTENER_SECRET='<与服务端相同的监听密钥>'
export RECHARGE_CENTER_LISTENER_COLLECTOR_ID=alipay-ledger-device-1
# 仅在刚刚成功读取支付宝账单且字段自检通过后设为 true
export RECHARGE_CENTER_LISTENER_READY=true
node tools/listener-client.js heartbeat
node tools/listener-client.js event /受保护目录/payment-event.json
```

事件文件只用于联调，生产适配器应在内存中调用 `RechargeListenerClient.sendPayment()`，不得把完整交易号和备注写入普通日志。事件字段规范、浏览器/手机适配条件及验收步骤见个人码手册。

### 4. 验收后打开生产闸门

必须完成以下测试，才能把 staging 配置切换为生产配置：

```dotenv
NODE_ENV=production
RECHARGE_CENTER_AUTO_MODE_VERIFIED=true
```

- 真实支付宝扫码后金额和备注均自动带入，用户没有手工填写步骤。
- 最终交易详情能读取完整备注、完整交易号、精确付款时间、收款标识、收入方向和成功状态。
- 同额两单分别显示原金额与唯一分角，且不会串单。
- 修改金额、修改/缺失备注、错收款账户、超时付款都会进入人工处理且不增加余额。
- 监听器停止超过配置时间后，`/readyz` 返回 503，且用户不能创建新订单。
- 模拟 Sub2API 超时只产生一条固定兑换码，订单进入 `needs_attention`。
- 充值中心独立 SMTP 通道收到脱敏告警，正文没有完整交易号、完整备注、用户邮箱或支付宝账号。
- 完成订单在 Sub2API 产生一条已使用余额兑换码，并能在运营中心成本分析中联动展示。

## 监听协议

端点：

```text
POST /api/listener/alipay/heartbeat
POST /api/listener/alipay/events
POST /api/listener/alipay/qr-heartbeat
POST /api/listener/alipay/qr-jobs/claim
POST /api/listener/alipay/qr-jobs/complete
POST /api/listener/alipay/qr-jobs/fail
```

签名头：

```text
X-Recharge-Signature-Version: 2
X-Recharge-Timestamp: Unix秒
X-Recharge-Nonce: 至少16字符的一次性随机值
X-Recharge-Signature: HMAC-SHA256(secret, method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + rawBody)
```

到账事件必须包含：

```json
{
  "collectorId": "alipay-ledger-device-1",
  "eventId": "设备内永久唯一事件ID",
  "source": "browser",
  "evidenceType": "ledger_detail",
  "tradeNo": "支付宝完整交易号",
  "amount": "50.01",
  "paidAt": "2026-10-03T08:01:02+08:00",
  "memo": "S2-完整随机备注",
  "recipientId": "配置的精确收款账户标识",
  "direction": "income",
  "status": "success"
}
```

手机通知只能唤醒采集，不得直接构造 `ledger_detail`。只有进入交易详情并取得上述最终字段后才能提交。

## 其他模式

静态码账务流水模式的接口申请、RSA 密钥、固定码、中转二维码和验收见[个人静态码账务流水手册](docs/alipay-accountlog-static-guide.md)。官方模式配置见[官方自动充值接入手册](docs/alipay-official-auto-recharge-guide.md)；设备监听模式与人工个人码模式见[个人支付宝转账自动充值手册](docs/alipay-personal-qr-guide.md)。

## 启动与健康检查

```bash
docker compose --env-file compose.services.env --profile recharge-center up -d
curl https://pay.example.com/readyz
```

`collector` 自动模式只有数据库、二维码代理心跳、到账监听心跳及监听器最近一次成功轮询都正常时才返回 200。任一设备登录失效、页面变化或字段缺失时必须发送 `ready=false` 或停止心跳；心跳间隔必须明显小于 `RECHARGE_CENTER_LISTENER_MAX_STALE_SECONDS`。

`personal_accountlog_static` 不使用上述设备心跳。它只有在支付宝账务接口至少成功查询并验签一次、且最近成功时间未超过 `RECHARGE_CENTER_ACCOUNTLOG_STALE_SECONDS` 时才返回 200；任何查询、限流、解析或验签错误都会暂停新订单。

## 本地验证

```bash
cd recharge-center
npm ci
npm run check
npm test
```

不要把 `.env`、支付宝二维码、事件样本、SQLite 数据卷或任何监听/通知凭据提交到 Git。
