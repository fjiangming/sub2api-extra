# 支付宝官方自动充值接入手册

本手册对应 Sub2API `0.2.13`、提交 `b8dece9000c68815a5b867ca5a1e6f236e173905` 与本项目的 `sub2api_official` 模式。目标链路是：

```text
用户输入金额
  -> Sub2API 创建唯一 out_trade_no
  -> alipay.trade.precreate 返回该订单专属动态二维码
  -> 用户原额付款
  -> 支付宝 HTTPS webhook 到 Sub2API，或 extra 调用 Sub2API 主动查询
  -> Sub2API 验签并核对订单、商户、交易号和金额
  -> Sub2API 幂等生成并核销 balance 兑换码
  -> 用户余额到账
  -> 运营中心按 redeem_codes.used_at 展示 CNY 自动收入
```

## 1. 必须先理解的边界

支付宝个人静态收款码和支付宝开放平台商户订单不是同一种能力。

- 个人静态收款码没有一个可让第三方服务端按任意金额查询到账的官方 `alipay.trade.query` 权限。
- `alipay.trade.query` 查询的是由同一开放平台应用/商户创建、带唯一 `out_trade_no` 的官方交易。
- 不能只靠个人码的金额和时间“猜测”订单归属；安全自动放款至少还需要每单随机关联信息和最终交易详情。
- 通知栏监听、Android Hook、抓包、支付宝 Cookie、模拟登录或账单爬虫都不能提供官方签名证明，并会扩大账号接管和错误放款风险。若采用项目的实验性个人转账模式，必须遵守个人码手册中的隔离监听、全字段匹配和失败关闭要求。

能否以个人经营者、个体工商户或企业主体开通产品，以支付宝开放平台在申请时展示的资质要求和审核结果为准。普通个人收款码本身不能替代这一步。

## 2. 需要准备的资源

开始前准备：

1. 可申请支付宝开放平台支付产品的合法经营主体和已实名支付宝商家账户。
2. 一个可由支付宝稳定访问的 Sub2API 公网 HTTPS 域名，例如 `api.example.com`。使用中国大陆服务器时按规定完成 ICP 备案；使用香港或海外服务器通常不需要中国大陆 ICP 备案。
3. 一个充值中心 HTTPS 地址，例如 `pay.example.com`。可以使用同一已备案主域名的子域名，不要求为了充值中心单独购买或单独备案一个新域名。
4. 可安全生成和保管 RSA 2048 位应用私钥的管理员设备。
5. 最新 Sub2API 和 PostgreSQL 的可靠备份。
6. 可用于小额实付验收的付款账户，付款账户不要与收款账户相同。

正式申请前确认业务用途、用户协议、退款规则、发票与当地财税要求。持续经营收款不要规避支付宝对主体和产品的要求。

### 2.1 是否必须进行 ICP 备案

ICP 备案是中国大陆公网部署和接入服务商侧的要求，不是 RSA2 验签或 `alipay.trade.query` 接口本身的技术条件。可按实际环境选择：

| 方案 | 是否需要新增 ICP 备案 | 适用说明 |
|---|---|---|
| 复用现有已备案主域名 | 通常不需要 | 使用 `api.example.com`、`pay.example.com` 等子域名；若更换大陆云服务商，可能仍需办理接入备案 |
| 香港或海外服务器 + 自有域名 + HTTPS | 通常不需要中国大陆 ICP 备案 | Sub2API webhook 和充值中心都必须公网稳定可达；需自行承担跨境网络时延、可用性和数据合规评估 |
| 中国大陆服务器 + 未备案域名 | 不可作为生产方案 | 云服务商通常不会开放相应 Web 访问，且不应使用端口、IP 地址或临时隧道规避备案要求 |
| 个人静态收款码人工核验 | 不涉及支付宝开放平台回调要求 | 仍要遵守实际部署所在地的建站规定，而且不能自动确认到账 |
| 个人转账二维码 + 详情监听 | 不涉及支付宝开放平台回调要求 | 实验性方案；仍需 HTTPS 部署，依赖非官方且可能变化的账单采集面 |

即使采用香港或海外服务器，仍必须完成支付宝要求的商户实名、经营主体认证、应用审核和支付产品签约。支付宝可能根据申请产品和业务场景要求补充网站、域名、经营材料或备案信息，最终以申请控制台展示和审核结果为准；“免 ICP”不等于“免商户资质”。

不要把匿名“免签支付”、个人码监听、账单爬虫、临时公网隧道或他人商户接口当作免备案方案。它们无法提供可靠的订单归属和官方签名证据，也会引入封号、资金冻结、凭据泄露和错误充值风险。

## 3. 支付宝开放平台申请

支付宝控制台名称会随版本调整，以下以功能含义为准。

1. 登录[支付宝开放平台](https://open.alipay.com/)，完成开发者和商家主体认证。
2. 创建适用于网页支付的应用，记录应用 `AppID`。
3. 在应用中添加支付能力，至少申请“当面付/扫码支付”。其接口产品码为 `FACE_TO_FACE_PAYMENT`，Sub2API 用它调用 `alipay.trade.precreate`。
4. 如需当面付失败时回退网页收银台，再按业务场景申请“电脑网站支付”；移动网页场景需要“手机网站支付”。
5. 提交应用审核并等待所需产品生效。控制台显示“已签约/已生效”之前不要上线真实用户入口。
6. 核对应用绑定的收款主体、商户账号和结算账户，避免把生产应用绑定到测试或其他主体。

仅看到 AppID 不代表支付能力已开通。必须用该 AppID 实际完成预下单、查询和 webhook 联调。

## 4. 生成 RSA2 密钥

当前 Sub2API 支付宝 provider 使用“应用私钥 + 支付宝公钥”的普通公钥模式，不是证书模式。不要把应用公钥、支付宝公钥和应用私钥混淆。

推荐使用支付宝官方密钥工具。也可以在受控离线设备上用 OpenSSL 生成 PKCS#8 RSA 2048 位私钥：

```bash
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out app_private_key.pem
openssl pkey -in app_private_key.pem -pubout -out app_public_key.pem
chmod 0400 app_private_key.pem
```

处理顺序：

1. 把 `app_public_key.pem` 中的应用公钥配置到支付宝开放平台应用。
2. 支付宝会为该应用显示“支付宝公钥”，将其另存为 `alipay_public_key.pem`。
3. `app_private_key.pem` 填入 Sub2API 的“应用私钥”。
4. `alipay_public_key.pem` 填入 Sub2API 的“支付宝公钥”。
5. AppID 填入 Sub2API 的 `AppID`。

安全要求：

- 应用私钥只进入 Sub2API 的受控配置，不进入 extra、Git、工单、聊天、截图、浏览器本地存储或普通备份。
- 生成设备、Sub2API 主机和密钥备份使用全盘加密；限制文件为服务账号只读。
- 不在命令行参数或环境变量回显中传递私钥，避免进入 shell 历史和进程列表。
- 至少两人复核应用公钥和支付宝公钥的来源；私钥泄露时立即下线实例、在支付宝侧换钥并核查异常订单。

## 5. 配置 Sub2API 官方支付宝实例

进入 Sub2API 管理后台“设置 -> 支付设置”。

### 5.1 全局支付设置

按下表配置：

| 设置 | 必须值或要求 |
|---|---|
| 启用支付 | 开启 |
| 余额充值 | 开启，不得禁用 |
| 余额充值倍率 | `1` |
| 充值手续费率 | `0` |
| 最低/最高金额 | 与业务风控一致，且覆盖 extra 配置范围 |
| 订单超时 | 建议 15 至 30 分钟 |
| 最大待支付订单数 | 建议 `1` |
| 支付宝可见方式 | 开启 |
| 支付宝支付来源 | 必须选择“支付宝官方” |

余额充值倍率不为 `1` 或手续费率不为 `0` 时，extra 会拒绝创建订单。这样用户目标充值金额、支付宝实付和入账额度始终一致。

### 5.2 新增服务商实例

在“服务商管理”新增“支付宝官方”实例：

| 字段 | 内容 |
|---|---|
| 名称 | 清晰标注环境，例如“支付宝官方-生产” |
| AppID | 第 3 节取得的生产 AppID |
| 应用私钥 | 第 4 节的应用私钥 |
| 支付宝公钥 | 支付宝为该应用提供的支付宝公钥 |
| 支持方式 | 支付宝 |
| 支付模式 | 二维码/默认模式，不要选择强制 redirect |
| 实例状态 | 联调完成前关闭，上线时开启 |
| 单笔/每日限额 | 按实际风控设置 |

回调基础域名填写 Sub2API 的公网 HTTPS 域名。最终异步通知地址必须是：

```text
https://api.example.com/api/v1/payment/webhook/alipay
```

同步返回地址可由 Sub2API 自动生成。支付是否成功只能以验签 webhook 或主动查询为准，不能以浏览器跳回成功页为准。

### 5.3 取得并锁定实例 ID

extra 会在展示二维码前回读订单并核对 `provider_instance_id`。取得实例 ID 的方式：

1. 登录 Sub2API 管理后台并打开浏览器开发者工具。
2. 进入支付服务商管理页。
3. 在 Network 中查看 `GET /api/v1/admin/payment/providers` 响应。
4. 找到 `provider_key` 为 `alipay`、名称和 AppID 对应本实例的记录。
5. 记录其数字 `id`，例如 `7`。

不要记录或导出响应中的敏感配置字段。多个经过批准的官方支付宝实例可记录为 `7,9`；任何 `provider_key=easypay` 的 ID 都不得加入 allowlist。

## 6. 配置公网回调

支付宝必须能直接访问 Sub2API webhook，而不是 extra。检查：

- DNS 指向生产反向代理，没有指向内网或临时隧道。
- TLS 证书链完整、域名匹配、未过期，只开放 HTTPS。
- 反向代理允许 `POST /api/v1/payment/webhook/alipay`，并保留原始表单请求体。
- WAF 不修改字段、不把支付宝请求重定向到登录页，也不缓存响应。
- Sub2API 能看到正确外部站点地址，从而生成正确 `notifyUrl`。
- 访问日志不记录私钥、Authorization、Cookie 或完整 webhook 表单；支付审计按组织留存策略保护。

不要用 IP 白名单替代 RSA2 验签。IP 限制只能是附加控制，因为平台出口可能调整。

## 7. 配置 extra

`.env` 的关键配置：

```dotenv
NODE_ENV=production
RECHARGE_CENTER_PAYMENT_MODE=sub2api_official
RECHARGE_CENTER_SECRET=至少48字符的独立随机值
RECHARGE_CENTER_PUBLIC_URL=https://pay.example.com
RECHARGE_CENTER_COOKIE_SECURE=true
RECHARGE_CENTER_TRUST_PROXY=true
RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED=false

RECHARGE_CENTER_QUICK_AMOUNTS=10,20,50,100,200,500,1000,2000,5000
RECHARGE_CENTER_MIN_AMOUNT=1
RECHARGE_CENTER_MAX_AMOUNT=1000000
RECHARGE_CENTER_MAX_ACTIVE_ORDERS=1

RECHARGE_CENTER_OFFICIAL_ALIPAY_INSTANCE_IDS=7
RECHARGE_CENTER_OFFICIAL_POLL_SECONDS=5
RECHARGE_CENTER_OFFICIAL_POLL_CONCURRENCY=4

SUB2API_BASE_URL=http://host.docker.internal:8080
SUB2API_PUBLIC_URL=https://api.example.com
SUB2API_REQUEST_TIMEOUT_MS=10000
SUB2API_FORWARD_CLIENT_FINGERPRINT=true
```

轮询说明：

- 用户创建或查看待付订单后，extra 才在内存中跟踪该订单。
- 每次轮询调用 Sub2API 的用户级 `/payment/orders/verify`；extra 不直接持有支付宝密钥。
- 同一订单禁止并发查询，全局并发受 `RECHARGE_CENTER_OFFICIAL_POLL_CONCURRENCY` 限制。
- 查询错误使用指数退避，最长 5 分钟；用户令牌过期、退出或订单终态后停止。
- 支付宝 webhook 仍是主路径，轮询只补偿 webhook 延迟或丢失。
- Sub2API 自身还有订单超时查询任务，因此 extra 重启不会使支付事实丢失。

## 8. 为什么金额可以完全一致

每个动态二维码绑定唯一商户订单号 `out_trade_no`，支付宝成功结果还带唯一 `trade_no`。服务端按这两个标识归属交易，不靠金额尾数匹配付款人。

创建时执行四层校验：

1. 浏览器只允许最多两位小数并显示 Sub2API/extra 交集限额。
2. extra 用整数分解析金额，`10.001` 不会被四舍五入。
3. Sub2API 创建订单后，extra 回读并要求 `amount == pay_amount == 用户输入`、币种为 CNY、手续费为 0、倍率为 1。
4. 支付完成后，Sub2API 再把支付宝返回金额与订单 `pay_amount` 对比，验签和金额都通过才履约。

因此用户充值 50 元就是付 50 元、到账 50 元，无需多付几分。

## 9. 沙箱与生产验收

先在支付宝沙箱或独立测试应用完成以下用例，再启用生产实例：

1. 创建 `0.01` 或允许的最小金额订单，页面显示动态二维码且订单号唯一。
2. 支付成功后，即使浏览器不跳回，订单也从 `PENDING` 进入 `COMPLETED`。
3. 暂时阻断 webhook，确认 extra 主动查询能补单；恢复 webhook 后重复通知不重复加余额。
4. 对同一 webhook 重放多次，余额和 `redeem_codes` 只能增加一次。
5. 修改回调金额、AppID、商户订单号或签名，Sub2API 必须拒绝。
6. 创建订单后不支付，确认超时状态正确且不能继续显示二维码。
7. 取消未付订单，确认支付宝侧订单被关闭或后续成功通知按 Sub2API 的恢复规则处理。
8. 把倍率临时改为 `0.9` 或手续费改为非零，确认 extra 拒绝创建订单。
9. 把支付宝可见来源误切到 EasyPay，确认 provider instance allowlist 阻止展示支付凭据。
10. 在不同用户之间请求订单和二维码，确认返回 404/归属校验失败。
11. 检查 Sub2API 中生成一条 `type=balance`、`status=used`、`used_by` 正确的兑换记录。
12. 打开运营中心成本分析，确认该记录按 `used_at` 只计入一次 CNY 自动收入。

生产首笔使用低金额真实付款，并由两名管理员同时核对支付宝账单、Sub2API 支付订单、兑换记录、用户余额和运营中心收入。

## 10. 上线闸门

所有项目都满足后再开放入口：

- 支付宝产品已生效，应用和收款主体正确。
- 私钥不在 Git、镜像层、extra、日志或普通工单中。
- Sub2API 支付宝来源为官方，实例 ID 与 extra allowlist 完全一致。
- 倍率为 1、手续费为 0、币种为 CNY。
- webhook 使用公网 HTTPS，并完成真实异步通知验证。
- Sub2API、extra、反向代理和数据库时间同步。
- Sub2API 数据库有加密备份并完成恢复演练。
- 管理员账号启用 TOTP；extra 生产环境关闭密码代理登录。
- 监控 `FAILED`、长时间 `PAID/RECHARGING`、金额不匹配、provider mismatch 和 webhook 验签失败。
- 已明确退款、迟到支付、重复付款和用户申诉 SOP。

## 11. 异常处理

### 用户已付款但页面未完成

1. 不让用户重复付款，也不要立即手工加余额。
2. 在 Sub2API 支付订单中按 `out_trade_no` 查询状态。
3. 在支付宝商家账单中核对同一商户订单号、支付宝交易号、金额和收款主体。
4. 通过 Sub2API 管理能力主动查询/重试履约；不要在 extra 数据库直接改状态。
5. 检查订单对应的 `recharge_code`，以及同码 `redeem_codes` 记录是否已经存在且已核销。若已核销，不能再次充值。

### 订单为 FAILED

`FAILED` 可能表示支付已确认但兑换履约中断。先查兑换码和用户余额，再使用 Sub2API 的订单重试功能。Sub2API 会复用同一兑换码并通过履约租约保持幂等。

### 金额或通道不匹配

extra 会隐藏二维码并尝试取消订单。立即检查倍率、手续费、支付宝可见来源和 provider instance allowlist；在原因查清前关闭充值入口。

### 私钥疑似泄露

1. 立即禁用该支付宝 provider instance 和充值入口。
2. 在支付宝开放平台更换应用密钥，并使旧密钥失效。
3. 检索异常预下单、查询、退款和 webhook 记录。
4. 更新 Sub2API 配置后完成全链路小额复验。
5. 记录事件时间线和受影响订单，不删除审计数据。

### 已完成订单退款

使用 Sub2API/支付宝的正式退款流程，并按现行业务规则处理用户余额。不要删除原 `redeem_codes`；运营中心自动收入基于已使用兑换记录，退款或冲销需要按财务规则单独记录，避免静默改写历史收入。

## 12. 日结与对账

每日对比四类数据：

1. 支付宝商家账单中的成功交易和退款。
2. Sub2API `payment_orders` 的成功、失败和退款状态。
3. Sub2API `redeem_codes` 中对应支付订单的已使用余额记录。
4. 运营中心同日 CNY 自动收入。

笔数、金额或订单归属任一不一致，都应暂停新充值，先查明差异。不能用新增一条手工收入或直接改余额来“对平”系统。

## 13. 个人码兼容模式

若暂时无法取得官方商户能力，最稳妥的兼容方式是：

```dotenv
RECHARGE_CENTER_PAYMENT_MODE=personal_manual
ALIPAY_QR_IMAGE_PATH=/run/secrets/alipay-personal-qr.png
```

该模式用户仍可自定义金额且不需要多付分角，但付款后必须提交支付宝交易号，由管理员从真实账单独立核验。

项目还提供 `personal_transfer_auto` 实验模式：由二维码自动带入随机备注，监听最终交易详情，只有备注、金额、交易号、收款账户、状态和付款时间全部匹配才自动入账。它不具备支付宝官方签名保证，必须完成真实账号验收并保留人工异常队列。两种个人码流程见[个人支付宝转账自动充值手册](alipay-personal-qr-guide.md)。
