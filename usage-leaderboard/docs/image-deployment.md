# 在现有 Sub2API Extra 项目中增量部署用量排行

适用于 Linux 服务器、Docker Compose 2.24+、已经部署其他子服务的 `sub2api-extra`。服务器只新增 `usage-leaderboard/compose.yaml` 和 `usage-leaderboard/.env`，再登记到现有根 Compose；使用已发布镜像，无需下载源码或安装 Node.js。

镜像为 `ghcr.io/fjiangming/sub2api-extra:usage-leaderboard-latest`。2026-10-13 已核验该标签可匿名读取，支持 `linux/amd64` 和 `linux/arm64`；镜像标注的源码版本 `d31322c7c60d1699c99126362ba3f61d9e5c1168` 已包含注册邮箱脱敏和移除金额展示、排序。

## 历史网络问题与本次配置

当前工程的历史会话《规划独立统计清理服务》记录了以下情况：

| 历史情况 | 原因 | 用量排行采用的配置 |
| --- | --- | --- |
| 运营中心无法通过 `host.docker.internal:8080` 验证登录，改用主站公开 HTTPS 地址 | 容器无法通过宿主机网关访问那个地址 | `SUB2API_BASE_URL` 使用容器可达的主站 HTTPS 根地址，并检查认证接口 |
| PostgreSQL 报 `ECONNREFUSED 172.17.0.1:5432` | 数据库仅在 Docker 网络内提供服务，宿主机网关没有监听 5432 | 永久加入数据库所在网络，连接 `sub2api-postgres:5432` |
| 临时 `docker network connect` 后验证成功 | 手动增加的网络连接不属于 Compose 声明 | 在 Compose 中声明外部网络，后续重建仍保留 |
| 在 `operations-center` 子目录重建，提示同名容器已存在 | 启动命令使用了另一个 Compose 项目 | 始终在现有 `sub2api-extra` 根目录执行，沿用原项目名 |

当时用户执行 `docker inspect` 后确认的数据库容器是 **`sub2api-postgres`**，网络是 **`sub2api-deploy_sub2api-network`**，改用这个容器名后连接验证成功。下面以这组配置为主流程；先检查服务器目前是否仍使用它们。

成本分析相关历史记录还说明了 `provider-monitor` 服务名只在共享网络内可达。用量排行不调用供应商监控，因此无需配置 `PROVIDER_MONITOR_BASE_URL` 或共享集成 Token。

本服务需要两条连接：排行容器到主站 `/api/v1/auth/me` 的 HTTP(S) 连接，以及排行容器到现有 PostgreSQL 的只读连接。`SUB2API_PUBLIC_URL` 用于浏览器主站地址和 iframe 允许来源；**用量排行没有运营中心的公开地址自动回退机制**，必须把 `SUB2API_BASE_URL` 配成实际可达的地址。

## 1. 找到原部署目录，确认网络

先检查运营中心所属的 Compose 项目和目录，不输出凭据：

```bash
docker inspect sub2api-operations-center --format '项目={{index .Config.Labels "com.docker.compose.project"}} 目录={{index .Config.Labels "com.docker.compose.project.working_dir"}}'
```

进入返回的现有 `sub2api-extra` 根目录。下面以 `~/sub2api-extra` 为例，实际路径不同时替换：

```bash
cd ~/sub2api-extra
docker compose version
docker inspect sub2api-postgres --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
docker network inspect sub2api-deploy_sub2api-network --format '{{.Name}}'
mkdir -p usage-leaderboard
```

应看到 `sub2api-deploy_sub2api-network`。若数据库实际网络名已变化，把第 3 步 Compose 中的 `name` 改为现在查到的名称，再继续。不要创建一个同名空网络来代替主站实际所在的网络。

沿用已有根 Compose 的项目名和覆盖文件。下文命令假设原项目由 `docker-compose.yml`、`compose.services.env` 管理；如果原部署使用 `-p` 或额外 `-f` 参数，后面的每条 Compose 命令都保留相同参数。不要进入 `usage-leaderboard` 子目录单独启动。

最终目录增加：

```text
sub2api-extra/
  docker-compose.yml
  compose.services.env
  ...原有子服务目录...
  usage-leaderboard/
    compose.yaml
    .env
```

## 2. 准备数据库只读账号

如果手中已有运营中心的有效只读连接凭据，可直接复用，无需创建账号。账号需具备 `public.users` 和 `public.usage_logs` 的必要字段读取权限。运营中心在网页初始化后加密保存的密码不一定在 `.env` 中；不要为找回密码重新初始化运营中心或重置它正在使用的账号。

运营中心可以使用 `.env` 中的高级连接配置，也可以使用页面初始化后保存的加密连接配置。默认只读角色名是 `sub2api_ops_read`，但密码由系统随机生成；页面里填写的 PostgreSQL 管理员密码不属于这个只读角色。不要把主站管理员账号、`SUB2API_MAINTENANCE_DATABASE_URL` 或清理角色用于排行。

在服务器 `sub2api-extra` 根目录执行以下命令，从运营中心读取生效的只读配置。命令不修改运营中心配置、不重置角色密码，并将结果写入权限受限的参考文件，不在终端打印凭据：

```bash
mkdir -p usage-leaderboard
umask 077
docker exec -i -w /app sub2api-operations-center node <<'NODE' > usage-leaderboard/.env.database-reference
const fs = require('node:fs');
const { RuntimeSettingsStore } = require('./src/runtime-settings-store');
const { loadConfig, resolveDataDir } = require('./src/config');
(async () => {
  const store = new RuntimeSettingsStore(resolveDataDir());
  let settings = {};
  if (fs.existsSync(store.settingsPath)) {
    store.key = Buffer.from(fs.readFileSync(store.keyPath, 'utf8').trim(), 'base64url');
    settings = await store.readEncrypted();
  }
  const config = loadConfig(process.env, settings);
  if (!config.databaseUrl) throw new Error('DATABASE_NOT_CONFIGURED');
  const url = new URL(config.databaseUrl);
  if (url.search || url.hash) throw new Error('DATABASE_URL_PARAMETERS');
  console.log("SUB2API_DATABASE_URL='" + url.href.replaceAll("'", '%27') + "'");
  console.log('SUB2API_DATABASE_SSL=' + config.databaseSsl);
  console.log('SUB2API_TIMEZONE=' + config.sub2apiTimezone);
})().catch(() => { console.error('无法读取可复用的只读配置'); process.exitCode = 1; });
NODE
chmod 600 usage-leaderboard/.env.database-reference
```

在服务器上用编辑器查看参考文件，将其中 `SUB2API_DATABASE_URL`、`SUB2API_DATABASE_SSL` 和 `SUB2API_TIMEZONE` 三行用于第 4 步的排行 `.env`，其余排行配置按第 4 步保留。参考文件包含数据库密码，不发送到聊天中。若运营中心容器名称已自定义，将命令中的名称替换为实际名称。

```bash
nano usage-leaderboard/.env.database-reference
nano usage-leaderboard/.env
```

导出的 URL 使用实际只读账号和已经 URL 编码的密码，无需自行拼接或再次编码密码。历史已验证的数据库主机是 `sub2api-postgres:5432`；如现有 URL 主机已经改为其他有效地址，按实际网络核实其可达性。用量排行仍需加入对应数据库网络，它不会自动共享运营中心的网络连接。配置完成后可以删除这个参考文件；它不是数据库，不产生持续累积的数据。


没有可用只读凭据时，在主站的现有数据库中新建独立读取角色即可，不创建数据库、业务表或数据卷。先进入 PostgreSQL：

```bash
docker exec -it sub2api-postgres sh -lc 'exec psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-sub2api}" -d "${POSTGRES_DB:-${POSTGRES_USER:-sub2api}}"'
```

在 `psql` 内查看当前库名：

```sql
SELECT current_database();
```

先创建角色：

```sql
CREATE ROLE sub2api_leaderboard LOGIN;
```

单独执行下面的命令，按提示输入两遍密码；完成后再执行授权，不把后续 SQL 一起粘贴到密码提示中：

```text
\password sub2api_leaderboard
```

`\password` 不回显密码。使用密码管理器生成随机密码；只使用随机字母和数字时，后面无需额外 URL 编码。若该角色已经存在且用途不明，选择新的角色名，并同步修改授权和连接串，不修改现有服务账号。

接着授权。以下假设库名是 `sub2api`，若不同，替换 `GRANT CONNECT` 中的库名：

```sql
GRANT CONNECT ON DATABASE sub2api TO sub2api_leaderboard;
GRANT USAGE ON SCHEMA public TO sub2api_leaderboard;
GRANT SELECT (id, email, role, status, deleted_at)
  ON public.users TO sub2api_leaderboard;
GRANT SELECT (user_id, created_at, model, input_tokens, output_tokens,
  cache_creation_tokens, cache_read_tokens)
  ON public.usage_logs TO sub2api_leaderboard;
ALTER ROLE sub2api_leaderboard SET default_transaction_read_only = on;
```

仍在 `psql` 中执行下面的条件授权；有 `requested_model` 字段时读取它，没有时服务使用 `model`：

```sql
SELECT 'GRANT SELECT (requested_model) ON public.usage_logs TO sub2api_leaderboard;'
WHERE EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'usage_logs'
    AND column_name = 'requested_model'
) \gexec
\q
```

复用已知只读账号时跳过 `CREATE ROLE`、`\password`，必要时仅补充上面的授权并使用实际角色名。完整邮箱只在服务端读取、脱敏，不发给浏览器；不需要费用、密码或 API Key 字段的权限。

## 3. 创建纯镜像 Compose 文件

```bash
nano usage-leaderboard/compose.yaml
```

写入以下完整配置：

```yaml
services:
  usage-leaderboard:
    profiles: [usage-leaderboard]
    image: ghcr.io/fjiangming/sub2api-extra:usage-leaderboard-latest
    container_name: sub2api-usage-leaderboard
    restart: unless-stopped
    ports: ["127.0.0.1:9876:9876"]
    env_file: ./.env
    environment:
      NODE_ENV: production
      USAGE_LEADERBOARD_BIND_HOST: "0.0.0.0"
      USAGE_LEADERBOARD_PORT: "9876"
    networks: [default, usage_leaderboard_database]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:9876/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    read_only: true
    tmpfs: ["/tmp:size=16m,mode=1777"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    pids_limit: 64
    mem_limit: 192m
    cpus: 0.5
    logging:
      driver: json-file
      options: {max-size: "5m", max-file: "3"}

networks:
  usage_leaderboard_database:
    external: true
    name: sub2api-deploy_sub2api-network
```

在 nano 中按 `Ctrl+O`、回车、`Ctrl+X` 完成编辑。这里的 `.env` 相对子服务目录解析，即 `usage-leaderboard/.env`。模板与仓库中的 [deploy/compose.yaml](../deploy/compose.yaml) 相同，服务器文件放在子服务目录直接使用，不再套一层 `deploy` 目录。

`external: true` 使用已存在的主站网络；此配置不创建或重建主站网络。`usage_leaderboard_database` 是排行专用的 Compose 网络配置键，避免与其他子服务的外部网络定义重名；`default` 保留排行在 Extra 项目内部的连接能力。

这是纯镜像配置，没有 `build`。服务内存上限 192 MB、CPU 0.5、Docker 日志最多 5 MB x 3，没有业务数据卷；缓存和会话只存在于有上限的内存中。

端口 9876 已占用时，只改宿主端口，例如 `127.0.0.1:19876:9876`；容器内部端口保持 9876，后面宿主机检查和反代相应改为 19876。

## 4. 创建环境配置

```bash
nano usage-leaderboard/.env
```

写入以下内容，再替换主站域名、只读账号密码和实际数据库名：

```dotenv
SUB2API_BASE_URL=https://api.example.com
SUB2API_PUBLIC_URL=https://api.example.com
SUB2API_DATABASE_URL=postgresql://sub2api_leaderboard:REPLACE_WITH_PASSWORD@sub2api-postgres:5432/sub2api
SUB2API_DATABASE_SSL=disable
SUB2API_TIMEZONE=Asia/Shanghai
SUB2API_REQUEST_TIMEOUT_MS=10000

USAGE_LEADERBOARD_TRUST_PROXY=true
USAGE_LEADERBOARD_COOKIE_SECURE=true
SUB2API_FORWARD_CLIENT_FINGERPRINT=false

USAGE_LEADERBOARD_DATABASE_CONNECTIONS=3
USAGE_LEADERBOARD_QUERY_TIMEOUT_MS=15000
USAGE_LEADERBOARD_CACHE_SECONDS=60
USAGE_LEADERBOARD_PERSONAL_CACHE_ENTRIES=256
USAGE_LEADERBOARD_MAX_SESSIONS=1000
USAGE_LEADERBOARD_SESSION_MINUTES=30
USAGE_LEADERBOARD_INCLUDE_ADMINS=false
```

完成编辑后执行：

```bash
chmod 600 usage-leaderboard/.env
```

- 两个 URL 都填 **Sub2API 主站** 根地址，不是排行域名，不带 `/api`、`/admin` 等路径。历史曾使用公开 HTTPS 地址解决运营中心连接问题；填写现在实际使用的主站地址。
- 数据库主机用 `sub2api-postgres`，不使用此前失败的 `host.docker.internal:5432`。填写第 2 步准备的只读角色密码，不把 `POSTGRES_PASSWORD` 当成这个角色的密码。
- 密码有 `@`、`#`、`/`、`$`、`%` 等特殊字符时，先对密码部分 URL 编码；可以用单引号包住整个连接串避免 Compose 插值。连接串不接受 `?sslmode=...` 等查询参数。
- `SUB2API_DATABASE_SSL=disable` 适用于这个未启用 SSL 的 Docker 内部 PostgreSQL；若实际服务器启用了 SSL，按证书配置使用 `verify-full`。
- `TRUST_PROXY=true` 适用于第 8 步中覆盖转发头的单层可信反代；直接访问 Node 时设为 `false`。主站启用会话绑定时，按[会话绑定说明](../README.md#添加到主站菜单)配置可信来源和客户端指纹转发，不直接跳过主站校验。

## 5. 登记到已有根 Compose

仍在 `sub2api-extra` 根目录执行：

```bash
nano docker-compose.yml
```

保留原有 `name`、`include` 和其他配置，只在现有 `include` 列表末尾追加：

```yaml
  - ./usage-leaderboard/compose.yaml
```

若这行已存在，不重复添加。然后编辑现有服务列表：

```bash
nano compose.services.env
```

在原 `COMPOSE_PROFILES` 末尾追加 `,usage-leaderboard`，例如：

```dotenv
COMPOSE_PROFILES=account-manager,provider-monitor,operations-center,usage-leaderboard
```

前面的旧服务只是例子，保留你服务器当前启用的完整列表。后面命令仍显式传 `--profile usage-leaderboard`，可以精确操作这个新服务。

## 6. 校验、拉取镜像、仅启动排行

所有命令从现有 `sub2api-extra` 根目录运行，沿用第 1 步确认的 Compose 项目身份：

```bash
docker compose --env-file compose.services.env --profile usage-leaderboard config --quiet
docker compose --env-file compose.services.env --profile usage-leaderboard pull usage-leaderboard
docker compose --env-file compose.services.env --profile usage-leaderboard up -d --no-build --no-deps --pull never usage-leaderboard
```

`config --quiet` 成功时不输出内容，也不将环境凭据打印到终端；它检查配置格式，不验证实际网络或数据库是否可达。`pull` 只下载排行镜像；最后一条只创建或更新排行容器，保留其他服务。这里不用全量 `down`、`up` 或 `--remove-orphans`。

服务器访问 GHCR 的出站网络与 Docker 容器共享网络是两件事。若 `pull` 阶段报 `ghcr.io` DNS、超时或 TLS 错误，应检查宿主机/Docker daemon 的出站网络；加入主站外部网络不能解决镜像下载故障。

## 7. 分别验证进程、数据库、主站 API

### 进程和数据库

```bash
docker compose --env-file compose.services.env --profile usage-leaderboard ps usage-leaderboard
docker compose --env-file compose.services.env --profile usage-leaderboard logs --tail 50 usage-leaderboard
docker inspect sub2api-usage-leaderboard --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
curl -fsS http://127.0.0.1:9876/healthz
curl -fsS http://127.0.0.1:9876/readyz
```

网络列表必须包含 `sub2api-deploy_sub2api-network`。`healthz` 返回 `{"status":"ok"}` 表示进程存活；`readyz` 返回 `{"status":"ready"}` 表示数据库连接和必需字段检查通过。Docker 的 `healthy` 同样只表示进程检查成功，**不能代替数据库检查或登录验证**。

若 `readyz` 返回 503，使用下列命令进一步检查真实数据库连接和列权限。它只运行零行只读查询，不输出连接串、密码或用户数据：

```bash
docker exec -i sub2api-usage-leaderboard node <<'NODE'
const { Client } = require('pg');
const { loadConfig } = require('./src/config');
const config = loadConfig();
const client = new Client({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl === 'disable' ? false : { rejectUnauthorized: config.databaseSsl === 'verify-full' },
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  options: '-c default_transaction_read_only=on'
});
(async () => {
  try {
    await client.connect();
    await client.query('SELECT id, email, role, status, deleted_at FROM public.users LIMIT 0');
    await client.query('SELECT user_id, created_at, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens FROM public.usage_logs LIMIT 0');
    console.log('DATABASE_OK');
  } catch (error) {
    console.error('DATABASE_ERROR', error.code || error.name);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
NODE
```

### 主站认证接口

即使 `readyz` 成功，仍要检查排行容器能否访问主站。本命令不携带登录 Token：

```bash
docker exec -i sub2api-usage-leaderboard node <<'NODE'
(async () => {
  try {
    const url = new URL('/api/v1/auth/me', process.env.SUB2API_BASE_URL);
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });
    let json = false;
    try { json = typeof await response.json() === 'object'; } catch {}
    console.log('AUTH_HTTP', response.status, json ? 'JSON' : 'NON_JSON');
    if (response.status !== 401 || !json) process.exitCode = 1;
  } catch (error) {
    console.error('AUTH_NETWORK_ERROR', error.cause?.code || error.code || error.name);
    process.exitCode = 1;
  }
})();
NODE
```

通常应返回 `AUTH_HTTP 401 JSON`：无 Token 被主站拒绝是预期结果，说明网络和该接口已通。它不证明真实登录 Token 可用，最后仍需从主站菜单打开验证。重定向、HTML 页面、403 或超时需要继续检查地址、代理和访问规则。

如果公开 HTTPS 地址从容器不可达，而主站应用也在同一个共享网络中，可以改走内部地址。先确认实际主站应用容器和网络：

```bash
docker inspect sub2api --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

确认主站容器确实叫 `sub2api`、内部监听 8080，且网络包含 `sub2api-deploy_sub2api-network` 时，将 `.env` 的第一项改为：

```dotenv
SUB2API_BASE_URL=http://sub2api:8080
```

`SUB2API_PUBLIC_URL` 继续保留浏览器可访问的主站 HTTPS 地址。运行第 6 步的 `up` 命令加载新配置，然后重新验证认证接口；使用当前实际容器名和内部端口，不猜测宿主机映射端口。

## 8. 配置排行 HTTPS 域名和用户菜单

例如主站是 `https://api.example.com`，排行使用 `https://rank.example.com`。将排行域名解析到服务器，在现有宿主机 Nginx、宝塔或其他反代中设置 HTTPS。在已有域名和证书的 Nginx `server` 块中添加：

```nginx
location / {
    proxy_pass http://127.0.0.1:9876;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 65s;
    proxy_cache off;
    access_log off;
}
```

修改宿主机 Nginx 后先检查，再重新加载：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

反代目标是本机 9876，页面提供在独立域名的根路径 `/`，不挂 `/rank/` 子路径。保留 Authorization 请求头，不缓存 `/api/`。主站菜单会向首次页面 URL 添加短期 Token，以上配置关闭访问日志；其他 CDN/网关日志也应排除查询参数。

如果反代自身也在 Docker 内，`127.0.0.1` 指向反代容器，不能照用宿主机地址。让反代和排行共享实际已有网络，目标改为 `http://usage-leaderboard:9876`；反代网络也要写入它自己的 Compose，单次 `network connect` 不是永久配置。若反代位于宿主机，当前主流程已经满足要求。

在 Sub2API 管理后台的自定义菜单中新增：

| 项目 | 值 |
| --- | --- |
| 名称 | 用量排行 |
| 地址 | `https://rank.example.com/`，替换为实际排行域名 |
| 可见范围 | 普通用户 |
| 打开方式 | iframe |

菜单 URL 不手填 Token、管理员 API Key 或用户 ID；主站会自动传入当前用户登录信息。确认 `SUB2API_PUBLIC_URL` 与用户实际打开的主站来源一致，并让排行反代允许该主站嵌入；不要在排行响应上添加与 iframe 冲突的 `X-Frame-Options: DENY/SAMEORIGIN` 或更严格的 `frame-ancestors`。

最后从普通用户账号打开菜单，确认 Top 10、个人用量和趋势正常，名称显示脱敏注册邮箱，排序仅有 Token 和调用次数，没有消费金额。直接访问排行域名而没有会话时提示登录是正常行为。

## 9. 后续更新和排查

更新镜像仍在现有 `sub2api-extra` 根目录执行：

```bash
docker compose --env-file compose.services.env --profile usage-leaderboard pull usage-leaderboard
docker compose --env-file compose.services.env --profile usage-leaderboard up -d --no-build --no-deps --pull never usage-leaderboard
```

只修改排行 `.env` 或 Compose 时，执行第二条即可，Compose 会应用配置并重建该服务。`restart` 不加载新环境变量。外部网络已声明在 Compose 中，更新后无需手动重新连接。重启会清空内存缓存和会话，用户重新从主站菜单进入即可；不会另外积累业务数据文件。

| 错误或现象 | 检查与处理 |
| --- | --- |
| `network ... declared as external, but could not be found` | 查 PostgreSQL 实际网络并修正 `name`；不要创建空网络代替 |
| 数据库 `ENOTFOUND` / `EAI_AGAIN` | 检查排行是否加入数据库网络、容器名及 Docker DNS |
| 数据库 `ECONNREFUSED` | 检查数据库容器状态、内部端口；历史的宿主机网关 5432 路径不可用 |
| 数据库 `28P01` | 只读账号密码错误；不要混用管理员密码，也不要重置运营中心账号 |
| 数据库 `42501` 或 `SCHEMA_INCOMPATIBLE` | 检查两张表的列权限，尤其 `users.email`；后者也可能是真实字段或类型不兼容 |
| `DATABASE_OK` 但 `readyz` 仍失败 | 检查必需字段类型；`created_at` 必须为带时区时间戳 |
| `AUTH_NETWORK_ERROR` | 从容器检查主站 HTTPS 地址；满足共享网络条件时使用实际主站容器名 |
| 认证返回 HTML、重定向或 403 | 确认是主站根地址，检查反代、CDN 或主站访问规则 |
| `SESSION_BINDING_MISMATCH` | 按模块 README 配置可信代理及真实客户端 IP/UA 转发 |
| 同名容器 `already in use` | 回到原根目录并使用原 Compose 项目名，不直接删除其他项目的容器 |
| `healthy` 但榜单不能使用 | 继续验证 `readyz`、认证接口和普通用户菜单；进程健康不等于全链路可用 |

本手册和镜像 Compose 已在本地做静态检查。历史网络名来自当时的服务器输出；当前服务器的实际网络、数据库授权和登录联通仍以第 1、7、8 步现场验证为准。
