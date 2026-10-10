# 充值中心部署与配置手册

本文从一个尚未配置的 `sub2api-extra` 目录开始，说明个人支付宝二维码放在哪里、每个参数从哪里取得，以及如何验证配置。本文只涉及 `recharge-center`，不需要修改 Provider Monitor、运营中心或其他扩展服务。

## 1. 先选择正确模式

四种模式使用的二维码和到账证据不同，不能混用：

| 模式 | 页面显示的二维码 | 到账方式 | 是否使用 `secrets` 中的图片 |
|---|---|---|---|
| `personal_manual` | 你在支付宝保存的静态个人收款码 | 用户提交支付宝交易号，管理员核账后入账 | 是 |
| `personal_accountlog_static` | 服务端生成包含 `RC-...` 订单号的中转二维码，最终跳到固定本人通用收钱码 | RSA2 验签后的官方账务流水按唯一金额和三分钟时间窗匹配 | 否，只挂载 RSA 密钥 |
| `personal_transfer_auto` | 服务按每笔订单动态生成，写入实付金额和随机备注 | 受控监听器读取最终交易详情，完整匹配后自动入账 | 否 |
| `sub2api_official` | Sub2API 通过支付宝官方接口取得的订单二维码 | 官方回调和主动查询 | 否 |

如果你的目标只是“先把个人收款码放上去”，选择 `personal_manual`。如果已实际获批 `alipay.data.bill.accountlog.query`，并接受用户在支付宝付款页手动输入本单应付金额，可选择 `personal_accountlog_static`：它只需服务器，不需要长期在线电脑、手机监听器或二维码生成设备。如果没有该接口权限但具备逐单金额/备注生成能力和最终交易详情监听器，才选择实验性的 `personal_transfer_auto`。仅上传一张二维码图片仍不能实现安全自动入账。

### 每日次数限制（无需配置）

充值中心所有模式默认且固定为每用户每天最多创建 **10 次**，每天北京时间零点重置，与服务器/容器本地时区无关。`RECHARGE_CENTER_MAX_ACTIVE_ORDERS` 仍仅控制同时活动订单数，不会改变每日上限。取消、过期或完成的订单也占用当天次数；个人模式创建失败并回滚不计数。官方模式已发出请求但因超时等无法确认创建结果时，为防止重复创建会保留次数。

剩余次数在金额选择页和付款须知中自动显示，由服务端查询，不需要配置项或定时清零脚本。达到上限只阻止新建订单，不影响已有订单付款、到账核验或人工处理。升级时保留充值中心原有数据卷；本服务自动执行数据库版本 10 的增量迁移，并统计升级前当天已有的个人订单。

## 2. 部署前准备

准备以下内容：

1. 已正常运行的 Sub2API，以及用户实际访问它的 HTTPS 地址。
2. Docker Engine 和 Docker Compose v2。
3. 充值中心专用 HTTPS 域名，例如 `pay.example.com`，以及指向本机 `127.0.0.1:9874` 的反向代理。
4. 若使用人工模式：从你自己的支付宝客户端保存的个人收款二维码原图。
5. 若使用静态码账务流水模式：本人通用 `fkx...` 地址、已获批账务接口的 AppID、应用 RSA 私钥、支付宝公钥、专用 SMTP 账号和 Sub2API Admin API Key。
6. 若使用设备监听自动模式：专用 SMTP 账号、Sub2API Admin API Key、能逐单生成 `fkx...` 收钱码的受控支付宝设备适配器，以及独立的支付宝账单监听适配器。
7. 服务器时间同步服务，例如 `systemd-timesyncd` 或 chrony。自动模式的付款窗口和签名校验依赖准确时间。

生产服务器建议使用 Linux。下面的路径均假定仓库位于 `/opt/sub2api-extra`；如果你的目录不同，只替换宿主机路径，不要修改容器内 `/run/secrets/...` 路径的含义。

## 3. 放置个人支付宝收款码

本节仅适用于 `personal_manual`。

### 3.1 从支付宝取得图片

支付宝客户端的菜单名称可能随版本变化，按功能找到“收付款”或“收钱/二维码收款”，进入你本人账户的个人收款码页面，然后使用支付宝提供的“保存收款码”功能保存原图。

取码时遵守以下要求：

- 必须是你自己已实名收款账户的码，先用另一个支付宝账号小额扫码，核对收款人脱敏姓名确实属于你。
- 使用普通、长期可扫码的收款码，不要使用付款码、红包码、群收款码、一次性码或他人的聚合码。
- 优先使用支付宝直接保存的原图，不截图、不裁掉二维码静区、不加水印、不经过聊天软件压缩。
- 图片只能是 PNG、JPEG 或 WebP；HEIC、PDF 和 SVG 不受支持。
- 默认不得超过 2 MiB。不要把图片上传到在线“二维码解析”网站验证，避免收款标识泄露。

### 3.2 上传到 Linux 服务器

先从管理电脑传到一个仅管理员可访问的临时位置，再在服务器执行：

```bash
cd /opt/sub2api-extra
sudo install -d -o 1000 -g 1000 -m 0700 recharge-center/secrets
sudo install -o 1000 -g 1000 -m 0400 \
  "$HOME/alipay-personal-qr.png" \
  recharge-center/secrets/alipay-personal-qr.png
```

镜像中的 `node` 用户 UID/GID 为 `1000:1000`，所以目录和文件必须允许该 UID 读取。`0400 root:root` 或 `0700 root:root` 会导致容器中的非 root 进程无法读取，不能照搬。若你使用了自定义镜像或 Docker 用户命名空间映射，应先确认容器进程的实际 UID，再把文件所有者改为该 UID。

检查文件类型、权限和摘要：

```bash
file recharge-center/secrets/alipay-personal-qr.png
stat -c '%a %u:%g %s %n' recharge-center/secrets/alipay-personal-qr.png
sha256sum recharge-center/secrets/alipay-personal-qr.png
```

预期权限为 `400 1000:1000`，文件大于 128 字节且不超过 `ALIPAY_QR_MAX_BYTES`。把 SHA-256 摘要保存在受控运维记录中；以后图片被替换时可以发现变化，不要把图片本身提交到 Git。

在 Windows Docker Desktop 做本地联调时可以执行：

```powershell
New-Item -ItemType Directory -Force .\recharge-center\secrets
Copy-Item "$env:USERPROFILE\Downloads\alipay-personal-qr.png" ".\recharge-center\secrets\alipay-personal-qr.png"
```

Windows 示例只用于本地验证。生产环境仍应使用受限 Linux 文件权限和专用服务主机。

### 3.3 宿主机路径与容器路径

Compose 中已有只读挂载：

```text
宿主机：recharge-center/secrets/
     -> 容器：/run/secrets/（只读）
```

因此 `.env` 必须写容器看到的路径：

```dotenv
RECHARGE_CENTER_PAYMENT_MODE=personal_manual
ALIPAY_QR_IMAGE_PATH=/run/secrets/alipay-personal-qr.png
```

不要把它写成 `/opt/sub2api-extra/recharge-center/secrets/...`，那是宿主机路径，容器内不存在。若保存的是 JPEG，则可以命名为 `alipay-personal-qr.jpg`，并同步修改 `ALIPAY_QR_IMAGE_PATH`。

## 4. 创建 `.env`

个人静态码账务流水模式可以直接使用 19 项最简模板：

```bash
cd /opt/sub2api-extra
cp recharge-center/.env.minimal.example recharge-center/.env
chmod 0600 recharge-center/.env
openssl rand -hex 48  # 账本主密钥
```

若部署 `personal_manual`、`personal_transfer_auto`、`sub2api_official`，或者需要修改端口、金额、轮询时效等高级参数，则改为复制完整模板：

```bash
cp recharge-center/.env.example recharge-center/.env
chmod 0600 recharge-center/.env
```

将命令输出填入 `RECHARGE_CENTER_SECRET`。账本主密钥一旦用于现有账本就不能随意更换，否则旧密文和敏感字段 HMAC 将无法读取或匹配。`personal_transfer_auto` 还需分别生成二维码代理密钥和到账监听密钥，三者不得相同。不要把终端输出粘贴到工单、聊天或 Git。

然后至少替换：

```dotenv
RECHARGE_CENTER_SECRET=<刚生成的独立随机值>
RECHARGE_CENTER_PUBLIC_URL=https://pay.example.com
SUB2API_BASE_URL=http://host.docker.internal:8080
SUB2API_PUBLIC_URL=https://api.example.com
```

尖括号只表示说明，不能原样写进生产 `.env`。

### 4.1 Compose 参数从哪里来

| 配置项 | 如何确定 |
|---|---|
| `RECHARGE_CENTER_IMAGE` | 项目发布到 GHCR 的镜像名；生产固定到已验收的版本标签或 digest。 |
| `RECHARGE_CENTER_CONTAINER_NAME` | 自行命名，确保本机唯一。 |
| `RECHARGE_CENTER_RESTART_POLICY` | Docker 重启策略，生产通常保持 `unless-stopped`。 |
| `RECHARGE_CENTER_PORT` | 宿主机未占用端口；仅绑定回环地址，公网入口由反向代理提供。 |
| `RECHARGE_CENTER_DATA_VOLUME` | 自行命名的 Docker 卷；它保存账本，升级时保持不变。 |
| `NPM_REGISTRY` | 只有本机构建且确需镜像源时填写可信 registry URL，否则留空。 |

### 4.2 通用参数从哪里来

| 配置项 | 如何确定 |
|---|---|
| `NODE_ENV` | 正式环境固定 `production`。 |
| `PORT` | 直接运行 Node 时的监听端口；Compose 已固定容器内为 `9874`。 |
| `RECHARGE_CENTER_BIND_HOST` | 直接运行 Node 时的监听地址；Compose 已固定容器内为 `0.0.0.0`，宿主机仍只暴露 `127.0.0.1`。 |
| `RECHARGE_CENTER_DATA_DIR` | Compose 卷挂载目录，保持 `./data`。 |
| `RECHARGE_CENTER_DATABASE` | SQLite 文件路径，保持 `./data/recharge-center.db`，或留空使用默认值。 |
| `RECHARGE_CENTER_SECRET` | 用 `openssl rand -hex 48` 自行生成；不可与二维码代理、监听、SMTP、Webhook 或 Admin API Key 复用。 |
| `RECHARGE_CENTER_PUBLIC_URL` | 充值中心反向代理后的 HTTPS 根地址，例如 `https://pay.example.com`。 |
| `RECHARGE_CENTER_TRUST_PROXY` | 使用本文的受控反向代理时设 `true`；不要让用户绕过代理直接访问容器。 |
| `RECHARGE_CENTER_COOKIE_SECURE` | 生产固定 `true`。 |
| `RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED` | 建议 `false`，避免充值中心接触用户密码；使用 Sub2API 自定义菜单 SSO。 |
| `RECHARGE_CENTER_SESSION_TTL_MINUTES` | 自行确定登录时长，允许 5 到 240，建议 60。 |
| `RECHARGE_CENTER_ORDER_TTL_MINUTES` | 官方/人工订单时长，允许 3 到 60；两种个人自动模式固定 3 分钟。 |
| `RECHARGE_CENTER_REVIEW_TTL_HOURS` | 人工处理时限，允许 1 到 168，建议 72。 |
| `RECHARGE_CENTER_FULFILLMENT_LEASE_MINUTES` | 幂等履约恢复租约，通常保持 5。 |
| `RECHARGE_CENTER_PAYMENT_MODE` | 按第 1 节四选一，不能自造名称。 |
| `RECHARGE_CENTER_QUICK_AMOUNTS` | 页面快捷按钮金额，自行制定，英文逗号分隔，最多 20 项。 |
| `RECHARGE_CENTER_ALLOWED_AMOUNTS` | 旧兼容项；新部署由 `QUICK_AMOUNTS` 覆盖，保持相同值即可。 |
| `RECHARGE_CENTER_MIN_AMOUNT` | 业务允许的最低人民币金额，最多两位小数。 |
| `RECHARGE_CENTER_MAX_AMOUNT` | 结合风控、账户限额和争议处理能力制定，最多两位小数。 |
| `RECHARGE_CENTER_CREDIT_MULTIPLIER` | 固定 `1`，代码会拒绝其他值。 |
| `RECHARGE_CENTER_MAX_ACTIVE_ORDERS` | 单用户活动订单上限，建议 `1`；不是自动模式的全局 100 笔上限。 |

### 4.3 官方支付宝模式参数

| 配置项 | 如何确定 |
|---|---|
| `RECHARGE_CENTER_OFFICIAL_ALIPAY_INSTANCE_IDS` | 在 Sub2API 支付服务商列表找到 `provider_key=alipay` 且 AppID、名称正确的记录，取数字 `id`；多个用逗号分隔。 |
| `RECHARGE_CENTER_OFFICIAL_POLL_SECONDS` | 主动查询间隔，允许 3 到 60，通常 5。 |
| `RECHARGE_CENTER_OFFICIAL_POLL_CONCURRENCY` | 同时查询数，允许 1 到 20，通常 4。 |

官方实例的申请、AppID、RSA 密钥和实例 ID 获取过程见[支付宝官方自动充值接入手册](alipay-official-auto-recharge-guide.md)。

### 4.4 静态个人码参数

| 配置项 | 如何确定 |
|---|---|
| `ALIPAY_QR_IMAGE_PATH` | Compose 部署填写容器路径 `/run/secrets/alipay-personal-qr.png`；直接运行 Node 才填写宿主机绝对路径。 |
| `ALIPAY_QR_MAX_BYTES` | 图片大小上限，默认 `2097152`（2 MiB），允许 1 MiB 以下的小图，也可在 1024 到 5242880 之间调整。 |

人工模式最小关键配置为：

```dotenv
NODE_ENV=production
RECHARGE_CENTER_PAYMENT_MODE=personal_manual
RECHARGE_CENTER_ORDER_TTL_MINUTES=3
ALIPAY_QR_IMAGE_PATH=/run/secrets/alipay-personal-qr.png
ALIPAY_QR_MAX_BYTES=2097152
RECHARGE_CENTER_CREDIT_MULTIPLIER=1
```

人工模式不会自动确认到账。用户付款后需要从支付宝账单详情复制完整交易号，管理员从自己的支付宝账单独立核对交易号、实收金额和付款时间，确认后系统才生成并核销余额兑换码。

### 4.5 个人转账自动模式参数

| 配置项 | 如何确定 |
|---|---|
| `RECHARGE_CENTER_TRANSFER_QR_SOURCE` | 本方案固定为 `collector`；它表示由受控设备为每单生成新码。`template` 只保留给已有真实可替换 URI 的兼容部署。 |
| `RECHARGE_CENTER_TRANSFER_QR_TEMPLATE` | `collector` 模式留空。只有选择 `template` 时才填写含 `{amount}`、`{memo}` 的本人实测 URI。普通 `fkx...` 地址不能填在这里。 |
| `RECHARGE_CENTER_QR_JOB_LEASE_SECONDS` | 二维码代理领取单个任务的最长处理时间，允许 15 到 120 秒，通常保持 45；不得大于实际可控的页面操作时长。 |
| `RECHARGE_CENTER_QR_PROVISIONER_SECRET` | 用独立的 `openssl rand -hex 48` 生成，只分发给服务端和二维码生成代理；它无权上报到账。 |
| `RECHARGE_CENTER_LISTENER_SECRET` | 用第二次 `openssl rand -hex 48` 独立生成，只分发给服务端和受控监听器。 |
| `RECHARGE_CENTER_LISTENER_COLLECTOR_ID` | 自行命名并固定到一台监听设备，例如 `alipay-ledger-phone-1`。 |
| `RECHARGE_CENTER_LISTENER_MAX_STALE_SECONDS` | 必须明显大于监听器查询间隔；每 10 秒成功查询一次时建议 30。 |
| `RECHARGE_CENTER_LISTENER_SIGNATURE_TOLERANCE_SECONDS` | 根据两端 NTP 同步质量设置，通常 60。 |
| `RECHARGE_CENTER_LISTENER_MAX_EVENT_AGE_SECONDS` | 允许采集延迟的上限，通常 600；它不会延长三分钟付款窗口。 |
| `RECHARGE_CENTER_ALIPAY_RECIPIENT_ID` | 由正式适配器从你账户一笔真实“收入成功”的最终交易详情中取得稳定、精确的收款方标识；不能用昵称或猜测的手机号代替。 |
| `RECHARGE_CENTER_AUTO_MODE_VERIFIED` | 初始保持 `false`；全部真实小额正向/负向验收通过后才由负责人改为 `true`。 |

你解码得到的 `https://qr.alipay.com/fkx...` 是不透明、不可改写的结果，仍然受支持，但必须由二维码代理针对每笔订单重新生成。代理从服务端领取金额和随机备注，在本人支付宝正常可见页面填写并生成收钱码，再回传页面实际显示的金额、备注、收款账户标识和 `fkx...` URL。服务端会逐项匹配 `RECHARGE_CENTER_ALIPAY_RECIPIENT_ID`、拒绝重复 URL，并用 AES-256-GCM 加密 URL；用户浏览器只会收到服务端渲染的 PNG。

仓库已提供队列、租约、签名客户端和 `tools/qr-provisioner-agent.js`。账号页面适配模块仍必须依据你当前支付宝页面的可见结构实现和验收，不能复制通用选择器、导出 Cookie 或调用猜测的私有接口。适配前保持 `RECHARGE_CENTER_AUTO_MODE_VERIFIED=false`。接口契约和验收要求见[个人支付宝转账自动充值手册](alipay-personal-qr-guide.md)。

### 4.6 个人静态码账务流水参数

| 配置项 | 如何确定 |
|---|---|
| `RECHARGE_CENTER_ALIPAY_STATIC_QR_URL` | 本地解码本人支付宝通用收钱码得到的完整 `https://qr.alipay.com/fkx...`；不能含预设金额、查询参数或说明文字。 |
| `RECHARGE_CENTER_ALIPAY_APP_ID` | 支付宝开放平台中已实际获批 `alipay.data.bill.accountlog.query` 的应用数字 AppID。仅创建应用不代表有权限。 |
| `RECHARGE_CENTER_ALIPAY_APP_PRIVATE_KEY_PATH` | Compose 中保持 `/run/secrets/alipay-app-private-key.pem`；对应文件是你离线生成的至少 2048 位 RSA 应用私钥。 |
| `RECHARGE_CENTER_ALIPAY_PUBLIC_KEY_PATH` | Compose 中保持 `/run/secrets/alipay-public-key.pem`；对应文件必须是开放平台给出的支付宝公钥，不是应用公钥。 |
| `RECHARGE_CENTER_ALIPAY_GATEWAY` | 生产固定 `https://openapi.alipay.com/gateway.do`；沙箱地址只允许非生产联调。 |
| `RECHARGE_CENTER_ACCOUNTLOG_POLL_SECONDS` | 全局轮询间隔，允许 5 到 60，建议 15；不是每个订单各建一个轮询器。 |
| `RECHARGE_CENTER_ACCOUNTLOG_LOOKBACK_SECONDS` | 每次重复查询的回看秒数，允许 180 到 3600，建议 900，用于容忍流水可见延迟。 |
| `RECHARGE_CENTER_ACCOUNTLOG_STALE_SECONDS` | 最近一次成功验签查询多久后暂停接单，至少为轮询间隔两倍，建议 60。 |
| `RECHARGE_CENTER_ACCOUNTLOG_AMOUNT_QUARANTINE_SECONDS` | 原三分钟窗口结束后继续隔离实付金额的秒数，不得短于回看窗口，建议 900；取消不向其他用户释放金额，同用户无证据、无异常的取消订单可复用占位。 |
| `RECHARGE_CENTER_ACCOUNTLOG_REQUEST_TIMEOUT_MS` | 单次支付宝请求超时，允许 1000 到 30000，建议 10000。 |
| `RECHARGE_CENTER_AUTO_MODE_VERIFIED` | 初始保持 `false`；完成真实接口权限、验签、正向、冲突、超时和履约故障测试后才改为 `true`。 |

该模式的二维码只编码 `https://你的充值域名/pay/<RC订单号>`。订单号是充值中心生成的 128 位随机审计令牌，不是 Sub2API 官方 `payment_orders` 的商户订单号，也不会进入支付宝账单；完成入账后它会写入 Sub2API 兑换记录备注，供充值中心账本、兑换记录和运营中心相互追溯。完整申请、密钥文件权限、取码和验收步骤见[个人静态码账务流水手册](alipay-accountlog-static-guide.md)。

取消后连续重建同金额订单，同一用户会复用自己的合格占位，不必通过修改配置消除分角累加；原金额被其他用户占用或属于自己不可复用的过期、已完成等订单时，才寻找下一个可用分值。这里的“占用”包括尚未结束的隔离，不能只看活动订单。账本会自动增量升级到版本 9，已有取消订单也可按规则复用，不需要清空订单或金额占位。升级前备份账本，详情见静态码手册的取消重建规则。

### 4.7 Sub2API 参数

| 配置项 | 如何确定 |
|---|---|
| `SUB2API_BASE_URL` | 容器访问 Sub2API 的内部地址；同机监听 8080 时通常是 `http://host.docker.internal:8080`。先从容器验证可达性。 |
| `SUB2API_PUBLIC_URL` | 用户浏览器访问 Sub2API 的 HTTPS 根地址，也是充值中心 CSP 允许嵌入的来源。 |
| `SUB2API_ADMIN_API_KEY` | 两种个人自动模式需要。在 Sub2API 管理后台“系统设置”创建/重新生成管理员 API Key，立即保存唯一一次显示的 `admin-` 加 64 位十六进制值。 |
| `SUB2API_REQUEST_TIMEOUT_MS` | 内部请求超时，允许 1000 到 30000，通常 10000。 |
| `SUB2API_FORWARD_CLIENT_FINGERPRINT` | SSO 时转发浏览器 IP 和 User-Agent，通常保持 `true`；同时只信任你自己的反向代理。 |

`SUB2API_ADMIN_API_KEY` 目前拥有全局管理员权限，不是只允许充值的细粒度 Key。必须为充值中心专用、走受控内网、限制该容器的出站目标，并制定轮换流程。它不是管理员登录密码，也不是用户 Token。

### 4.8 独立通知参数

| 配置项 | 如何确定 |
|---|---|
| `RECHARGE_CENTER_ALERT_CHANNELS` | 不启用时留空；自动模式必须含 `email`；需要双通道时填 `email,webhook`。 |
| `RECHARGE_CENTER_ALERT_TIMEOUT_MS` | 单次投递超时，通常 5000。 |
| `RECHARGE_CENTER_SMTP_HOST` | 邮箱服务商 SMTP/第三方客户端设置页给出的主机名。 |
| `RECHARGE_CENTER_SMTP_PORT` | 服务商给出的端口；SMTPS 常用 465，STARTTLS 常用 587。 |
| `RECHARGE_CENTER_SMTP_SECURE` | 465 通常为 `true`；587 通常为 `false`。以服务商说明为准。 |
| `RECHARGE_CENTER_SMTP_REQUIRE_TLS` | 587 必须为 `true`；生产至少启用 SMTPS 或强制 STARTTLS。 |
| `RECHARGE_CENTER_SMTP_USER` | 服务商给出的 SMTP 用户名，通常是完整邮箱地址。 |
| `RECHARGE_CENTER_SMTP_PASSWORD` | 在邮箱安全设置中生成的授权码/应用密码；不要优先使用网页登录密码。 |
| `RECHARGE_CENTER_SMTP_FROM` | 服务商允许使用的单个发件邮箱。 |
| `RECHARGE_CENTER_ALERT_EMAIL_TO` | 你的运维收件邮箱，多个用英文逗号分隔，最多 20 个。 |
| `RECHARGE_CENTER_ALERT_WEBHOOK_URL` | 你自行维护的告警接收端；生产必须是 HTTPS，不能发生重定向。 |
| `RECHARGE_CENTER_ALERT_WEBHOOK_BEARER_TOKEN` | 用 `openssl rand -hex 48` 单独生成，并在 Webhook 接收端配置同一 Token。 |

SMTP 参数全部来自邮箱服务商，不来自支付宝。通知模块完全位于充值中心，不读取或复用 Provider Monitor 的渠道、数据库或凭据。

## 5. 校验并启动

### 5.1 已部署 `sub2api-extra` 根目录时增量启动

目录已有 `compose.services.env`、`docker-compose.yml` 和其他服务时，不要替换原有服务列表。先把 `recharge-center` 追加到现有 `COMPOSE_PROFILES`，例如：

```dotenv
COMPOSE_PROFILES=provider-monitor,operations-center,degradation-detector,recharge-center
```

然后只拉取并更新充值中心，不重建其他容器：

```bash
cd /opt/sub2api-extra
docker compose --env-file compose.services.env config --services
docker compose --env-file compose.services.env pull recharge-center
docker compose --env-file compose.services.env up -d --no-deps recharge-center
docker compose --env-file compose.services.env logs --tail=100 recharge-center
```

`recharge-center/.env` 由该服务自己的 `compose.yaml` 读取，不能把其中密钥写进根目录 `compose.services.env`。只有 `personal_transfer_auto` 需要二维码代理和监听设备；`personal_accountlog_static` 的二维码与轮询都在充值中心服务器完成。

### 5.2 单独使用充值中心 Compose

先检查 Compose 语法和变量展开：

```bash
cd /opt/sub2api-extra
docker compose \
  --env-file recharge-center/.env \
  -f recharge-center/compose.yaml \
  --profile recharge-center \
  config --quiet
```

拉取并启动：

```bash
docker compose \
  --env-file recharge-center/.env \
  -f recharge-center/compose.yaml \
  --profile recharge-center \
  pull

docker compose \
  --env-file recharge-center/.env \
  -f recharge-center/compose.yaml \
  --profile recharge-center \
  up -d --no-build
```

查看状态与日志：

```bash
docker compose \
  --env-file recharge-center/.env \
  -f recharge-center/compose.yaml \
  --profile recharge-center \
  ps

docker compose \
  --env-file recharge-center/.env \
  -f recharge-center/compose.yaml \
  --profile recharge-center \
  logs --tail=100 recharge-center
```

不要把 `docker compose config` 的完整输出贴到公开位置，它会展开 `.env` 中的密钥。

## 6. 配置 HTTPS 反向代理

容器端口只绑定 `127.0.0.1`，不要改成 `0.0.0.0` 暴露公网。以下是 Nginx 核心代理段，证书部分按你的现有 ACME 方案配置：

```nginx
# 放在 http {} 中，避免自定义菜单首次请求的 token 查询参数进入访问日志。
log_format recharge_no_query '$remote_addr - $remote_user [$time_local] '
                             '"$request_method $uri $server_protocol" $status $body_bytes_sent';

server {
    listen 443 ssl;
    server_name pay.example.com;

    access_log /var/log/nginx/recharge-center.access.log recharge_no_query;

    # 订单号是高熵付款令牌；该路径不写访问日志，也不缓存。
    location ^~ /pay/ {
        access_log off;
        proxy_pass http://127.0.0.1:9874;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_buffering off;
        proxy_request_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:9874;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

必须使用有效 HTTPS 证书。Cloudflare 代理开启（黄/橙云）时使用 `Full (strict)` 和有效源站证书，不能使用 Flexible；源站只放行 Cloudflare 官方网段，并按其当前官方列表配置 Nginx `set_real_ip_from` 与 `real_ip_header CF-Connecting-IP`。不要无条件信任公网传入的 `CF-Connecting-IP`，也不要经会修改响应、缓存二维码或记录完整查询串的其他代理。`RECHARGE_CENTER_TRUST_PROXY=true` 只适用于外部请求确实只能经过受控代理的部署。

## 7. 接入 Sub2API 自定义菜单

在 Sub2API 管理后台进入“设置 -> 自定义菜单”，新增：

```text
名称：充值中心
URL：https://pay.example.com/?token={token}&theme={theme}
可见性：所有需要充值的用户
```

充值中心会校验 Token、换成自己的短时会话，然后立即从地址栏删除 Token。由于首次请求仍带 Token，必须按上一节让反向代理访问日志忽略查询参数。

自定义菜单的“SVG 图标”可填写 [充值中心图标](../public/recharge-center-icon.svg) 的完整内容，与 Sub2API 原生充值菜单图标一致，颜色自动跟随主题。

模块首次打开时显示居中的 loading，配置和登录校验完成后直接进入充值页面。启动请求超时或服务异常会显示“重试”；只有确认登录会话不可用时才显示登录或返回 Sub2API 的提示。

如果提示 `SESSION_BINDING_MISMATCH`，先确认反向代理正确传递真实 IP 和 User-Agent、`SUB2API_FORWARD_CLIENT_FINGERPRINT=true`，并确认 Sub2API 只信任你的代理头。调整会话绑定策略后需要退出 Sub2API 并重新登录，旧 Token 不会自动改变绑定信息。

## 8. 健康检查与二维码验收

先从服务器本机检查：

```bash
curl -fsS http://127.0.0.1:9874/healthz
curl -fsS http://127.0.0.1:9874/readyz
```

- `/healthz` 返回 `{"status":"ok"}` 只表示进程活着。
- `/readyz` 返回 200 才表示当前模式可以接单。
- `personal_manual` 的 `/readyz` 会确认静态图片已成功加载。
- `personal_accountlog_static` 只有在完成过一次成功 OpenAPI 查询和 RSA2 响应验签、且最近成功时间未过期时才返回 200；它不需要设备心跳。
- `personal_transfer_auto` 在监听器尚未成功读取支付宝账单并发送就绪心跳时返回 503，这是安全设计，不应绕过。
- `collector` 来源还要求二维码代理独立心跳正常；两类设备任一不健康都会返回 503 并停止创建新订单。

再从 Sub2API 自定义菜单打开充值中心，用另一个支付宝账号做最低金额测试：

1. 页面收款人必须是你本人，二维码清晰且不会跳到第三方域名。
2. 页面显示的应付金额和到账额度都正确，倍率为 1。
3. 人工模式下，完整执行“付款 -> 提交交易号 -> 管理员核账 -> 确认”。
4. 账务流水模式下，扫码后在支付宝手动输入页面应付金额，并确认三分钟内唯一流水只自动入账一次。
5. 确认 Sub2API 只生成一条 `type=balance`、`status=used` 的兑换记录，备注包含充值中心 `RC-...` 订单号，用户余额只增加一次。
6. 确认运营中心按现有兑换记录逻辑展示对应 CNY 自动收入。

## 9. 常见错误

| 现象 | 原因与处理 |
|---|---|
| `ALIPAY_QR_IMAGE_PATH` 找不到文件 | `.env` 写成了宿主机路径，或文件未放在 `recharge-center/secrets`；改用 `/run/secrets/...`。 |
| `EACCES` 或二维码不可用 | `secrets` 目录不可遍历，或图片不是容器进程 UID 1000 可读；按第 3.2 节修正所有者和权限。 |
| “仅支持 PNG、JPEG 或 WebP” | 文件实际是 HEIC/PDF/SVG，或被错误下载为 HTML；重新从支付宝保存原图，不要只改扩展名。 |
| 图片过大 | 压缩为清晰 PNG/JPEG，或在 5 MiB 硬上限内谨慎调整 `ALIPAY_QR_MAX_BYTES`。 |
| 生产启动提示主密钥无效 | 仍在使用 `.env.example` 占位值；重新生成独立随机值。 |
| 生产启动提示必须 HTTPS | `RECHARGE_CENTER_PUBLIC_URL` 或 `SUB2API_PUBLIC_URL` 不是实际 HTTPS 根地址。 |
| 账务流水模式 `/readyz` 为 503 | 尚未成功调用并验签 `alipay.data.bill.accountlog.query`，或最近成功查询已过期；检查 AppID、接口权限、RSA 密钥、服务器时间和网络。 |
| 启动提示拒绝切换收款身份 | 固定 `fkx...` 或 AppID 已变化，但仍有活动/人工处理订单或金额隔离；停止接单、处理异常并等待隔离期结束后再切换，不能删除账本元数据绕过。 |
| 设备监听模式 `/readyz` 为 503 | 监听器没有真实成功轮询、心跳过期或报告 `ready=false`；不能用假心跳强行变绿。 |
| 自动模式提示二维码代理不可用 | `collector` 模式未启动 `qr-provisioner-agent.js`、代理未登录正确账号、适配器健康检查失败或心跳过期。 |
| `PAYMENT_QR_PENDING` | 本单 `fkx...` 尚在受控设备生成；页面会自动轮询，超过三分钟仍未完成则订单过期。 |
| 自动模式拒绝模板 | 仅 `template` 兼容模式会出现；检查 `{amount}`/`{memo}`、支付宝域名和嵌套跳转。 |
| 自动模式拒绝 Admin API Key | 生产必须使用当前 Sub2API 生成的 `admin-` 加 64 位十六进制值。 |
| 邮件无法发送 | 核对服务商 SMTP 主机、端口、授权码和 TLS 组合；465 通常 `SECURE=true`，587 通常 `REQUIRE_TLS=true`。 |
| 上传静态码图片后仍不能自动充值 | 图片文件仅属于 `personal_manual`。静态码自动模式要配置解码后的 `fkx...` URL，并且应用必须实际拥有账务接口权限；设备监听模式则需要逐单生成器和详情监听器。 |

## 10. 更新与备份注意事项

- 更新前备份 `RECHARGE_CENTER_DATA_VOLUME` 中的 SQLite 账本，并做恢复演练。
- 同时安全备份 `.env`、收钱码和 RSA 密钥，但不要把它们放进源码仓库或普通网盘；应用私钥与账本备份分开保管。
- 不要在服务运行时直接复制 SQLite 主文件作为一致性备份，应使用 SQLite 在线备份方式或先停服务。
- 不要通过删除订单、修改数据库或更换数据卷“修复”异常订单；应在管理页面保留审计轨迹并按人工流程处理。
- 轮换 `RECHARGE_CENTER_SECRET` 需要专门迁移设计；二维码代理密钥、监听密钥、SMTP 授权码、Webhook Token 和 Admin API Key 可以分别轮换，且始终不得互相复用。
