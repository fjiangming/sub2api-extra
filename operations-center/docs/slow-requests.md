# 慢请求监测与上游核对

实现日期：2026-10-20。入口：运营中心的“慢请求”Tab。本次代码包括页面、查询与核对服务、诊断存储、Go 插桩、Linux 采集器和 Nginx 配置样例；生产接入、构建和重启需由部署流程执行。

## 1. 页面与数据链路

```text
Sub2API PostgreSQL usage_logs / ops_error_logs --只读--> 运营中心
上游业务日志 --现有供应商同步--> Provider Monitor --按账号/Key 限定--> 运营中心
Sub2API 分段事件 --有界非阻塞队列--> /api/latency/ingest --> 本地诊断 SQLite
Linux /proc、Nginx JSON 日志 --独立主机采集器--> 同一采集入口
管理员 SSO/本地会话 --> 请求记录 / 实时阶段 / 资源历史 / 单请求诊断
```

“请求记录”支持日期、账号、用户、模型、推理档位、本地/上游请求 ID，以及普通首输出、高推理首输出、总耗时阈值。默认分别为 60、180、300 秒；达到阈值即标记。阈值仅用于查询，不会终止请求、修改并发或降低推理档位。日期按 `SUB2API_TIMEZONE`，包含起止日，单次最多 31 个自然日，且限定在用量日志保留期内。

概要、趋势和账号/模型/档位分布使用全部符合维度筛选的保留记录；“慢请求/全部/错误”只影响记录列表。首输出分位数只使用 `stream=true AND first_token_ms>0` 的样本，非流式与缺失值不填零。列表支持服务端分页、排序、本页 CSV 导出；详情支持诊断 JSON 导出。

用量记录不等于成功请求；失败或取消流也可能产生用量，错误表可能包含同一请求的重试。页面分别统计“用量/错误记录”，不把两表行数之比当作成功率。指标遵循运营中心现有规则排除用户 ID 1；历史明细被清理后无法恢复完整分布。缺少错误表或新增字段时提示当前可观测范围，不读取错误表中的正文、请求头或响应正文。

## 2. 上游关联与耗时差

Provider Monitor 必须先完成供应商日志同步和本地账号到上游 Key 的映射。运营中心复用既有服务地址、集成 Token 或当前管理员 SSO，不保存第二套供应商凭据。两个服务均需升级到包含新接口的版本。

1. 按阶段轨迹实际起止前后各 15 分钟查找该账号映射 Key 的上游样本；没有轨迹时，在本地记录时间两侧额外覆盖记录的总耗时，查询最长 48 小时、最多 2,000 条。历史映射按生效区间限定样本，当前映射回查未覆盖的历史时标记为未验证。接口只读取已同步的业务样本，不主动调用计费模型，也不强制刷新供应商。
2. 用 `upstream_request_id`、已有 `request_id` 或关联轨迹最后一次尝试的上游 ID 匹配上游 `request_id`。最后一次尝试必须属于同一账号、HTTP 2xx 且已完成；若最终尝试未结束/失败，不拿早先成功尝试替代。多条轨迹或错误记录不从尝试推断唯一 ID。只有唯一的请求 ID 关联且查询未截断时才标记“精确关联”。
3. 无共同 ID 时，使用模型、流式模式、输入/输出/两类缓存 Token 和时间窗口寻找候选。缺失 Token 不当作零；本地同一窗口出现重复指纹或上游有多个候选时保留歧义。指纹匹配始终需要核实，不自动进入确认对比。
4. 管理员可临时选择候选查看数值；页面持续标记“人工候选”，不写回原日志，不把它提升为已确认请求。
5. 同步状态、最后同步时间、截断标记和当前/历史映射来源随详情返回。当前映射回查历史时不能保证当时配置相同；上游日志过期、API 不支持、Key 未映射、请求仍未结束等情况都可能无结果。

显示本地与上游首输出、总耗时及首输出后时长；差值保留负数，缺失不填零。两项差值均约 118 秒且首输出后时长接近时，只提示额外等待可能集中在首输出前。上游计时起点及首输出口径没有统一，不能直接把差值称为网络耗时或判定责任。

该服务无法透视供应商内部排队/推理，无法证明用户实际渲染时间。跨机器时钟应同步；阶段间隔使用应用进程内单调时钟，资源和上游日志通过 UTC 绝对时刻关联。

## 3. 启用诊断采集

只使用历史查询与上游核对时无需开启采集。需要实时卡住请求和新请求分段时，配置独立采集 Token，至少 32 字符，与供应商集成 Token 分开：

```dotenv
# operations-center/.env
LATENCY_TELEMETRY_TOKEN=<独立随机Token>
LATENCY_TELEMETRY_DIRECTORY=/app/latency
LATENCY_TELEMETRY_MOUNT_PATH=/app/latency
LATENCY_TELEMETRY_MAX_MB=5120
LATENCY_TELEMETRY_MIN_FREE_MB=5120
```

建议先确认数据盘已挂载到 `/www`，为运营中心添加 bind mount：`/www/api-observability/telemetry:/app/latency`。配置 `MOUNT_PATH` 时，该目录必须位于与父目录不同的挂载设备，缺失挂载会停止采集；运行中检查设备是否变化，避免落回系统盘。只查询历史日志时不要求挂载诊断盘。

事件、索引、WAL、SHM 共用 5 GiB 预算，另外为 Nginx 轮转日志设置约 256 MiB 上限，保持整体约 6 GiB 的诊断预算余量；容器自身日志仍由 Compose 的轮转限制管理。SQLite 设置页数上限、WAL 检查点、每请求最多 128 个普通事件加一个结束事件、10 万轨迹/10 万代理摘要/20 万资源样本上限。每分钟按保留期淘汰，空间接近上限时提前淘汰最旧数据；保留天数不承诺一定有完整历史。低于 5 GiB 可用空间停止新写入，采集异常显示在实时页。

`/api/latency/ingest` 仅接受专用 Bearer Token，不接受管理员会话代替；管理查询只接受管理员会话，不接受采集 Token。事件使用严格字段白名单，未知字段直接拒绝。HTTP 正文上限 64 KiB，每批最多 64 个事件，每分钟采集请求上限 6,000 次。采集入口只应通过受控内部网络或 HTTPS 访问。

## 4. Sub2API Go 插桩

`integrations/sub2api/latencytrace` 是使用标准库的可测试包。接入工具适配本地核对过的 Sub2API `d2e319b2a17006122cd2d53d828c44a0bf21bd9b` 源码；修改点包括 Gin 入口、请求体元数据读取、实际并发等待函数，以及普通/TLS 指纹 HTTP 上游调用。工具默认只检查：

```powershell
node operations-center/integrations/sub2api/install.cjs E:\path\to\sub2api --check
node operations-center/integrations/sub2api/install.cjs E:\path\to\sub2api --apply
```

工具会在所有锚点和目标文件状态通过后写入 8 个文件（含两份测试）并运行 gofmt，拒绝覆盖已有本地改动或重复安装。部署时必须基于实际运行版本及其自定义改动合并；此前生产二进制存在 `vcs.modified=true`，不能直接用本地原版构建覆盖它。先保留当前二进制/镜像与启动配置，验证合并构建，再按维护窗口更新应用。

应用进程新增环境变量：

```dotenv
LATENCY_TELEMETRY_URL=http://operations-center:9872/api/latency/ingest
LATENCY_TELEMETRY_TOKEN=<同一个独立采集Token>
LATENCY_RESOURCE_HOST=gateway-01
```

未配置 URL 时插桩为空操作。启用后生成服务端根 ID 并由 `X-Request-ID` 返回；结束事件关联 Sub2API 用量表实际使用的 `client:<id>` / `local:<id>` 标识，每次 HTTP 尝试有独立 attemptId，并关联上游响应中的 `x-request-id` / `request-id`。自定义上游标识头仍需配置账号自身的 `upstream_request_id_header`，由用量表提供关联。采集请求体读取、前置处理起点/首次 HTTP 调用前的结束点、实际等待区间、请求改写完成、连接获取、DNS/TCP/TLS、请求写入完成、响应头首字节、完整 SSE、语义/可见内容、尝试结束和请求结束。工具不记录正文，只读取已有内存请求体的模型及 `reasoning.effort` / `reasoning_effort` 字段作为元数据；过长字段省略，避免整批事件被拒绝。

支持 OpenAI Responses、Chat Completions 和 Anthropic SSE 的常见文本/工具/推理增量；`response.created`、`in_progress` 和心跳不计为语义输出。SSE 单事件缓冲上限 32 KiB，超大或未识别事件不会臆造语义计时。HTTPtrace 回调并发安全，单请求事件数与 4,096 条导出队列均有上限；HTTP 导出由独立 goroutine 批量执行，2 秒超时、不重试，失败/溢出丢弃并计数，不阻塞业务。单请求丢弃数随结束事件返回，全局丢弃计数每 30 秒至多记录一次到应用日志。

复用连接没有新 DNS/TLS 事件，界面不填零；连接获取与其子阶段重叠不求和。`wrote_request` 不等于上游程序读完，Flush 返回不等于客户端已收到。首版没有浏览器/终端客户端计时、WebSocket 帧计时、供应商内部队列、非标准 SSE 解码或绕过共享 HTTP 上游实现的调用路径；这些阶段保留缺失，不能以成功调用接口代替计时证据。断连后轨迹仍保留已有事件；30 分钟未收到新事件的未结束轨迹标记“状态未确认”，不一直声称仍在运行。

## 5. Linux 资源与 Nginx

主机采集器运行在 Linux 宿主机，读取 `/proc`，不挂载 Docker socket，不重放客户请求。复制 `integrations/latency-collector.service.example` 作为 systemd 单元，在环境文件中配置：

```dotenv
LATENCY_TELEMETRY_URL=http://127.0.0.1:9872/api/latency/ingest
LATENCY_TELEMETRY_TOKEN=<同一个独立采集Token>
LATENCY_RESOURCE_HOST=gateway-01
LATENCY_RESOURCE_DISK_PATH=/www
LATENCY_RESOURCE_DISK=vdb
LATENCY_RESOURCE_INTERVAL_SECONDS=15
LATENCY_NGINX_LOG=/www/api-observability/nginx/latency.jsonl
```

Node.js 需 >=20.18.1，按实际设备修改 `vdb`；环境文件限制为运行用户可读。该单元使用 `RequiresMountsFor=/www`。采样 CPU 执行/steal/iowait、可用内存、swap、数据盘容量/inode/读写、网卡吞吐/丢包、TCP 重传。首次采样和计数器重置时速率为空，不填零。它不提供容器级 OOM/重启计数，也不能在宿主机自身卡死时继续记录；外部可用性探测仍需独立节点。

`integrations/nginx-latency.conf.example` 给出只包含白名单字段的 JSON 日志。把 `map`/`log_format` 放在 `http {}`，把 `access_log` 放在实际网关 `server {}`；先 `nginx -t`，再平滑重载。必须为日志配置时间与容量轮转，日志权限只给采集用户读取。采集器首次启动从文件末尾开始，轮转/截断后重置读取位置，内存发送队列上限 256、4 个并发发送、失败不重试，防止采集故障拖慢资源采样。进程重启或队列溢出会丢失未发送摘要，应用阶段数据由 Go 直接导出。

Nginx 的 upstream 是本机 Sub2API，其 `upstream_header_time` 不表示模型供应商处理时间。日志在请求结束后产生；卡住时的实时阶段依靠应用开始事件。多次代理尝试的逗号分隔计时、缺失值不强制转换成零。

## 6. API 与验收

管理员只读接口：`GET /api/latency/options`、`/requests`、`/requests/:source:id`（实际 ID 如 `usage:419966`，URL 编码冒号）、`/live`、`/resources`。资源查询最多 24 小时/2,000 个样本，按主机查询可避免多主机混淆；详情以轨迹起点对齐资源，无轨迹时扩大前后窗口而不假定日志时间必为请求开始。

验收用本地模拟上游与隔离 PostgreSQL/SQLite，不自动调用真实模型：

- 复现本地 139.499 / 150.748 秒、上游 21.610 / 32.940 秒；差额分别 117.889 / 117.808 秒，结论保留口径限制。
- 检查唯一 ID、重复 ID、重复指纹、缺失 Token、非流式空值、高推理阈值、管理员排除、错误 schema 降级、分页与过期范围。
- 验证初始 SSE 后等待、重试尝试、EOF/取消、并发回调、连接事件和导出不可用时的队列边界。
- 验证独立采集认证、重启恢复、事件去重/乱序、事件上限、保留期、低空间和数据盘异常。
- 桌面与手机检查筛选、分页、详情、候选对比、时间线、资源图、关闭后迟到响应、自动刷新与导出。

本地查看：`node operations-center/scripts/latency-preview.cjs`，使用隔离演示数据、仅监听回环地址，不连接真实 Sub2API 或供应商。完整生产接入完成后，下一次慢请求应能关联每次尝试、实际可观测等待区间和同时段资源；缺失上游内部或客户端证据时继续明确标记。

## 7. 本地验证记录

2026-10-20：运营中心全量 145 项、供应商监控全量 282 项通过，运营中心 `npm run check` 通过。Go 标准库插桩包测试通过；在基于上述 Sub2API commit 的隔离工作树中应用工具后，中间件、仓储、处理器及插桩包通过编译和定向测试，覆盖真实 Gin 入口、等待中上报、用量 ID 关联、重试、取消与 panic 恢复。原始 Sub2API 工作目录未修改。

Playwright 检查 1600×1000 与 390×844 视口，覆盖筛选/空结果、分页、上游精确与歧义对比、分段时间线、资源图、CSV/JSON、关闭后的迟到响应、自动刷新和退出停止轮询；无脚本或接口错误，页面无横向溢出，宽表在自身区域滚动。

当前本机 Docker daemon 未运行，未验证镜像构建；Go race 检查因缺少 CGO/C 编译器未运行。Linux 采集器的解析和差分逻辑已测，真实宿主机的 `/proc`、systemd、挂载及 Nginx 平滑重载仍需部署环境验收；未部署生产、发起付费模型调用或修改现有业务超时。
