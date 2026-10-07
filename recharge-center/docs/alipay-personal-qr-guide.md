# 个人支付宝转账自动充值部署与操作手册

需要先完成目录、二维码文件、`.env`、反向代理和 Sub2API 自定义菜单配置时，请从[充值中心部署与配置手册](deployment-configuration.md)开始。本文专门说明个人转账自动模式的安全边界和验收流程。

> `personal_transfer_auto` 不读取 `ALIPAY_QR_IMAGE_PATH`，也不会改写已有静态码。最终方案使用 `collector`：受控支付宝设备按每笔订单的金额和随机备注生成一个新的 `https://qr.alipay.com/fkx...`，服务端校验并渲染成用户扫描的 PNG。

## 1. 可行性结论

本项目已经实现 `personal_transfer_auto` 后端链路：三分钟订单、同额优先/冲突分角、随机备注、监听心跳、HMAC 防重放、交易详情匹配、Sub2API 幂等入账、异常人工队列和充值中心独立通知。

该模式不要求开通当面付，但有两个不能绕开的前提：本人支付宝当前页面必须能逐单设置“金额”和“备注”并生成收钱码，到账监听器还必须能从最终交易详情稳定取得完整备注。普通静态码和已经生成的某个 `fkx...` 都不能复用于任意订单；如果任一页面流程不成立，必须保持 `RECHARGE_CENTER_AUTO_MODE_VERIFIED=false`。

这不是支付宝开放平台官方支付能力。支付宝没有向普通个人账户承诺一个可供任意服务器使用、带签名回调和商户订单号的通用到账查询接口。浏览器页面或手机端可见的账单信息属于非稳定采集面，页面字段、登录策略和风控都可能变化。因此本模式只能做到严格失败关闭，不能宣称与官方接口同等级或“完美零风险”。

## 2. 已实现的安全链路

```text
用户输入金额
  -> 创建 180 秒订单
  -> 原金额优先；冲突时 +0.01..+0.99 全局占位
  -> 生成 S2-<96 bit 随机值> 备注
  -> 二维码代理在本人支付宝页面生成本单 fkx URL
  -> 服务端校验、加密 URL 并生成二维码 PNG
  -> 独立浏览器/手机适配器读取最终交易详情
  -> 使用另一把 HMAC 密钥签名到账事件
  -> 精确匹配全部字段
  -> 固定兑换码 + Idempotency-Key 调用 Sub2API
  -> 余额与 balance/used 兑换记录
  -> 运营中心成本分析自动收入
```

自动放款必须同时满足：

1. `evidenceType` 为 `ledger_detail`。
2. 随机备注 HMAC 唯一命中一个自动模式订单。
3. 实收金额精确到分且等于订单实际应付金额。
4. 本单二维码状态为 `ready`，支付宝付款时间不早于二维码生成时间且不晚于订单过期时间。
5. `recipientId` 与部署时锁定的收款标识完全一致。
6. 方向为 `income`，状态为 `success`。
7. 完整支付宝交易号此前未处理过。
8. 事件送达未超过配置的最大迟到窗口。
9. 订单未完成、未取消，也没有处于不确定的履约状态。
10. Sub2API 返回的兑换码、类型、金额、状态和用户全部可核验。

任一条件不满足都不会自动增加余额。

## 3. 准备独立凭据

生成账本、二维码代理和到账监听三枚互不复用的随机值；启用可选 Webhook 时再生成第四枚 Token：

```bash
openssl rand -base64 48  # RECHARGE_CENTER_SECRET
openssl rand -base64 48  # RECHARGE_CENTER_QR_PROVISIONER_SECRET
openssl rand -base64 48  # RECHARGE_CENTER_LISTENER_SECRET
openssl rand -base64 48  # RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN（可选）
```

还需要当前 Sub2API 生成的 `admin-<64 hex>` Admin API Key。充值中心自身只用它调用 `create-and-redeem`，但 Sub2API `0.2.13` 的 Admin API Key 是全局管理员能力，并不支持单独的充值 scope。必须让 `SUB2API_BASE_URL` 走受控内网、用主机/容器网络 ACL 只允许充值中心访问，并且不要让其他服务复用该 Key；若同一 Sub2API 实例已有依赖此全局 Key 的集成，应先完成凭据影响评估。不要把管理员密码、用户 Token、支付宝 Cookie、登录密码或支付密码写入充值中心。

权限要求：

- `.env`、二维码代理和监听器环境文件：Linux `0600`。
- SQLite 数据目录：`0700`；账本文件：`0600`。
- 二维码代理密钥与监听密钥分别只存在充值中心和对应进程，不互相分发，不放入网页脚本、页面 DOM 或同步网盘。
- SMTP 密码和可选 Webhook Token 只存在充值中心服务端，不发给监听器，也不与其他服务复用。

## 4. 验证逐单 `fkx` 收钱码

你解码得到的这类地址可以使用：

```text
https://qr.alipay.com/fkx165...
```

但它是不透明的单次生成结果，不含可由服务器替换的金额或备注。正确流程不是保存一张静态图片，也不是把 `fkx...` 当成 `RECHARGE_CENTER_TRANSFER_QR_TEMPLATE`，而是让受控设备为每笔订单重新执行支付宝正常页面流程：

1. 二维码代理通过签名接口领取 `amount`、`memo` 和 45 秒左右的租约。
2. 代理在已登录本人账号的支付宝正常可见页面填写两项数据并触发生成收钱码。
3. 代理从结果页回读实际显示的金额、完整备注、生成时间及 `fkx...` URL。
4. 服务端要求金额和备注逐字一致，URL 必须是无查询串、无片段、无凭据的直接 `https://qr.alipay.com/fkx...`，且此前从未用于其他订单。
5. URL 以 AES-256-GCM 密文保存，数据库只索引带密钥 HMAC；用户浏览器只能通过鉴权二维码端点得到 PNG。

代理不能导出支付宝 Cookie、调用猜测的私有查询接口、把完整备注或 URL 写入日志，也不能在页面结构变化时继续报告健康。扫码支付页必须自动显示本单金额和备注，用户不得补填。最终账单详情还必须原样保留同一备注。

分别验收整数金额、小数金额、同额冲突分角、租约超时、重复 URL、金额回读不一致、备注回读不一致和登录失效。任何一项失败都不能打开生产闸门。

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

RECHARGE_CENTER_TRANSFER_QR_SOURCE=collector
RECHARGE_CENTER_QR_JOB_LEASE_SECONDS=45
RECHARGE_CENTER_QR_PROVISIONER_SECRET=<二维码代理独立密钥>
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

## 7. 接入二维码代理与到账监听器

### 二维码代理

二维码代理应运行在已登录本人支付宝的专用设备上。服务端容器不接触支付宝登录态，只通过独立签名接口下发短时任务：

```bash
export RECHARGE_CENTER_LISTENER_BASE_URL=https://pay.example.com
export RECHARGE_CENTER_QR_PROVISIONER_SECRET='<二维码代理独立密钥>'
export RECHARGE_CENTER_LISTENER_COLLECTOR_ID=alipay-ledger-device-1
export RECHARGE_CENTER_ALIPAY_RECIPIENT_ID='<与服务端相同的精确收款标识>'
export RECHARGE_CENTER_QR_ADAPTER_MODULE=/secure/alipay-qr-adapter.js
export RECHARGE_CENTER_QR_POLL_MS=3000
node tools/qr-provisioner-agent.js
```

`RECHARGE_CENTER_QR_ADAPTER_MODULE` 指向本机普通 JS 文件，Linux 上不得允许组用户或其他用户写入。模块契约：

```js
module.exports = {
  async healthCheck() {
    // 只有已登录正确收款账号且页面字段自检通过才返回 ready。
    return { ready: true, recipientId };
  },
  async generate({ amount, memo, expiresAt, signal }) {
    // 使用正常可见页面设置 amount/memo，并从结果页回读四个字段。
    return { qrUrl, observedAmount, observedMemo, observedRecipientId, generatedAt };
  }
};
```

适配器不得使用订单传入值冒充 `observedAmount`、`observedMemo` 或 `observedRecipientId`；这些值必须从支付宝结果页独立回读。代理框架不会在普通日志中记录完整备注或二维码 URL。网络中断导致完成回执不确定时会以同一租约重试，不会发送破坏性的失败请求。任一生成失败或回执不确定都会锁止代理为不健康；查明原因后由运维人员重启代理，不能自动忽略故障继续接单。

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

客户端自动生成时间戳和 144 位随机 nonce，并对 HTTP 方法、接口路径、时间戳、nonce 与原始 JSON 请求体计算版本 2 HMAC-SHA-256。服务端验证时间漂移后把按权限域隔离的 nonce HMAC 写入 SQLite；路径替换、跨权限域使用或重放都会被拒绝。

`ready=true` 只能在本轮已成功访问支付宝账单、完成登录状态检查，并确认最终详情所需字段仍可读取后发送。登录过期、页面结构变化、解析异常或最近一次成功轮询超过阈值时，发送 `ready=false` 或停止心跳；不能用一个与采集逻辑无关的定时器持续报告就绪。

### 当前账号适配边界

仓库已实现二维码任务代理、租约和回传校验，但没有硬编码你当前支付宝网页的 DOM 选择器或非公开接口。原因不是遗漏：在未观察当前账号、页面版本、生成页和最终详情字段前，写死选择器会产生“看起来自动、实际漏单或读错字段”的危险实现。账号适配模块只有在以下条件全部实测后才可投入生产：

- 页面登录会话由支付宝正常维护，程序不导出 Cookie。
- 能稳定区分收入与支出、成功与处理中/退款。
- 能进入详情并读取完整交易号、完整备注和精确付款时间。
- 页面变化或字段缺失时停止发送事件，而不是猜测默认值。
- 进程崩溃恢复后 `eventId` 不复用，重复扫描同一交易仍保持同一交易号。
- 生成页能独立回读金额和备注，并只返回直接 `qr.alipay.com/fkx...`。

当前 Chrome 必须先安装并启用 Codex/ChatGPT Browser 扩展，才能由开发工具观察已登录页面并完成账号适配。未完成真实页面适配前，后端、代理框架和签名客户端可以联调，但 `RECHARGE_CENTER_AUTO_MODE_VERIFIED` 必须保持 `false`。

## 8. 心跳与健康检查

到账监听器应每 10 秒发送一次；二维码代理会独立执行 `qr-heartbeat`：

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
    "ledgerHealthy": true,
    "qrProvisioningRequired": true,
    "qrProvisioningHealthy": true,
    "lastQrProvisionerHeartbeatAt": "2026-10-03T00:00:00.000Z",
    "lastQrProvisionerCheckAt": "2026-10-03T00:00:00.000Z",
    "lastHeartbeatAt": "2026-10-03T00:00:00.000Z",
    "lastSuccessfulPollAt": "2026-10-03T00:00:00.000Z",
    "staleAfterSeconds": 30
  }
}
```

二维码代理或到账监听器任一心跳过期后，服务仍接收已有订单的付款事件，但拒绝创建新订单。事件只有在 `RECHARGE_CENTER_LISTENER_MAX_EVENT_AGE_SECONDS`（默认 600 秒，允许 180 到 3600 秒）内，且付款时间位于本单二维码生成后至订单过期之间，才可能自动入账；更晚的事件保留证据、告警并转人工。

## 9. 联调事件

只在隔离测试中创建权限为 `0600` 的事件文件：

```bash
chmod 0600 /secure/payment-event.json
node tools/listener-client.js event /secure/payment-event.json
```

成功返回 `status: completed`。任何 `needs_attention` 都表示没有自动放款，应立即查看充值中心独立告警邮件和管理员队列。

必须执行的负向测试：

1. 二维码生成回读错金额、错备注、非 `fkx` 域名和重复 URL。
2. 二维码租约过期、旧租约重放和完成回执网络中断。
3. 二维码代理密钥调用到账接口，到账监听密钥调用二维码接口。
4. 到账错金额、未知/缺失/截断备注和错收款标识。
5. `direction=outgoing`、`status=pending` 或退款状态。
6. 付款时间早于二维码生成或晚于订单过期。
7. 同一交易号配不同备注重放。
8. 同一 nonce 重放或把签名请求改投其他路径。
9. 分别停止两类心跳超过阈值。
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

1. 停止二维码代理和到账监听器，并关闭充值中心入口。
2. 保全 SQLite、支付宝原始账单、Sub2API 兑换记录和充值中心通知记录。
3. 轮换对应的二维码代理密钥、监听密钥、SMTP 密码、Webhook Token 或 Admin API Key；不同用途不要复用轮换值。
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
