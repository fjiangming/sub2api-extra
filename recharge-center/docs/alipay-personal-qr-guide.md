# 个人支付宝转账自动充值部署与操作手册

需要先完成目录、二维码文件、`.env`、反向代理和 Sub2API 自定义菜单配置时，请从[充值中心部署与配置手册](deployment-configuration.md)开始。本文专门说明个人转账自动模式的安全边界和验收流程。

> `personal_transfer_auto` 不读取 `ALIPAY_QR_IMAGE_PATH`，也不会把上传的静态个人收款码自动改造成带金额和备注的订单码。静态图片只用于 `personal_manual`；自动模式必须使用真实验证的转账 URI 模板并接入最终交易详情监听器。

## 1. 可行性结论

本项目已经实现 `personal_transfer_auto` 后端链路：三分钟订单、同额优先/冲突分角、随机备注、监听心跳、HMAC 防重放、交易详情匹配、Sub2API 幂等入账、异常人工队列和充值中心独立通知。

该模式不要求开通当面付，但有一个不能绕开的前提：你的个人支付宝转账入口必须在当前客户端版本中实际支持由二维码自动带入“金额”和“备注”，收款侧监听器也必须能从最终交易详情稳定取得完整备注。普通静态收钱码图片本身通常只标识收款人；如果扫码后无法自动带入备注，这个方案不能满足“用户只填金额”，必须保持 `RECHARGE_CENTER_AUTO_MODE_VERIFIED=false`。

这不是支付宝开放平台官方支付能力。支付宝没有向普通个人账户承诺一个可供任意服务器使用、带签名回调和商户订单号的通用到账查询接口。浏览器页面或手机端可见的账单信息属于非稳定采集面，页面字段、登录策略和风控都可能变化。因此本模式只能做到严格失败关闭，不能宣称与官方接口同等级或“完美零风险”。

## 2. 已实现的安全链路

```text
用户输入金额
  -> 创建 180 秒订单
  -> 原金额优先；冲突时 +0.01..+0.99 全局占位
  -> 生成 S2-<96 bit 随机值> 备注
  -> 服务端生成含金额与备注的支付宝二维码 PNG
  -> 浏览器/手机适配器读取最终交易详情
  -> HMAC 签名事件
  -> 精确匹配全部字段
  -> 固定兑换码 + Idempotency-Key 调用 Sub2API
  -> 余额与 balance/used 兑换记录
  -> 运营中心成本分析自动收入
```

自动放款必须同时满足：

1. `evidenceType` 为 `ledger_detail`。
2. 随机备注 HMAC 唯一命中一个自动模式订单。
3. 实收金额精确到分且等于订单实际应付金额。
4. 支付宝付款时间位于订单创建到过期之间。
5. `recipientId` 与部署时锁定的收款标识完全一致。
6. 方向为 `income`，状态为 `success`。
7. 完整支付宝交易号此前未处理过。
8. 事件送达未超过配置的最大迟到窗口。
9. 订单未完成、未取消，也没有处于不确定的履约状态。
10. Sub2API 返回的兑换码、类型、金额、状态和用户全部可核验。

任一条件不满足都不会自动增加余额。

## 3. 准备独立凭据

生成账本和监听两枚互不复用的随机值；启用可选 Webhook 时再生成第三枚 Token：

```bash
openssl rand -base64 48  # RECHARGE_CENTER_SECRET
openssl rand -base64 48  # RECHARGE_CENTER_LISTENER_SECRET
openssl rand -base64 48  # RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN（可选）
```

还需要当前 Sub2API 生成的 `admin-<64 hex>` Admin API Key。充值中心自身只用它调用 `create-and-redeem`，但 Sub2API `0.2.13` 的 Admin API Key 是全局管理员能力，并不支持单独的充值 scope。必须让 `SUB2API_BASE_URL` 走受控内网、用主机/容器网络 ACL 只允许充值中心访问，并且不要让其他服务复用该 Key；若同一 Sub2API 实例已有依赖此全局 Key 的集成，应先完成凭据影响评估。不要把管理员密码、用户 Token、支付宝 Cookie、登录密码或支付密码写入充值中心。

权限要求：

- `.env`、监听器环境文件：Linux `0600`。
- SQLite 数据目录：`0700`；账本文件：`0600`。
- 监听密钥只存在充值中心和受控监听进程，不放入网页脚本、扩展页面 DOM 或同步网盘。
- SMTP 密码和可选 Webhook Token 只存在充值中心服务端，不发给监听器，也不与其他服务复用。

## 4. 验证个人转账二维码模板

`RECHARGE_CENTER_TRANSFER_QR_TEMPLATE` 不是静态二维码图片路径，而是你自己的支付宝转账 URI 模板。它必须各包含一次：

```text
{amount}
{memo}
```

允许的目标仅为：

- `alipays://platformapi/startapp`，并使用你从支付宝合法分享流程取得的查询参数
- `https://alipay.com/` 或支付宝子域名下的 HTTPS 地址

禁止把第三方跳转域名、短链接或带账号密码的 URL 放入模板。`alipays://` 只接受 `platformapi/startapp`，查询参数内嵌的 HTTP(S) 地址也必须是支付宝 HTTPS 域名。模板中的固定收款人参数必须指向你的账户。

验收步骤：

1. 从你自己的支付宝“转账/收钱”合法分享流程取得 URI，不使用他人的链接，不抓取或复制登录 Cookie。
2. 在隔离的 staging 环境把实际 URI 中的金额值替换为 `{amount}`，把备注值替换为 `{memo}`。验收时使用 `NODE_ENV=development`、HTTPS、Secure Cookie、`RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED=false` 和反向代理 IP 白名单；不得接入真实用户流量。
3. 创建 0.01 元测试订单并扫码。
4. 支付确认页必须自动显示服务端分配的金额和随机备注。
5. 不做任何手工填写，完成付款。
6. 收款账单最终详情必须完整显示同一备注，不能截断、转义、改写大小写或丢失前缀。
7. 重复测试整数金额、小数金额、同额冲突金额和跨 1 元边界的分角金额。

只要其中一步不成立，就不能打开自动模式生产闸门。不要通过要求用户手填备注来掩盖模板失败，因为这违反本方案的交互要求，也显著增加错单概率。
配置校验会拒绝 `REPLACE_FROM_OWN_LINK`、`replace-with-*` 以及尖括号形式的明显占位值；它们只能出现在文档中，不能进入生产环境。

## 5. 配置充值中心独立告警

个人转账自动模式强制使用邮件告警。申请或准备一个专用于充值中心的 SMTP 账号，不要复用 Provider Monitor、运营中心或其他服务的通知配置。在 `recharge-center/.env` 配置：

```dotenv
RECHARGE_CENTER_ALERT_CHANNELS=email
RECHARGE_CENTER_ALERT_TIMEOUT_MS=5000
RECHARGE_CENTER_SMTP_HOST=smtp.example.com
RECHARGE_CENTER_SMTP_PORT=587
RECHARGE_CENTER_SMTP_SECURE=false
RECHARGE_CENTER_SMTP_REQUIRE_TLS=true
RECHARGE_CENTER_SMTP_USER=<充值中心专用SMTP账号>
RECHARGE_CENTER_SMTP_PASSWORD=<专用SMTP密码或授权码>
RECHARGE_CENTER_SMTP_FROM=recharge-alerts@example.com
RECHARGE_CENTER_ALERT_EMAIL_TO=operations@example.com
```

使用 SMTP 465 端口时通常设置 `RECHARGE_CENTER_SMTP_SECURE=true`；使用 587 端口时保持 `false` 并强制 STARTTLS。先在隔离环境制造一笔错金额事件，确认邮件到达且只包含订单号、应付金额、交易号末六位、备注末六位、异常代码和时间。

可选第二通道：把 `RECHARGE_CENTER_ALERT_CHANNELS` 改为 `email,webhook`，并配置 `RECHARGE_CENTER_ALERT_WEBHOOK_URL` 与至少 32 字符的 `RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN`。生产 Webhook 必须使用 HTTPS，拒绝跳转；SMTP、Webhook 各自有限重试。投递失败只会记录本地审计，异常订单仍保持人工处理且绝不自动放款。

## 6. 配置充值中心

`recharge-center/.env` 示例：

```dotenv
NODE_ENV=production
RECHARGE_CENTER_PAYMENT_MODE=personal_transfer_auto
RECHARGE_CENTER_SECRET=<账本主密钥>
RECHARGE_CENTER_PUBLIC_URL=https://pay.example.com
RECHARGE_CENTER_TRUST_PROXY=true
RECHARGE_CENTER_COOKIE_SECURE=true
RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED=false

RECHARGE_CENTER_QUICK_AMOUNTS=10,20,50,100,200,500,1000
RECHARGE_CENTER_MIN_AMOUNT=1
RECHARGE_CENTER_MAX_AMOUNT=5000
# 单用户同时活动订单上限；系统另有不可调高的 100 笔全局占位硬上限
RECHARGE_CENTER_MAX_ACTIVE_ORDERS=1

RECHARGE_CENTER_TRANSFER_QR_TEMPLATE=<已验证模板>
RECHARGE_CENTER_LISTENER_SECRET=<监听密钥>
RECHARGE_CENTER_LISTENER_COLLECTOR_ID=alipay-ledger-device-1
RECHARGE_CENTER_LISTENER_MAX_STALE_SECONDS=30
RECHARGE_CENTER_LISTENER_SIGNATURE_TOLERANCE_SECONDS=60
RECHARGE_CENTER_LISTENER_MAX_EVENT_AGE_SECONDS=600
RECHARGE_CENTER_ALIPAY_RECIPIENT_ID=<详情页稳定收款标识>
RECHARGE_CENTER_AUTO_MODE_VERIFIED=false

SUB2API_BASE_URL=http://host.docker.internal:8080
SUB2API_PUBLIC_URL=https://api.example.com
SUB2API_ADMIN_API_KEY=<Sub2API生成的admin-前缀管理员API-Key>

RECHARGE_CENTER_ALERT_CHANNELS=email
RECHARGE_CENTER_ALERT_TIMEOUT_MS=5000
RECHARGE_CENTER_SMTP_HOST=<SMTP主机名>
RECHARGE_CENTER_SMTP_PORT=587
RECHARGE_CENTER_SMTP_SECURE=false
RECHARGE_CENTER_SMTP_REQUIRE_TLS=true
RECHARGE_CENTER_SMTP_USER=<专用SMTP账号>
RECHARGE_CENTER_SMTP_PASSWORD=<专用SMTP密码或授权码>
RECHARGE_CENTER_SMTP_FROM=<发件邮箱>
RECHARGE_CENTER_ALERT_EMAIL_TO=<收件邮箱，多个用逗号分隔>
```

自动模式会忽略 `RECHARGE_CENTER_ORDER_TTL_MINUTES` 并固定使用三分钟。生产环境在 `RECHARGE_CENTER_AUTO_MODE_VERIFIED` 不是 `true` 时拒绝启动，这是故意设计的上线闸门。完成本手册全部验收前只能运行受控 staging；验收通过后同时切换为 `NODE_ENV=production` 和 `RECHARGE_CENTER_AUTO_MODE_VERIFIED=true`。

## 7. 接入浏览器或手机监听器

### 监听器必须提供的事实

生产适配器必须进入单笔交易最终详情，而不是读取通知栏文案或列表摘要，并输出：

```json
{
  "eventId": "本设备永久唯一ID",
  "source": "browser",
  "evidenceType": "ledger_detail",
  "tradeNo": "完整支付宝交易号",
  "amount": "50.01",
  "paidAt": "2026-10-03T08:01:02+08:00",
  "memo": "S2-0123456789abcdef",
  "recipientId": "与服务端配置完全一致",
  "direction": "income",
  "status": "success"
}
```

`source` 也可以是 `phone`，但手机系统通知只能作为“有新交易”的触发器。适配器必须进一步打开或查询最终账单详情，不能把“收款 50 元”的通知直接标成 `ledger_detail`。

### 签名客户端

生产适配器可以直接引用：

```js
const { RechargeListenerClient } = require('./tools/listener-client');

const client = new RechargeListenerClient({
  baseUrl: 'https://pay.example.com',
  secret: process.env.RECHARGE_CENTER_LISTENER_SECRET,
  collectorId: 'alipay-ledger-device-1'
});

await client.heartbeat({
  version: 'my-alipay-adapter/1.0.0',
  ready: true,
  observedAt: lastSuccessfulPollAt.toISOString()
});
await client.sendPayment(paymentDetail);
```

客户端自动生成时间戳和 144 位随机 nonce，并对原始 JSON 请求体计算 HMAC-SHA-256。服务端验证时间漂移后把 nonce 写入 SQLite，任何重放都会返回 `LISTENER_REPLAY_REJECTED`。

`ready=true` 只能在本轮已成功访问支付宝账单、完成登录状态检查，并确认最终详情所需字段仍可读取后发送。登录过期、页面结构变化、解析异常或最近一次成功轮询超过阈值时，发送 `ready=false` 或停止心跳；不能用一个与采集逻辑无关的定时器持续报告就绪。

### 当前适配器边界

仓库没有硬编码支付宝网页 DOM 选择器或非公开接口。原因不是遗漏：在未观察你当前账号、当前页面版本和最终详情字段前，写死选择器会产生“看起来自动、实际漏单或读错字段”的危险实现。浏览器适配器只有在以下条件全部实测后才可投入生产：

- 页面登录会话由支付宝正常维护，程序不导出 Cookie。
- 能稳定区分收入与支出、成功与处理中/退款。
- 能进入详情并读取完整交易号、完整备注和精确付款时间。
- 页面变化或字段缺失时停止发送事件，而不是猜测默认值。
- 进程崩溃恢复后 `eventId` 不复用，重复扫描同一交易仍保持同一交易号。

在真实页面适配完成前，后端和签名客户端可以联调，但 `RECHARGE_CENTER_AUTO_MODE_VERIFIED` 必须保持 `false`。

## 8. 心跳与健康检查

监听器应每 10 秒发送一次：

```bash
export RECHARGE_CENTER_LISTENER_BASE_URL=https://pay.example.com
export RECHARGE_CENTER_LISTENER_SECRET='<监听密钥>'
export RECHARGE_CENTER_LISTENER_COLLECTOR_ID=alipay-ledger-device-1
# 仅限已完成一次真实账单读取和字段自检的联调
export RECHARGE_CENTER_LISTENER_READY=true
node tools/listener-client.js heartbeat
```

`/readyz` 的自动模式响应包含：

```json
{
  "status": "ready",
  "paymentMode": "personal_transfer_auto",
  "paymentQr": "dynamic",
  "listener": {
    "required": true,
    "healthy": true,
    "lastHeartbeatAt": "2026-10-03T00:00:00.000Z",
    "lastSuccessfulPollAt": "2026-10-03T00:00:00.000Z",
    "staleAfterSeconds": 30
  }
}
```

心跳或最近成功轮询过期后服务仍接收付款事件，但拒绝创建新订单。事件只有在 `RECHARGE_CENTER_LISTENER_MAX_EVENT_AGE_SECONDS`（默认 600 秒，允许 180 到 3600 秒）内且付款时间位于原订单三分钟窗口时才可能自动入账；更晚的事件保留证据、告警并转人工。

## 9. 联调事件

只在隔离测试中创建权限为 `0600` 的事件文件：

```bash
chmod 0600 /secure/payment-event.json
node tools/listener-client.js event /secure/payment-event.json
```

成功返回 `status: completed`。任何 `needs_attention` 都表示没有自动放款，应立即查看充值中心独立告警邮件和管理员队列。

必须执行的负向测试：

1. 错金额。
2. 未知、缺失和截断备注。
3. 错收款标识。
4. `direction=outgoing`。
5. `status=pending` 或退款状态。
6. 付款时间早于创建或晚于过期。
7. 同一交易号配不同备注重放。
8. 同一 nonce 重放。
9. 停止心跳超过阈值。
10. 心跳继续但报告 `ready=false`，或最近成功轮询时间过期。
11. 事件迟到超过最大允许时间，但其 `paidAt` 仍伪装在订单窗口内。
12. Sub2API 请求超时或返回无法核验的兑换记录。

上述测试都必须满足：用户余额不增加、订单进入人工处理或保持未付款、审计存在、告警送达。

## 10. 日常操作与异常处理

### 自动模式异常订单

1. 管理员在受信设备打开支付宝原始账单详情。
2. 按订单号、金额、交易尾号和备注尾号定位，但不能只依赖金额。
3. 独立读取完整交易号、付款时间和实收金额。
4. 在充值中心管理员页录入这些值并确认。
5. 对金额错误、窗口外付款、错账户或找不到交易的订单拒绝，不直接改库。
6. `needs_attention` 表示 Sub2API 履约结果未知；先查兑换记录，再使用原订单“恢复入账”，不得创建新兑换码。

### 每日对账

逐笔核对四处记录：支付宝账单、充值中心 `payment_events`/订单、Sub2API `balance/used` 兑换记录、运营中心 CNY 自动收入。笔数或金额有差异时立即停止新订单。

### 事故处置

发生错充、重复入账、监听器被控制、密钥泄露或页面字段变化时：

1. 停止监听器并关闭充值中心入口。
2. 保全 SQLite、支付宝原始账单、Sub2API 兑换记录和充值中心通知记录。
3. 轮换对应的监听密钥、SMTP 密码、Webhook Token 或 Admin API Key；不同用途不要复用轮换值。
4. 通过 Sub2API 正式余额调整流程纠正，不直接编辑数据库，不删除原兑换记录。
5. 重新完成全部正向和负向验收后再设置生产闸门。

## 11. 人工静态码模式

如果二维码不能自动带入备注或详情页无法稳定读取备注，请改用：

```dotenv
RECHARGE_CENTER_PAYMENT_MODE=personal_manual
ALIPAY_QR_IMAGE_PATH=/run/secrets/alipay-personal-qr.png
```

人工模式仍支持自定义金额。用户提交完整支付宝交易号，账本只保存 HMAC 和末六位；管理员必须从自己的支付宝账单独立核对交易号、金额和付款时间后才能入账。不要把手机通知、截图或同额时间碰撞当成自动放款依据。

图片应放在宿主机 `recharge-center/secrets/alipay-personal-qr.png`，Compose 会只读挂载为容器内 `/run/secrets/alipay-personal-qr.png`。取得原图、Linux UID/权限命令和扫码验收步骤见[部署与配置手册的个人码章节](deployment-configuration.md#3-放置个人支付宝收款码)。
