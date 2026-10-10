# 个人静态收钱码 + 支付宝账务流水自动充值手册

本文对应：

```dotenv
RECHARGE_CENTER_PAYMENT_MODE=personal_accountlog_static
```

该模式只需要一台部署充值中心的服务器，不需要长期在线的电脑、手机监听器或二维码生成设备。服务器生成每单中转二维码，用户扫码后进入固定的本人支付宝通用收钱码；服务器通过支付宝官方 `alipay.data.bill.accountlog.query` 查询已验签账务流水。

## 先确认能否使用

支付宝最新 SDK 将该接口描述为“支付宝商家账户账务明细查询”。实现代码不能替你取得权限，也不能借用浏览器登录 Cookie 绕过开放平台审核。

上线前必须同时满足：

1. 支付宝开放平台应用的 API 列表中能搜索并申请 `alipay.data.bill.accountlog.query`。
2. 控制台明确显示该应用已获得接口权限，而不只是创建了应用。
3. 该应用查询到的确实是放置收钱码的本人支付宝账户流水。
4. 个人收钱码收入会出现在接口结果中，并稳定返回 `account_log_id`、`trans_amount`、`trans_dt` 和 `direction`。
5. 接受用户仍需在支付宝付款页手动输入页面显示的应付金额。

如果控制台要求企业主体、营业执照、商家产品签约或其他资质，而你的个人账号无法完成，当前模式就不可用。不要改成抓浏览器私有接口、Cookie 或页面 DOM；那会把账号风控、接口变化和凭据泄露直接带入放款链路。

## 工作流程与证据边界

1. 用户只在充值中心输入金额。
2. 充值中心生成三分钟订单，订单号格式为 `RC-日期-128位随机值`。
3. 原金额未占用时应付金额不变；冲突时分配 `+0.01` 到 `+0.99`。
4. 二维码内容为 `https://你的充值域名/pay/<订单号>`。
5. 中转端点确认订单仍有效后，以 `303` 跳到固定 `https://qr.alipay.com/fkx...`。
6. 用户在支付宝付款页准确输入本单应付金额并付款。
7. 服务端每 15 秒全局查询一次最近 15 分钟账务流水，验证支付宝 RSA2 响应签名。
8. 仅当收入方向、精确金额、三分钟付款时间、唯一候选订单和未使用 `account_log_id` 全部成立时自动入账。
9. 充值中心调用 Sub2API `create-and-redeem`，生成一条 `balance/used` 兑换记录；备注同时写入充值中心订单号和账务流水尾号，运营中心可沿用现有成本分析联动。

订单号只存在于中转 URL、本地审计和最终 Sub2API 兑换备注中。它是充值中心生成的订单号，不是 Sub2API 官方 `payment_orders` 的商户订单号。固定个人收钱码无法把该订单号写入支付宝账单，因此订单号不是支付宝侧的付款归属证据。支付宝接口也明确说明 `trans_memo` 不可依赖用于对账，本实现不会用备注自动放款，也不会明文保存备注。

## 申请接口

支付宝控制台界面可能调整，以下以实际页面名称为准：

1. 登录 [支付宝开放平台](https://open.alipay.com/)。
2. 在“控制台”创建或选择由实际收款主体持有的应用。
3. 在应用“产品绑定 / 能力列表 / API 权限”中搜索 `alipay.data.bill.accountlog.query`。
4. 按控制台要求提交申请、签约或补充主体资料。
5. 等待状态变为已生效，再记录应用详情中的数字 `AppID`。
6. 不要填写其他人的 `bill_user_id` 或 `open_id`。本服务不实现第三方商户代查，也不传 `app_auth_token`。
7. 若搜索不到、没有申请按钮或审核拒绝，联系支付宝开放平台客服确认账号是否具备准入资格。不能用 `alipay.trade.query` 替代，因为个人静态收钱码没有由本应用创建的商户订单号。

“账号已登录支付宝”不等于“应用已获得接口权限”。只有 `/readyz` 中 `accountLog.healthy=true` 才表示服务器完成过一次成功查询和响应验签。

## 配置 RSA2 密钥

本服务使用普通公钥 / RSA2 模式，不使用证书模式。先区分已有的三份密钥：

| 名称 | 保存到 Linux 服务器的文件 | 用途 |
| --- | --- | --- |
| 应用私钥 | `recharge-center/secrets/alipay-app-private-key.pem` | 服务端签署 API 请求，必须与当前 AppID 已上传的应用公钥配对 |
| 应用公钥 | `recharge-center/secrets/alipay-app-public-key.pem` | 上传到支付宝开放平台；服务器只用它检查密钥是否配对，运行时不读取 |
| 支付宝公钥 | `recharge-center/secrets/alipay-public-key.pem` | 服务端验证支付宝响应，必须从同一 AppID 的普通公钥配置中取得 |

### 已有密钥：直接复制粘贴到 Linux

已有正确的应用私钥、应用公钥和支付宝公钥时，跳过下一小节的生成步骤。不要重新生成或覆盖正在使用的密钥，否则它可能与开放平台当前配置不匹配。

以下操作在通过 SSH 登录的 Linux 服务器上完成，使用 Bash。`/你的路径/sub2api-extra` 替换成现有部署根目录；使用你有权限管理该目录的账号。先执行不含密钥的准备命令：

```bash
cd /你的路径/sub2api-extra
umask 077
mkdir -p recharge-center/secrets
chmod 700 recharge-center/secrets
```

使用编辑器粘贴密钥正文，避免把密钥写进 Shell 命令历史。以下以 `nano` 为例；也可以使用 `vi`。如果出现 `nano: command not found`，Ubuntu / Debian 可以执行 `sudo apt-get install nano` 后继续。

1. 打开应用私钥文件：

   ```bash
   nano recharge-center/secrets/alipay-app-private-key.pem
   ```

   在编辑器内粘贴完整的应用私钥。PKCS#8 私钥的文件结构如下，中文占位文字必须替换成你的实际 Base64 密钥正文：

   ```text
   -----BEGIN PRIVATE KEY-----
   此处粘贴应用私钥的完整Base64正文
   -----END PRIVATE KEY-----
   ```

   如果已有私钥带有 `-----BEGIN RSA PRIVATE KEY-----` / `-----END RSA PRIVATE KEY-----`，它是 PKCS#1 格式，保留原来的完整首尾标记即可，不要仅替换标记来假装转换格式。

2. 按 `Ctrl+O`，再按回车保存；按 `Ctrl+X` 退出。然后打开应用公钥文件：

   ```bash
   nano recharge-center/secrets/alipay-app-public-key.pem
   ```

   粘贴完整的应用公钥并以同样方式保存、退出：

   ```text
   -----BEGIN PUBLIC KEY-----
   此处粘贴应用公钥的完整Base64正文
   -----END PUBLIC KEY-----
   ```

3. 打开支付宝公钥文件：

   ```bash
   nano recharge-center/secrets/alipay-public-key.pem
   ```

   粘贴开放平台给出的完整支付宝公钥，再保存、退出：

   ```text
   -----BEGIN PUBLIC KEY-----
   此处粘贴支付宝公钥的完整Base64正文
   -----END PUBLIC KEY-----
   ```

   该文件的首尾标记与应用公钥一样，但正文不同；不能用应用公钥代替。

如果复制到的只有一长串 Base64、没有首尾标记，在编辑器中按上述格式补齐。应用私钥需先确认导出格式：PKCS#8 使用 `PRIVATE KEY`，PKCS#1 使用 `RSA PRIVATE KEY`；开放平台常见的两份公钥使用 `PUBLIC KEY`。不要把 JSON 字段名、引号、逗号、Markdown 代码围栏或字面量 `\n` 一起粘贴。正文可以保持一行，也可以按原有换行粘贴。`BEGIN CERTIFICATE` 是证书，不能直接当作本模式的公钥文件；`BEGIN ENCRYPTED PRIVATE KEY` 也不能直接供当前无人值守服务读取。

所有文件写好后设置权限，并只检查有效性与公开指纹，不打印私钥正文：

```bash
chmod 600 recharge-center/secrets/alipay-app-private-key.pem \
  recharge-center/secrets/alipay-app-public-key.pem \
  recharge-center/secrets/alipay-public-key.pem

openssl pkey -in recharge-center/secrets/alipay-app-private-key.pem -check -noout
openssl pkey -pubin -in recharge-center/secrets/alipay-app-public-key.pem -pubcheck -noout
openssl pkey -pubin -in recharge-center/secrets/alipay-public-key.pem -pubcheck -noout

set -o pipefail
openssl pkey -in recharge-center/secrets/alipay-app-private-key.pem -pubout -outform DER \
  | openssl dgst -sha256
openssl pkey -pubin -in recharge-center/secrets/alipay-app-public-key.pem -outform DER \
  | openssl dgst -sha256
```

前三条 OpenSSL 校验应成功；最后两条命令的 SHA-256 指纹必须完全一致，才说明应用私钥与应用公钥配对。支付宝公钥无需与它们相同。检查失败时先核对复制是否完整、私钥导出格式是否正确，不要继续启动服务。

如果开放平台已经配置了这一份应用公钥，无需重复上传；如果尚未配置，在当前 AppID 的“接口加签方式”中选择普通公钥 / RSA2，上传应用公钥，并使用该页面最新返回的支付宝公钥。能解析公钥文件只证明文件格式有效，实际响应验签成功还要按后面的上线验收确认。

### 没有密钥：生成新的密钥对

仅首次配置且没有可复用密钥时，在离线或受控主机生成 2048 位以上 RSA 私钥。不要对已有生产文件直接执行以下命令：

```bash
umask 077
mkdir -p recharge-center/secrets
openssl genpkey -algorithm RSA \
  -pkeyopt rsa_keygen_bits:2048 \
  -out recharge-center/secrets/alipay-app-private-key.pem
openssl pkey \
  -in recharge-center/secrets/alipay-app-private-key.pem \
  -pubout \
  -out recharge-center/secrets/alipay-app-public-key.pem
chmod 600 recharge-center/secrets/alipay-app-private-key.pem
chmod 600 recharge-center/secrets/alipay-app-public-key.pem
```

然后：

1. 在应用的“接口加签方式”选择普通公钥或 RSA2 公钥模式。
2. 上传 `alipay-app-public-key.pem` 的应用公钥。
3. 控制台会显示或下载“支付宝公钥”。将它保存为：

   ```text
   recharge-center/secrets/alipay-public-key.pem
   ```

4. 对该文件执行 `chmod 600`。

### Docker Compose 文件权限与配置

已有密钥和新生成密钥都要完成这一小节。以下命令在 Linux 服务器的 Bash 中执行。需要对应实际部署调整的是项目目录、Docker 命令前缀、容器用户和挂载路径；密钥内容不参与这些命令。

| 实际部署情况 | 如何调整 |
| --- | --- |
| 项目在 `/opt/sub2api-extra` | 执行 `cd /opt/sub2api-extra`；其他位置只替换为你的真实项目根目录 |
| SSH 以 root 登录，使用默认镜像 | 文件操作无需 `sudo`；容器仍以 `node` 运行，通常是 `1000:1000`，不能因为登录 root 就改成 `root:root` |
| 普通用户登录，可以直接使用 Docker | Docker 命令保持原样；文件归属和权限操作使用 `sudo` |
| 普通用户登录，只有 `sudo docker` 能访问当前 Docker 引擎 | 本小节的所有 Docker 查询和 Compose 命令都按相同方式加 `sudo` |
| 自定义镜像或 Compose 设置了 `user:` | 以下面实测的容器 UID/GID 为准；不要为读取密钥把充值服务改成 root |
| 更改了 `secrets` 的宿主机目录或容器挂载目标 | 文件操作针对实际宿主机目录；`.env` 填实际容器内路径；默认挂载不需要改 `.env` |
| Docker 启用了 rootless 或 `userns-remap` | 容器 UID 与宿主机 UID 不相同，不能直接套用下面的 `chown`；见本小节末尾的说明 |

**第一步：进入部署根目录并确认当前 Docker 引擎。**

```bash
cd /你的路径/sub2api-extra
docker context show
docker info --format '{{json .SecurityOptions}}'
```

如果你平时使用 `sudo docker compose` 部署，此处也使用 `sudo docker context show` 和 `sudo docker info`，后面的 Compose 命令同样加 `sudo`。保持原有 Docker 引擎、`--env-file`、`-f` 和项目名 `-p` 参数一致，不能查询一套引擎后去修改另一套部署的权限。输出包含 `rootless` 或 `userns` 时跳过下面的直接 `chown`，先处理用户映射。

**第二步：读取实际容器 UID/GID。** 已填写 `recharge-center/.env`、密钥文件已保存且镜像可用时，在同一个 Bash 会话执行：

```bash
recharge_container_owner=$(docker compose --env-file compose.services.env run --rm -T --no-deps \
  --entrypoint sh recharge-center -c 'printf "%s:%s\n" "$(id -u)" "$(id -g)"') &&
printf 'Container UID:GID = %s\n' "$recharge_container_owner"
```

默认镜像应输出 `Container UID:GID = 1000:1000`。自定义非 root 镜像可能输出 `1001:1001` 或其他数字，后面的命令会复用这个实测值。这个一次性容器只运行身份查询，不启动充值服务，不需要先通过支付宝接口查询或生产验收闸门。查询报错、没有取得值或 UID 为 `0` 时，先修正镜像 / Compose 配置，不要猜测数字继续操作。

**第三步：设置宿主机文件权限。** 以下适用于没有用户映射的常规 Linux Docker；同一 Bash 会话会自动选择 root 直接执行、普通用户使用 `sudo`，并在发现 rootless / 用户映射时停止修改。你平时使用 `sudo docker` 时，也要给下面的 `docker info` 加 `sudo`：

```bash
recharge_file_admin=()
if [ "$(id -u)" -ne 0 ]; then
  recharge_file_admin=(sudo)
fi

if [[ "$recharge_container_owner" =~ ^[1-9][0-9]*:[0-9]+$ ]] &&
  recharge_security_options=$(docker info --format '{{json .SecurityOptions}}') &&
  [[ "$recharge_security_options" != *rootless* && "$recharge_security_options" != *userns* ]]; then
  "${recharge_file_admin[@]}" chown -- "$recharge_container_owner" \
    recharge-center/secrets \
    recharge-center/secrets/alipay-app-private-key.pem \
    recharge-center/secrets/alipay-public-key.pem &&
  "${recharge_file_admin[@]}" chmod 700 recharge-center/secrets &&
  "${recharge_file_admin[@]}" chmod 600 \
    recharge-center/secrets/alipay-app-private-key.pem \
    recharge-center/secrets/alipay-public-key.pem &&
  "${recharge_file_admin[@]}" stat -c '%a %u:%g %n' \
    recharge-center/secrets \
    recharge-center/secrets/alipay-app-private-key.pem \
    recharge-center/secrets/alipay-public-key.pem
else
  printf 'UID:GID or Docker user mapping needs verification; no permissions changed.\n' >&2
fi
```

默认部署预期输出：

```text
700 1000:1000 recharge-center/secrets
600 1000:1000 recharge-center/secrets/alipay-app-private-key.pem
600 1000:1000 recharge-center/secrets/alipay-public-key.pem
```

运行时只需应用私钥和支付宝公钥，应用公钥文件可留作核验，继续保持 `600`。这些命令只调整列出的目录和两个文件，不递归修改项目。不要通过 `chmod 644` 或 `chmod 777` 解决读取失败；生产环境会拒绝组用户或其他用户可读的密钥文件。调整目录归属后，原 SSH 用户可能无法直接访问该目录，需要维护时使用受控的 `sudo` 编辑。

**第四步：确认挂载和 `.env` 中的容器路径。** 仓库 Compose 默认将服务器的 `recharge-center/secrets` 只读挂载为容器中的 `/run/secrets`。因此在 `recharge-center/.env` 中保持：

```dotenv
RECHARGE_CENTER_ALIPAY_APP_PRIVATE_KEY_PATH=/run/secrets/alipay-app-private-key.pem
RECHARGE_CENTER_ALIPAY_PUBLIC_KEY_PATH=/run/secrets/alipay-public-key.pem
```

无论项目放在 `/opt/sub2api-extra` 还是 `/root/sub2api-extra`，默认挂载下这两个 `.env` 值都不变。只有你自己把挂载目标从 `/run/secrets` 改到其他容器目录时，才需要同步改 `.env`。没有“应用公钥路径”配置项，因为应用公钥不参与本服务的运行。

**第五步：在容器内确认文件可读。** 不要只凭宿主机的 `ls` 判断成功：

```bash
docker compose --env-file compose.services.env run --rm -T --no-deps \
  --entrypoint sh recharge-center -c \
  'id; test -r /run/secrets/alipay-app-private-key.pem && test -r /run/secrets/alipay-public-key.pem && echo "key files readable"'
```

应看到与第二步一致的 UID/GID，以及 `key files readable`。该命令不启动充值服务、不输出密钥正文。没有出现后者或命令返回非零时，检查服务器文件是否存在、属主是否匹配容器用户、目录是否允许该用户进入；自定义挂载也要同步替换检查命令中的容器路径。

启用了 rootless / `userns-remap` 时，需要根据该容器用户命名空间的 `uid_map` / `gid_map` 得到对应宿主机 UID/GID，再设置宿主机属主；不能拿 SSH 用户的 `id`、第二步的容器内 `id` 或随意的 `1000:1000` 代替映射结果。此类部署先由维护该 Docker 引擎的管理员确认映射，再执行受限文件权限设置和第五步的真实读取检查。不要为修复密钥权限直接改成 `sudo docker`，rootless Docker 下这可能切换到另一套引擎。

权限和读取检查通过后再继续上线验收。已有容器更换密钥文件后，需要重新创建 `recharge-center` 容器，使运行中的服务重新读取文件；单独更新该服务即可。自定义容器 UID 还需要确认账本目录 `/app/data` 可写，不能只解决密钥读取就视为部署完成。

`alipay-app-private-key.pem` 是应用私钥，永远不能上传到支付宝、提交 Git、放进 `.env` 或发送给他人。`alipay-public-key.pem` 必须是控制台给出的支付宝公钥，不能误用你刚生成的应用公钥。服务启动时会拒绝小于 2048 位、类型错误、过大的文件；Linux 生产环境还会拒绝组用户或其他用户可读的密钥文件。

## 取得固定个人收钱码 URL

必须使用本人支付宝的通用收钱码，不要设置预设金额：

1. 支付宝打开“收钱”，展示或保存本人通用收钱码。
2. 使用可信二维码解码工具在本地解码图片，不要上传到陌生网站。
3. 结果必须是单独一行类似：

   ```text
   https://qr.alipay.com/fkx165xxxxxxxx
   ```

4. 不要把中文说明、Markdown 链接括号、空格、逗号或引号一起复制。
5. 用另一个支付宝账号扫码验证它进入正确的本人收款页，且付款页要求手动输入金额。

服务只接受 HTTPS、主机严格为 `qr.alipay.com`、路径以 `/fkx` 开头且没有查询参数、片段或 URL 凭据的地址。固定码只作为最终跳转目标，不会按订单改写。

## 最简配置

复制 `.env.minimal.example` 为 `recharge-center/.env`，填写空项和示例项：

```dotenv
NODE_ENV=production
RECHARGE_CENTER_PAYMENT_MODE=personal_accountlog_static
RECHARGE_CENTER_SECRET=<openssl rand -hex 48 的输出>
RECHARGE_CENTER_PUBLIC_URL=https://aihubpay.fo2.us.ci
RECHARGE_CENTER_TRUST_PROXY=true

RECHARGE_CENTER_ALIPAY_STATIC_QR_URL=https://qr.alipay.com/fkx165xxxxxxxx
RECHARGE_CENTER_ALIPAY_APP_ID=<开放平台数字AppID>
RECHARGE_CENTER_ALIPAY_APP_PRIVATE_KEY_PATH=/run/secrets/alipay-app-private-key.pem
RECHARGE_CENTER_ALIPAY_PUBLIC_KEY_PATH=/run/secrets/alipay-public-key.pem
RECHARGE_CENTER_AUTO_MODE_VERIFIED=false

SUB2API_BASE_URL=http://host.docker.internal:8080
SUB2API_PUBLIC_URL=https://你的Sub2API域名
SUB2API_ADMIN_API_KEY=admin-<64位小写十六进制>

RECHARGE_CENTER_ALERT_CHANNELS=email
RECHARGE_CENTER_SMTP_HOST=<邮箱服务商SMTP主机>
RECHARGE_CENTER_SMTP_USER=<SMTP账号>
RECHARGE_CENTER_SMTP_PASSWORD=<专用客户端授权码>
RECHARGE_CENTER_SMTP_FROM=<发件邮箱>
RECHARGE_CENTER_ALERT_EMAIL_TO=<运维收件邮箱>
```

SMTP 未写端口时默认 `587`，默认 `RECHARGE_CENTER_SMTP_SECURE=false` 且 `RECHARGE_CENTER_SMTP_REQUIRE_TLS=true`，即强制 STARTTLS。使用 465 时显式增加：

```dotenv
RECHARGE_CENTER_SMTP_PORT=465
RECHARGE_CENTER_SMTP_SECURE=true
RECHARGE_CENTER_SMTP_REQUIRE_TLS=true
```

可调参数及安全默认值：

```dotenv
RECHARGE_CENTER_ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
RECHARGE_CENTER_ACCOUNTLOG_POLL_SECONDS=15
RECHARGE_CENTER_ACCOUNTLOG_LOOKBACK_SECONDS=900
RECHARGE_CENTER_ACCOUNTLOG_STALE_SECONDS=60
RECHARGE_CENTER_ACCOUNTLOG_AMOUNT_QUARANTINE_SECONDS=900
RECHARGE_CENTER_ACCOUNTLOG_REQUEST_TIMEOUT_MS=10000
```

金额隔离不得短于回看窗口。订单三分钟过期后，该应付金额仍继续隔离，防止支付宝延迟返回的旧流水误匹配下一单。

取消后重建的金额规则：同一用户再次输入相同目标金额，只要旧单是无付款证据、无异常的已取消订单，就能复用自己原来的金额占位。例如没有其他用户占用 `1.00` 元时，连续取消重建都显示 `1.00` 元；其他用户占用 `1.00` 元、自己被分配 `1.01` 元时，取消重建仍可使用 `1.01` 元，不会不断累加。复用不增加全局占位数，原占位与新单之间的审计关联会保留。

复用时，旧订单仍是已取消状态，中转入口仍失效，并记录 `payment_match_until` 为取消时间。取消前已付但延迟出现的流水仍进入旧订单人工处理；取消所在秒无法区分的新旧候选一律转人工。新订单的付款必须位于新三分钟窗口并唯一匹配，不能把旧单证据搬到新单，也不能重放同一流水。

其他用户的已取消金额、已过期金额和已完成金额仍需等待隔离到期。固定收钱码无法撤销已经打开的支付宝付款页面，因此不能把“仅检查其他用户当前有效订单”作为唯一安全规则。不要调低隔离参数或删除占位来强制使用整数金额。此改动不需要新增环境变量；启动时账本自动升级到版本 9，保留历史订单、占位和流水，更新前应备份原账本。

服务会在本地账本中保存“固定收钱码 + AppID”的带密钥指纹。修改任一项时，只要仍有活动/人工处理订单或尚未到期的金额隔离，服务就拒绝启动，避免已保存的中转二维码跳到与轮询账户不一致的收款目标。需要换码或换 AppID 时，先关闭新订单，处理完异常订单，等待最长订单窗口与隔离期全部结束，再修改配置并启动；不要删除账本元数据绕过检查。

## Docker Compose 增量部署

根目录已有 `docker-compose.yml`、`compose.services.env` 和其他服务时，只新增/更新 `recharge-center`，不要修改供应商监控或运营中心代码：

```bash
cd /你的路径/sub2api-extra

# 先按“配置 RSA2 密钥”小节写好文件，并设置容器用户的归属与严格权限。

# 确认根 docker-compose.yml 已 include ./recharge-center/compose.yaml
# 在现有列表末尾增加 recharge-center，不要删掉原服务
sed -i 's/^COMPOSE_PROFILES=.*/&,recharge-center/' compose.services.env

docker compose --env-file compose.services.env config --services
docker compose --env-file compose.services.env pull recharge-center
docker compose --env-file compose.services.env up -d --no-deps recharge-center
docker compose --env-file compose.services.env logs --tail=100 recharge-center
```

如果 `COMPOSE_PROFILES` 已包含 `recharge-center`，不要重复添加。仓库 `recharge-center/compose.yaml` 已把 `./secrets` 只读挂载到 `/run/secrets`，并只把端口绑定到宿主机 `127.0.0.1:9874`。

## 反向代理注意事项

- 公网只开放 Nginx/Cloudflare，不能直接开放 `9874`。
- `/pay/<订单号>` 必须原样代理，不能缓存、改写或跳到其他主机。
- Nginx 访问日志应对 `/pay/` 路径关闭或脱敏，Cloudflare 日志和分析数据也应限制保留；本地审计已记录中转访问。
- Cloudflare 代理已开启（黄/橙云）时应使用 `Full (strict)` 和有效的源站证书。不要使用 Flexible；否则 Cloudflare 到源站之间是明文，违背自动充值的安全底线。源站防火墙只允许 Cloudflare 官方网段访问 443，并按 Cloudflare 当前官方网段配置 Nginx `set_real_ip_from` 与 `real_ip_header CF-Connecting-IP`，不要无条件信任公网传入的该请求头。
- `RECHARGE_CENTER_PUBLIC_URL` 必须与用户实际访问的 HTTPS 根域名完全一致。

示例位置块：

```nginx
location / {
    proxy_pass http://127.0.0.1:9874;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_request_buffering off;
}

location ^~ /pay/ {
    access_log off;
    proxy_pass http://127.0.0.1:9874;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_request_buffering off;
}
```

## 上线验收

首次真实联调使用受限 staging：`NODE_ENV=development`，同时显式设置 `RECHARGE_CENTER_COOKIE_SECURE=true`、`RECHARGE_CENTER_PASSWORD_LOGIN_ENABLED=false`、`RECHARGE_CENTER_TRUST_PROXY=true`，全程使用 HTTPS，并在 Nginx/Cloudflare 只允许测试 IP。生产环境在 `RECHARGE_CENTER_AUTO_MODE_VERIFIED=false` 时会拒绝启动，这是有意的上线闸门。

按顺序完成：

1. 启动后访问 `/readyz`，确认 `accountLog.healthy=true`。如果为 false，先看容器日志中的错误代码，不要创建订单。
2. 创建 `0.01` 或允许的最小金额订单，扫码后准确输入应付金额，在三分钟内付款。
3. 确认订单只完成一次，Sub2API 出现一条 `balance/used` 兑换记录，备注包含 `RC-...` 订单号和账务流水尾号。
4. 用两个不同用户创建相同目标金额订单，确认第二单显示唯一分角；分别付款且不串单。
5. 同一用户连续取消、重建同目标金额订单，确认复用自己的金额占位、全局占位数不增加、旧中转入口不能继续使用；其他用户取消的金额仍不能占用。
6. 测试取消前付款但流水延迟返回，以及取消所在秒的多候选流水，确认不自动入账而是转人工；在新单窗口内付款且唯一匹配时只充值一次。
7. 测试错金额、三分钟后付款、支出流水、重复 `account_log_id` 和同流水内容冲突，确认均不增加余额并收到脱敏邮件。
8. 临时使用错误支付宝公钥，确认 `/readyz` 变为 503 且不能创建新订单；恢复正确公钥后再测试。
9. 模拟 Sub2API 超时，确认订单进入 `needs_attention`，不会把未知结果报告为成功，也不会生成第二个兑换码。
10. 确认邮件没有完整账务流水号、对方账号、用户邮箱、密钥或完整备注。
11. 在运营中心成本分析中确认该已使用余额兑换记录按现有逻辑展示。

全部通过后再设置：

```dotenv
NODE_ENV=production
RECHARGE_CENTER_AUTO_MODE_VERIFIED=true
```

并重建单个服务：

```bash
docker compose --env-file compose.services.env up -d --no-deps --force-recreate recharge-center
curl -fsS https://你的充值域名/readyz
```

## 异常订单人工处理

- 只有账务流水已唯一关联到一个订单、但自动校验未全部通过时，系统才把该订单转为 `payment_reported` 并附加不可逆流水指纹。
- 管理员必须在支付宝官方账务明细中重新读取实收金额、付款时间和完整 `account_log_id`，在审核弹窗输入“账务流水号”并勾选独立核验；服务端会再次校验金额、原三分钟窗口和 HMAC 指纹。
- 同额多候选、找不到订单、已复用流水或无法安全附加证据时，不允许靠猜测把流水绑定给某个用户。应保留告警与审计，按正式余额调整/退款流程处理。
- Sub2API 请求结果不确定的订单进入 `needs_attention`，只能使用“恢复入账”复用原兑换码收敛，不能重新确认或创建第二条兑换记录。

## 无法消除的残余风险

该模式比抓浏览器页面或手机通知可靠，但仍不等同于支付宝官方订单支付：

- 固定个人码无法预填并锁定每单金额，也无法把充值订单号写入支付宝账单。
- 用户必须手动输入金额，输错后只能进入人工处理。
- 如果本人支付宝账户在同一三分钟窗口收到一笔外部、无关但金额完全相同的收入，账务接口无法证明它属于哪个充值用户，仍可能发生误归属。
- 金额隔离只能防止充值中心内部同额订单冲突，不能隔离账号上的外部收款。
- 接口权限、个人码可用范围和支付宝风控策略可能变化。

降低风险的必要措施是：使用专门收款账户、该账户不要同时接收其他个人转账、保持三分钟窗口和 100 笔硬上限、设置较低单笔上限、启用异常邮件并定期人工对账。对“绝不能误充”的业务，只能使用由服务端创建唯一支付宝订单并由官方订单查询/回调确认的 `sub2api_official` 模式。
