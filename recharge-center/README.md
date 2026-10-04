# Sub2API 独立充值中心

独立运行在 `sub2api-extra` 中，按 Sub2API `0.2.13`（提交 `b8dece9000c68815a5b867ca5a1e6f236e173905`）的原生充值页实现页面结构、金额输入、支付宝方式卡、扫码、倒计时和结果状态。个人码模式固定实收与到账额度 `1:1`，因此对应原生页面的“无优惠、无手续费、倍率 1”状态。支持三种明确隔离的支付模式：

首次部署请先阅读[部署与配置手册](docs/deployment-configuration.md)。该手册逐步说明个人支付宝二维码的取得、宿主机与容器路径、文件权限、每个 `.env` 参数的来源、HTTPS 反向代理、Sub2API 自定义菜单和健康检查。

> **二维码模式不能混用：** `personal_manual` 才读取 `recharge-center/secrets/alipay-personal-qr.png`；`personal_transfer_auto` 完全不读取这张图片，而是使用经过真实验收的 `RECHARGE_CENTER_TRANSFER_QR_TEMPLATE` 为每单动态生成带金额和随机备注的二维码。仅放置普通个人收款码不能实现安全自动到账。

| 模式 | 收款依据 | 自动入账 | 适用场景 |
|---|---|---|---|
| `sub2api_official` | 支付宝官方订单、验签回调和主动查询 | 是 | 生产首选 |
| `personal_transfer_auto` | 个人转账二维码 + 交易详情监听 + 随机备注 | 仅完整匹配时 | 无官方产品时的实验性方案 |
| `personal_manual` | 个人静态收款码 + 管理员独立核账 | 管理员确认后 | 兼容/应急 |

`personal_transfer_auto` 不会把个人收款码变成支付宝官方支付接口，也不具备官方回调同等级别的可信度。它采用严格失败关闭：备注、金额、支付宝交易号、收款账户、收入方向、成功状态和付款时间必须全部一致，否则不放款、进入人工队列并由充值中心自己的邮件/Webhook 通道通知。完整边界见[安全设计](docs/security.md)。

## 个人转账自动模式

### 用户流程

1. 用户只选择快捷金额或输入最多两位小数的自定义金额。
2. 服务生成三分钟订单和不可预测的随机备注。
3. 原金额未被占用时，实付与输入金额一致。
4. 同额冲突时，服务从 `+0.01` 到 `+0.99` 分配一个三分钟全局独占金额，并在原生订单区域明确展示实际应付与到账额度。
5. 用户扫码，支付宝页面应自动带入金额和备注；用户无需填写其他信息。
6. 受控浏览器或手机监听器读取支付宝最终交易详情，通过 HMAC 签名接口提交。
7. 完整匹配后，充值中心使用固定兑换码和幂等键调用 Sub2API `create-and-redeem`，余额及 `balance/used` 兑换记录同步生成，运营中心可按现有逻辑计入 CNY 自动收入。

自动订单窗口固定为 180 秒。`RECHARGE_CENTER_MAX_ACTIVE_ORDERS` 限制单用户同时活动订单，建议保持 `1`；同一时刻另有不可调高的 100 个全局金额占位硬上限。达到任一上限，或采集器心跳/最近成功轮询过期时，新订单返回“请稍后再试”。付款发生在窗口内但事件稍晚到达时，系统可按支付宝 `paidAt` 恢复处理；事件迟到超过 `RECHARGE_CENTER_LISTENER_MAX_EVENT_AGE_SECONDS` 或付款发生在窗口外时只转人工，永不自动放款。

### 关键数据保护

- 完整自动备注仅以 AES-256-GCM 密文保存，并绑定订单 ID；索引使用带密钥 HMAC。
- 完整支付宝交易号和收款账户不落库，只保存 HMAC 与必要尾号。
- 浏览器订单 API 不返回自动备注；备注只在鉴权后的二维码端点中短暂解密并渲染成 PNG。
- 监听请求使用独立密钥、原始请求体 HMAC、时间戳和一次性 nonce；重放请求会被拒绝。
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

RECHARGE_CENTER_TRANSFER_QR_TEMPLATE=alipays://platformapi/startapp?appId=REPLACE_FROM_OWN_LINK&amount={amount}&memo={memo}
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

二维码模板必须各包含一次 `{amount}` 和 `{memo}`，并指向 `alipays://platformapi/startapp` 或支付宝 HTTPS 域名；任何内嵌 HTTP(S) 地址也只能指向支付宝。字符串通过校验不代表支付宝当前客户端一定接受参数，必须按[个人支付宝转账自动充值手册](docs/alipay-personal-qr-guide.md)完成真实小额验收。
示例中的 `REPLACE_FROM_OWN_LINK`、`replace-with-*` 和尖括号占位值会被生产配置校验拒绝，不能作为实际凭据或收款标识使用。

### 3. 接入监听器

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
```

签名头：

```text
X-Recharge-Timestamp: Unix秒
X-Recharge-Nonce: 至少16字符的一次性随机值
X-Recharge-Signature: HMAC-SHA256(secret, timestamp + "\n" + nonce + "\n" + rawBody)
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

官方模式配置和支付宝开放平台操作见[官方自动充值接入手册](docs/alipay-official-auto-recharge-guide.md)。人工个人码模式继续使用 `ALIPAY_QR_IMAGE_PATH`，流程也记录在个人码手册中。

## 启动与健康检查

```bash
docker compose --env-file compose.services.env --profile recharge-center up -d
curl https://pay.example.com/readyz
```

自动模式只有数据库、动态二维码模板、监听心跳和采集器最近一次成功轮询都正常时才返回 200。监听器应在成功读取账单并完成字段自检后每 10 秒发送一次就绪心跳；登录失效、页面变化或字段缺失时必须发送 `ready=false` 或停止心跳。心跳间隔必须明显小于 `RECHARGE_CENTER_LISTENER_MAX_STALE_SECONDS`。

## 本地验证

```bash
cd recharge-center
npm ci
npm run check
npm test
```

不要把 `.env`、支付宝二维码、事件样本、SQLite 数据卷或任何监听/通知凭据提交到 Git。
