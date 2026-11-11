# 个性化功能维护台账

## 2026-11-11：恢复只在检测子服务内兼容原版主站

用户明确要求撤销 `sub2api` 相关源码修改，仅在 `sub2api-extra` 兼容。本轮移除先前的跨服务恢复协议，主站通过新的回退提交恢复到 `f503f1e2f` 之前的 backend 源码；本仓库保留流中断识别、有限补测、未知结果冷却及原检测要求。两个既有远端分支分别提交回退和兼容修复，保留所有其他任务差异，不连接或部署服务器。

- `degradation-detector/src/detection-runner.js`：删除专用恢复头、标记收集及应用状态；Responses 每次独立检测使用随机 `session-id`，明确建连失败 / 可重试的 HTTP 429 / 503 短重连保持该标识，仅实际自动补测更换会话，避免正文相同导致长期粘在旧会话。使用主站原有调度接口，正文 / 模型 / 提示词 / 推理强度 / 输出上限和原次数 / 期限 / 取消保护保持，不查询或指定内部账号、不跨组取 Key。
- `src/sub2api-client.js`：移除恢复标记解析和 `onResponse` 协议钩子，继续识别 HTTP/2、流读取及提前结束错误；对结果未知的故障保持至少 30 秒冷却、至多一次补测，HTTP 503 包装同样遵守，不进入五次短重连。
- `src/store.js`：撤下 `route_recovery` 白名单字段，不再记录无法验证的已换线状态；既有 SQLite 结构不变，不持久化随机会话标识。
- `tests/detection-recovery.test.js`：将专用协议测试替换为无主站扩展的原生会话兼容验证，覆盖连续补测会话更新、混合短重连身份稳定、独立检测不复用会话、其他协议保持、旧恢复头被忽略、SQLite 重开脱敏及真实 loopback HTTP 粘性会话重新调度 / 残片隔离。
- `degradation-detector/README.md`：改为仅升级检测子服务，无需主站源码或专用恢复协议；说明更换会话仍可能选中同一账号、网关忽略会话头时仍有限补测，以及供应商流时长限制仍需要健康长流线路。

验证：检测端完整 **178 项测试全部通过**（含 22 项恢复专项），**57 个 JavaScript 文件**语法检查通过；主站恢复后原有 handler 整包回归及 6 项既有会话头契约测试通过，backend 与回退前基线 `6f8c5c205efee1886e6713aa6db1a58e333ba89d` 的完整 Git diff 为空。范围内 diff --check 通过。全部使用临时 SQLite、模拟供应商及 loopback HTTP，不调用收费模型或生产数据；没有部署，不宣称保证成功或已经换到其他账号。推送前只暂存本节、下节历史方案失效说明及本轮检测端差异；其余图标 / 画布 / 多域名和维护记录继续保留本地，GitHub Actions 结果以本次提交 SHA 为准。

## 2026-11-11：修复流中断补测遗漏并配合同组线路避让

本节记录先前已推送方案，现已由上节“仅检测子服务兼容”替换；下述主站钩子和双服务升级要求不再适用于当前实现。

用户根据生产只读排查结论要求修复两组检测异常。本轮修改本仓库降智检测及相邻 `fjiangming/sub2api` 的 `dev` 分支运输钩子；分别在两仓库维护台账登记，保留供应商通知 / 充值 / 多域名等其他任务差异。保持原模型、题目、推理强度和输出上限，沿用原鉴权、分组授权、调度及计费契约；不操作生产配置 / 数据、不部署、不执行真实收费检测。

- `degradation-detector/src/sub2api-client.js`：补齐 `upstream_http2_stream_error`、`upstream_stream_read_error`、`upstream_stream_truncated` 及对应标准消息 / Node HTTP2 运输错误，明确为结果未知的可恢复错误；HTTP 503 包含这些错误时不再进入 5 次短重连。永久错误优先拒绝，HTTP 状态及 Retry-After 规则保持。SSE 请求读取并严格校验主站随机恢复标记和应用状态，供本次任务内部使用。
- `src/detection-runner.js`：SSE / JSON 故障统一应用未知结果至少冷却 30 秒、最多补测 1 次且计入原总上限 / 总时限的限制。Responses 请求启用主站恢复关联，后续补测携带已有失败标记，保持请求正文不变，失败片段不拼接；记录协议支持 / 避让应用状态，不持久化或打印标记。
- `src/store.js`：既有 `request_attempts_json` / 结果 API 白名单增加 `route_recovery` 枚举，无新表、迁移或必填配置，不保存上游账号 ID、请求正文、明文 Key 或恢复标记。
- `tests/detection-recovery.test.js`：覆盖生产两种 SSE 错误格式、HTTP 200 / 500 / 502 / 503 错误体、未知结果次数 / 冷却、原参数及残片隔离、恢复标记逐次累积 / 校验、旧主站与未命中提示、永久错误、SQLite 重开后的脱敏状态；新增真实 loopback HTTP 标记交换、断流补测、完成不等 EOF 验证。
- `degradation-detector/README.md`：说明新错误分类、四个恢复协议头、双服务升级要求，以及旧版 / 多实例 / 主站重启 / 缓存淘汰到期 / 同组无备用线路的边界。配套主站实现和验证详见其 `CUSTOMIZATIONS.md` 同日章节，不将上游固定时限问题表述为检测端延长超时即可解决。

验证：降智检测完整 **176 项测试全部通过**（原 170 项和新增 6 项），**57 个 JavaScript 文件**语法检查及范围内 diff --check 通过。配套主站 `go test -tags unit ./internal/handler -count=1` 整包回归、6 个新增测试及 `go vet -tags unit ./internal/handler` 通过。主站测试还复现并修正“读到终止错误后立即关闭连接，失败关联因取消分支提前返回而丢失”的竞态；验证备用账号也失败时不会重新访问已排除账号。全部使用隔离 SQLite、模拟传输和 loopback HTTP / 本地网关夹具，未访问收费模型，没有生产复测、Linux 镜像构建、提交 / 推送或部署，不能宣称线上已恢复；线路避让需同时更新两服务。

用户随后明确要求提交 GitHub。本次仅将本节修复、下节生产只读排查记录、配套测试及恢复协议说明提交并推送既有 `origin/main`，主站运输钩子同步提交至 `fjiangming/sub2api` 的 `dev` 分支；其他图标、画布、多域名及维护记录差异保留本地。沿用上述已通过的验证，推送前核对远端和暂存范围并执行 diff --check；既有 GitHub Actions 的测试、构建及发布结果以本次提交 SHA 为准。本次不连接或部署服务器，线路避让需同时更新两服务。

## 2026-11-11：降智检测两组流式失败的生产只读排查

用户反馈“GPT不降智”仍出现最大流时长超限并已补测 2 次、“GPT Pro号池”出现 HTTP/2 流失败，授权连接服务器排查。本轮只读核对运行版本、容器健康、脱敏日志、SQLite 检测记录与 PostgreSQL 错误 / 用量记录；仅在本地本节登记结果，保留其他任务差异。未改业务源码 / 测试 / 线上配置或数据，未重启 / 部署 / 提交 / 推送，也未主动调用收费模型。SSH 凭据不写入仓库或诊断记录。

- 降智检测镜像修订为 `f42342fef32dfb6a9c5af8eabe997892dac290ea`；线上 `detection-runner.js`、`sub2api-client.js`、`config.js` 的 SHA-256 与本地对应文件一致，确实包含先前补测实现。独立只读诊断进程加载配置，确认单次上限 1800000ms、补测最多 2 次、全部尝试期限 3600000ms，网关为 `http://sub2api:8080`。两容器健康，启动时间均为 UTC 11-10 19:06 左右，排查前后未变化。
- 主站镜像标签修订较旧，但实际二进制版本为 `0.2.18001201` / 提交 `6f8c5c205efee1886e6713aa6db1a58e333ba89d`；宿主机 `/proc/<容器 PID>/exe` 与容器 `/app/sub2api` 的 SHA-256 一致，不能只按镜像标签判断线上源码。主站实际运行文件未被本轮替换。
- **GPT不降智（分组 79）**：检测 `#440` 在北京时间 11-11 09:13:07 至 09:37:48，3 次分别耗时 480.192 / 480.150 / 480.164 秒；`#444` 在 15:21:00 至 15:45:46，3 次分别耗时 481.456 / 482.426 / 481.920 秒。每次均返回 `stream_timeout` / `Upstream response exceeded the maximum stream duration`，主站日志 / 错误表确认 6 次全部使用上游账号 `360`（`tuokeapi.com`）。补测确实执行，但没有避开同一个超时来源。`#444` 对应主站错误记录为 `237029` / `237034` / `237039`。
- **GPT Pro号池（分组 8）**：检测 `#442` 在北京时间 11-11 15:00:01 至 15:15:03，单次耗时 901.986 秒，使用账号 `391`（`cctoken.store`），返回 `upstream_http2_stream_error` / `Upstream HTTP/2 stream failed`；主站错误记录 `237007`，请求 ID `b4cc50bd-fa19-4ecd-a0d0-6bde37233ed6`。仅有初次尝试，没有自动补测。独立诊断进程调用线上原 `isTransientModelFailure`，该码返回 `false`，`upstream_stream_read_error` 同样为 `false`；`stream_timeout` 返回 `true`。`src/sub2api-client.js` 可恢复错误白名单遗漏了这类明确的流传输错误，`src/detection-runner.js` 据此直接终止。
- 两类原始流内错误均从主站错误表提取为 `event: error`，白名单解析确认上述 code / message；日志为 `upstream response failed: ...` 且 `upstream_error_response_already_written=true`，不是本次诊断观察到的主站本地 HTTP/2 读连接异常。检测到主站的访问日志协议为 HTTP/1.1，HTTP 状态 200 后通过 SSE 报错；错误表记为 502，不能把流式 HTTP 200 当成功。此内网调用不经过本站对外 Nginx / Cloudflare；提高本站 Nginx 时限或关闭检测客户端 HTTP/2 不能解决上游已返回的终止错误。
- 同一题目实际设置为 `gpt-6.1-sol`、`reasoning_effort=max`、HTML、`max_output_tokens=131072`，历史完整生成经常超过 8 分钟。分组 79 的 `#436` 在 11-10 使用账号 391，731.140 秒完成，主站输出 25909 tokens；分组 8 的 `#438` 在 11-11 09:00 使用账号 230，775.767 秒完成，输出 30908 tokens。账号 360 在 11-09 也有约 618 秒完成记录；证据支持当前所选上游链路固定约 480 秒终止，不能据此断言该供应商所有节点一直有同一硬上限。账号 391 本次接近 900 秒的 HTTP/2 错误只有一条匹配记录，尚不能判为固定 15 分钟限制，具体 RST_STREAM / 内层超时原因需供应商侧日志确认。

后续优化方向：补齐稳定流错误码的有界恢复，并对结果未知的传输失败保留冷却和次数约束；为同组补测增加可靠的失败来源关联与规避，避免所有新请求再次落回同一时限受限的账号；请相应供应商核查约 480 秒最大流时长及约 900 秒 HTTP/2 失败，或在相同模型 / 推理能力的组内选择支持长流的备用线路。保持原题目 / 模型 / 推理强度，不能靠降强度、接受残缺输出或无限补测来声称检测成功。上述建议尚未实施；本轮没有以真实消费发起复测，不能声明生产已经恢复。

## 2026-11-11：iOS 推送渠道按时间段切换提醒级别

用户要求供应商监控的 iOS 渠道支持白天普通、晚上重要提醒。本轮仅修改 `provider-monitor` 和本节台账，保留其他任务差异；不连接生产、不发送真实手机推送，不提交、推送或部署。

- `provider-monitor/src/services/bark-level-schedule.js`（新增）、`src/services/notification-service.js`：在原通道 config JSON 增加可选 `levelSchedule`（启用开关、明确时区及最多 24 个每日时段）。按实际发送时刻选择 Bark level，支持跨午夜、开始包含 / 结束不包含，空档回退原默认级别；校验时区、时间、级别及重叠，在配置 / 凭据事务前拒绝非法输入。正常投递、重试、测试及充值模拟共用；保留原 APNs 参数、投递记录、凭据加密和错误脱敏。注入可控时间供隔离测试，生产使用真实当前时间。无定时任务、依赖、必填环境变量或数据库迁移。
- `provider-monitor/public/index.html`、`public/app.js`、`public/styles.css`：原 iOS 表单增加分时段开关、时区、可增删时间及级别，初始提供 22:00 至 08:00 重要警告的待启用样例；默认级别保持已有值。关闭后保留配置、其他渠道不启用隐藏字段校验，新增原位错误和保存期间防重复提交。沿用原图标、表单及响应式样式。
- `provider-monitor/tests/notification-bark-schedule.test.js`（新增）、`tests/frontend-behavior.test.js`：覆盖白天 / 夜间 / 午夜及精确边界、多时段与空档、时区 / 夏令时、非法输入和配置 / 凭据不被覆盖、旧通道 / 关闭开关 / SQLite 重开 / 导出、实际 HTTP 推送参数与发送时刻、管理员 / CSRF 接口；更新原表单夹具。
- `provider-monitor/scripts/bark-schedule-preview.cjs`、`scripts/bark-schedule-browser-check.cjs`（新增）：隔离 SQLite、模拟 Bark 接收端、可控发送时间和正式页面验收，包含桌面 / 手机的编辑、校验、重载、禁用 / 再启用、增删上限、切换渠道及推送级别；不读取真实凭据或访问真实上游。
- `provider-monitor/README.md`、`CUSTOMIZATIONS.md`：记录白天普通 / 夜间重要的配置示例、边界与时区、固定级别兼容、所有时段共用铃声 / 持续响铃和 Bark / iOS 重要警告授权要求。

验证：分时段新增 9 项与原通知 / TTFT / 前端专项合计 **69 项全部通过**；**119 个 JS / CJS 文件**语法检查及范围内 diff --check 通过。Playwright 正式页面在 1440px、390px、320px 验证时段增删 / 24 条上限、时间重叠 / 起止相同 / 无效时区、旧渠道兼容、新建必填凭据、先启用再关闭保留草稿、重载保留 / 密钥不回显、禁用 / 再启用 / 渠道切换，以及白天 / 夜间 / 午夜的实际模拟推送 level；无页面异常、外部浏览器请求或整页 / 弹窗横向溢出。已复核桌面及窄屏截图，位于系统临时 `provider-bark-schedule-qa`。隔离本地预览为 http://127.0.0.1:50718/（admin / preview-password），仅临时数据库与 loopback Bark 接收端。

完整回归执行 350 项，346 通过、4 项失败，均位于原有 `tests/daily-cost.test.js` 的短实时时限用例；单独复跑该文件为 20/23 通过。在系统临时目录从修改前 HEAD 导出源码 / 测试，使用同一 Node 和依赖独立对照，两次都复现其中“迟到响应隔离”和“共享凭据等待”失败，另外两项在定向对照中通过。全量测试尚不能声明全绿；本轮不修改日报源码、测试或期限，保留这一验证限制。本次功能、浏览器验收和通知回归通过；没有实际手机推送、生产访问、GitHub 提交 / 推送或部署。

用户随后明确要求提交 GitHub，本次据此仅将上述 iOS 分时段提醒实现、测试、预览工具、README 和本节台账提交并推送既有 `origin/main`。保留其他维护章节、降智检测 / 画布 / 多域名与其他任务差异；沿用上述已完成的验证并在提交说明中保留全量日报测试限制。推送前 fetch 核对远端及暂存范围，执行暂存 diff --check；镜像测试 / 构建由仓库原有 GitHub Actions 执行，结果以本次提交 SHA 为准。本次不连接或部署服务器，不发送真实推送。

## 2026-11-11：修复充值中心 Node 20 午夜时间格式

用户确认按只读诊断结论修改代码，要求不动服务器配置并在完成后直接提交 GitHub。本轮只修改充值中心账务时间格式、针对性测试、配套说明和该模块的 CI 测试；不连接 / 部署生产、不修改服务器时区 / Nginx / env / 密钥、不改变账单匹配、金额隔离、付款窗口、验签、订单 / 余额或兑换契约，保留其他任务差异。与本次故障有关的上一节只读诊断记录随修复提交，其他未提交维护章节不纳入。

- `recharge-center/src/alipay-accountlog-client.js`：去掉覆盖 `hourCycle: 'h23'` 的 `hour12: false`，明确保持 `00–23` 小时制，并注明 Node 20 的优先级陷阱。现有共享函数同时修复签名 timestamp、账务查询起止时间和流水时间往返校验，不只修出站请求；严格校验及未就绪下单保护保持。
- `recharge-center/tests/alipay-accountlog-client.test.js`：补充全部 24 小时和零点 / 日月年边界 / 闰日往返、非法 `24:xx` 与非法日期 / 时钟拒绝；通过真实客户端及轮询器，在零点、00:30、01:00 和跨年窗口核对精确签名参数、RSA2 响应验签、午夜流水 UTC 解析及就绪状态。所有密钥和流水均为测试样本，不访问真实支付宝或处理付款。
- `.github/workflows/docker-publish.yml`：按现有服务测试约定增加充值中心 Linux Node 20 的安装、语法检查和完整测试，并纳入镜像发布前置条件，覆盖本地 Node 24 无法暴露的运行时差异；其他服务测试和镜像配置保持。
- `recharge-center/docs/alipay-accountlog-static-guide.md`：补充午夜故障原因、代码升级及验证方式，无新增配置或账本迁移；回看窗口外历史付款仍独立核验，不绕过保护或自动补余额。
- `CUSTOMIZATIONS.md`：登记本轮修复、验证、用户授权提交及未部署边界，保留其他维护内容。

验证：使用按官方 SHA-256 清单校验的 Windows Node 20.20.2，修改前时间 / 账务轮询定向测试有 3 项失败，修复后 10 项全部通过；本地 Node 24.13.0 完整 163 项测试、`npm run check` 和修改测试文件的语法检查通过。工作流 YAML 结构及构建依赖检查、范围内 `git diff --check` 通过；仅使用模拟账单及测试密钥，本轮未连接服务器或真实支付宝，没有改动配置或部署。没有页面改动，不重复浏览器验收；本机 Docker 引擎未运行，Linux Node 20 全量验证由新增 GitHub Actions 在推送后执行，结果以提交 SHA 为准。

## 2026-11-11：充值中心午夜创建订单失败的生产只读排查

用户授权登录服务器分析挂载在 Sub2API 下的充值中心创建订单时“服务暂时不可用”。本轮只读检查容器、脱敏日志、健康接口、主站连通及支付宝账务查询；没有重启 / 部署、修改线上配置或服务文件、创建订单、调用履约或主动改写账本。仅在本地本台账登记诊断结果，保留全部其他任务差异，不提交 / 推送 GitHub，不保存用户提供的登录凭据。

- 充值中心运行镜像修订 `6cc673927554190d7ed28a6f75b204257f2f62be`，Node `v20.20.2`，`personal_accountlog_static` 模式。`/healthz` 返回 200，`/readyz` 返回 503、数据库正常、账务轮询错误 `ALIPAY_ACCOUNTLOG_REJECTED`；最近 12 笔下单请求被 `ACCOUNTLOG_POLLER_NOT_READY` 拒绝。容器内访问主站身份接口正常返回未登录 401，主站和其他扩展服务健康。
- 最后账务成功时间为北京时间 11-10 23:59:59.851，首次拒绝为 11-11 00:00:15.358；服务器 NTP 已同步。使用部署中原账务客户端只发查询，取得经 RSA2 验签的支付宝错误 `isv.invalid-timestamp`，未将响应交给订单处理器。
- 根因位于 `recharge-center/src/alipay-accountlog-client.js` 的 `formatShanghaiDateTime`：同时设置 `hour12: false` 和 `hourCycle: 'h23'`，在生产 Node 20 的 Intl / ICU 下前者优先，实际 `resolvedOptions().hourCycle` 为 `h24`。零点被写成当天 `24:xx:xx`；例如 `2026-11-11 00:30:00` 实际生成 `2026-11-11 24:30:00`，影响请求 timestamp、查询起止时间及 `parseShanghaiDateTime` 的往返校验。现有本地 Node 24 午夜测试通过，不能替代生产 Node 20 / ICU 验证。
- 先在独立进程只修正出站时间，支付宝已不再拒绝，但原解析器继续报 `ALIPAY_ACCOUNTLOG_TIME_INVALID`。随后仅在该独立 Node 进程内加载去掉 `hour12: false` 的客户端副本，保留原 `hourCycle: 'h23'`、签名 / 验签 / 分页 / 字段校验；同一应用配置在北京时间 00:29:16 成功取得并验证账务分页及流水。处理订单数为 0，未回放或补写查询到的流水，也未改变常驻轮询器。
- 修复需统一该格式化函数为明确的 `00–23` 小时制，覆盖签名时间、窗口参数和午夜流水解析，并在生产 Node 20 镜像增加零点、跨日与全天时段回归后单独更新充值中心。不能绕过就绪检查来恢复下单；回看窗口外的既有付款仍需按原规则独立核验，诊断成功不代表已补充任何余额。

没有修改业务源码、测试或部署配置；只读实测已经确认根因与修复方向。诊断结束时再次核对原客户端 / 轮询器文件 SHA-256 和容器启动时间；线上保留原保护状态，未宣称服务已修复或恢复。

## 2026-11-10：修复 Fingerpoint 组合参考名称误判

用户要求修复截图中请求 `gpt-6.1-sol`、候选 `gpt-6-astra/6.1-sol` 被标为不同的问题，验证后提交 GitHub。已只读核对官方 2026-11-09T19:31:55 版本、68 个模型的参考清单，内部标识为 `gpt-6-astra`，组合显示名称由官方参考数据提供。本轮仅修改降智检测模块与本台账，保留其他任务差异，不调用真实收费模型、不修改 SDK 或主站，不操作服务器或生产部署。

- `degradation-detector/src/model-results.js`：名称比较版本升为 2，识别参考显示名称中 `/` 明确列出的完整名称及数字简写共享家族前缀，兼容版本分隔符；不猜测其他家族 / 版本 / 日期 / 后缀。精确模型标识优先，弱别名跨多个候选时保持歧义；原 SDK 评分、概率、采样和真实请求名称不变。最相近候选属于组合名称时保存组合范围标记。
- `src/model-store.js`：使用名称比较版本生成新的独立迁移标记，保留 v1 标记兼容，已执行旧补丁的数据库仍能按每批 50 条修复有证据的历史；同步摘要和详情，不重新检测，保留样本 / 排名 / 时长 / 快照 / 数据版本，已清理响应的记录和其他渠道不变。
- `public/model-result-renderer.js`：组合名称匹配仍显示既有绿色“候选相符”，详情说明请求名称属于参考库组合候选，并明确无法区分组合内具体型号；所有排名和置信度原样展示。
- `tests/fingerpoint-model.test.js`：新增官方组合条目的简写 / 完整名称 / 分隔符、独立标识优先、歧义、不同家族 / 后缀 / 日期、缺失或部分分析、实际请求与 SDK 证据保留、已安装 v1 的历史修复及幂等回归；原名称比较断言同步版本。
- `scripts/model-browser-check.cjs`：在隔离预览插入组合候选历史，验收列表 / 历史 / 详情的相符状态、完整请求 / 参考名称、99.8% 及组合范围说明、桌面 / 390px / 320px / 深色展示与既有绿色。全部请求继续使用模拟传输。
- `degradation-detector/README.md`、`CUSTOMIZATIONS.md`：说明组合候选的识别边界、置信度含义和版本化历史修复；不要求修改配置中的请求模型或重新消费补测。

验证：完整 **170 项测试**、**57 个 JavaScript 文件**语法检查、范围内 diff --check 和 Chrome / Playwright 正式页面验收通过。使用官方同版本 68 模型清单再次确认 `gpt-6.1-sol` 对照为组合候选相符；真实模型调用为 0。桌面 1440px、手机 390px / 320px 与深色模式的状态、完整名称、99.8% 和组合范围说明验证通过，页面异常 / 外部浏览器请求均为 0；已复核截图，存于系统临时 `sub2api-model-browser-NKSx3A`。测试临时服务已自动关闭，不修改原预览或生产实例。按用户授权仅提交本次功能 / 测试 / 文档段落，推送既有 `origin/main`，镜像由已有工作流构建，未部署服务器。

## 2026-11-10：降智检测请求恢复与有限自动补测

用户要求完善降智检测的自动恢复，尽量让每次检测获得完整结果。本轮仅修改 `degradation-detector` 与本台账；保留原有模型图标 / README 段落、画布、运营中心、多域名及其他未提交工作，不调用真实收费模型、不连接生产、不提交 / 推送或部署。恢复只重发原题目的相同模型 / 推理强度 / 输出上限，不改变检测判定或把残缺输出当成功。

- `src/sub2api-client.js`：SSE 支持事件名回退和接收终态后立即释放读取，不等待 EOF 或让随后断连接覆盖完整结果；统一流式与非流式推理的请求阶段分类，明确建连失败 / 429 / 503 保留短重连，其余可恢复错误交给有界补测。解析秒数 / HTTP 日期 Retry-After，识别嵌套上游错误、永久性鉴权 / 配额 / 参数错误，贯穿取消信号并在结束时取消连接。普通身份 / 分组只读请求保持原契约。
- `src/detection-runner.js`：短重连最多 5 次，增加随机退避及 Retry-After；可恢复上游失败默认最多补测 2 次，结果未知的断流 / 代理错误最多补测 1 次且至少冷却 30 秒。单次最多 30 分钟，全部尝试共用默认 60 分钟期限。各次独立聚合答案，不保留中断的残缺输出；鉴权 / 配额 / 格式 / Token 截断 / TLS 配置等不补测。记录实际尝试和恢复次数；分组 / Key / 题目变化或服务关闭停止请求及后续补测，正常关闭中断的任务同样延后下一次计划，避免重启后原手动任务的到期计划立即重提。
- `src/config.js`、`.env.example`：新增可选 `DEGRADATION_DETECTOR_RECOVERY_RETRIES`（0–3，默认 2）及 `DEGRADATION_DETECTOR_RECOVERY_TIMEOUT_SECONDS`（60–7200，默认 3600）；0 可关闭可能产生额外消费的补测，既有配置无需增加变量即可启用默认有界恢复。
- `src/store.js`：增量增加原 runs 表的 `request_attempts_json`，持久化并白名单返回每次开始 / 结束、动作、错误码和 HTTP 状态，不保存 Key、请求体或原错误正文；等待时复用历史说明反馈。重启区分排队与已运行任务，排队可立即重排，运行结果未知的任务延后至少一个请求时限及下一计划，停用分组保持不调度。历史 / 有效判定 / 人工复核和资金契约保持。
- `src/scheduler.js`、`src/server.js`：关闭调度器及保存配置时通知原降智执行器取消；不修改独立模型身份检测、第三方审核或主站。
- `tests/detection-recovery.test.js`（新增）、`tests/detection-runner.test.js`、`tests/sub2api-client.test.js`、`tests/store.test.js`、`tests/config.test.js`：模拟时长超限、嵌套错误、完整终态后断连接 / 长连接、四协议结果未知的单次冷却补测、残缺内容隔离、次数 / 期限 / 停用、Retry-After、永久错误和截断、SQLite 重开与脱敏、重启排期及真实 loopback HTTP 完成不等 EOF；原退避断言注入固定随机源，配置示例断言同步可选变量。
- `degradation-detector/README.md`：同步恢复范围、可选开关、进度 / 持久记录、重启边界及补测会产生新推理消费、不能保证每次成功的实际限制。

验证：最终完整 **167 项测试**通过（原 149 项及新增 18 项），**57 个 JavaScript 文件**语法检查、范围内 diff --check 通过。新增覆盖流时长超限 / upstream_error 补测后取得完整答案、四协议断流至多单次补测、永久错误及配置故障停止、重试 / 总期限与迟到退避、真实 HTTP 已完成但不关连接、SQLite 持久记录与停用 / 重启 / 正常关闭排期；使用临时 SQLite、模拟上游和 loopback HTTP，不调用真实收费模型或生产。原身份 / CSRF / 分组授权、判定 / 复核 / 历史 / 归档及独立模型身份检测回归均保持通过。未修改页面脚本或布局，未另跑浏览器、Docker / Linux 镜像验收，不把模拟恢复结果当作生产成功率；未提交、推送或部署。

用户随后明确要求提交 GitHub，本次据此将上述请求恢复、有限补测、配置、测试、README 恢复说明及本节台账提交并推送既有 `origin/main`。沿用本轮已通过的完整 167 项测试与 57 个 JavaScript 文件语法检查，提交前核对远端和暂存差异并执行 diff --check。原模型图标及其 README 说明、其他维护章节、画布、运营中心、多域名和其他任务差异继续保留本地。沿用仓库已有 GitHub Actions 测试及镜像构建流程，发布结果须按本次提交 SHA 核对，不操作服务器或部署生产。

## 2026-11-09：候选相符使用与降智正常一致的绿色

按用户要求，仅调整 `degradation-detector/public/model-result-renderer.js` 中 Fingerpoint `candidate_match` 的展示色调为既有 `success`，复用公共 `--green`：浅色 `#047857`、深色 `#6ee7b7`，与降智检测“正常”一致。模型列表、渠道标签、历史与管理员详情共用渲染器同步生效；沿用既有成功标签背景，不改判定逻辑、状态文本、其他状态或配置。保留其他任务差异，本轮不提交、推送或部署。

验证：修改脚本语法检查通过；Chrome 无外部请求加载实际渲染器和公共 CSS，浅色 / 深色下“候选相符”与“正常”的计算文字颜色完全一致，并确认“已提供候选”仍为蓝色、“候选不同”仍为琥珀色。未新增测试文件或执行真实检测。

用户随后要求提交 GitHub。本次仅提交上述渲染器配色和本节台账，沿用已通过的浏览器颜色验证；其他任务差异保留在工作区。提交说明记录浅色 / 深色配色一致及验证范围，推送至既有 `origin/main`，不操作服务器或生产数据。

## 2026-11-09：提交 Fingerpoint 名称比较修复到 GitHub

用户要求提交 GitHub。本次仅提交 Fingerpoint 版本分隔符 / 参考名称比较、已有证据的历史标签一次性修复、详情比较说明、单组触发范围回归及对应文档；README 和本台账仅暂存本次相关段落。模型图标及其说明、画布、运营中心、多域名 Nginx 和其他任务差异继续保留在工作区，不操作服务器或生产数据。

沿用本次实现已通过的 149 项测试、56 个 JavaScript 文件语法检查和正式页面 Chrome / Playwright 验收，提交前检查暂存范围与 diff --check。提交备注记录问题、修复边界和验证结果，推送至既有 `origin/main`，镜像由仓库已有工作流构建。

## 2026-11-09：修复 Fingerpoint 版本名称误判并核实单分组触发范围

用户反馈请求 `claude-opus-5-5`、第一候选 `claude-opus-5.5` 被标为“候选不同”，并要求排查单分组按钮是否触发其他组。只读核对官方 SDK 与公开参考清单，确认直接字符串比较错误；官方参考库采用点分版本号。未请求真实模型、未读取或使用生产凭据，不连接服务器、不提交、推送或部署，保留所有其他任务差异。

- `degradation-detector/src/model-results.js`、`src/model-detection.js`：集中比较参考模型标识、显示名称及由参考版本号生成的明确分隔符别名，保留精确标识优先；别名存在多个参考候选时不确认相符或不同。缺少预测标识、部分样本和无法评分不强行判成不同，不按家族模糊匹配或删除型号 / 日期 / 后缀。API 仍请求配置的原名称，官方 SDK 挑战、采样、分析、概率及最后一轮摘要逻辑保持。
- `src/model-store.js`：增加一次性结果标签修复标记，以每批 50 条、单事务校正仍有详细响应的已完成 Fingerpoint 历史摘要和响应标签，保存名称比较依据。其他渠道、排队 / 异常 / 已清理响应的记录保持；不发请求，不重评 SDK 原始证据或修改计时、快照及数据版本。之后启动不重复扫描。
- `public/model-result-renderer.js`：详情在候选名称下说明版本号写法等价、参考显示名称匹配或名称歧义，其余交互保持。
- `tests/fingerpoint-model.test.js`、`tests/model-server.test.js`：覆盖截图中的真实命名差异、不同型号 / 版本 / 后缀 / 日期、显示名称及歧义、缺失 / 部分分析、53 条历史跨批修复 / 幂等及证据保留；验证单组只创建本组各已启用渠道任务、不改变其他组记录或计划，显式平台批量请求才创建两组任务。
- `scripts/model-browser-check.cjs`：新增正式页面名称等价详情验收，核对“候选相符”、等价说明、原请求名称与参考排名同时保留；沿用原只读、跨平台及桌面 / 手机验收。
- `degradation-detector/README.md`、`CUSTOMIZATIONS.md`：说明名称对照边界、历史修复无需补测消费、100% 为库内相对置信度，以及单组 / 平台批量 / 定时 / 原排队任务的触发范围。

验证：完整 **149 项测试**、**56 个 JavaScript 文件**语法检查及范围内 diff --check 通过。正式页面 Chrome / Playwright 验收通过，包含名称等价的列表 / 历史 / 详情、原三渠道与降智交互、管理员 / 只读权限和桌面 / 手机 / 深色布局；页面异常及外部 / 付费请求均为 0。已复核名称等价详情截图，临时截图位于 `sub2api-model-browser-w9qlYE`；测试临时服务已自动关闭，未改动既有预览或生产实例。

## 2026-11-09：提交降智检测与 Fingerpoint 功能到 GitHub

用户要求提交 GitHub。本次提交纳入 `degradation-detector` 的官方 Fingerpoint SDK 接入、参考数据更新管理、平台分区与动态渠道介绍、两个独立只读结果页、Node 22 运行时、相关测试 / 预览及文档，维护台账仅暂存本任务相关新增章节。保留未关联的画布、运营中心、多域名 Nginx 及其他文件和台账改动，不操作服务器或业务数据。

沿用提交前已通过的完整 146 项测试、56 个 JavaScript 文件语法检查及正式页面 Chrome 验收，提交前复核暂存差异、凭据 / 运行数据排除和 diff --check。提交说明记录功能内容与验证范围；推送至既有 `origin/main`，由仓库既有工作流处理镜像构建。

## 2026-11-09：拆分降智与模型只读结果页

用户要求两个独立结果入口，原页面继续仅展示降智检测，移除检测类型 Tab；核实渠道介绍与启用配置的关系，并说明 Fingerpoint 首次配置及后续更新。本轮仅修改降智检测服务与本台账，保留既有 Fingerpoint 正式接入及其他任务改动，不操作生产、主站、资金契约或真实付费检测。

| 文件 | 改动与保留要求 |
| --- | --- |
| `degradation-detector/public/index.html`、`public/app.js` | 原 `/`、`/index.html`、`/results` 始终展示降智结果，删除模型内容、检测类型 Tab 和跨类型事件；保留平台分区、说明与计划、倍率 / 缓存率、柱状图、原历史 / 预览 / 源码交互。无分组显示对应空状态，分组停用后关闭失效详情。 |
| `public/model-results.html`（新增）、`public/model-results.js`、`public/model-results.css` | 新增独立模型结果页，直接读取模型接口并定时刷新，移除对降智 DOM、接口、Tab 和自动切换的依赖及废弃样式。保留全部渠道结果、官网入口、详情内渠道切换及独立历史；介绍继续按用户有权且启用模型检测的分组所启用渠道的并集生成，无需已有记录。 |
| `public/session.js`（新增） | 两页共用原 SSO / Token 清理 / 会话 / 主题和只读请求契约，集中初始化、刷新、重试与 5 秒轮询；各页只加载自身结果。登录失效时停止轮询、清除会话及该页结果 / 详情；普通接口故障提供错误 / 重试反馈，不跳转到另一类检测。 |
| `src/server.js` | 新增 `/model-results`、`/model-results/`、`/model-results.html` 独立 HTML 路由，沿用 no-store 和安全响应头；共享会话脚本纳入资源版本散列。原结果 API 兼容元数据保留，管理角色、CSRF 和分组权限边界不变。 |
| `admin/index.html` | 原返回入口明确为降智结果，并增加带提示的模型结果图标入口；管理页权限及配置交互保持。 |
| `tests/server.test.js`、`scripts/model-browser-check.cjs` | 验证两页及别名、安全 / 不缓存头、资源版本、公共脚本与管理操作分离；浏览器验证无类型 Tab、无跨类型结果请求或自动跳转、两类空状态、跨平台启停渠道时介绍同步、无历史渠道介绍、停用组详情关闭、503 重试和 401 清理。保留三渠道完整详情、管理更新操作、只读 / 越权、原 IQ 作品交互和桌面 / 手机 / 深色验收。 |
| `scripts/model-preview.cjs`、`scripts/fingerprint-demo.cjs`、`scripts/fingerprint-demo/README.md` | 两个独立预览地址同步，继续使用隔离临时数据和禁真实调用的正式页面预览。 |
| `degradation-detector/README.md`、`CUSTOMIZATIONS.md` | 同步三个独立入口、Sub2API 两个普通用户菜单地址与 Nginx 路径、渠道介绍范围、Fingerpoint 五步配置及参考数据 / SDK 分别更新的边界。 |

验证：完整 **146 项测试**、**56 个 JavaScript 文件**语法检查及范围内 diff --check 通过。正式页面 Chrome + Playwright 验收通过，桌面 1440px、手机 390px / 320px 与深色模式无页面异常、整页横向溢出或外部 / 付费调用；已复核两类结果及手机配置截图，截图保存在系统临时 `sub2api-model-browser-hbxdvb`。另只读核对官方 SDK 文档、npm 最新发布及官方参考清单：当前固定与最新发布均为 `lmfpd-sdk@0.2.0`，官方参考数据构建于 2026-11-03、66 个模型；本轮未对实际服务数据执行安装或更新，首次使用仍应在管理页检查并取得参考数据。

只重启本任务已核对的本地 loopback 隔离预览进程，19896 端口现分别使用 `/results?demo=readonly` 和 `/model-results?demo=readonly`，管理仍为 `/admin/config?demo=1`；不提交、推送、构建或部署生产镜像。

## 2026-11-09：正式接入 Fingerpoint、数据更新管理及平台分区结果页

用户确认 Demo 后要求完成正式开发。本轮将确认的布局和第三渠道接入既有降智检测服务，保留现有两渠道、降智规则 / 视觉审核 / 作品预览 / 复核 / 历史交互。仅修改 `degradation-detector` 与本台账；不修改主站、运营中心或资金契约，不连接生产、不提交 / 推送 / 发布或部署，不使用真实用户 Key 或收费模型。保留其他任务的既有文件和台账。

| 文件 | 改动及必须保留的行为 |
| --- | --- |
| `degradation-detector/public/index.html`、`public/app.js` | 两段说明移入降智 Tab 原筛选位置，删除平台筛选和结果分组编号，按平台独立分区；保留原柱状图、倍率 / 缓存率、历史与 HTML 预览。 |
| `public/model-results.js`、`public/model-results.css` | 模型 Tab 删除平台 / 渠道筛选，用当前用户可见模型分组所启用渠道的介绍替代，名称旁提供官网外链及无来源 / 无 opener 保护。模型分组按平台分区，展示所有启用渠道，删除卡片底部固定说明；详情时间统一“记录时间”，手机切换渠道后选中项保持可见。 |
| `public/model-result-renderer.js` | 复用平台分区生成器，新增 Fingerpoint 全候选排名、每轮分析 / 样本 / 挑战 / 原始回答、诊断、SDK 与数据版本及脱敏 JSON。兼容部分样本、无分析、无排名、缺概率和中断；库内候选结果不转换成身份或智商证明。原两网站全部项 / 零分 / null / 扩展字段保留。 |
| `admin/index.html`、`admin/app.js`、`admin/model-config.js`、`admin/model-config.css` | 在原管理页第三渠道配置中加入模型 / 协议 / 推理强度（含 Max）/ 轮数 / 样本 / 并发 / 严格模式、分组模型覆盖、独立专用 Key、原手动 / 批量与自动计划。新增更新策略、来源、版本状态、后台进度、检查 / 应用 / 恢复与更新记录；未保存配置不能操作，过期管理员状态清理敏感内容。Fingerpoint 不提供检测网站 Key 输入。 |
| `src/model-config.js`、`src/config.js`、`src/model-store.js` | 增加第三渠道、取样约束、可选更新设置和分组模型覆盖；旧两渠道配置自动补入关闭的 Fingerpoint，不强制重填原设置。任务、历史、归档及清理继续分渠道；配置和加密 Key 使用原 SQLite / 数据卷。 |
| `src/model-detection.js`、`src/model-results.js` | 接入官方 SDK Worker 和专用 Key，先取得可用参考数据再请求目标。逐样本 / 逐轮持久化进度和脱敏结果，最大响应 2 MiB，运行总限 1,800 秒；独立候选状态不进入降智率。停用 / 改配置取消执行；中断或重启不重发模型请求，已完成样本保留。 |
| `src/fingerpoint-worker.js`、`src/fingerpoint-runner.js`（新增） | 官方 `lmfpd-sdk` 负责挑战、请求、解析和评分，支持 Responses / Chat Completions / Messages，多轮分别检测。Worker 内存限制、总取消及退出清理，不增加浏览器或截图服务；修复取消与 Worker 退出竞态的错误分类。 |
| `src/fingerpoint-http.js`（新增） | 参考下载限流量、校验公网 HTTPS、不跟随重定向；模型传输限定为 SDK 生成的唯一 POST 端点，每次固定已验证公网 DNS，拒绝重定向和超大流式响应，完成 / 异常关闭连接。参考服务不接收模型 Key。 |
| `src/fingerpoint-fixture.js`（新增） | 隔离演示与页面验收共用三轮样本及候选数据，明确模拟数据标记，不调用真实模型或参考下载服务。 |
| `src/fingerpoint-data.js`（新增） | 固定官方 / 镜像来源，支持 1–168 小时自动检查、自动应用或手动应用、检查 / 安装 / 恢复和最多 30 条历史。校验 manifest / 路径 / 大小 / SHA-256 / 解压 / SDK 绑定，坏包尝试备用来源，旧数据源不能自动降级，失败保留可用版本。不可变 hash 目录和版本租约保证在途 / 历史不变，清理无引用版本和遗留临时目录；当前版在更新期间可立即取得，首次等待可取消。SDK 只提示版本，不安装远程代码。 |
| `src/server.js`、`src/model-routes.js` | 管理设置同事务保存；新增仅实时管理员访问的数据状态与操作 API，写操作要求 CSRF。操作立即 202、GET 续看进度，避免长下载占用反代请求；普通用户仍只能按可见且已启用分组 / 渠道读取结果，无配置、Key 或目标 URL。演示模式禁止真实数据下载。 |
| `package.json`、`package-lock.json`、`Dockerfile` | 固定官方 MIT SDK `lmfpd-sdk@0.2.0`，运行时最低 Node 22.15，Docker 两阶段使用 Node 22；不升级无关依赖，不新增 `.env` 变量、服务或容器。 |
| `tests/fingerpoint-data.test.js`、`tests/fingerpoint-model.test.js`（新增） | 18 项专项覆盖参考包校验 / 来源回退 / 原子切换 / 重开与恢复 / 版本租约 / 保留 / 自动策略 / 取消 / 首次安装竞态、SDK 协议与 Worker、三渠道及仅 Fingerpoint、分组 Key / 模型、定时 / 部分结果 / 中断不重放、角色 / CSRF / 分组授权与后台操作。均使用隔离数据和模拟传输，不收费。 |
| `scripts/model-preview.cjs`、`scripts/model-browser-check.cjs` | 正式页面三渠道隔离预览与 Chrome 验收，原有降智 / 两渠道交互继续验证；新增候选、轮次、空分析、更新策略与拦截响应的后台检查 / 应用 / 恢复 / 记录，验证手机、深色、越权拒绝及零真实调用。 |
| `scripts/fingerprint-demo.cjs`、`scripts/fingerprint-demo-check.cjs`、`scripts/fingerprint-demo/README.md` | 原 Demo 启动与验收命令保留，改为复用正式页面与隔离预览；移除原型的四份动态叠加脚本 / 样式，不把模拟后端接入生产。19896 地址继续可用，检测结果是模拟数据，真实更新在演示中禁用。 |
| `degradation-detector/README.md`、`CUSTOMIZATIONS.md` | 同步三渠道配置、Key 和费用边界、样本 / 排名含义、参考数据与 SDK 更新边界、限额 / 保留 / 安全、运行时及验证步骤。 |

验证：降智检测完整 **146 项测试**、55 个 JavaScript 文件语法检查及范围内 diff --check 通过。正式页面 Chrome + Playwright 验收覆盖 1440px、390px / 320px 和深色模式、全部三渠道、后台更新操作反馈、原降智预览 / 源码 / 历史、角色与分组边界；无页面异常、整页横向溢出或真实外网 / 付费调用，截图在系统临时 `sub2api-model-browser-xVtcIb` 等目录。另实际从官方获取 2026-11-03 版本参考数据（66 个模型），校验解压 hash 与 SDK 加载 / 分析成功；用该真实参考库和三协议模拟 SSE 响应验证官方 SDK 取得各 3 个有效样本、66 个候选，9 次传输均为模拟，不请求真实模型。真实检测质量及目标 API 兼容性仍需管理员配置专用 Key 后按实际回包核对，不把演示候选当鉴定结果。

只重启本任务已核对命令行的 loopback 预览，继续使用 `http://127.0.0.1:19896/results?demo=readonly#model` 与 `/admin/config?demo=1`；临时 SQLite 与实际数据隔离。当前机器 Docker Linux 引擎未运行，未构建或验收 Linux 镜像，不启动 Docker Desktop、不部署服务器。生产升级应使用后续发布的服务镜像并持久挂载原数据卷，SDK 后续程序逻辑升级仍须重新发布镜像。

## 2026-11-08：按确认文案统一 Fingerpoint Demo 展示

用户确认先前文案方案，并要求去除每个模型检测分组卡片底部的“独立检测记录 · 不计入降智率”。本轮仅调整 Demo 展示，正式接入继续等待确认；保留全部模拟标识、现有渠道能力和数据更新设计，其他任务文件保持。

- `degradation-detector/scripts/fingerprint-demo/results.js`：第三渠道名称统一为 `Fingerpoint`，官网入口提示同步新名称；介绍改为“采用与官网一致的检测逻辑，分析模型回答特征，提供候选模型排名。”，摘要改为“指纹检测 · 版本随记录保存”。
- 同目录 `admin.js`、`renderer.js`：配置、分组模型覆盖、历史渠道选项及详情标题统一名称，配置摘要改为“官方检测逻辑 · SDK 0.2.0 · 无需检测网站 Key”。
- `degradation-detector/scripts/fingerprint-demo.cjs`：模拟结果返回与复用脚本的渠道名称同步，Demo 动态资源将详情时间标签改为“记录时间”，删除模型卡片完整底部说明节点，不保留空白占位；不改正式公共脚本或服务 API。
- `degradation-detector/scripts/fingerprint-demo/README.md`、`CUSTOMIZATIONS.md`：同步已确认文案和原型边界，说明正式同源逻辑须以接入对应检测程序及参考数据版本为前提；当前仍为模拟数据。

验证：51 个 JavaScript 文件语法检查及完整 Demo 浏览器验收通过，原有分组 / 渠道 / 详情 / 数据更新 / 权限流程正常，真实外部和付费调用均为 0。另对运行中的 19896 预览验证两分组 6 个渠道结果、介绍 / 返回名称 / 详情 / 管理历史新文案，以及卡片底部节点已删除；模型展示与配置中无旧名称或相关“本地”描述，无页面异常，320px 页面无整页横向溢出。已复核结果与配置截图，保存在临时 `sub2api-fingerpoint-copy-wl4WAy`，完整验收截图在 `sub2api-fingerprint-demo-JdCdZA`。已核对命令行，仅重启本任务的独立后台 Demo 进程，继续使用原 URL；未新增测试文件、提交、推送或部署正式服务。

## 2026-11-08：Demo 渠道介绍增加官网入口

按用户要求，仅调整既有模型结果 Demo。`degradation-detector/scripts/fingerprint-demo/results.js` 在已启用渠道名称旁增加官网外链图标，分别指向 `https://bazaarlink.ai/`、`https://cctest.ai/`、`https://lm.ikale.io/`；新标签页打开，设置 `noopener noreferrer`、中文悬停提示及无障碍名称，不附加凭据或检测数据。`preview.css` 补充固定尺寸图标入口、悬停和键盘焦点样式，沿用当前主题；同目录 `README.md` 与本台账同步说明。未修改正式功能、依赖或配置，不提交或部署。

验证：对运行中的 Demo 检查三个链接的目标、提示及实际新标签页打开行为，确认新页 opener 为空、来源为空；外站导航在浏览器内拦截为模拟响应，无真实外网请求。1440px、390px / 320px 及深色模式显示正常，无页面异常和整页横向溢出；已复核桌面与手机截图，保存在临时 `sub2api-channel-links-xVHDP1`。修改脚本语法检查通过，未增加生产测试或依赖。

## 2026-11-08：模型结果 Demo 去除筛选并按平台分区

用户要求重新调整 Demo，确认后才开发正式功能。本轮只修改既有隔离原型，沿用已有页面风格和模拟数据，不接入第三渠道正式服务、不请求外部 API、不提交或部署；其他任务的文件和台账保持。

| 文件 | 改动与保留要求 |
| --- | --- |
| `degradation-detector/scripts/fingerprint-demo/results.js` | 模型 Tab 隐藏平台和检测渠道筛选，原位置展示当前用户可见分组启用渠道的简短说明和检测计划；按模型结果自身平台分区，复用降智 Tab 的区标题、分隔线和卡片布局，取消卡片重复平台标签。说明随配置刷新同步，跨平台仍启用的渠道继续显示；保留所有已配置渠道结果、详情和独立历史，不借用降智分组决定模型分组可见性。 |
| `degradation-detector/scripts/fingerprint-demo/preview.css` | 新增无框渠道说明布局，桌面并列、手机纵向；模型与降智结果共用平台分区网格，复用现有颜色变量和深色主题。 |
| `degradation-detector/scripts/fingerprint-demo-check.cjs` | 更新浏览器验收：两类检测独立分区、筛选不可见、6 个渠道结果完整保留、跨平台关闭 / 恢复渠道后说明同步、刷新无重复分区；渠道变更使用各分组不同的模拟专用 Key 满足原安全确认。保留全部原型管理、数据更新、详情、权限检查，增加模型列表手机 / 深色截图。 |
| `degradation-detector/scripts/fingerprint-demo/README.md`、`CUSTOMIZATIONS.md` | 同步最新 Demo 布局、验证范围与待确认边界。 |

验证：完整 Demo 浏览器验收通过，原降智作品预览、三个模型渠道详情和管理操作正常；1440px、390px / 320px 与深色模式无整页横向溢出，页面未捕获异常为 0，真实外部 / 付费调用为 0。已复核桌面、手机和深色模型列表截图，保存于本机临时 `sub2api-fingerprint-demo-4Sa4XY`。`npm run check` 检查 51 个 JavaScript 文件。预览仍使用独立后台 loopback 服务 `http://127.0.0.1:19896/results?demo=readonly#model`，静态叠加资源刷新即生效；正式业务源码与生产配置未改。

## 2026-11-08：降智结果分区与第三指纹渠道交互 Demo

用户要求先输出最终 Demo，确认后再实施正式改造。本轮只新增本地隔离交互原型，不把 Fingerpoint SDK、渠道 schema 或更新器接入正式服务，不改 Sub2API、Docker、计费及现有生产页面。不提交、推送或部署；其他任务的文档、Nginx 修改及无关文件保留。

| 文件 | 改动与保留要求 |
| --- | --- |
| `degradation-detector/scripts/model-preview.cjs` | 现有隔离预览额外返回 Express app，供新 Demo 复用；原端口、页面、临时数据、上游禁用和清理语义保持。 |
| `degradation-detector/scripts/fingerprint-demo.cjs`（新增） | 仅 loopback 的 Demo 启动器，复用既有真实页面与临时模拟服务，按请求叠加资源和模拟第三渠道。新增设置保存、分组模型、排队 / 手动、历史及数据检查 / 应用 / 回退接口，仅操作内存及临时库；管理与写请求沿用管理员会话和 CSRF。完整样本、候选、置信度及数据版本均为虚构演示，无 SDK 安装、外网数据下载或模型请求。 |
| `degradation-detector/scripts/fingerprint-demo/results.js`、`preview.css`（新增） | 两段提示移到降智 Tab 原筛选位置，该 Tab 去除可见平台筛选；按平台无框分区，保留原卡片、倍率 / 缓存率、柱状图、历史 / HTML 交互，取消只读分组编号。第三渠道沿用模型结果页，手机渠道导航保证选中项可见，兼容现有深色。 |
| `degradation-detector/scripts/fingerprint-demo/admin.js`（新增） | 沿用配置页增加第三渠道，配置目标模型、协议、推理强度、轮数与取样参数，分组覆盖及仅选第三渠道可保存。独立数据管理提供自动检查间隔 / 应用策略 / 来源、手动检查 / 应用 / 回退和更新记录；明确参考数据可直接更新，程序与挑战生成逻辑仍随 SDK / 镜像升级。 |
| `degradation-detector/scripts/fingerprint-demo/renderer.js`（新增） | 显示完整模拟候选、逐轮样本、挑战 / 原始回答、诊断、SDK / 参考数据版本与 JSON；部分样本不显示置信度，保留库内排名的解释，不计入降智率。更新前后历史保持其执行时数据版本。 |
| `degradation-detector/scripts/fingerprint-demo-check.cjs`、`scripts/fingerprint-demo/README.md`（新增） | 提供 Chrome 验收和原型运行说明。验证布局、现有 HTML / 两渠道交互、管理员保存与分组覆盖、模拟手动取样、仅第三渠道、自动 / 手动策略保存、数据检查 / 应用 / 回退 / 记录、历史版本不覆盖及普通用户管理访问拒绝。截图仅存系统临时目录。 |
| `CUSTOMIZATIONS.md` | 登记本轮 Demo 范围、确认前边界及验证结果，不覆盖其他任务台账。 |

验证：新 Demo 与原模型检测浏览器回归均通过，桌面 1440px、手机 390px / 320px、深色模式无未捕获页面异常或整页横向溢出；已复核平台分区、管理更新、第三渠道、结果详情及手机 / 深色截图。普通用户访问管理页面、新管理脚本、数据设置和更新请求均 403；外部浏览器请求和模拟服务的真实上游调用均为 0。`npm run check` 检查 51 个 JavaScript 文件，降智检测范围 diff --check 通过。新增流程截图在本机临时 `sub2api-fingerprint-demo-JTW6hG`，原回归在 `sub2api-model-browser-bpGmWD`。默认新预览 http://127.0.0.1:19896，结果 `/results?demo=readonly`、模型 `/results?demo=readonly#model`、配置 `/admin/config?demo=1`；数据 / 版本与结论为演示，未运行生产 API、Docker / Linux 验收或实际升级。

## 2026-11-07：新旧域名并存与 yunhop.cc 加密回源准备

用户授权兼容除 3X-UI、订阅管理和 Xray 节点之外的现有服务，并为 yunhop.cc 新增独立证书和 Nginx 8443 加密回源准备。用户随后明确保留当前 Cloudflare HTTP 回源，不修改 Cloudflare，仅将本轮代码推送到 extra main，应用镜像由用户自行更新。保留旧域名、原容器数据、计费合同和 fork 镜像通道，不修改排除服务的配置或资金数据。既有无关工作文件保持。

- `recharge-center/src/public-origins.js`、`operations-center/src/public-origins.js`、`provider-monitor/src/public-origins.js`、`usage-leaderboard/src/public-origins.js`：独立镜像内提供同样的显式浏览器 Origin 列表解析；去重、拒绝通配符、账号、路径、参数和非 HTTP(S) 地址，生产别名仅允许 HTTPS。服务端 API 基址和持久凭据不使用这些别名。
- 上述四个服务的 `src/config.js`：新增可选 `SUB2API_PUBLIC_URLS`，旧单地址继续有效；充值中心另支持 `RECHARGE_CENTER_PUBLIC_URLS`。
- `recharge-center/src/app.js`、`operations-center/src/app.js`、`provider-monitor/src/server.js`、`usage-leaderboard/src/app.js`：嵌入白名单同时包含旧主站及显式新主站；充值请求来源精确匹配合法别名，原认证、CSRF、Cookie 和权限保持。供应商监控的跨域 API 配置继续单独管理。
- `recharge-center/src/qr-service.js`：付款中转二维码接受显式充值域名列表，保留原订单路径、查询参数及凭据校验。
- 四个服务的 `.env.example` 及 `recharge-center/docs/deployment-configuration.md`：说明可选主站别名及充值别名；最小配置模板保持原必填项，旧标准地址、付款链接、内网 API 地址和认证凭据继续有效。
- 四个服务的 `tests/multi-domain.test.js`（新增）：共 13 项回归，覆盖来源解析、旧新 iframe CSP、充值双域 SSO、无 / null / 外域来源拒绝、CSRF 不放宽、host-only Cookie，以及二维码域名与订单路径约束；监控 iframe 别名不扩大跨域 API 授权。
- `infinite-canvas/docs/nginx.conf.example`、`nginx-subpath.conf.example`：画布 CSP 加入新主站，清除登录参数和子路径跳转保留当前 Host。画布业务无需重建，按域隔离的浏览器历史不会自动迁移。
- `operations-center/integrations/multi-domain/yunhop-services.conf`、`yunhop-tls.conf`、`yunhop-proxy.conf`（新增）：12 个明确新主机名同时支持原 80 HTTP 回源和独立 8443 TLS，共用相同路由，HTTP 入口直接代理，避免 Cloudflare HTTP 回源发生整站跳转循环；保留流式请求、WebSocket、主站维护与防取消配置、监控 / 画布子路径；`port_in_redirect off` 及明确的 HTTPS 子路径跳转防止公开跳转暴露源站端口或降级为 HTTP。
- `operations-center/integrations/multi-domain/install-nginx.py`、`operations-center/docs/multi-domain-deployment.md`（新增）：根用户互斥、证书配对 / CA 校验、完整候选 Nginx 校验、私有备份和原子替换 / 失败回滚；记录 DNS、源站端口规则、严格回源和镜像发布 / 回滚步骤，不在脚本或文档中保存私钥。
- `operations-center/integrations/multi-domain/install-app-env.py`（新增）：四份 `.env` 白名单候选 / 备份、完整 Compose 结构比对、保持属主权限的原子写入、并发修改保护和失败回滚；拒绝覆盖已有不同别名，不输出环境秘密，不在环境准备阶段重启容器。

验证：充值中心 160 项、运营中心 376 项、供应商监控 341 项、排行榜 81 项完整测试全部通过，共 958 项。充值 / 运营 / 排行榜 `npm run check`、监控变更文件 `node --check` 和 `git diff --check` 通过。本轮无前端视觉改动，没有真实付款、付费模型请求或资金写入。

北京时间 11-07 已安装用户在 Cloudflare 创建的 Origin 证书，SAN 为 yunhop.cc / *.yunhop.cc，有效至 2041-11-03；核对配对、官方 Origin RSA CA 签名和主机名。私钥仅位于服务器 `/etc/nginx/ssl/yunhop.cc/origin.key`（目录 0700，文件 0600），此前生成的无用私钥和 CSR 已删除。Nginx 安装成功，原始配置备份 `/root/sub2api-deploy/backups/yunhop-domain-20261107-203355-411132/before/`，最终禁止跳转暴露端口的配置备份 `/root/sub2api-deploy/backups/yunhop-domain-20261107-203549-931904/`。12 个新 Host 及主站画布 / 监控子路径的实际 SNI + CA 验证、普通 HTTPS 跳转均通过，旧主站 / 画布 / 运营 / 充值检查 200。15 个容器身份 / 启动时间、Nginx master、Xray 443、排除服务配置与证书散列均未改变。

环境工具已在真实生产 Compose 上预演，通过后仅追加四份 `.env` 的主站别名及充值专用别名，前后完整结构比较符合预期，文件仍为 root / 0600，15 个容器均未重启。候选备份 `/root/sub2api-deploy/backups/yunhop-app-env-20261107-204456-438825/`；实际安装和原配置备份 `/root/sub2api-deploy/backups/yunhop-app-env-20261107-204600-493551/`。别名只随新容器启动生效，旧进程尚不支持新增变量。

用户已授权本轮相关代码提交 / 推送，仍沿用现有 Actions / GHCR 发布，不修改发行工作流；四个生产应用镜像由用户自行更新，本轮不 pull 或重建容器。Cloudflare 配置和当前回源方式保持，部署说明将 8443 源站规则和 Full (strict) 明确为未来操作；新域名当前尚未完成边缘业务验收，源站 TLS 成功不能冒充边缘切换完成。主站菜单保留原绝对地址。新域名 HTTP 回源兼容修正、现有入口与双协议源站验证结果在本节追加。

按用户最终回源安排，修正先前只做 HTTPS 跳转的新域名 80 入口，使 80 和 8443 共享同一 Nginx server 及业务规则；`/monitor` 跳转显式保持浏览器 HTTPS 地址。完整候选与生产 `nginx -t` 均通过，平滑重载，备份 `/root/sub2api-deploy/backups/yunhop-domain-20261107-220441-826433/`。34 项真实源站 HTTP / TLS 检查全部通过，覆盖 12 主机名、监控 / 画布子路径及无端口泄漏的重定向。现有 10 个公网入口全部 200；15 个容器身份 / 启动时间、Nginx master、排除服务配置散列均不变。yunhop.cc 公网当时仍为 Cloudflare 525，Cloudflare 未调整，不将它作为已完成验收的新业务入口；新应用由用户待镜像发布成功后自行更新。部署文档补充限定四服务的拉取、完整 revision 核对及更新命令。

## 2026-11-07：结果页仅显示已配置分组的检测类型

用户要求降智检测或模型检测未配置任何分组时隐藏对应结果页签。本轮仅调整降智检测服务及本台账；以主站当前授权分组与管理员已启用的对应检测分组交集为准，不以历史条数或筛选结果判断。用户验收后明确授权提交 GitHub，本次据此提交并推送；保留其他模块和无关本地文件，不部署服务器。

| 文件 | 改动与后续保留要求 |
| --- | --- |
| `degradation-detector/src/model-store.js`、`src/model-routes.js` | 提取模型检测可见分组交集筛选，结果与页签可用性复用同一权限口径，包含分组 ID 和平台匹配；原管理员与只读 API 权限保持。 |
| `degradation-detector/src/server.js` | 原 `/api/results` 在同一次主站分组查询中返回降智 / 模型页签可用布尔值，不新增全量模型结果请求，不泄漏其他用户分组、配置或凭据。 |
| `degradation-detector/public/index.html`、`public/app.js`、`public/model-results.js` | 初始隐藏页签，成功读取后仅显示有可见启用分组的类型，保留有效选中；当前类型不可用及无效 `#model` 自动切换，两类皆空显示统一空状态并保留刷新。配置变更关闭已不可查看类型的详情，键盘跳过隐藏页签；空历史、筛选为空和请求失败不会冒充未配置。 |
| `degradation-detector/tests/model-server.test.js`、`scripts/model-browser-check.cjs` | 扩展既有回归，覆盖两类 / 单类 / 无配置、已启用但无历史、保留历史但停用、其他用户分组与撤权、深链接回退、刷新恢复、筛选为空、请求失败、键盘及详情关闭。浏览器仅操作隔离预览临时 SQLite，不连接真实上游。 |
| `degradation-detector/README.md`、`CUSTOMIZATIONS.md` | 补充结果页签的分组 / 权限 / 空状态及自动切换规则，登记本轮改动与验证。 |

验证：完整 128 项测试通过，`npm run check` 检查 46 个 JavaScript 文件，`git diff --check` 通过。真实本地服务 + Chrome / Playwright 原配置、检测、历史及只读边界回归和新增页签场景通过，已有桌面 / 390px / 320px / 深色流程无整页溢出或未捕获页面异常；新增仅模型及两类皆空截图已复核，材料位于本机临时 `sub2api-model-browser-sG4eBO`。浏览器外部请求与真实检测消费均为 0；未执行生产 API、Docker / Linux CI 或服务器更新。

## 2026-11-07：降智检测增加独立模型身份检测

用户确认沿用现有管理员设置页和最终双页签结果 Demo，要求正式实现。本轮只修改 `degradation-detector` 及本台账，不修改 Sub2API 主站、计费契约或其他服务。降智检测与模型检测配置在同一管理页，专用凭据、计划、任务、历史和结论独立；普通结果页保持只读。实现与验证完成后，用户明确授权提交 GitHub，本次据此提交并推送；不部署、不使用真实 Key 或付费检测验证，保留无关未跟踪文件。

| 文件 | 改动与后续保留要求 |
| --- | --- |
| `degradation-detector/src/model-config.js`（新增）、`src/config.js` | 独立平台 / 渠道 / 分组模型覆盖与计划 schema，默认关闭，支持 Bazaarlink Probe、CCTest 多选，GPT / Claude 对应协议；总超时 30–1800 秒、每日多时间 / 间隔。公网 HTTPS 标准端口校验、严格字段白名单，无新增必填 env，兼容旧降智配置请求。 |
| `degradation-detector/src/model-store.js`（新增） | 原 SQLite 增量增加独立模型设置、平台、分组、任务、归档、限流与提交计数表。保存加密 Key 快照，分组 + 渠道活动唯一，已知远程任务重启只续查，未知已提交结果不重发、未提交队列可恢复。历史按组 / 渠道分页与批量 / 全清，保护在途；维护每轮最多 20 个组合、每组最多 200 条归档 / 200 份响应清理并让出请求，至少保护最近 60 条。清历史不能绕过 30 次 / 小时提交上限。 |
| `degradation-detector/src/model-detection.js`（新增） | 独立串行队列和自动计划，手动不推迟自动。检测网站持异步任务，提交一次、轮询 GET 最多连续重连 5 次，整体期限包含 DNS / 退避 / 响应体；限制 2 MiB，校验返回格式 / 任务 ID。使用单独模型检测 Key 和网站 Key，不借用登录 Token；地址 / 渠道目的地改变须重填目标 Key，网站地址改变不复用原网站 Key。保留网站原结论及全部返回项，不混入降智率；demoMode 仅模拟。 |
| `degradation-detector/src/model-results.js`、`src/model-routes.js`（新增） | 普通查询实时分组交集授权；管理员资源 / 配置 / 检测 / 批量 / 清理接口沿用实时角色、CSRF 和限流。完整脱敏响应保留 0、null、警告、未知字段和全部数组项；隐藏 Key、认证头、Cookie、用户 IP / 邮箱、目标地址、远程任务 ID 与报告定位信息，不返回加密配置。 |
| `degradation-detector/src/server.js`、`src/scheduler.js`、`src/maintenance.js` | 集成模型服务生命周期、独立配置安全返回、与原降智保存同事务、受保护管理员资源及内容哈希版本，维护 / 空闲回收考虑模型任务。原降智路由和作品沙箱保持。 |
| `degradation-detector/src/review-http.js` | 公用 HTTPS 连接器可选响应体限额 / 精确秘密脱敏，未指定时保留原视觉审核 256 KiB 边界；429 安全读取 Retry-After，无任务幂等 Key 时不发送对应头，模型调用仍禁止重定向和内网 DNS。 |
| `degradation-detector/admin/model-config.js`、`admin/model-config.css`（新增）、`admin/app.js`、`admin/index.html` | 原配置编辑器下增加模型平台设置，分组下独立启用 / Key / 两渠道模型覆盖，独立自动计划和手动 / 平台批量检测。模型历史支持完整详情、在途自动刷新、最多 100 条选择、全选状态、批量删除和按渠道清空；原降智独立配置、复核、清理保留。 |
| `degradation-detector/public/model-result-renderer.js`、`public/model-results.js`、`public/model-results.css`（新增）、`public/app.js`、`public/index.html` | 原结果页增加降智 / 模型两个页签；原降智柱状图、折叠证据、HTML / 源码交互保留。模型展示全部已选渠道、逐渠道历史、Bazaarlink 每项 / 身份 / 警告 / 诊断、CCTest 全 scores / 性能 / 全轮 Token 审计及完整脱敏 JSON，空值不假 0、网站总分不重算。区分本地查询失败与网站最后状态，错误不冒充匹配；响应文本全部转义，支持手机和深色。 |
| `degradation-detector/tests/model-detection.test.js`、`tests/model-server.test.js`（新增） | 模拟两网站提交 / 轮询，覆盖双渠道协议、仅专用 Key、加密脱敏、全部项 / 0 / null / 未知字段、重复排队、5 次 GET 重连 / POST 不重发、重启恢复、ID 不一致 / 过期 / 超时 / 格式错误、独立计划、限流计数 / 分批维护 / 跨组渠道与在途保护。HTTP 验证真实会话、普通 / 匿名 / 撤角色 / CSRF / 分组撤权、配置原子性 / 旧客户端及管理员资源隔离。 |
| `degradation-detector/scripts/check.cjs`、`scripts/model-preview.cjs`、`scripts/model-browser-check.cjs`（新增）、`package.json` | 新增语法检查及真实服务隔离模拟预览 / Chrome 回归入口。预览使用临时 SQLite / 假 Key，禁用上游请求，不连接生产；检查配置持久化、独立计划与分组覆盖、手动 / 批量检测、全部项与 Token 轮次、删除、原降智预览 / 源码、普通用户隔离及桌面 / 手机 / 深色布局。截图仅存系统临时目录，不添加浏览器生产依赖。 |
| `degradation-detector/README.md`、`CUSTOMIZATIONS.md` | 记录两类 Key、目标公网地址、协议、独立计划 / 结果 / 授权 / 费用 / 保留、外部网站结论边界和本地模拟方法；入口仍为 `/admin/config` 与 `/results`。 |

验证：降智检测完整 128 项测试通过；最终 IP / 任务定位信息脱敏与 Key 故障反馈收尾后，新增 11 项模型 / HTTP 回归再次通过。`npm run check` 检查 46 个 JavaScript 文件，`git diff --check` 通过。真实服务 + Chrome / Playwright 验证每日三时间点与间隔持久化、分组模型覆盖、Key 不回显、原降智有效题目不变、手动 / 平台双渠道检测、8 条 Probe 项 / 11 个 CCTest 分项 / 6 轮审计全部展示、0 / null / 未知字段 / 转义、批量及整渠道清空、原 HTML 预览 / 源码和证据默认折叠、普通用户四类管理访问均 403。1440px / 390px / 320px 与深色布局通过，无未捕获页面异常或整页溢出；已复核桌面、手机和深色截图，最终截图在本机临时 `sub2api-model-browser-UJvMIX`。浏览器和服务的真实上游调用均为 0；未运行 Docker / Linux CI、两网站生产 API 或真实付费检测，不以模拟通过代替网站协议 / 额度可用性验收。独立预览默认 http://127.0.0.1:19895，只使用临时数据，配置入口 `/admin/config?demo=1`、只读入口 `/results?demo=readonly#model`；正式服务仍需管理员配置并保存专用 Key 后使用。

推送前 fetch 确认本地 main 与 origin/main 一致。本次仅提交上述模型检测功能、文档、测试和本节台账；沿用现有 GitHub 测试及 GHCR 镜像发布流程，构建 / 镜像是否发布须以本次完整提交 SHA 对应的 Actions 为准。提交和推送不代表服务器已更新；本轮不部署服务器，其他工程文件继续保留本地。

## 2026-11-06：充值中心管理员大额充值 Bark 提醒

用户要求在只有管理员可见的到账审核页面配置单笔大额充值提醒，固定使用 iOS Bark，参考供应商监控通知实现。本轮仅修改充值中心；实现和凭据独立，不调用或修改供应商监控、运营中心及其通知通道，不改变对账规则、主站余额或兑换记录契约。部署仍未执行；本次 GitHub 提交和推送由用户在验收后明确授权。既有无关工作继续保留。

| 文件 | 改动与保留要求 |
| --- | --- |
| `recharge-center/src/large-recharge-alert-service.js`（新增） | 实现默认关闭的开关、精确分值阈值、Bark Device Key AES-256-GCM 加密设置、掩码返回、保留 / 清除 / 更新 Key 和审计；固定官方 HTTPS 地址、时效性级别和分组，禁止自定义目标及凭据复用。完成订单严格大于阈值才唯一入队，后台租约领取、重启恢复、最多三次有限退避；发送期限覆盖响应体，64 KiB 上限，校验 HTTP / JSON 成功，不保存上游原始错误。正文完整下单邮箱只取加密订单快照并校验格式、长度及控制字符；失败不影响已完成充值。 |
| `recharge-center/src/db.js` | 版本 12 增量创建 `large_recharge_alerts` 持久队列表和索引；按订单唯一，保留原订单、兑换与审计数据。设置复用本服务现有 metadata 表并独立加密，无额外数据库或数据卷。 |
| `recharge-center/src/order-service.js`、`src/server.js` | 在既有兑换结果核验通过后的订单完成事务内入队；注入独立通知服务及后台生命周期，关闭时取消请求。排队异常记录安全审计码，不把提醒失败变为入账失败，不增加充值网络等待或再次发额度。 |
| `recharge-center/src/app.js` | 新增管理员配置 GET / PUT 和测试 POST；沿用认证、本站 Origin、CSRF 和更新限流，测试每来源 IP 15 分钟最多 5 次；严格字段白名单，普通用户和官方模式不可用，公共配置不暴露 Key。 |
| `recharge-center/public/index.html`、`public/app.js`、`public/styles.css` | 审核页增加未套卡片的提醒设置区域，提供开关、金额、密码型 Key、清除、保存、测试与最近投递状态。沿用现有颜色、图标、按钮、深色及响应式约定；自动订单轮询不覆盖未保存输入，离开会话清除 Key，过期异步响应不写入新会话。 |
| `recharge-center/tests/large-recharge-alert.test.js`、`tests/large-recharge-alert-http.test.js`（新增） | 覆盖阈值上下界与等值、完成入账口径、自动账务收入 / 支出隔离、未核验结果、配置损坏、加密及脱敏、文本注入、并发去重、重启恢复、有限重试、响应限额 / 超时，以及管理员、来源、CSRF、字段白名单和测试限流。 |
| `recharge-center/tests/database.test.js` | 更新版本及表断言；旧库迁移夹具删除新增队列表，核验升级确实重新建表且历史金额不变。 |
| `recharge-center/scripts/large-recharge-preview.cjs`、`scripts/large-recharge-browser-check.cjs`（新增） | 临时账本、模拟主站与 Bark 的 loopback 本地预览；Playwright 验证桌面、手机、窄屏和深色的保存、测试、重载持久化、无密钥回显、未保存修改保留、错误反馈、清除 / 退出、普通用户隔离及布局，截图留在系统临时目录。不会连接生产、发送真实推送或暴露实际密钥。 |
| `recharge-center/package.json` | `check` 纳入新通知模块和两个预览 / 浏览器脚本语法检查，不增加生产依赖。 |
| `recharge-center/README.md`、`docs/deployment-configuration.md`、`docs/security.md`、`docs/large-recharge-bark-guide.md`（新增） | 记录页面配置、iPhone Key 取得及各项含义、单笔实付严格大于口径、仅个人码模式、持久化与升级、故障排查、隐私及外部推送可能重复的边界；无新增必填 env，不替代原异常邮件通道。 |
| `CUSTOMIZATIONS.md` | 登记本轮实现范围、验证及未部署边界，保留既有记录。 |

验证于 11-07 完成：充值中心完整 156 项测试通过；加强旧库迁移夹具后定向 3 项、修复保存时会话过期的按钮复位后前端 6 项通过，`npm run check` 和 `git diff --check` 通过。Playwright 1440px、390px、320px 和系统深色四组页面流程通过，另验证保存时会话过期会清除未保存 Key、重新登录后按钮恢复；无未捕获页面异常或整页横向溢出。已复核桌面、窄屏及深色截图，材料位于本机临时 `sub2api-large-recharge-qa`。隔离预览为 http://127.0.0.1:19894/preview，临时账本和模拟主站 / Bark；默认模拟管理员，切换“到账审核”查看配置。没有运行 Docker / Linux CI、发送真实推送、实际付款、生产访问或部署。网络超时 / 重启在 Bark 接受后发生时可能出现重复通知，但通知不会再次触发充值。

## 2026-11-06：每日明细供应商消费手动刷新

用户要求在成本分析“每日明细 → 详情”的供应商账号消费列表最右侧增加刷新按钮，能够只重新读取所选供应商在该日的实际消费。本轮仅修改现有运营中心与供应商监控的读取 / 归档能力，不直接扣余额、不改主站计费记录、不增加配置或数据库迁移，不部署或提交 GitHub。

| 文件 | 改动与保留要求 |
| --- | --- |
| `provider-monitor/src/services/gross-profit-service.js`、`src/services/daily-cost-service.js` | 每日消费读取器支持 `connectionId` 供应商范围过滤，仍只读取启用定时检查的账号、使用上游每日汇总并保留原认证、币种、缓存及超时契约；定向请求不会混入其他供应商或旧 Key 明细。 |
| `operations-center/src/services/cost-analysis-service.js` | 增加单供应商单日消费读取，核验来源、范围、日期、时区、币种和供应商身份，异常或缺失仍返回不可用，不把失败当零。 |
| `operations-center/src/daily-profit-store.js`、`src/services/daily-profit-service.js` | 增加历史日报的手动原子快照更新。历史日期只替换目标供应商并重算该日汇总，其他供应商和主站消费保持原值；今日只更新实时结果，不提前写成历史归档；后台任务占用时拒绝覆盖；定向刷新不完整时保留最后完整归档并单独排队重试。 |
| `operations-center/src/app.js` | 增加管理员认证和 CSRF 保护的 `POST /api/cost-analysis/daily-profit/provider-refresh`，请求为 `{ date, providerId }`，校验日期、未来日期和供应商 ID。 |
| `operations-center/public/cost-accounting-ui.js`、`public/cost-accounting.css`、`public/index.html` | 详情抽屉供应商账号列表增加最右侧刷新图标按钮，点击时禁用并旋转显示 loading，成功后重新读取日报并保持详情抽屉及当前日期；更新静态资源版本和按钮样式，保留移动端表格滚动与无障碍标题。 |
| `operations-center/tests/daily-profit.test.js`、`provider-monitor/tests/daily-cost.test.js` | 覆盖供应商范围过滤、历史目标供应商原子替换、后台归档不覆盖手动结果、不完整定向刷新保留最后完整归档、今日实时刷新、管理员 / CSRF 接口、停用供应商和异常响应。 |
| `operations-center/scripts/accounting-browser-check.cjs` | 四视口实际打开历史日期详情，拦截并核对定向刷新 POST 参数，验证按钮禁用 / loading、刷新后抽屉仍打开且详情保持可见，并保留现金收支、图表、分页和布局回归。 |

验证：运营中心完整 373 项测试、供应商监控完整 338 项测试全部通过；`npm run precheck`、`npm run check`、`git diff --check` 通过。Playwright 1440px、390px、320px 和系统深色四组页面流程通过，供应商刷新请求、响应和详情状态均已验证，无未捕获页面异常或整页横向溢出。使用本地 PGlite / SQLite 和模拟上游，不代表生产金额；没有运行 Docker / Linux CI、连接生产、部署或推送 GitHub。

## 2026-11-03：主站同域 Canvas 子目录

用户明确要求服务器增加 `https://aihub.fo2.us.ci/canvas`，使画布入口与主站同域。本轮保留独立域名、原服务和另一个对话已经发布的画布浅色主题 / 顶部简化，不复用曾撤销的外观改动。

画布 fork 在其最新 `2b207f1` 基础上增加子目录能力：Vite 相对资源、可由 Nginx 定位替换的 HTML base、React Router basename，以及 logo / 本地插件的前缀解析；子目录首页直接展示画布库，独立根域名首页不变。源码、CHANGELOG、待验收清单及部署说明记录在该 fork 的 CUSTOMIZATIONS。模型地址和个人 Key 不随 UI 路由改写。

Extra 新增 `infinite-canvas/docs/nginx-subpath.conf.example`：仅在既有 aihub server 引入 `/canvas` 和 `/canvas/`，去前缀后反代原 9877 容器，仅对 HTML base 做替换，不改写主站根 assets、API、monitor 或其他路由。画布路径关闭访问日志、清理主站自动附加的登录参数，并移除传给画布容器的 Cookie / Authorization；frame-ancestors 允许同源及原有受信主站别名 `aihubdirect.fo2.us.ci`、`epoint2api.fjmooo.cn`。根 Compose 和统一拉取方式保持既有配置。模块 README 记录同域入口、主站 API Base URL、独立域名数据需导出导入，以及回滚方法。

部署前将原 Nginx 站点、根 Compose / env、镜像 ID 和 15 个容器身份备份到 `/root/sub2api-deploy/backups/canvas-subpath-20261103`，目录 0700、文件 0600。生产只在 `/etc/nginx/conf.d/migrated-services.conf` 的 aihub server 增加一条片段 include，片段为 `/etc/nginx/snippets/infinite-canvas-main.conf`；原独立域名配置不变。Nginx 重载完成后需等待新 worker 接管再验证，首次即时探测命中旧页面时脚本自动恢复原配置，补充有界等待后检查通过。

主站原生管理员 API 仅更新既有菜单 `83171c9fee9a4214` 的 URL 为 `https://aihub.fo2.us.ci/canvas/`；原 9 个其他菜单、该菜单的其他字段和全部其他返回设置前后相同，公共设置接口也已确认新地址。既有账务服务内凭据只在原容器进程内使用，原设置保存在受保护备份中，没有写入画布或仓库。

画布首次子目录构建 `b3e2bd7` 的 Actions `41572545400` 成功；后续修复 Agent 连接片段清理时的重复前缀，`e36a126` 的 Actions `41573555093` 也成功。已用独立 Playwright Chrome 在 1440×900 / 390×844 验证入口补斜杠、相对资源、创建文本节点、项目深链接刷新保存、配置页、本地插件清单及同域 `/v1/models` JSON 401，无脚本异常或画布路径资源错误。主站 CSP 下的 iframe 能读取父页面 origin，确认不再跨域；模拟主站登录参数被清理，原独立域名也能创建项目。验收脚本和截图位于本机 `sub2api-canvas-subpath-20261103`；未调用收费模型。

最终验收：生产运行 `e36a126ee44c513ab1866d0d2f51fd78a3d42e9c` 且 healthy；Agent 引导片段清理保留挂载前缀，同域 GET `/v1/models` 和 POST `/v1/responses` 均能读取 JSON 401，没有 CORS 错误或收费模型调用。主站 6 项根 assets 正常，原 14 个其他容器 ID、既有 Compose / env 与其他站点配置不变，根目录 `docker compose pull` 仍包含画布。最终片段经 `nginx -t` 和平滑重载，公网返回 200、正确 HTML base 及受信 frame-ancestors。片段示例与模块 README 同步至生产模块目录，源码配置与本节台账一并提交至 Extra main，保留独立备份和验收材料。

## 2026-11-04：成本分析历史读库、今日实时与端到端超时修复

用户在生产只读排查后要求按“历史存库、今日实时”改造并修复超时。本轮在既有运营中心及供应商监控实现；不重建数据卷，不修改主站余额或计费记录，不连接生产执行补算、不提交 / 推送或部署。本地保留生产诊断证据、原有独立维护记录及其他无关文件。

| 文件 | 改动与保留要求 |
| --- | --- |
| `operations-center/src/daily-profit-store.js` | 在原 daily-profit.sqlite 非破坏性增加 daily_profit_attempts；完整快照与最近尝试独立保存。失败 / 不完整重算保留最后完整金额及 computedAt，事务性保存失败状态和退避排期；成功后按原作用域 / 日期唯一替换，租约和 generation 防重保留。旧库无需手工迁移。 |
| `operations-center/src/services/daily-profit-service.js` | 普通查询 / 刷新只读完整历史，缺失及旧失败快照自动入队，01:00 归档和漏跑补排保留；维护重算使用显式 recalculate=1，旧 accounting 刷新兼容。live=0 只读历史和今日内存快照，正常请求合并今日实时计算；短轮询缓存最多 60 秒，不因轮询延长。单日期限覆盖读取器创建和计算，超时取消、让出工作器并退避；迟到结果及数据源变更不可写入旧归档。按日返回 notices / lastAttempt / archiveStatus / nextAttemptAt。 |
| `operations-center/src/provider-monitor-client.js`、`src/services/cost-analysis-service.js` | 监控请求的 headers / body 共用强制期限，兼容不响应 abort 的底层请求；每日读取器、SSO 创建和日查询传递取消信号。保留既有认证和错误脱敏，供应商失败原因按日期归属，不把今日故障混入历史详情。 |
| `operations-center/public/cost-accounting-ui.js`、`public/index.html` | 先读取 live=0 展示历史，再独立更新今天，页头天数与当前展示同步；旧响应 / 离页隔离，历史补算仍按原节奏轮询、今日每分钟刷新。打开中的单日详情跟随实时结果更新，仅展示该日来源和最近尝试，保留完整归档时说明最近更新失败。更新静态资源版本，原现金收支逻辑保持。 |
| `provider-monitor/src/http/request-budget.js`（新增）、`src/http/client.js` | 可取消的统一请求期限，覆盖 DNS、所有重试与退避、重定向、响应体及 SSE 回调；不等待 dispatcher.close，按请求销毁连接并异步收尾。忽略 abort 的调用也会按时返回，晚到操作不继续发请求或回调。共享报告信号支持多供应商，所有监听器和计时器正常移除。 |
| `provider-monitor/src/services/daily-cost-service.js` | 整份日汇总 8.5 秒、单供应商执行 5 秒的强制预算；供应商串行锁、凭据协调、并发排队同受整体期限限制。可取消排队票据，超时释放逻辑占用，不让单家永久堵住后续请求；保存缓存 / 凭据前检查期限和配置，保留单飞、认证冷却、启用筛选、账号日汇总及折算契约。 |
| `operations-center/tests/daily-profit.test.js`、`tests/provider-monitor-client.test.js` | 历史与挂起的今日读取隔离、旧失败自动续算、刷新不重算、保留完整快照及重启后诊断、超时让出 worker、迟到响应隔离、会话创建期限、持续短轮询过期、数据源切换和监控 headers / body / 主动取消恢复。 |
| `provider-monitor/tests/daily-cost.test.js`、`tests/http-timeouts.test.js`（新增） | 永不返回的上游、卡住的供应商锁 / 凭据协调、队列耗尽 / 释放、单家隔离、冷却后恢复、超时后的旧结果 / 轮换凭据不可覆盖；真实 HTTP 测试覆盖不返回 headers、半段 body、重定向到挂起端点、30 秒 Retry-After 和下一次正常请求，另覆盖 DNS 及无界清理。 |
| `operations-center/scripts/accounting-browser-check.cjs` | 四视口实际页面流程；拦截今日实时请求但放行历史读库，证明历史列表 / 详情可用、今日失败不污染归档和日级提示、普通刷新不发历史上游请求。调整实时结果等待条件，避开动态日期与固定 09-30 示例账碰撞，失败时保存截图和状态。保留现金 CRUD、用户分页、累计过滤、图表像素及布局检查。 |
| `operations-center/README.md`、`docs/cost-accounting.md`、`docs/cost-analysis.md`、`docs/cost-analysis-automatic-plan.md`、`docs/metrics.md`、`provider-monitor/README.md` | 同步现行归档 / 实时 / 刷新口径、自动恢复、最后完整结果保留、端到端期限、维护参数和升级说明；这次需要两个服务配套更新，无新增必填配置或依赖。 |
| `CUSTOMIZATIONS.md` | 登记本轮改造、实际验证及未部署边界；其他已有记录保留。 |

验证：完整运营中心 370 项、供应商监控 337 项测试通过；持续轮询缓存的最后修复另跑相关日报 / 消费 / 监控客户端 42 项全部通过，页头状态同步后另跑前端 / 布局 20 项通过。npm run check、供应商新增及修改 JS 语法检查、diff --check 通过。Playwright 1440px、390px、320px、系统深色四组流程通过，无未捕获页面异常或整页横向溢出；已复核桌面、手机及“今日失败但历史正常”截图，使用真实本地 SQLite、PGlite 和模拟上游，不代表生产金额。材料位于本机临时 sub2api-profit-timeout-qa。浏览器检查的前两次发现并修正测试中的 09-30 日期碰撞及子页可见性 / 拦截清理等待，未因此修改现金业务逻辑。

隔离预览为 http://127.0.0.1:19888/preview，使用临时数据目录和模拟来源；原有其他预览保留。尚未部署或补写生产历史，升级须保留原完整卷并同时更新运营中心和供应商监控；旧失败日期将按持久队列自动重试，来源已被清理的历史不能凭空恢复。没有运行 Docker / Linux CI 或宣称线上超时已恢复。

用户随后明确要求提交 GitHub。本次仅提交并推送上述历史 / 实时统计、超时修复、测试、配套文档及本节维护记录；先快进同步远端画布子目录提交，合并维护台账时保留双方内容。沿用此前已通过的完整测试与四视口浏览器验收，提交前核对暂存内容和 diff --check。独立生产诊断台账、订阅手册及其他无关文件继续保留本地。沿用现有 Actions 测试和 GHCR 镜像发布流程，构建 / 发布状态以本次 SHA 为准，不部署服务器或改写生产历史。

## 2026-11-04：生产本月供应商日消费补偿入库

用户反馈升级后本月今天之前的上游消费未恢复，授权连接服务器补偿获取并保存。本次处理窗口按请求发起时的北京时间固定为 2026-11-01 至 2026-11-03；操作及最后验收在 11-04 23:49 至 23:59 完成。两个生产服务已经运行 `aceaff4b077f0d512b5198b0d517077943a3f3b4`，无需部署、重启或修改配置。本轮未修改业务源码、测试、主站余额、使用记录或现金流水，未提交 / 推送 GitHub，保留既有独立维护记录和无关文件。

三天原快照均为升级前请求监控超时产生的 `supplier_incomplete`，供应商金额为空；原任务已失败 14 次，处于一小时退避，升级不会立即清除此排期。先使用 SQLite 在线备份 API 备份原库并验证 quick_check=ok，再核对无在途租约，通过部署中原 `DailyProfitStore.enqueueDays(..., { force: true })` 仅重排这三天缺失日期。原常驻后台工作器实际请求各上游账号每日汇总，按原作用域 / 日期唯一保存成功快照，不硬编码诊断金额或直接拼写统计 SQL。

| 日期 | 主站消费 | 供应商消费 | 消费毛利 | 利润率 |
| --- | ---: | ---: | ---: | ---: |
| 2026-11-01 | 416.30515923 | 317.60115128 | 98.70400795 | 23.71% |
| 2026-11-02 | 1815.38800276 | 1513.20734550 | 302.18065726 | 16.65% |
| 2026-11-03 | 656.74983844 | 539.24630098 | 117.50353746 | 17.89% |
| 合计 | 2888.44300043 | 2370.05479776 | 518.38820267 | 17.95% |

每一天的 ailzd、apiclub、lingsu、tuokeapi、鸡出没五家均完整成功，源为 upstream_daily_summary；三天重试任务全部删除，最近尝试无错误、无 notices。使用部署中的正式日报读取服务和只读 SQLite 连续读取两次，分别 13ms / 1ms，completeDays=3、pendingDays=0、全部 mode=archived，禁止上游访问的探针计数为 0。备份中原有的 17 天完整快照内容及 computed_at 全部相同；另有 14 天十月旧失败任务由常驻调度器按原排期独立重试，未在本次强制补偿范围，不能把其自动更新时间误称为本次改写。数据库 quick_check=ok。

11-04 23:59:47 前另经原监控集成接口验证 11-04 的五家实时汇总完整，约 2060ms，查询时点上游消费为 967.05864406；11-04 没有提前写成历史快照，仍按原北京时间 01:00 调度归档。历史 HTTP 管理员会话验收未完成：服务器只有主站管理员 API Key，没有可用于运营中心浏览器登录的密码 / JWT；没有绕过认证或修改认证配置，已验证实际部署的日报服务读库结果。

一致性备份、补排前快照 / 任务状态与最终脱敏验收保存在运营中心原持久卷 `/app/data/maintenance/daily-profit-backfill-20261104T1549Z/`，分别为 `daily-profit.before.sqlite`、`before.json`、`verification.json`，目录 0700、文件 0600。备份不包含设置密钥或新增凭据，保留原卷即可跨后续容器更新保存本次补偿结果。

## 2026-11-04：成本分析历史及当日报表超时的生产只读排查

用户授权连接服务器分析截图中的 11-01 至 11-04 超时。本轮只读检查两个容器版本、运行状态和数据库，正常 GET 查询集成接口及上游账号日汇总；不部署、重启、修改配置、补写日报或操作用户资金。两个服务均运行 `e556e3e3525f2b008172ce95877fc34dda6af014`，内网地址 `http://provider-monitor:9871`，集成认证已配置，运营中心请求超时为 10000ms。健康接口实测 7–72ms；常驻监控的今日 daily-costs 请求在独立诊断客户端等待 40 秒后仍未返回。

生产 `daily-profit.sqlite` 同一作用域保存 34 个日期，范围为 10-01 至 11-03；11-01、11-02、11-03 当前快照的主站消费完整、供应商消费为空，错误是集成请求超时，后台任务以 `DAILY_PROFIT_INCOMPLETE` 重试。用只读连接和禁止入队 / 访问上游的诊断实例读取这三天，16ms 返回、上游调用 0 次，确认页面中的历史超时文字来自已保存的失败状态，不是读取 SQLite 超时。库只保留最新快照，不能凭现存记录确认这三天过去是否曾有成功结果。

逐家从同一服务器使用已保存且仍有效的访问令牌 GET 验证 ailzd、apiclub、lingsu、tuokeapi、鸡出没，今日 profile 与日汇总均返回 200，单家汇总总耗时约 258–661ms。再以部署中的原 DailyCostService、新建独立内存请求状态、只读 SQLite 和拦截全部缓存写入 / 非 GET 的适配器验证：今日五家完整汇总约 1640ms；11-01、11-02、11-03 分别约 2165 / 1582 / 1538ms，五家全部完整，对应上游折算总消费 317.60115128、1513.20734550、539.24630098。诊断结果未写回生产，实时金额仅代表查询时刻。

已定位故障范围为常驻监控进程的日报聚合等待，而非当前上游接口普遍不可用、内网不通或缺汇率；具体最初挂起的底层调用没有现场调用栈，不能断言其触发原因。代码存在明确可靠性缺口：daily-cost-service 的供应商串行锁 / 并发队列和 Promise.all 没有端到端等待上限，HTTP 计时不覆盖前置 DNS 和结束时 dispatcher.close，因此标称 5 秒 / 8.5 秒预算不是整条调用的强制上限。另有 daily-profit-store.finish 无条件覆盖快照的问题：重算失败可以覆盖此前完整结果，且页面单日详情展示整段日期的 notices，容易混淆今日实时失败与历史归档失败。建议后续修复整体超时与任务隔离、保留最后完整历史结果并独立保存失败状态、按日展示来源提示，再补算缺失日期；本轮仅登记排查证据，没有修改这些业务实现、执行新版功能测试或声称线上恢复。原有未提交维护记录及无关文件保留。

## 2026-11-02：Infinite Canvas 独立镜像与子服务部署

用户明确授权为自己的 `fjiangming/infinite-canvas` fork 创建镜像，并在现有服务器 Extra 目录部署、配置 `canvas.fo2.us.ci` 独立域名，纳入根目录统一拉取更新。本轮使用独立工作树维护配置，不提交或覆盖原工作区的错误分析、现金统计、生产维护等无关改动。

源码仓库配置：根 `docker-compose.yml` 增加 `infinite-canvas/compose.yaml`；`compose.services.env` 支持列表增加模块，默认已启用项保留。新增 `infinite-canvas/compose.yaml`，使用 `ghcr.io/fjiangming/infinite-canvas:latest`、loopback 9877 → 3000、健康检查和轮转日志，无数据库或数据卷；新增 `infinite-canvas/docs/nginx.conf.example` 与模块 README，根 README 登记镜像和更新方式。

fork 发行：只调整 `.github/workflows/docker-image.yml`、`docker-compose.yml`、README，并新增部署说明和该 fork 的 CUSTOMIZATIONS。main / 版本标签 / 手动构建，镜像名称随仓库，default branch 发布 latest、保留短提交和完整 SHA 标签；两种原生架构成功后再合并并校验清单，原画布业务、浏览器存储、API 调用和作者信息不变。

生产接入：保留原 Compose 项目及五个已部署模块，在根 include 与原 profile 列表追加画布；根目录原无 `.env`，建立指向 `compose.services.env` 的相对软链接，使普通 `docker compose pull` 也启用画布。现有 Nginx 为 Cloudflare HTTPS 入口后的 80 端口站点，独立新增 canvas 配置并仅平滑重载；不占用已由其他服务使用的 443。画布入口清除未使用的主站登录查询参数、关闭访问日志；固定 `/v1/` / `/v1beta/` 转发到现有主站 9000，用户自行配置个人 API Key，保留原生计费，不接 SSO、不建立用户作品数据库。

主站入口：核对已部署主站版本支持设置部分更新，通过原生管理员 API 仅追加 custom_menu_items，新增用户可见“无限画布” → `https://canvas.fo2.us.ci/canvas`，ID `83171c9fee9a4214`；主站自动将该域名纳入 frame-src。前后比较原 9 个菜单及全部其他返回设置，均保持一致。管理员凭据只在原容器进程内使用，没有写入画布、仓库或部署环境文件。

部署于北京时间 11-02 至 11-03 完成：fork 提交 `7676c01526119080f5a373aff3c3cd861cc422e2` 的 Actions `41474449809` 成功，amd64 / arm64 清单与匿名拉取确认；镜像索引 `sha256:1cce2c09ad541a1f7b4edcbf4ec3d0732cdcd262ec4cd1fc59658a6e1b02a52d`，服务器实际运行版本标签一致且健康。Compose 前后结构比较原五模块及资源不变，默认 `.env` 与显式 env-file 完全一致，根 pull 预演覆盖六模块；原有 14 个容器 ID、三个 Nginx 站点文件校验和不变，nginx -t 与平滑重载成功。

公网 HTTPS 页面、config.js、JS / CSS / 图标资源正常；含模拟登录参数的入口 302 到无查询地址；无 Key 的 `/v1/models` 返回主站 JSON 401。独立 Playwright Chrome 验证 1440×900 / 390×844 新建画布、添加文本节点、刷新后 IndexedDB 数据保留，无本域资源失败或未捕获脚本异常，桌面编辑与主站来源 iframe 实际加载成功并已复核截图。原版手机项目编辑侧栏 / 工具栏拥挤，此次保留上游界面并记录限制，不宣称手机布局完善；未调用收费模型。验收截图和临时脚本在本机 `sub2api-canvas-deploy-20261102`；生产原配置及菜单受保护备份位于 `/root/sub2api-deploy/backups/infinite-canvas-20261102`。

## 2026-11-02：错误分析 Tab 正式实现与默认今天

用户确认将默认近七日改为今天后开发，本轮在现有运营中心增加正式“错误分析”Tab；保留独立现金收入、生产维护、订阅文档、无关工程和 SVG 等本地改动。功能只读主站错误日志 / 本地诊断 / 供应商历史映射，不运行推理重试、上游同步、计费核查或资金写入。无新增依赖、必填环境配置或错误分析数据库；本轮不连接生产、不提交 / 推送或部署。

| 文件 | 改动与保留要求 |
| --- | --- |
| `operations-center/src/services/request-errors-source.js`（新增） | schema 探测、只读有界 PostgreSQL 快照与跨日后续错误补取；不读取请求正文和密钥，错误体只在进程内提取有限代码，来源表缺失 / 截断 / 遥测故障与真实零值分开。 |
| `operations-center/src/services/request-errors-classifier.js`（新增） | 可信直接根 ID 与用户 / Key 身份关联、尝试链、五类最终结果与十二类失败；缺结束 / 冲突保留待判定，缺根身份单列待关联，非流式完整响应不要求 SSE terminal，恢复须完整尝试与下游终止证据。 |
| `operations-center/src/services/request-errors-service.js`（新增） | 默认今天 / 最多 31 日、期间 / 每日 / 失败类型 / 分组和 Key / 用户 / 请求与原因矩阵、分页 / 稳定分母 / 独立去重；按尝试时刻验证历史 Key，歧义或来源不可用保留账号；10 秒缓存 / 单飞 / 数据库切换拒绝旧响应。 |
| `operations-center/src/app.js`、`src/server.js` | 注入服务；新增管理员、no-store 的 options / report / requests/:id GET 接口，不增加资金或重发写入口。 |
| `operations-center/src/latency-telemetry-store.js` | 白名单接收可选用户 Key / 分组与版本 1 下游终止证据；添加开始日索引和只读直接根查询，不用客户端 / 上游别名关联，不套用资金的管理员排除规则。失败后恢复的尝试链保留 30 天，普通完成仍 7 天，沿用原有卷和容量限制。 |
| `operations-center/src/provider-monitor-client.js`、`provider-monitor/src/server.js`、`provider-monitor/src/services/latency-samples-service.js` | 增加集成 Token / 管理员 SSO 的只读历史映射接口，跨 Key 替换 / 删除保留 ID；不输出凭据或 config_json，不发上游探测 / 同步。别名明确是当前名称，缺快照不冒充历史名称。 |
| `operations-center/public/request-errors-ui.js`、`public/request-errors.css`（新增）、`public/index.html`、`public/app.js` | Tab 和样式 / 版本接入；默认今天与失败类型，十二类下钻、分组展开 Key、按用户和请求分页、详情及原因 × 全结果；显示 HTTP 200 流错误 / 无错误事件的已证实断流 / 恢复 / 证据缺口；离页取消、过期响应隔离、当日每分钟刷新和跨日更新。保留 index 中独立现金脚本版本。 |
| `operations-center/tests/request-errors-fixture.js`、`tests/request-errors.test.js`（新增）、`tests/latency-telemetry.test.js`、`tests/provider-monitor-client.test.js`、`tests/frontend-layout.test.js`、`provider-monitor/tests/latency-samples.test.js` | 隔离 PGlite / SQLite、真实 SQL、十二类型对平、身份 / 终止证据 / 重试覆盖、跨日迟到、Key 替换 / 删除 / 歧义、来源故障恢复 / 截断、缓存切换与管理员边界测试；更新新增 Tab 后的模块数量断言。 |
| `operations-center/scripts/request-errors-preview.cjs`、`scripts/request-errors-browser-check.cjs`、`scripts/check-sub2api-error-telemetry.cjs`（新增）、`operations-center/package.json` | 隔离模拟预览、五视口浏览器流程与截图；新增预览 / 页面检查 / 语法检查 / Go 集成检查脚本，npm run check 自动覆盖新文件，Playwright 复用本地运行时而非新增生产依赖。Go 标准库包正常 vet / 测试，真实主站 middleware 用临时 overlay、Windows 虚拟目录单独关闭 vet 后验证，不自动安装到主站。 |
| `operations-center/integrations/sub2api/latencytrace/delivery.go`、`delivery_test.go`（新增）、`latencytrace/trace.go`、`latency_middleware.go`、`latency_middleware_test.go`、`install.cjs` | 标准协议的有界下游观察器，在原 Write 之后检查实际成功写出的 SSE / JSON 元数据，记录完整正常终止、错误写出、已完整观察的提前断流和断开，准确 HTTP 尝试总数及用户 / Key / 分组 ID；不会缓冲转发或改变响应 / 重试。超限 / 不支持协议 / 缺证据保留未知，不导出正文。更新安装文件列表和 Go 用例，已有插桩拒绝重复安装。 |
| `operations-center/docs/request-error-analysis-plan.md`、`docs/slow-requests.md`、`operations-center/README.md`、当前会话可视化目录 `request-error-analysis.html`、本台账 | demo 与正式默认日期统一为今天；补充当前接口、实际接入条件、旧采集缺口、当前别名、无独立归档及保留期边界，更新主站模板接入说明，保留原方案与其他维护记录。 |

实际采集边界：旧版主站插桩没有完整的版本 1 终止证据。本次补齐接收 / 分类和配套主站采集模板，并用本地真实主站类型验证，但未自动修改现有主站工作区或安装 / 部署；必须合并配套采集后才有新的完整下游证据。旧日志仍不能仅凭 200 或 Recovered 标记认定成功。即使错误表无记录，可信终止采集的异常也独立计入请求，错误表行数不虚构。当前预览的三百个最终失败等数字均来自模拟数据，不是生产统计；长期派生归档仍未新增，不恢复旧挂载或重写历史。

验证：完整运营中心 363 项测试、供应商监控 330 项测试、npm run check 与 diff --check 通过。Go 标准库采集包（含终止协议分表用例）与真实主站 middleware 的 overlay 编译 / 行为测试通过；验证 502 尝试后正常输出、HTTP 200 SSE 错误、无错误事件的完整观察断流，响应内容和状态不变。错误专项另外覆盖没有错误表记录但有可信终止证据仍可计入失败，以及重试恢复保留 30 天。Playwright 1440px、1024px、390px、320px 与深色偏好五组实际页面流程通过，默认今天、十二类型 / 稳定占比、Key 下钻、用户分页搜索、HTTP 200 断流 / 重试恢复、待关联查看、原因矩阵、近七日切换、来源失败与恢复均验证；无未捕获脚本异常或整页溢出。已复核桌面、手机及详情截图，材料位于本机临时 `sub2api-request-errors-qa/`。隔离预览按页面注明模拟来源，默认端口 19892；未运行 Docker / Linux CI 或生产验收，未改生产数据、部署或安装主站插桩。

2026-11-03 用户明确要求提交 GitHub。本次将错误分析实现、配套供应商只读映射接口、主站采集模板、测试、预览脚本、规划与接入文档及本功能维护记录提交并推送 extra main；先同步远端已提交的 Infinite Canvas 配置，保留双方维护记录。独立生产诊断台账、订阅手册、其他工程与图标继续保留本地，不纳入本次提交。提交前核对暂存快照，沿用既有 Actions 测试及 GHCR 镜像发布流程；实际构建状态以本次提交 SHA 的 Actions 为准。本次不部署服务器或安装主站插桩，完整下游终止证据仍需主站配套接入。

提交前将暂存内容导出到本机临时目录隔离复核：运营中心完整 363 项、供应商监控完整 330 项测试及 npm run check 均通过；git diff --cached --check 通过。独立原型仍保留在会话可视化目录，GitHub 包含正式页面及可复现的模拟预览脚本。

## 2026-11-02：现金历史累计固定从 10 月 1 日开始

用户要求成本分析现金收支中的历史收入、历史支出、累计净结余仅统计 2026-10-01 之后的数据。本轮按资金时区 2026-10-01（含当天）至今实现；当前用户余额仍取现值，排除 ID 1 和已删除用户。仅修改现有运营中心的累计汇总，不改原收支、防重、消费毛利、主站余额或资金；此前记录保留可查，本期卡片 / 趋势 / 列表仍按页面日期。无新增配置、依赖或数据库迁移，不连接生产、提交 / 推送或部署；保留正在进行的错误分析源码 / 文档、所有独立维护台账与无关文件。

| 文件 | 改动与后续保留要求 |
| --- | --- |
| `operations-center/src/services/cash-flow-service.js` | 累计起点常量 2026-10-01；所有来源先按既有 ID / 关联防重，再按资金日筛选累计收入、支出、数量和人民币组成。累计净结余减当前非管理员用户余额，不受查询日期 / 粒度 / 搜索 / 收支 / 来源 / 分页影响。响应 from 固定起点、to 为资金时区今天；退款缺失按退款发生日判断，原收款更早不能漏掉起点后的退款，起点前退款不再阻断累计。全历史归档 / 同步保留用于历史查询和跨起点防重。 |
| `operations-center/public/cost-accounting-ui.js`、`public/index.html` | 历史三卡注明 2026-10-01 起，详情展示包含起点当天的范围，折叠规则和累计组成统一口径；更新成本脚本版本。保留同一 index.html 中其他会话新增导航 / 静态资源。 |
| `operations-center/tests/cash-flow.test.js` | 两项新增回归覆盖 09-30 23:59:59.999 / 10-01 00:00 资金时区边界、自动 / 手工 / 原 JSON 收支、正负兑换、跨起点订单防重、日期及全部列表筛选独立、旧记录修改与重启保留；验证起点前退款不阻断、早期订单在起点后退款仍缺失直到取得实际金额。 |
| `operations-center/scripts/accounting-browser-check.cjs` | 隔离示例增加 09-30 收入 999 / 支出 777，验证原期间记录可见但不进入累计；新增旧支出 / 修改 / 删除也按累计起点处理。检查三卡与下钻日期标注、切换旧日期 / 搜索累计不变，保留现金 CRUD、余额分页、图表及四视口布局回归。 |
| `operations-center/README.md`、`docs/cost-accounting.md`、`docs/cost-analysis-automatic-plan.md`、`docs/cost-analysis.md`、`docs/metrics.md` | 更新固定起点公式、包含当天 / 资金时区、独立筛选、旧账保留、退款日期及 API 范围说明，无需运维修改配置或重建账本。 |
| `CUSTOMIZATIONS.md` | 记录本轮修改与验证，原有维护记录保留。 |

验证：30 项现金测试全部通过，npm run check 及最终 diff --check 通过。Playwright 1440px、390px、320px 和深色四组页面流程通过，桌面 / 手机截图复核，无页面溢出或未捕获脚本异常；截图位于本机临时 sub2api-cumulative-cutoff-qa。未重复其他未变业务的完整测试。独立示例 http://127.0.0.1:19887/preview 已启动并返回 200，查询 9 月时累计仍从 10-01 开始，只使用模拟源与临时 SQLite，原有其他预览进程保留。没有执行生产核算、变更或部署。

用户随后要求提交 GitHub，本次仅提交并推送固定累计起点的实现、测试、五份配套说明及本节台账到 extra main。共享 README / index / 本台账按本轮内容单独暂存，错误分析的实现 / 导航 / 文档、独立生产维护记录和其他未提交文件保留本地。推送前核对远端及暂存快照；将待提交内容导出到本机临时目录隔离验证，完整 349 项测试、npm run check 通过。沿用现有 Actions 测试 / GHCR 镜像流程，发布状态以本次提交 SHA 的运行结果为准，不部署或变更生产服务。

## 2026-11-02：错误分析 Tab 规划与交互 demo

用户引用“分析502重试与下游最终响应”会话，要求先规划并提供 demo 等待确认。本轮新增 `operations-center/docs/request-error-analysis-plan.md`：按日 → 分组 → 供应商 Key → 请求链路，支持用户统计；错误原因与下游最终结果分离，互斥区分重试恢复、HTTP 失败、流式失败、客户端断开及待判定。HTTP 200、Recovered / resolved 标记和已有用量不能单独证明成功；上游 403 与下游 502 分列，跨 Key 请求的组 / 用户总数独立去重。定义跨日归属、失败尝试、历史 Key 映射、证据冲突 / 缺口及拟定只读 API、归档和验收范围。

在当前会话可视化目录新增 `request-error-analysis.html` 独立交互稿、预览包壳及本地浏览器验收材料，使用 10-27 至 11-02 的确定性示例请求，提供日期 / 分组 / 供应商筛选、每日分布、展开 Key、用户分页与详情、请求链路、结果 / 原因筛选和统计口径。与原话题跨自然日的真实数字分离，不把旧 52 条日志冒充某日结果；demo 不读取真实数据库、凭据、日志或上游。

本轮只新增规划文档与本节记录，不修改正式业务源码、导航、配置、依赖、数据库或测试。接入方案明确现有文件日志读取器不保留本页所需结束字段，且生产旧 CSV 日志挂载已撤除；缺下游证据必须保留待判定，不能承诺现有来源足以还原全部历史。保留所有独立生产维护记录、订阅手册、无关工程和图标；不连接生产、提交 / 推送或部署。

验证：独立 demo 的 Playwright 1440px、1024px、390px、320px 与深色五组流程通过；464 个模拟根请求、五类互斥结果、跨 Key 不可加性、供应商筛选下实际失败尝试、受影响用户去重、日期 / 分组筛选、用户搜索 / 分页 / 请求详情与返回、HTTP 200 流内失败、恢复及未知、空状态、无效日期和原因矩阵下钻均验证。复核桌面 / 手机 / 深色截图并调整窄屏结果详情布局，表格局部横向滚动、不撑开整页，无未捕获脚本异常或数据网络请求。使用现有本地 Lucide 静态库完成隔离浏览器检查，未添加依赖；交互稿约 56 KB。文档 diff --check 通过，正式业务未改动，未运行或声称新业务测试通过；本轮不运行生产日志分析、资金操作或部署。

用户继续反馈下游失败分析不清晰，要求在该类型下继续细分。本轮更新同一规划、独立 demo 与其浏览器检查：默认下游失败类型视图 / 仅已确认失败、期间失败首卡、可选择分析日与折叠每日概览；十二类覆盖余额不足、上游认证 / 权限、限流、服务故障、无账号、连接 / 首响应超时、本站校验、流内错误、输出中超时、提前结束、网关异常、已确认失败但根因未明。展示实际 HTTP / 流表现、是否已输出、类型请求 / 稳定占比 / 用户数、重试后仍失败 / 未重试 / 未知，类型可连续下钻分组、Key、请求或用户；详情区分无错误事件但已证实断流与仅缺结束证据。原因与结果对照保留同日全结果，不因默认失败筛选将重试恢复显示为零；从对照下钻会清除不兼容的失败类型。保持五类结果口径与跨 Key 去重，不修改正式业务、资金、配置或部署。

新版验证：Playwright 1440px、1024px、390px、320px 与深色五组流程通过。464 个示例请求中 320 个最终失败，分析日 33 个失败覆盖十二类且逐项合计对平；恢复 / 断开 / 待判定不带失败类型。验证类型 → 分组 / Key → 请求及类型 → 用户筛选保持、类型人数去重、重试证据 / 分项、稳定占比分母、502 后路由耗尽归无账号、两种超时、无错误事件但已证实断流、已确认原因未知与结果未知分离，以及旧版交互状态迁移。沿用日期 / 供应商 / 搜索分页和详情回归，复核桌面 / 手机 / 深色截图；无整页溢出、未捕获脚本异常或数据网络请求。仍为隔离交互稿约 70 KB，仅本地原型验收；正式业务接入、来源不可用状态和分类器测试等待确认后实施。

## 2026-11-02：恢复自动兑换入账与独立历史收支卡片

用户反馈更新后成本分析自动收入为零，授权连接服务器排查，并明确确认“恢复旧版兑换入账口径，排除非金额类型，并与订单防重”。本轮仅修改 extra main 的既有运营中心；保留所有独立生产维护台账、订阅手册、无关工程与 SVG，不改主站余额或资金、供应商监控、数据库结构和配置，不提交 / 推送、发布或部署。

生产只读核对：运营中心与供应商监控均为 d720cde。不是连接失败，而是上一版现金自动收入仅认已付款订单 pay_amount + paid_at；实际 8 个订单均未付款（2 EXPIRED、6 CANCELLED），因此为零。主站本月有 31 条非 ID 1、已使用的余额兑换，合计 1,851 元；全历史 677 条合计 37,996.49250992 元，包含带符号管理员余额调整。未使用及并发等非金额记录不能作为收入。

另在服务器进程内存中加载候选现金服务，与已部署服务读取同一组原始归档、旧账及只读 PostgreSQL 快照对照；没有写入脚本 / 配置、运行同步 / 初始化、重启容器或改生产 SQLite。2026-11-02 北京时间约 11:57 的快照：候选本月自动收入 1,851 元，与源 SQL 精确相同；累计收入 37,996.49250992、支出 31,400.1、当前非 ID 1 且未删除用户余额 1,382.73917372，累计净结余 5,213.65333620 元。日期 / 搜索 / 收支筛选不影响累计，未发现关联订单重复贡献。余额会随实际使用变化，此为当时快照，不是固定上线验收金额。诊断仅输出聚合，无凭据落盘或进入仓库。

| 文件 | 本轮改动与后续保留要求 |
| --- | --- |
| `operations-center/src/services/cash-flow-service.js` | 恢复已使用 balance / admin_balance 的带符号 value + used_at 入账，排除 ID 1、非金额类型、无有效日期和金额；沿用有效旧非现金 / 未支付 / 排除事实。订单与已使用余额兑换关联后，由兑换金额与日期承接一次收入，原订单只读保留并注明不再入账；无此关联的有效已付款余额 / 订阅订单继续补充。已排除的兑换也阻止迟到关联订单重新入账。兑换 / 支付 / 手工按稳定 ID 和明确来源关联防重，不凭金额、日期或同一用户猜测；已归档来源删除或外键清空仍保留。 |
| 同上 | 只有支付、兑换两类历史扫描均完成且来源可读，才展示完整自动收入；缺兑换表或只扫完部分兑换不能冒充完整零值。保留有界分批、断点、后台重试、审计、手工 CRUD、退款未知传播和人民币原数值口径；无需新配置或数据迁移。 |
| `operations-center/public/cost-accounting-ui.js`、`public/cost-accounting.css`、`public/index.html` | 现金第一行三卡：本期收入、本期支出、净现金流；独立第二行四卡：历史收入、历史支出、当前用户余额、累计净结余。历史卡片使用不含页面筛选的全历史汇总，收入 / 支出 / 净结余可查看组成，余额可打开用户分页搜索。统一自动入账名称，详情区分兑换 / 付款，折叠规则说明兑换可能含赠送 / 优惠、不是渠道实收；兼容手机两列及长金额，更新静态版本。 |
| `operations-center/tests/cash-flow.test.js` | 新增无已付款订单仍取得线下余额兑换、带符号调整 / 非金额排除、兑换与订单跨日期防重、手工及迟到兑换 / 订单合并、有效旧排除和源更正、4,001 条分批 / 缺表保护，以及真实 PGlite SQL 的未使用 / 管理员 / 非金额排除与删除保留回归。更新旧金额断言，保留 HTTP 权限 / CSRF / 只读 / 幂等 / 退款保护。 |
| `operations-center/scripts/accounting-browser-check.cjs` | 更新自动入账合计和记录数，验证本期三卡 / 历史四卡位置、历史组成及余额下钻、兑换只读及订单不再计入、搜索 / 日期独立和现金新增 / 修改 / 删除后的历史累计。沿用四种视口、图表像素、布局、旧汇率不放大、离页 / 旧响应和缺来源回归。 |
| `operations-center/README.md`、`docs/cost-accounting.md`、`docs/cost-analysis-automatic-plan.md`、`docs/cost-analysis.md`、`docs/metrics.md` | 更新当前兑换入账代理口径、正负值 / 非金额排除、订单防重、线下自动入账与手工来源关系、两行卡片及全历史独立范围；明确实付 100 得 120 额度已兑换时计 120，关联 100 不再相加，无须逐笔核算。 |
| `CUSTOMIZATIONS.md` | 登记本轮全部源码、测试、说明及只读验证，保留之前独立改动。 |

验证：完整运营中心 347 项测试、28 项现金专项、npm run check 和最终 diff --check 通过。新增的“已排除兑换 + 迟到支付”先复现 100 被重新计入的问题，再验证修复后为零且来源更正会撤销过期排除。Playwright 的 1440px、390px、320px 和深色四组实际页面回归通过，图表非空、指标与控件无整页溢出或未捕获脚本异常；桌面 / 手机截图已复核，位于本机临时 sub2api-restored-income-qa。隔离示例 http://127.0.0.1:19886/preview 已启动并返回 HTTP 200，只含模拟主站 / 上游与临时 SQLite；原有其他预览不受影响。没有运行实际 Docker / Linux CI、提交 GitHub 或部署生产，本轮更新仅需运营中心且保留原数据卷。

用户随后明确要求提交 GitHub。本次据此仅提交并推送上述自动收入修复、历史卡片布局、测试、说明和本节维护记录至 extra main；沿用已通过的 347 项测试、语法检查和四组浏览器验收，推送前 fetch 核对远端及暂存内容。其他独立生产维护台账、订阅手册、工程及 SVG 保留本地；沿用现有 Actions 测试与 GHCR 镜像流程，发布状态以本次提交 SHA 的运行结果为准，不部署服务器。

## 2026-11-02：简化现金支出表单并默认供应商付款

用户要求现金支出“记一笔”去掉项目名称、支出类型默认供应商付款。本轮在现有人民币现金收支改动上继续实现，保留无关文件和独立维护记录，不修改主站余额或资金，不连接生产、提交 / 推送或部署。

`operations-center/public/cost-accounting-ui.js`：新记账默认支出 / 供应商付款，供应商仍需明确选择，供应商汇总行入口继续预选对应供应商。支出项目输入隐藏、禁用并移除必填，提交时自动生成“供应商名称 付款”或“自定义支出”；切到收入时保留项目名称输入和必填校验。编辑历史支出且原类型 / 供应商不变时保留旧名称，更换类型或供应商后重新命名；不改后端记账 / 防重契约。`public/index.html` 更新静态脚本版本。

更新 `operations-center/scripts/accounting-browser-check.cjs` 验证默认类型 / 未误选供应商、支出无需名称可保存、收入仍必填名称、自动名称 / 编辑保留及自定义支出保存删除；沿用既有现金 CRUD、人民币累计、图表和布局回归。更新 `operations-center/README.md`、`docs/cost-accounting.md`、`docs/cost-analysis-automatic-plan.md` 操作说明。无新增配置、依赖或数据库迁移。

验证：npm run check 及本轮 diff --check 通过；Playwright 1440px、390px、320px 和深色四组完整现金页面回归通过，无未捕获脚本错误或整页 / 数值溢出。额外在现有本地示例 19885 验证默认支出表单，桌面 / 手机截图已复核，截图位于本机临时 `sub2api-cash-entry-qa/`；供应商付款、自定义支出无名称输入均能保存，修改名称保留，收入切换与必填正常。本轮无后端行为修改，未重复上一轮已通过的 341 项后端测试；使用隔离示例，不代表生产验收。

用户随后明确要求提交 GitHub。本次将本节支出表单简化及下一节人民币原数值口径一并提交并推送 extra main，包含配套测试、配置示例、文档和这两节台账；沿用已通过的 341 项测试、最新语法检查和四组浏览器验收。推送前 fetch 核对远端，其他独立生产维护记录、订阅手册及无关工程继续保留本地；沿用既有 Actions / GHCR 流程，构建发布状态以本次提交 SHA 为准，不连接或部署服务器。

## 2026-11-02：现金收支统一人民币原数值口径

用户要求现金收支不再区分 USD / CNY，并明确确认“金额不变，100 USD 按 100 元人民币统计”。本轮只修改运营中心现金模块，所有来源金额原数值统一计人民币；不套用市场汇率，不改供应商实际消费 / 余额估值的倍率汇率、主站余额、计费补记或真实资金。既有独立生产维护台账及无关文件原样保留；本轮未连接生产、提交 / 推送或部署。

源码：`operations-center/src/services/cash-flow-service.js` 去掉现金的币种分桶与现金汇率折算，期间卡片、趋势、分页列表、详情及全历史累计同口径；缺币种不再使现金未知，缺收款来源 / 实际退款金额 / 当前余额仍保留未知。新建 / 修改固定保存 CNY，兼容旧币种参数及旧 USD UUID 重试；旧 JSON、SQLite 原币种 / 已存汇率和审计不批量重写，仍按稳定 ID 防重、沿用有效旧排除 / 未支付事实。`public/cost-accounting-ui.js` 去掉币种筛选、输入和原币拆分，统一标注人民币 / 元，保留保存后自动切日期定位与 CRUD；`public/index.html` 更新现金脚本版本。

测试：更新 `operations-center/tests/cash-flow.test.js`，覆盖多币种 / 缺币种原数值合并、旧汇率不放大、四种粒度与趋势同源、旧 USD 幂等请求、原值留档、旧 JSON 和归档重启、退款未知传播。更新 `scripts/accounting-browser-check.cjs`，验证无币种控件、旧 USD 支付与手工记录按人民币展示和编辑、新增立即展示、累计金额及桌面 / 手机图表布局。

文档 / 配置示例：更新 `operations-center/.env.example`、`README.md`、`docs/cost-accounting.md`、`docs/cost-analysis-automatic-plan.md`、`docs/cost-analysis.md`、`docs/metrics.md`。`FINANCE_CASH_EXCHANGE_RATES` 仅兼容保留，不再参与现金金额计算，无新增必填配置、依赖或数据迁移；供应商监控配置仍按原规则使用。

验证：运营中心完整 341 项测试全部通过，npm run check 通过。Playwright 的 1440px 桌面、390px / 320px 手机及深色外观四组真实应用流程通过；历史 USD 订单 / 手工现金按原数值计人民币、原存档未重写，无币种筛选 / 输入，现金新增 / 修改 / 删除、跨筛选定位、累计及退款 / 重试口径均验证。图表画布非空、布局无整页 / 数值溢出或未捕获脚本错误；桌面和手机截图已复核，保存在本机临时 `sub2api-rmb-cash-qa/`。测试仅使用隔离 SQLite、PGlite 和模拟供应商，不读取生产或真实资金。

## 2026-11-02：供应商余额独立检查与逐家刷新周期

用户要求将余额检查从资产 / 日志同步中独立，并支持每家配置刷新时间。本轮只修改供应商监控；保留正在开发的运营中心现金收支、规划、订阅手册和其他无关变更，不连接生产、不提交 / 推送或部署，不执行充值、支付或扣款。

涉及源码：`provider-monitor/src/services/balance-monitor-service.js`（新增）、`src/services/sync-service.js`、`src/repositories/provider-repository.js`、`src/db/index.js`、`src/server.js`、`src/services/alert-service.js`、`src/services/automation-service.js`、`src/services/query-service.js`、`src/services/transfer-service.js`；`src/adapters/base.js`、`src/adapters/sub2api.js`、`src/services/daily-cost-service.js`、`src/services/catalog-service.js`、`src/services/checkin-service.js`、`src/services/recharge-link-service.js`；`public/app.js`、`public/index.html`。新增余额检查服务，独立每 5 秒扫描到期连接、有界并发、同供应商单飞，不占用资产队列；默认每分钟读取账号余额，成功即保存和评估余额告警 / 自动化，不等待分组、Key、日志、映射比较。全量同步先完成余额步骤，后续不再覆盖账户余额，保留原资产 / 采购 / 用量核算流程。

两类周期分别按供应商配置 1–1440 分钟；余额默认 1 分钟且无随机延迟，资产保留原值与原有随机延迟。schema v35 自动新增余额周期、排期、最后成功、错误和失败计数字段，不覆盖旧阈值、资产周期或凭据。周期和连接配置变化立即重新排期，停用停止定时检查，失败保留旧真实余额并单独标错 / 退避；限流至少 5 分钟，手动刷新可重试。新增管理员与 CSRF 保护的独立余额刷新接口，编辑页 / 供应商卡片分别展示周期和更新时间，卡片与总览支持刷新余额；复制、导入导出和备份延续周期，旧导入不重置已有余额周期。历史条数受限时保留最新样本，避免分钟级采样后预测误读旧余额。

已保存 Sub2API 会话通过同一仓库上下文协调续期，读取最新凭据并核对后原子保存，覆盖余额、全量 / 定向日志、日报、目录、签到、充值中转及使用已保存凭据的探测 / 验证 / Key 发现。凭据或连接在请求期间改变时不保存旧余额或覆盖新 Token；不承诺上游撤销后仍能自动恢复。

测试：新增 `provider-monitor/tests/balance-monitor.test.js`，更新 `tests/sync.test.js`、`tests/server.test.js`、`tests/database-migration.test.js`、`tests/frontend-behavior.test.js`。覆盖独立读取、即时两级提醒、慢同步 / 队列占满不阻塞余额、旧结果不覆盖、逐家周期与停用、退避与恢复、Token 并发续期、配置变更隔离、导入导出 / 复制、真实 HTTP 鉴权和 CSRF、旧库迁移和最新历史样本。新增 `provider-monitor/scripts/balance-monitor-preview.cjs` 与 `scripts/balance-monitor-browser-check.cjs`，使用隔离 SQLite、示例供应商和模拟 HTTP 提供本地预览及桌面 / 手机验收，不读取真实凭据或访问上游。更新 `provider-monitor/README.md` 调度与配置说明，并纠正原文中“内置规则每小时重复提醒”与既有代码不符的描述，提醒去重行为本轮不变。

验证：供应商监控最终完整 329 项测试全部通过，111 个 JS / CJS 文件语法检查、相关 diff --check 通过。Playwright 使用本机 Chrome 在 1440px、390px、320px 验证两种周期独立编辑、无效值拦截、保存 / 刷新后保留、卡片与总览直接刷新余额及布局，无页面脚本错误或整页横向溢出；截图在忽略的 `provider-monitor/data-preview/balance-monitor-qa/`，已复核桌面和手机截图。仅本地隔离数据库与模拟 HTTP，未读生产凭据、调用收费模型或写入真实资金；预览为示例服务，不代表已经部署。未改运营中心源码，本轮不将其他会话正在进行的运营中心测试计入验证结果。

用户随后要求核对影响，并在不需要手动配置时提交 GitHub。本次确认 v35 自动迁移和默认一分钟余额检查无需新增环境变量、手工建表或重设阈值 / 通知通道；原资产周期保留。余额查询频率提高，显式“连续命中”及已启用低余额 / 恢复自动化随真实快照更快触发，原去重与动作限制保持；不产生模型调用或直接扣款。仅将上述供应商监控实现、测试、预览工具、README 与本节记录提交并推送 extra main；运营中心开发、设计文档、独立生产记录和其他无关变更保留本地。沿用此前通过的 329 项完整回归及页面验收，推送前核对远端和暂存内容；Actions / 镜像发布状态以本次提交 SHA 为准，本次不部署服务器。

## 2026-11-02：实现自动消费毛利、简洁现金收支与累计净结余

用户确认最新两视图方案并要求正式开发，首先核对累计净结余扣除的余额排除系统管理员 ID 1。本轮仅在既有运营中心实现；保留原数据卷、旧账、日报和审计，不修改主站余额、计费补记或供应商监控源码，不提交 / 推送、发布或部署。此前规划章节及独立生产维护记录、订阅手册、无关文件继续保留。

| 文件 | 改动与后续必须保留的行为 |
| --- | --- |
| `operations-center/src/services/cash-flow-service.js` | 新增同模块现金服务，主站只读 SQL 按唯一订单 ID、实收 pay_amount 和 paid_at 汇总余额 / 订阅付款；包含已付款未兑换、履约失败及退款流程中的原收款，排除 ID 1。兑换只保留额度，不重复计现金。全历史有界分页、断点、并发合并与后台重试，来源更正按原 ID 替换，已同步来源删除后仍保留；删除用户或清空外键保留原身份和订单 / 兑换关联防重。 |
| 同上 | 原 JSON 收支按稳定 ID 延续，有效旧非现金 / 未支付 / 重复标记和明确实际现金退款沿用，迁移副本不重复相加。简单现金新增 / 修改 / 软删除、UUID 幂等、来源单号防重及迟到自动匹配合并，审计保留；自动来源不可改删。退款额度不按比例估现金，缺真实金额保留未知。 |
| 同上 | 当前余额 SQL 明确 `u.id<>1 AND u.deleted_at IS NULL`，再防御过滤；独立分页搜索和上游余额。累计净结余只按全历史实际现金入账减支出再减当前上述余额，独立于日期 / 粒度 / 原币 / 列表筛选，非 CNY 用实际日期现金汇率；缺来源、原币 / 汇率、退款金额或当前余额不当零。期间 / 原币现金卡片、趋势和列表同源，列表筛选不改变期间合计。 |
| `operations-center/src/accounting-store.js` | 原 accounting.sqlite 非破坏性创建现金来源、幂等表与日期索引，复用原作用域、审计和事务；来源同步进度不清空旧经营结果。旧分类、期初、政策、原始来源和审计原样保留。 |
| `operations-center/src/config.js`、`.env.example` | 可选 FINANCE_CASH_EXCHANGE_RATES，默认 []；验证正数、真实日期和同币种区间不重叠，CNY 固定 1。现金汇率独立于供应商充值倍率 / 监控展示汇率，原币收支无需该配置，无新增运行依赖。 |
| `operations-center/src/server.js`、`src/app.js` | 新现金、余额及持久额度接口沿用管理员 / CSRF / no-store 边界；现金后台随服务启停。默认消费归档不再挂载旧手工核算来源收集 / 加权分摊，不因缺期初或逐用户核算来源重拉旧日报，原 scope、SQLite 和 01:00 调度保持；旧 API 兼容保留。 |
| `operations-center/src/services/cost-analysis-service.js` | 自动日报补完整日期小计，原汇总 / 趋势 / 日表算法和未知传播保持，不拿小计冒充整期。 |
| `operations-center/public/cost-accounting-ui.js`、`public/cost-accounting.css`、`public/app.js`、`public/index.html` | 仅消费毛利 / 现金收支，移除精细核算、期初、分类、核验、政策和分摊表单。保留月内 / 按日默认、日表分页、供应商汇总 / 日来源、充值用户 / 兑换和余额搜索分页。现金四卡最后为全历史累计净结余，桌面在净现金流右侧、手机两列，详情展示组成 / 原币 / 快照；大金额按实际可用宽度调整且不换行。简单记账默认 CNY，供应商行直达，保存自动切日期 / 币种并定位，修改 / 删除即时汇总。说明折叠，来源失败自动重试、不造手工核验待办；辅助数据独立、旧响应失效、离页停轮询；历史补算轮询仍每分钟读取今日实时数据。静态资源版本更新。 |
| `operations-center/tests/cash-flow.test.js` | SQLite + 真实 PGlite + 管理员 HTTP 覆盖余额 ID 1 / 已删除排除、累计对全部筛选独立、支付 / 订阅 / 状态 / 兑换防重、并发 UUID / 单号 / 迟到匹配、历史重启 / 删除 / 外键与关联保留、旧账 / 旧分类 / 退款、原币 / 现金汇率 / 缺失、分批 / 缓存 / 作用域及主站只读 / 权限。 |
| `operations-center/scripts/accounting-preview.cjs`、`scripts/accounting-browser-check.cjs`、`package.json` | 隔离模拟主站、上游与真实接口 / SQLite，接入现金生命周期，不连接真实凭据。Playwright 验证 1440px、390px、320px 与系统深色偏好下的实际应用，指标 / 分页 / 下钻、供应商现金新增 / 修改 / 删除、自动记录只读、累计位置 / 日期与外币独立、慢辅助源和旧响应、缺成本及今天刷新，检查画布像素和图例间距、无整页 / 数值溢出及未捕获脚本异常。新服务加入语法门禁。 |
| `operations-center/README.md`、`docs/cost-accounting.md`、`docs/cost-analysis-automatic-plan.md`、`docs/cost-analysis-redesign.md`、`docs/cost-analysis.md`、`docs/metrics.md` | 现行两视图、实际现金与兑换额度区别、累计公式 / 非管理员余额、可选日期现金汇率、兼容 / 备份和 API；旧四视图方案明确归档，设计状态改为用户已确认并已本地实现。 |
| `CUSTOMIZATIONS.md` | 本节登记所有源码、配置、测试、文档与验证，不覆盖之前的独立维护记录。 |

验证：运营中心完整 339 项测试、20 项现金专项、npm run check 及 diff --check 通过；四组 Playwright 流程和截图复核通过，截图位于本机临时 sub2api-automatic-cash-qa。读源 / 归档 / 现金为隔离模拟及 PostgreSQL 兼容 SQL 验证，不冒充真实服务器金额或上线验收；本轮未运行 Docker / Linux CI、连接生产、修改资金或部署。

升级只需运营中心（供应商监控须已具备原账号日汇总 / 余额接口），保留 cost-ledger.json、daily-profit.sqlite、accounting.sqlite 和完整卷。CNY 收支无新增必填配置；有外币现金且历史未保存真实汇率时，按 README 配置可选日期现金汇率后重启，原币收支仍可使用，累计不得擅自用供应商倍率折算。主站只有额度而无现金证据的线下充值不能自动推断实收，保留简单收付录入；首次同步前已清理的历史无法恢复。

用户随后明确要求提交 GitHub。本次据此仅提交并推送上述成本分析实现、规划、测试、配套文档和相关台账，沿用已通过的 339 项测试、现金专项、语法检查和四组浏览器验收；推送前 fetch 核对远端，保留其他独立改动与生产维护记录。沿用现有 Actions 测试及 GHCR 镜像流程，构建 / 发布状态以本次提交 SHA 为准；不更新服务器、修改真实资金或部署。

## 2026-11-02：成本分析自动统计与简洁现金收支规划和 demo

用户要求去掉所有手动核算，重新制作规划与 demo，随后补充保留原有简单收支记录与现金流统计，等待其确认。本轮新增 `operations-center/docs/cost-analysis-automatic-plan.md`，更新 `docs/cost-analysis-redesign.md` 的后续方案索引；仅提供下一轮设计，不修改正式业务源码、配置、数据库或测试，不连接生产、不提交 / 推送或部署。保留之前独立维护记录、订阅手册和其他无关文件。

方案移除精细核算、期初、核算起点、逐笔分类、凭证核验和订阅 / 费用摊销；保留消费毛利与现金收支两个视图。前者展示非 ID 1 主站消费、启用供应商实际消费、消费毛利和毛利率，充值额度及当前余额独立展示。后者自动汇总线上订单实收与简单手工收付，支持供应商支出和自定义项目，默认 CNY、原币分开，不把兑换额度当现金或重复扣除供应商付款与实际消耗。原收支账按稳定 ID 延续、审计保留，旧日报不受核算起点限制；线下金额不能推断，允许实际收付后记一笔，不恢复财务待办流程。缺成本保留未知与完整日期小计，不用自动化之名把缺失改零。

在当前会话可视化目录新增独立 `cost-analysis-automatic.html` 交互 demo，使用示例用户、兑换和供应商日汇总，支持日期 / 粒度、日表分页、供应商汇总、用户搜索 / 分页 / 兑换下钻、余额与旧账原始快照和数据缺失情境。按用户补充增加现金卡片 / 趋势、收支搜索 / 过滤 / 分页、简单新增 / 修改 / 确认删除、供应商行直接记支出，以及保存后自动切换超出筛选的日期 / 币种并定位记录。订单及关联兑换单号重复录入会拦截，提交幂等；自动记录只读。新增同目录 `cost-analysis-automatic-qa.cjs` 与预览包壳，截图保存于 `automatic-qa/`；不纳入业务源码。demo 不连接主站或上游，不写真实资金。

用户进一步要求在净现金流右侧增加累计净结余。本轮同步修改方案、同一 demo 及其验收脚本：累计净结余 = 全历史累计现金入账 - 全历史累计现金支出 - 当前未删除且非 ID 1 用户余额，独立于页面日期、粒度、原币、搜索和列表筛选；四张卡片桌面同排、手机两列。点击累计卡片展示全历史收支、当前余额、原币拆分及快照时间；收支新增 / 编辑 / 删除即时更新。累计值统一 CNY，demo 的 USD 现金按明确示例历史现金汇率 7.2 换算，与供应商充值倍率无关；方案规定真实历史汇率 / 收支完整性 / 当前余额缺失时不展示伪造累计值，采用独立全历史汇总而非当前分页累加。不新增人工核算或修改主站余额，仍仅改规划与示例。

验证：1440px 桌面、390px / 320px 手机、1024px 深色 Playwright 流程通过，已复核截图。覆盖默认本月按日、上月 31 天分页、日 / 周 / 月 / 年同源汇总、自定义日期校验、用户 / 记录分页与搜索返回状态、删除用户记录保留但当前余额排除、只读旧账、单家成本 / 主站缺失、完整日期小计、零分母与亏损、自动重试后恢复及页面宽度。现金流程验证新增即时展示、默认 CNY、编辑 / 取消删除 / 确认删除、重复提交 / 来源订单及兑换防重、搜索不改变期间总额、旧收支延续、订阅付款及已付尚无兑换订单、原币隔离、跨筛选自动定位、供应商直接记账、现金 / 消费算法独立及自动收款来源失败时保留未知，无未捕获脚本错误。图表通过画布像素检查，HTML 小于 1 MB、无数据网络请求，依赖只加载允许的静态资源；验收以本地静态库替代 CDN 响应。修正预览沙箱中的表单事件和窄屏表格 / 抽屉尺寸。文档 diff --check 通过；本轮没有正式业务改动，未运行或声称通过新业务回归，正式开发等待用户确认。

累计卡片追加验收覆盖四种视口中的相对位置、全历史范围大于本月、公式与独立当前余额一致、外币现金折算、点击组成不改日期、日期 / 粒度 / 币种 / 搜索不改变累计值、跨筛选收支变更正确更新累计值，以及收款来源失败时累计净结余为空。修正窄屏大金额尾数换行，按卡片实际可用宽度适配数值字号，保留完整金额。

## 2026-11-01：新版待核验排查与自动统计入口

用户要求连接服务器排查大量待核验，并希望恢复打开即可查看的统计体验。本轮使用已授权的 SSH，只读检查镜像、主站 PostgreSQL 和运营中心 SQLite；SQLite 使用 readonly / query_only，主站 SQL 使用 READ ONLY 事务，凭据仅在进程内使用，不输出或写入文件。通过既有集成客户端正常读取当日供应商日汇总与余额，监控按原逻辑维护缓存；没有部署、重启、修改生产配置 / 分类 / 期初或用户资金。

北京时间 23:31–23:38 核验：两服务均运行 b72ec37，健康；核算起点 11-01，零已确认期初。94 条凭证全部待分类，其中 71 条原供应商支出（67 条 CNY / 4 条 USD）、23 条当日 balance 兑换；18 位消费用户被期初来源不足拦截。当日结果共 115 条问题，包含旧支出重复进入当日核验提示。主站只有一条取消支付订单，无已支付订单可直接证明兑换的现金实收；不能把兑换值自动改成已确认现金。实测当前启用的 ailzd、apiclub、lingsu、tuokeapi、鸡出没五家日汇总及余额均正常。正常只读计算当日主站消费 364.19605106、上游消费 272.51210767、消费毛利 91.68394339、毛利率 25.17%，不需要期初或分类；实时金额会继续变化。旧 10 月归档仍在，部分历史存在已知倍率覆盖缺口。

用户明确选择默认自动统计口径。本轮修改 `operations-center/public/cost-accounting-ui.js`、`public/cost-accounting.css`、`public/app.js`、`public/index.html`：默认自动统计主站消费、启用供应商实际消费、消费毛利及毛利率，趋势和每日列表复用原 `/api/cost-analysis/daily-profit` 与持久历史，不受精细核算起点约束，不要求分类和期初。充值额度和当前用户余额独立加载，失败不遮挡已取得的消费统计；自动充值下钻直接查询原主站接口，精细核算仍查已同步归档。原经营视图更名精细核算，与现金和核对入口保留可选；余额辅助查看不强制进入核算。补强切换期间旧请求隔离，保留轮询及离页失效，更新静态资源版本。无后端、数据结构、配置或供应商监控源码变化，无新环境变量或迁移。

扩展 `operations-center/scripts/accounting-browser-check.cjs`，验证默认不调用精细核算接口、核算起点前 31 天历史照常展示、充值 / 余额慢请求及失败不阻断统计、快速切换的旧核算响应不覆盖自动视图、两种充值用户分页 / 搜索 / 记录下钻、日表分页、图表非空及图例留白、原记账可见性 / 默认 CNY / 期初核对、供应商成本缺失仍不输出毛利。更新 `operations-center/README.md`、`docs/cost-accounting.md`、`docs/cost-analysis-redesign.md`、`docs/cost-analysis.md`、`docs/metrics.md`，明确自动统计无需人工核算，以及消费毛利和现金实收利润的差异。

验证：运营中心完整 319 项测试、`npm run check`、`git diff --check` 通过；Playwright 在 1440px / 390px / 320px 完整流程通过，无页面脚本错误或整页横向溢出，桌面和手机截图已检查。本轮未改供应商监控，未重复其完整测试。测试使用隔离 SQLite / PGlite 和模拟上游，不连接生产，不写真实资金；本地示例预览仅供查看。

限制：自动消费毛利含赠送及订阅计费额度，未扣其他运营费用，不作为现金利润；缺真实成本、历史倍率或用量时仍为空并自动重试，不能为消除提示捏造零值。旧分类、期初、手工账与日统计均保留；主站已清理且未归档的数据不能恢复。本轮不提交 / 推送或部署，不改写服务器账目；保留之前独立生产记录、订阅手册及其他无关变更。

用户随后明确要求提交 GitHub。本次将上述自动统计改造、浏览器回归、配套文档及本节记录提交并推送 extra main，沿用此前已通过的 319 项测试、语法检查及三种视口验收。推送前 fetch 核对远端；独立生产维护记录、订阅手册、其他工程及无关图标保留本地，不纳入本次提交。沿用现有 Actions 门禁与 GHCR 镜像流程，构建 / 发布状态以本次提交 SHA 的 Actions 为准；本次不部署服务器或修改生产资金 / 配置。

## 2026-11-01：成本分析经营核算实现

用户明确要求开发成本分析改版。本轮继续已有未提交实现，在既有 operations-center 中增加经营分析、现金收支、余额与核对及记账抽屉；保留自动额度用户与兑换记录下钻，不直接修改主站余额或使用记录，不连接生产、不部署。保留全部无关变更，包括订阅手册、诊断记录、其他项目和图标。

涉及文件：`operations-center/src/accounting-store.js`、`src/services/accounting-source.js`、`src/services/accounting-service.js`、`src/app.js`、`src/server.js`、`src/provider-monitor-client.js`、`src/services/cost-analysis-service.js`、`src/services/daily-profit-service.js`；`public/cost-accounting-ui.js`、`public/cost-accounting.css`、`public/app.js`、`public/index.html`；`provider-monitor/src/server.js`、`src/services/daily-cost-service.js`。独立 accounting.sqlite 保存源记录、分类、期初、规则、结果及审计，原账本保留；主站只读，供应商余额只读已有监控快照。优惠充值采用每日加权实收分摊，费用按自然日归属，缺来源 / 成本时不输出完整利润，核算不再减去当前余额。

测试与工具：新增 `operations-center/tests/accounting.test.js`，使用真实 SQLite、PGlite SQL、管理员 HTTP 会话及 CSRF 验证核算、持久化和接口；更新 `tests/frontend-layout.test.js`、`tests/provider-monitor-client.test.js`、`provider-monitor/tests/daily-cost.test.js`。新增 `operations-center/scripts/accounting-preview.cjs` 及 `scripts/accounting-browser-check.cjs`，提供隔离示例和桌面 / 手机浏览器验收；`operations-center/package.json` 增加对应命令及语法检查，无新生产依赖。趋势图明确顶部滚动图例及绘图区留白，避免日期标签重叠；抽屉截图按可见视口检查。

防重补强：线下兑换直接确认收款与手工关联收款双向互斥，UUID 重试幂等；后续同步发现对应线上支付时，早先手工凭证转为待核验，分类为关联已有业务后才恢复完整核算。旧手工收入分类为赠送时携带零实收价值，避免迁移后额度池错误未知。消费分配保留八位金额并守恒，订阅终止退款停止后续分摊，退款关联原收款且累计不超实收；负向兑换与退款不能重复减核算额度。

文档：新增 `operations-center/docs/cost-accounting.md` 作为新版权威操作、迁移和核算说明；更新 `operations-center/docs/cost-analysis-redesign.md` 实施状态、`docs/cost-analysis.md` 旧版兼容说明、`docs/metrics.md` 指标口径及两服务 README，保留原有 CMD Token、内部地址 / 域名和故障排查说明。

验证：运营中心完整 319 项、供应商监控完整 316 项全部通过，共 635 项；新增核算测试 27 项包括跨月继承、按实收消费、赠送、订阅、未付费用及年费分摊、退款、防重、已删除用户、来源变化、成本缺失、旧账迁移和真实只读 SQL。运营中心 npm run check、本轮供应商模块 node --check、git diff --check 通过。1440px / 390px / 320px Playwright 流程覆盖趋势非空及图例留白、31 天分页合计、额度用户分页 / 搜索 / 兑换下钻、默认 CNY、新增即展示及筛选外自动切日、期初保存即时刷新、HTML 转义、上游异常后利润未知；无脚本错误或整页横向溢出，截图已复核。浏览器验收用临时数据库、模拟用户和供应商，验收进程已关闭。

边界：需两服务配套更新并保留数据卷，无新环境变量。首次需核验旧分类与用户期初；未同步且已清理的历史无法恢复，缺少精确历史时点快照不展示历史期初 / 期末，当前余额仅独立展示。初始赠送、邀请返利等缺兑换来源时需凭证补录；自动订阅仍需核验真实服务期；混合赠送池不声称能逐笔还原赠送消耗。上游余额是当前倍率折算估值，过期 / 缺汇率时未知。本轮不提交 / 推送、不更新服务器，既有无关改动原样保留；本地预览只用示例数据。

用户随后明确授权提交 GitHub。本次将上述经营核算实现、配套供应商余额接口和等价折算修复、测试、文档及本节维护记录提交并推送 extra main。推送前 fetch 确认本地与远端一致；独立生产诊断 / 维护记录、订阅手册、其他项目与无关图标继续保留本地，不纳入提交。沿用已有 Actions 测试门禁及 GHCR 镜像发布流程，构建 / 发布状态以本次 SHA 的 Actions 为准；不部署服务器，不变更生产资金或配置。

## 2026-11-01：成本分析页面改版规划

用户要求重新规划设计成本分析页面。本轮新增 `operations-center/docs/cost-analysis-redesign.md` 规划稿，并在当前会话的可视化目录制作示例数据交互稿，明确这不是已上线功能。方案将页面划分为经营分析、现金收支、余额与核对，区分确认收入、消费额度、现金收付和预付 / 预收存量；定义费用所属期间、收入分类关联、历史数据待分类、缺失数据待核验和受影响日期重算，保留用户 / 兑换记录下钻、默认当月按日及凌晨一点归档设计。

本轮仅新增设计文档和本节记录；不改业务源码、配置、测试、原账本或生产数据，不连接服务器、不提交 / 推送或部署。独立交互稿使用示例数据，浏览器验收不代表业务功能已完成。

验证：独立交互稿通过桌面、390px / 320px 手机宽度及深色外观检查；视图切换、用户搜索与兑换下钻、供应商充值不计经营成本、费用付款日与所属日期分离、未知成本 / 收入保留空值、日详情及周趋势交互通过，无页面脚本异常或整页横向溢出。仅执行交互稿验收及文档差异检查，不把它等同运营中心业务回归。

用户随后明确要求提交 GitHub，本次只提交上述设计文档及本节维护记录到 extra main。交互示例保留会话目录，业务功能尚未实现；其他生产诊断记录、订阅手册及无关文件保留本地，不纳入提交，不部署服务器。

## 2026-11-01：apiclub 登录验证与 Token 自动续期诊断

用户要求从服务器连接 apiclub，确认账号登录拦截原因、评估免交互登录及 Token 自动续期方案。本轮只查询诊断和分析方案，没有修改业务源码、生产配置、凭据或会话；不部署 / 重启服务、不提交 / 推送。SQLite 使用 readonly / query_only，凭据仅在服务器进程内解密做字段格式与 JWT 时效布尔检查，不输出 Token、密码、邮箱或绑定指纹。外部仅查询公开设置，并各发送一次使用合成不存在账号 / 合成无效 Refresh Token 的认证请求，不使用真实 Refresh Token 发起轮换或重试登录。

核验时刻约北京时间 2026-11-01 17:15–17:22。监控运行 revision `6ea7df90c4f43a0ba2642c451588be6f39219bce`；apiclub 启用，认证模式 `token_pair`，定时检查间隔 15 分钟。公开 `/api/v1/settings/public` HTTP 200 且 `turnstile_enabled=true`；缺少人机验证的 `/api/v1/auth/login` 在验证密码前返回 HTTP 400 / `TURNSTILE_VERIFICATION_FAILED`。这是上游应用的登录验证码要求，不是整个域名不可达或简单请求头不匹配。未发现可依赖的纯 HTTP 免验证登录路径；稳定接入应使用上游认可的集成策略，或人工验证后使用官方 Token 刷新流程，不把验证码绕过作为保证。

现有 Access Token 寿命 86400 秒，于北京时间 10-31 22:47:23 到期；保存的 Token 对格式正常，没有首尾空白、包裹引号、把 Access 填入 Refresh 等明显错误。监控最后成功为 10-31 22:38；22:54 首次自动刷新失败，至本次查询共 65 条 `AUTH_EXPIRED`，明确信息为 Refresh Token 无效 / 已轮换。凭据最后变动为 10-31 09:47 的人工录入，没有之后成功轮换的保存时间。合成无效 Token 请求官方 `/api/v1/auth/refresh` 得到 HTTP 401 / `REFRESH_TOKEN_INVALID`，未要求 Turnstile；运行日志同类远端错误由真实现有适配器映射，不能把它写成“未实现自动刷新”或单纯 Access Token 过期。

上游正常轮换会立即作废旧 Refresh Token，浏览器与监控共用同组令牌、浏览器退出登录、上游撤销 / 清理等均可能导致此现象；仅监控端证据不能确认具体消费或撤销方。JWT 含非空 `bnd`，但未确认上游当前是否强制执行会话绑定；本次错误为无效 Refresh Token，不能直接归因为绑定失败。若后续明确返回 `SESSION_BINDING_MISMATCH`，应由上游按认可策略提供适合服务器的会话，不能保证复制浏览器令牌跨 IP / UA 永远可用。

现有 `provider-monitor/src/adapters/sub2api.js` 已在请求前检查 Access 有效期，并在临近过期或认证失败时用 Refresh Token 调官方刷新端点，回调加密保存新 Token 对；无效 Refresh Token 在 Token 对模式下不退回账号密码。恢复建议：从独立浏览器配置 / 无痕会话重新人工登录并取得同一会话的两个新 Token，录入“OAuth Token 对”，关闭该整个独立会话但不要点退出，日常网页登录使用另一独立会话。已经无效的 Refresh Token 不能靠定时脚本自行恢复，必须先重新授权。

可靠性补强方案（仅设计，未实现）：在既有监控服务内统一按供应商协调刷新，覆盖资产同步、日报、目录及充值登录等所有入口；提前续期、合并并发、版本核对后原子保存新 Token 对，认证失效停止无效重试并提示重新授权，避免单独外部 cron 与内置逻辑争用单次 Refresh Token。现有同步与日报各自单飞但未共享全入口刷新协调，属于后续风险，不把它推断为本次故障的已证实原因。上游若撤销或使 Refresh Token 失效，仍需人工再授权，不能承诺永久免登录。

验证：本地现有 `tests/adapter-contracts.test.js` 23 项通过，包含成功刷新并保存轮换 Token、无效 Refresh 不回退密码、Turnstile / 会话绑定分类及回调不泄露 Refresh。真实上游本轮未获得新 Token 对，因此不宣称已经恢复账号、成功完成实际 Token 轮换或绕过验证码；本轮只追加此维护记录。

## 2026-10-31：服务器日报待核验与供应商日消费诊断

用户明确要求连接服务器排查部分供应商无法获取实际消费及日报待核验。本轮仅查询诊断，不改生产源码、配置、历史倍率或资金，不部署 / 重启服务；保留全部既有本地变更。SSH 复用用户已授权的连接，认证信息不写文件或诊断输出；SQLite 使用 readonly / query_only，只选择报表、队列、供应商启停及脱敏倍率字段。上游适配器诊断仅用已有 Access Token，禁止 Refresh Token 轮换及凭据写回；另通过运营中心既有客户端执行一次正常当天只读报表查询（由运行服务照常更新其汇总缓存），不手动改写账本。

核验时间约北京时间 2026-10-31 14:27–14:36。运营中心、供应商监控均为 `6ea7df90c4f43a0ba2642c451588be6f39219bce`，健康并从 14:23 起运行；资金与用量时区均为 Asia/Shanghai，内部地址、集成 Token 及持久管理员认证已配置。监控汇率 USD=1 / CNY=1 可用。本月 10-01 至 10-30 已归档的 30 日主站消费全部已核验，均为供应商不完整；队列存在且按退避重试，不是旧镜像、缺汇率或主站消费查询失败。

| 供应商 / 范围 | 实测证据与结论 |
| --- | --- |
| `aikangs` | 唯一在昨日及当天无法取得日汇总的启用供应商；旧归档所有日期均为超时。诊断直接读取 `/api/v1/user/profile` 等待 15 秒仍超时；公开首页无凭据请求亦在 TCP 约 10ms、TLS 约 32ms 建连后 12 秒无 HTTP 首字节。确认从此服务器访问该上游的 HTTP 链路不通畅，不能仅凭此认定具体是 CDN、源站或访问拦截；现有 Token 也已于北京时间 10-28 02:14 过期，链路恢复后仍需有效刷新 / 登录。没有通过延长生产超时或写入新 Token 掩盖故障。 |
| `ailzd`、`apiclub`、`lingsu`、`tuokeapi`、`鸡出没` | 两真实日期 10-30 / 10-31 的 profile 和日汇总均 HTTP 200，单个请求约 36–254ms，取得实际金额与请求数。正常运营中心当天查询也确认这五家可折算且完整；当天汇总仍因 aikangs 未知而保持待核验，不以部分成本推断利润。 |
| `tuokeapi` 的 10-25、10-28、10-29 | 上游已返回非零实际消费，失败点是历史倍率覆盖；账号 10-29 09:33 接入，首条已确认倍率从该时刻开始，之前以及接入日零点至该时刻没有完整历史。需依据真实充值记录补齐历史后重算，不能把保存当前倍率自动视为覆盖过去。 |
| `鸡出没` 的 10-14 至 10-24 | 日消费接口正常；账号 10-24 13:27 接入，唯一已确认倍率历史从该时刻开始，之前有非零消费而缺少历史，故无法确认现金成本。更早的零消费日可以确认零成本，不代表已有过去全部倍率。 |
| `apiclub` 的 10-29 | 程序存在过度保守的误判：当天两个历史段 multiplier 均为 1，付款币种字段从 CNY 变为空（回退 USD）；在实际 USD=1 / CNY=1 下，复用真实 convertCost 两段折算 CNY 的单位系数同为 1。现实现比较 multiplier / currency 元组数量，误提示“当日充值倍率发生变化”；应比较完整覆盖后的实际目标币种系数并区分币种变化，不绕过真正缺失的历史。该日实际消费 1.3497645706 已成功读取，并非上游故障。本轮仅确认缺陷，未修改或部署修复。 |
| 未启用的四家 | `ai.max66.xyz`、`ai2api`、`hubway`、`wanfaai` 按用户要求排除，即使存在旧汇总也不计入新日报；这不是获取失败。 |

结论：当前总额待核验的首要阻塞是 aikangs；历史另有接入前倍率缺口和 apiclub 等价折算误判三类独立原因。建议分别恢复上游访问 / 认证、凭实际记录确认历史倍率、修正等价折算判断，完成后重算对应日期。此诊断不保证未接入或被停用上游已覆盖所有主站请求。本轮仅新增本地维护记录，不提交、推送或部署，不把历史缺口回填为假定成本。

## 2026-10-31：每日真实收入归档与统一趋势

用户要求排除未启用定时检查的供应商，按资金时区每日 01:00 统计前一日并入库，当日实时查询，历史列表读取本地归档，并将原余额消费趋势替换为同口径的主站消费、供应商消费和真实收入。实现及测试期间不连接生产、不部署、不操作余额，保留无关变更。

| 文件 | 本轮改动与必须保留的约定 |
| --- | --- |
| `provider-monitor/src/services/daily-cost-service.js`、`tests/daily-cost.test.js` | 账号日汇总仅查询 `enabled=1`（启用定时检查）的供应商，停用且仍有历史采购台账、汇总缓存的供应商不请求、不计入。响应新增 `providerFilter=scheduled_enabled`；全部未启用时保持待核验，不凭空认定零成本。测试覆盖停用供应商已有历史数据与异常的排除。 |
| `operations-center/src/daily-profit-store.js`（新增） | 独立 `daily-profit.sqlite` 保存按数据源 / 时区 / 日期唯一的日报、持久补算队列及日程游标，使用 WAL / FULL。任务版本与五分钟租约阻止旧计算覆盖新重算，失败退避一分钟至最多一小时，重启后恢复；不写主站资金、原成本台账或明文凭据。 |
| `operations-center/src/services/daily-profit-service.js`（新增） | 按 `FINANCE_TIMEZONE` 每日 01:00 排队统计前一天，启动及定期检查补排漏日。历史缺口立即返回待统计并后台每批最多补算三天；零点至一点的昨日延至一点，未来日期不请求。当日普通查询 / 刷新强制实时读取，同日并发合并；历史进度轮询复用最近一次当天结果。刷新历史异步唯一覆盖，失败保存待核验并重试；历史保留统计时的供应商范围、倍率、汇率和完整性。后台监控读取器按身份 / 凭据隔离复用五分钟，错误失效，不将浏览器 Token 写入归档。 |
| `operations-center/src/services/cost-analysis-service.js` | 保留既有单日计算器，新增统一日报、合计及日 / 周 / 月 / 年趋势构造，金额使用 Decimal、保留八位小数，未知向周期传播，利润率以合计计算。严格验证供应商启用筛选声明，公开同契约读取器供后台复用；`include_consumption=0` 允许页面跳过已停用图表的历史用量 SQL。主站全部消费仍排除 ID 1，真实收入为主站消费减供应商消费，不扣手工台账或当前余额。 |
| `operations-center/src/server.js`、`src/app.js`、`package.json` | 在既有进程中初始化归档库并启停日报服务，后台停止时只等待当前日，HTTP 退出后再关闭数据库；日报路由保留管理员认证与 no-store。新归档、服务和计算器纳入语法检查，无新增依赖或环境变量。 |
| `operations-center/public/app.js`、`public/index.html` | 将原余额消费趋势替换为主站消费、供应商消费和真实收入，列表与趋势使用同一日报。展示今日实时 / 已归档 / 待统计及重试状态和计算时间；后台补算期间仅轮询日报，不反复读取手工台账或当天上游。保留请求版本检查、离页 / 退出取消轮询与手机表格滚动，更新 app.js 资源版本。 |
| `operations-center/tests/daily-profit.test.js`（新增）、`tests/cost-consumption.test.js`、`tests/cost-analysis-ui.test.js`、`tests/frontend-layout.test.js` | 覆盖真实 SQLite 持久化、历史查询不计算、当天实时 / 并发 / 轮询、未来日期、01:00 / 夏令时 / 停机补排、凭据轮换隔离及短期 SSO 复用、失败退避 / 重启 / 幂等替换、租约 / 旧任务拒绝、真实 HTTP 鉴权与 no-store、各粒度未知传播、跳过旧 SQL 和列表 / 图表一致性。 |
| `operations-center/README.md`、`docs/cost-analysis.md`、`docs/metrics.md`、`provider-monitor/README.md` | 说明启用筛选、归档与实时边界、后台补算 / 刷新 / 重试、认证与资金时区、历史配置快照、数据卷备份及两服务配套更新。 |
| `operations-center/data-preview/daily-summary-qa-20261031.cjs` 及 `daily-archive-*.png`（忽略的本地验收文件）、`CUSTOMIZATIONS.md` | 扩展既有隔离浏览器验收并记录结果；真实 PGlite SQL、SQLite 监控与归档、两种真实适配器及本地 HTTP，模拟上游、不使用公网或生产凭据。保留全部无关变更。 |

验证：运营中心完整 291 项、供应商监控完整 313 项测试全部通过，运营中心 `npm run check`、监控日汇总服务 `node --check` 及 `git diff --check` 通过。1440px 桌面 / 390px 手机浏览器验收验证首次待统计到后台自动更新、停用供应商排除、持久历史读取、日 / 月趋势与列表一致，以及重算失败后利润待核验；无页面脚本错误或整页横向溢出，手机表格内部滚动，截图已复核。隔离环境已归档三日报告读取分别约 6.04ms / 3.60ms，无上游请求或主站 usage SQL；仅为本地验收测量，不代表生产性能。验收服务、浏览器和临时数据库均已关闭并清理。

更新要求：两服务配套更新以支持新筛选声明，保留运营中心数据卷和新增日报库；无人值守需可用集成 Token 或持久管理员认证，单次浏览器 SSO 不保证凌晨可用。首次访问缺失历史会后台补算，历史结果在重算前保持保存时口径；已清理的源明细无法靠重算恢复。本轮未提交、推送、发布或部署。

用户随后明确授权提交 GitHub。本次据此将每日真实收入归档、供应商启用筛选、统一趋势及相关测试 / 文档和本节台账提交并推送 extra main；推送前 fetch 确认与远端同步。沿用现有 Actions 测试门禁和 GHCR 镜像发布流程，构建 / 发布状态以本次提交 SHA 的 Actions 为准。订阅配置手册、独立生产维护台账及无关工程 / 文件保留本地，不纳入本次提交；不更新服务器或操作资金。

## 2026-10-31：上游账号每日消费汇总

用户要求成本分析直接读取上游每日消费汇总，兼容 Sub2API 与 New API。本轮仅本地实现与隔离测试，保留已有未提交改动；不部署、不扣余额、不改生产账本。供应商账号日汇总与原 Key 明细账本分开，日报只使用一种来源，避免重复叠加。

| 文件 | 本轮改动与必须保留的约定 |
| --- | --- |
| `provider-monitor/src/adapters/base.js`、`src/adapters/sub2api.js`、`src/adapters/one-api-family.js` | 增加账号日汇总能力及严格数值校验。Sub2API 使用用户身份和 `/api/v1/usage/stats` 的 `total_actual_cost`，不取标价；New API 使用 `/api/log/self/stat` 的消费 `quota / quota_per_unit`，验证真实额度单位，结束秒排除次日零点，不把 RPM / TPM 当全天总量。仅 API Key 的 Sub2API 及其他适配器明确不支持，不回退 Key 日志。 |
| `provider-monitor/src/services/daily-cost-service.js`、`src/services/gross-profit-service.js`、`src/server.js` | 新服务接管集成与管理员每日成本接口，沿用原认证和参数 / 汇率校验，返回 `source=upstream_daily_summary`、`scope=account`。按资金日读取账号全部 Key 消费，原采购账本、毛利和计费核查不叠加或改写。覆盖完整且已确认的历史充值倍率、币种和汇率才折算现金成本；日内倍率变化、历史缺口、重复账号及无效金额保留待核验，只有有效零消费确认为零。一并保留原明细统计中有界复用时区日期格式器的性能修复。 |
| `provider-monitor/src/db/index.js` | 版本 34 自动新增 `provider_daily_cost_summaries`，按供应商 / 日期 / 时区唯一覆盖保存原始汇总和账号 / 配置 HMAC，不存明文身份或凭据，不改旧采购台账。 |
| `operations-center/src/services/cost-analysis-service.js`、`src/provider-monitor-client.js`、`public/app.js`、`public/index.html` | 只接受新账号汇总来源，按资金日逐日查询，一份报表只交换一次 SSO 会话、会话不跨用户缓存；单日失败保留成功日期，连续三次失败或全局错误有界停止，按错误码提示原因且不暴露上游错误。页面显示账号范围和汇总时间，刷新按钮传 `refresh=1`；以递增请求标识丢弃过期响应及错误，避免慢整月查询覆盖最新日期筛选。更新 app.js 资源版本。 |
| `provider-monitor/tests/daily-cost.test.js`、`tests/database-migration.test.js`、`tests/gross-profit.test.js` | 新增两真实适配器契约、无 Key / 日志拉取、独立快照替换及持久化、跨午夜 / 夏令时、刷新失效、历史倍率 / 汇率、重复账号、凭据变更 / 安全轮换、失败预算 / 冷却 / 脱敏、迁移与真实 HTTP 鉴权测试，保留旧账本回归。 |
| `operations-center/tests/cost-consumption.test.js`、`tests/provider-monitor-client.test.js`、`tests/cost-analysis-ui.test.js` | 验证新来源及账号范围、拒绝旧账本响应、日期筛选和强制刷新传递、供应商更新时间，以及旧日期请求晚到或失败不覆盖新结果。 |
| `operations-center/README.md`、`docs/cost-analysis.md`、`docs/metrics.md`、`provider-monitor/README.md` | 记录上游端点、完整账号范围、凭据要求、时间边界、缓存 / 刷新、历史倍率及汇率、失败排查、v34 自动迁移和两服务配套更新。 |
| `operations-center/data-preview/daily-summary-qa-20261031.cjs` 及截图（忽略的本地验收文件）、`CUSTOMIZATIONS.md` | 真实 PGlite 主站 SQL、SQLite 监控、两真实适配器与本地集成 HTTP 的桌面 / 手机验收，模拟上游响应，不使用真实凭据或公网请求；维护本轮实施与验证记录。 |

读取与可靠性：当天缓存 60 秒、历史日期 1 小时，跨午夜重取前一日完整汇总；刷新绕过成功缓存，失败使旧快照失效，不用旧金额冒充成功。并发相同读取合并，供应商串行处理自身令牌轮换，沿用有界全局并发；单家最多 5 秒、整份监控请求约 8.5 秒读取预算、不自动重试，超时 / 限流 / 认证 / 验证码失败冷却 30 秒。失败保留其他供应商数据，缺失成本及利润不当零。返回脱敏原因，不返回地址、凭据、账号 HMAC 或原始上游错误；上游账号混有其他业务也会纳入，未接入供应商无法自动发现。

验证：供应商监控完整 312 项、运营中心完整 279 项测试全部通过，共 591 项；运营中心 npm run check、本轮服务 / 适配器 / 迁移语法检查及 git diff --check 通过。1440px 桌面 / 390px 手机 Playwright 验证三日主站消费、两上游实际汇总、历史倍率与汇率、亏损及零分母、默认折叠明细 / 更新时间、刷新失败后待核验、最新日期请求优先；放入大额旧采购账本仍不重复计入，无未捕获页面错误或整页横向溢出，手机表格内部滚动。截图已复核，验收浏览器、两个本地服务和临时数据库均已关闭 / 清理。

边界：本轮不连接生产，不变更生产配置、已保存凭据或资金；无需新增环境变量或依赖，沿用已有监控地址、Token / SSO、账号凭据、历史倍率和汇率，数据库自动迁移。上线需配套更新运营中心和供应商监控；本轮不部署，不代表真实供应商接口已全部完成现场验证。

用户随后明确授权提交 GitHub，本次据此将账号日汇总改造、相关逐日查询 / SSO / 错误提示修复、测试、文档和本节台账提交并推送 extra main。推送前 fetch 确认本地与远端一致，沿用现有 Actions 测试门禁及 GHCR 镜像流程，构建 / 发布结果以本次 SHA 的 Actions 为准。订阅配置手册、独立生产维护记录及无关工程 / 文件保留本地，不纳入本次提交；不更新服务器或操作资金。

## 2026-10-31：三条不降智线路共享订阅操作手册

用户要求在已核对 Sub2API 源码的基础上输出配置手册，接受满额正利润，不再要求 15%。新增 `operations-center/docs/subscription-three-lines-setup.md`，描述一个 composite 订阅组、一份 199 记账额度、199 元 / 30 天售价、三个账号归属别名和 10% / 2% / 1% 优惠；列出当前九个账号的归属快照、18 条每百万 Token 价格、272k 长上下文区间、用户范围 Standard 档位过滤、CNY 实付核对、测试验收、成本暂停线与恢复步骤。手册位于既有运营中心文档目录；没有新增运营脚本或把编排移入核心。

本轮服务器仅只读查询账号、模型价卡和支付数值，不写生产配置、凭据或资金，不发收费模型请求。保留核心和 extra 两仓库既有未提交改动；本轮只新增手册及本台账说明，没有修改业务源码、运行配置或测试。按最高采购倍率 0.11 / 0.17 / 0.20、2% 手续费及 7 元分摊和预留复算，最差满额余款约 15.42 元；明确该费用分摊是测算假设，现有文本订阅缺少通用在途预占，不能宣称绝对成本硬封顶。

验证：源码与表单单位核对、18 条价格和盈亏公式复算、文档格式检查通过；补充执行核心现有 Fast 全档位过滤、用户规则优先级、区间倍率、服务档位分项计费和订阅 CNY 直付的定向 Go 测试通过。完整配置后的真实请求、额度耗尽、上游账单及支付回调验收仍待配置人员执行；未提交、推送、发布或部署。

## 2026-10-31：逐日读取供应商消费与逐家验证

用户要求验证按日查询并逐一核对供应商消费。沿用已授权的服务器只读排查，不部署或重启服务、不改生产账本或凭据；上游验证只请求已有账号的 Key 目录与用量日志，不发模型请求，不轮换已保存的 Refresh Token，诊断过程中获得的临时登录信息不写入数据库。

| 文件 | 本轮改动与约定 |
| --- | --- |
| `operations-center/src/services/cost-analysis-service.js` | 供应商消费按资金日逐日请求，每次 from=to，日期不重叠；单日失败保留其他日期结果，连续失败有界停止，身份或接口全局错误立即停止，不以缺失数据推断利润。 |
| `operations-center/src/provider-monitor-client.js` | 增加报表内复用的每日消费读取器，SSO 每份报表只换取一次监控会话，避免逐日重新登录触发 20 次 / 15 分钟限制；会话不跨用户或全局缓存，原 getDailyCosts 契约保留。 |
| `provider-monitor/src/services/gross-profit-service.js` | 有界复用日期时区格式化器，去除每条账本记录创建 Intl 对象的性能瓶颈；保持资金日、日周月分桶、历史倍率、汇率与完整性核验口径。 |
| `operations-center/tests/cost-consumption.test.js`、`tests/provider-monitor-client.test.js`、`provider-monitor/tests/gross-profit.test.js` | 验证逐日无重叠、成功日期保留、失败隔离与有界停止、一次 SSO 和用户隔离、时区 / 夏令时边界及格式化资源复用。 |
| `operations-center/README.md`、`operations-center/docs/cost-analysis.md`、`provider-monitor/README.md`、`CUSTOMIZATIONS.md` | 更新逐日读取与认证说明，区分实时上游日志可读、已同步成本可读与完整利润已核验，记录本地及生产只读验证结果。 |

验证：运营中心完整 276 项、供应商监控完整 298 项测试全部通过，共 574 项；运营中心 npm run check、三个修改源码文件 node --check 及 git diff --check 通过。没有新增环境变量、依赖或数据库迁移。

生产只读验证：从运营中心容器使用真实集成客户端、现有 Token 和默认 10 秒超时，对 2026-10-01 至 10-31 发出 31 次 from=to 的日请求，全部成功并通过日期 / 来源 / 范围核对，最慢 5035ms；未优化的现有服务串行合计 43095ms。接口成功不代表成本已核验，现存同步缺口仍使各日完整利润不可确认。

金额一致性：在监控容器独立只读 Node 进程、同一 SQLite 快照和固定报表时刻下，仅在内存加载本地实际修改的日期格式化函数。2026-10-30 原实现 1633ms、优化后 209ms，完整 JSON 完全一致；优化后的整月计算 4200ms，31 次逐日合计 4272ms，全部日期的金额、供应商拆分、已记录成本、请求数和完整性状态与整月返回逐项完全一致，两个结果 SHA-256 相同。未改服务器源文件、运行服务或账本。

逐家上游只读验证窗口为 2026-10-31 00:00 至 00:56:25（Asia/Shanghai），只查询受监控 Key 的目录与日志：ai.max66.xyz、ai2api、ailzd、hubway、tuokeapi、wanfaai、鸡出没这 7 家在该窗口完整可读；lingsu 部分 Key 限流，结果截断；aikangs 请求超时；apiclub 要求验证码。该窗口可读不代表历史已完整同步，尤其 ailzd / lingsu 已有截断，其他历史覆盖缺口也未补齐；不得把缺失成本当零或宣称全部供应商整月利润准确。

本轮修复仅本地完成，未提交、推送或部署；生产无文件、配置、账本或已保存凭据变更。

## 2026-10-31：服务器只读排查每日消费不可用

用户明确授权连接服务器排查。本轮 SSH 只读核对容器镜像 revision、有效配置、真实集成 HTTP、SQLite 查询计划和同步覆盖；不保存登录密码、集成 Token 或供应商凭据，不部署、不重启、不改生产配置或资金数据。与下节较早的本地汇率复现区分：服务器当前两服务均为 `e93ab60313e24d1ec896ebabfd7c26fa8c5d00e6`，实际汇率已经是 USD=1 / CNY=1，供应商目录 200，因此当前服务器故障不能再归因为缺 CNY 汇率或只更新一个服务。

实际运营中心集成请求超时为 10000ms；默认整月消费请求复现 `PROVIDER_MONITOR_TIMEOUT`，独立只读探测把客户端等待延长到 35 秒仍超时，不能仅靠略增超时解决。2026-10-30 单日接口实测 1485ms 返回 200，但因供应商同步覆盖不完整仍为待核验。只读账本中约 45.8 万条有效费用、10 月约 36.1 万条；查询计划已使用 `provider_cost_profit_window` 索引。定位到现有 `gross-profit-service.js` 为每条费用重新构造 `Intl.DateTimeFormat`：在独立只读 Node 进程、同一 SQLite 快照和固定报表时刻下，单日原实现 1625ms / 12535 次格式器构造，临时复用格式器后 223ms / 3 次构造，单日完整 JSON 完全一致，复用后的整月只读计算 5286ms。对照只影响诊断进程内对象，未修改运行服务或服务器文件；正式性能修复尚未实现或部署。

同时发现 `ailzd` / `lingsu` 日志同步截断，`aikangs` 最后成功同步停留在 10 月 27 日并存在超时，`apiclub` 需要验证码且日志覆盖停留在 10 月 28 日，另有供应商仅覆盖部分日期或没有日志同步状态。即便接口超时解决，这些缺口仍会使对应成本 / 利润保持未知，不能通过汇率设置或把缺失当零来解决。发现充值倍率并非全部为 1（如 hubway=10、ai.max66.xyz=1.1），保留实际检测与历史冻结记录，不按口述情况擅自覆盖。

## 2026-10-31：每日供应商消费失败原因与汇率排查

用户反馈服务器可展示供应商但每日消费提示不可用。本轮先以隔离数据库和本地 HTTP 复现：默认显示 USD、汇率仅 USD=1 时，供应商列表返回 200，CNY 每日消费返回 400 / CURRENCY_RATE_MISSING；旧实现 catch 将其吞成通用提示。该复现不等于已确认生产原因，本轮不连接或变更生产、不修改汇率或真实账本。

| 文件 | 改动与必须保留的约定 |
| --- | --- |
| `operations-center/src/services/cost-analysis-service.js` | 按稳定错误码与 HTTP 状态区分缺汇率、缺地址 / 认证、接口旧版或响应不兼容、超时、连接及上游异常，给出明确处理入口；不暴露上游原始错误、URL 或凭据，不把失败或不完整消费变成零。 |
| `operations-center/tests/cost-consumption.test.js`、`provider-monitor/tests/gross-profit.test.js` | 验证错误分类和脱敏，复现同一 Token 下供应商列表可读但 CNY 消费缺汇率，并核对补全测试汇率后接口可读；全部使用隔离数据。 |
| `operations-center/README.md`、`operations-center/docs/cost-analysis.md`、`provider-monitor/README.md` | 说明供应商目录与每日成本接口、同步账本与实时上游读取的区别，补齐汇率方向及缺 CNY 的排查步骤，核对实际导航为“设置与备份 → 运行设置”；不擅自调整默认币种或配置实际汇率。 |
| `CUSTOMIZATIONS.md` | 记录本轮改动、复现证据、验证及本地 / 生产边界，保留既有未提交维护记录和无关工程。 |

验证：运营中心完整 273 项、供应商监控完整 297 项测试全部通过；运营中心 npm run check、消费服务 node --check 及 git diff --check 通过。隔离 HTTP 测试确认同一 Token 可读取供应商目录，但默认配置请求 CNY 消费得到 400 / CURRENCY_RATE_MISSING，补齐测试汇率后接口返回 200 且正确折算金额，缺同步覆盖时成本仍为 null。服务测试覆盖错误分类、上游错误脱敏、旧版或异常响应与重复日期；保留主站消费，失败时不伪造供应商成本或利润。没有新增环境变量、依赖或前端资源改动，本轮未提交、推送、发布或部署，尚未确认服务器实际错误原因。

## 2026-10-30：成本分析每日真实收入

用户要求用当前日期范围的每日主站实际消费减各供应商实际消费，替换原周期明细。本轮仅本地实现和隔离验证，保留本文件既有未提交生产维护记录、其他工程与无关文件；不部署、不连接生产或执行资金写入。原计费核查、CSV 后台任务和主站原生资金事务不变。

| 文件 | 改动与必须保留的约定 |
| --- | --- |
| `operations-center/src/services/cost-analysis-service.js` | 新增逐日利润只读报表；主站消费为所选资金日内全部 `usage_logs.actual_cost`，排除用户 ID 1，包含余额与订阅使用记录，不因删除用户抹除消费；与原有余额消费趋势分开。供应商成本来自已同步采购台账，数据或币种未核实时不把成本当零、不推断利润；不重复扣手工台账。 |
| `operations-center/src/provider-monitor-client.js`、`src/app.js` | 复用既有集成 Token 或管理员 SSO，增加供应商每日消费读取与管理员每日利润 API，保留超时和认证边界。 |
| `provider-monitor/src/services/gross-profit-service.js`、`src/server.js` | 复用原有采购台账的 active / comparable 仲裁、历史充值倍率与配置汇率，新增脱敏只读每日成本；按运营中心资金时区聚合，返回供应商拆分、同步覆盖和未确认金额状态，不调用模型或触发同步。新接口严格要求源 / 目标币种有确认汇率，不沿用显示币种变化时的 USD 默认 1；缺费用、负费用或未确认倍率不算已核验。原毛利接口行为保留。 |
| `operations-center/public/index.html`、`public/app.js`、`public/styles.css` | 移除周期明细，固定逐日展示日期、主站消费、供应商消费、利润、利润率、请求数与核验状态，支持供应商拆分复核；粒度不改变每日列表。仅更新本次涉及的资源版本。 |
| `operations-center/tests/cost-consumption.test.js`、`cost-analysis-ui.test.js`、`provider-monitor-client.test.js`、`server.test.js`、`frontend-layout.test.js`；`provider-monitor/tests/gross-profit.test.js` | 验证真实 SQL、日界线 / 时区、管理员排除、订阅与删除用户、供应商去重 / 倍率 / 汇率 / 缺失 / 截断覆盖、鉴权、逐日列表与手机展示；不操作真实余额。 |
| `operations-center/data-preview/daily-profit-qa-20261030.cjs`（忽略的本地验收脚本与截图） | 隔离 PGlite 主站、SQLite 供应商监控、真实只读集成 HTTP 和浏览器端到端核验；只绑定本地临时端口，完成后关闭两个服务并清理临时数据库，不连接生产或发送推理。 |
| `operations-center/README.md`、`docs/cost-analysis.md`、`docs/metrics.md`、`provider-monitor/README.md`、`CUSTOMIZATIONS.md` | 记录每日公式、真实采购成本、同步覆盖与同币种要求、兼容及配套更新范围。验证完成后补充结果。 |

验证：运营中心完整 271 项、供应商监控完整 297 项测试通过；运营中心 npm run check 及本轮新增接口 / 服务文件 node --check 通过；git diff --check 通过。供应商监控原有 key-probe 恢复间隔测试首次全量偶发失败，单独 9 项及第二次完整 297 项均通过，未修改无关探测逻辑。1440px 桌面 / 390px 手机 Playwright 使用真实 PGlite SQL、SQLite 采购账本和新供应商 HTTP 接口验证管理员排除、订阅消费、历史倍率 / 汇率、亏损和零分母、按月查询仍保留日表、供应商详情、截断后利润待核验；无未捕获页面错误或整页横向溢出，手机表格内部滚动，说明和详情默认折叠。截图已复核，保存在忽略的 operations-center/data-preview/daily-profit-*.png；两个验收服务及临时数据库均已关闭 / 清理。

边界：沿用主站 CNY 额度金额约定，列表仅 CNY；监控只能核验已配置供应商，未接入上游无法自动发现。今日日志未覆盖当前时刻或历史日期缺完整覆盖时仍为待核验，不把有一部分账本记录误认为全天完整。需要运营中心与供应商监控配套更新，沿用既有地址、Token / SSO、倍率与汇率配置，无新环境变量或数据库迁移。当前仅本地实现，未提交、推送、发布或部署，不代表生产已更新。

用户随后明确授权提交 GitHub。本次只将本节每日真实收入实现、测试和文档提交并推送 extra main；推送前 fetch 核对远端，沿用原有 Actions 测试与 GHCR 镜像流程，构建 / 发布结果以本次提交 SHA 的 Actions 为准。此前独立生产维护台账、无关工程和文件保留本地，不纳入本次提交；本次不部署或操作生产资金。

## 2026-10-25：修复满血 AI HTML 审核 HTTP 400 与管理员诊断

用户要求修复降智检测审核不可用，并随后授权提交 GitHub。本轮只提交降智检测及对应台账，保留运营中心、独立生产台账及其它无关未提交改动；推送至 main 后沿用现有 Actions 构建镜像，不部署，不改 Sub2API 源码、生产配置或历史记录。

根因：满血 AI 当前公开 API 文档已与旧教程不同。`pelican` 用于上游生成，提交已有作品必须使用 `html` 模式，并携带 `base_url`、`api_key`、固定 `model=gpt-6-astra`。旧格式实际返回 HTTP 400 / `model is required and must be gpt-6-astra for pelican, creative and html`。官方文档明确 HTML 模式是源码分类器，不调用上游、不消耗上游 Token，也不是真正的截图视觉判断。

| 文件 | 本轮改动与后续必须保留的约定 |
| --- | --- |
| `degradation-detector/src/visual-config.js`、`src/config.js` | 仅识别官方 HTTPS origin 与 `/api/v1/tests` 路径，将已有配置自动归一为 HTML 分类与固定模型字段；生成模型不变，非官方兼容接口保留原协议与可配置基准。无新增环境变量或迁移。 |
| `degradation-detector/src/visual-review.js` | 提交已保存 HTML，固定发送非真实的 URL / Key 占位值满足官方格式校验，不转发用户或分组生成凭据，不进入上游生成模式；轮询校验实际 HTML 基准、任务 ID 和最终结论，正常 / 疑似降智 / 无法判定映射不变。HTTP 400 / 422、401、403、404、413、429、重定向与 5xx 分别给出通用错误，不误记正常或降智，不自动重发提交。 |
| `degradation-detector/src/review-http.js` | 非成功响应仅限时 2 秒读取最多 8 KiB JSON，提取错误码和最多 300 字符说明；过滤已知凭据、Key 模式、长令牌、URL、邮箱、控制字符及包含源码的消息。保留 HTTP 状态，不保存整段正文；DNS 固定公网、禁止重定向及原总超时保持。 |
| `degradation-detector/src/server.js`、`src/store.js` | 脱敏审核诊断只加入现有管理员分组历史，沿用实时角色及分组授权；普通用户结果列表、详情及预览不返回诊断。公开结果仅新增安全枚举 `method=source_classifier` 标识实际方法，旧记录的 HTTP 状态可供管理员查看，缺失说明不编造。 |
| `degradation-detector/admin/app.js`、`public/app.js` | 官方接口的基准与模型字段自动填充且只读，其它兼容模型字段可编辑；管理员历史展示转义后的提交 / 查询、状态码及脱敏说明。结果详情明确显示源码分类及其依据，保留原有折叠证据、HTML 预览、人工复核及只读结果页边界。 |
| `degradation-detector/tests/visual-review.test.js`、`tests/server.test.js` | 更新官方真实请求契约与 HTML 基准；覆盖旧配置归一、不发送真实生成凭据、兼容旧异步服务和同步 HTML 服务、两种有效结论、HTTP 分类 / 大小限制 / 脱敏、管理员专有诊断、普通用户隔离与角色撤销；保留任务不匹配、超时与不重复提交回归。 |
| `degradation-detector/README.md`、`CUSTOMIZATIONS.md` | 说明新格式、固定占位值、源码分类的实际能力、旧配置兼容、管理员诊断入口和原历史不自动重判。 |

验证：降智检测完整 117 项测试通过；本机用无真实凭据的示例 HTML 调用公开 API，旧格式得到上述 400，新格式返回 202 并轮询至 succeeded；修复后的实际 VisualReviewer 模块也取得 completed / degraded，生成模型保持不变。仅圆形 SVG 的简化示例被分类为疑似降智符合其输入，不代表用户的真实分组结论。1280px 桌面 / 390px 手机 Playwright 验证固定与自定义模型控件、管理员诊断、源码分类依据、默认折叠证据及 iframe 内 SVG 渲染，无页面错误或横向溢出；使用隔离演示数据库且不发生成请求，测试服务已关闭。截图留在忽略的 `degradation-detector/data-preview/manxue-protocol-20261025/`。生产 SSH 接口探测仍被自动审批拒绝，因此没有生产侧复测或重启；不把本机实测称为服务器已修复。

## 2026-10-23：运营中心计费核查

配套 `fjiangming/sub2api` dev，核心基线 `dba770d56a0ee0ae5bad1b3dc5e11614d323163c`。
后续 AI 修改源码/配置/测试时同步记录，禁止用原作者更新覆盖本功能。核心事务、发行源和可靠性边界见相邻 `sub2api/CUSTOMIZATIONS.md`。

| 文件 | 需保留的功能 |
| --- | --- |
| `operations-center/src/services/billing-recovery-service.js` | 原生 admin API 代理、查单与用量差异、版本 CAS、补记/确认/结算编排、后台单飞、重启恢复；不写余额、不重发推理。 |
| `operations-center/src/app.js` | 管理员会话和所有变更的 CSRF，复用现有 SSO/持久认证。 |
| `operations-center/src/server.js` | 已有进程中启停恢复线程，无额外服务。 |
| `operations-center/src/config.js`、`.env.example` | OPERATIONS_CENTER_BILLING_RECOVERY_ENABLED 默认 true；没有持久管理员认证则后台不运行。 |
| `operations-center/public/index.html`、`public/app.js` | 计费核查 tab 与现有导航、刷新、退出生命周期。 |
| `operations-center/public/billing-recovery-ui.js`、`.css` | 异常列表、详情、查单差异、历史价格凭据、原生多模态记录、核查确认、结算、审计历史及手机布局。 |
| `operations-center/tests/billing-recovery.test.js` | 会话/CSRF、唯一性/历史映射、拒绝余额差额、单飞、失败隔离、重启读取持久待办。 |
| `operations-center/tests/frontend-layout.test.js` | 新增 tab 对应的导航计数。 |
| `operations-center/package.json` | 新源码纳入语法检查。 |
| `operations-center/README.md` | 入口、配置与操作边界。 |
| `operations-center/docs/billing-recovery-update.md` | 基于服务器只读核验的更新步骤：保留冻结数据库/Redis、已有网络及数据卷，修改目标服务镜像与 pull_policy，备份、按主站→运营中心顺序更新及回滚。无密码/Token，不依赖服务器 Git。 |
| `AGENTS.md`、`CUSTOMIZATIONS.md` | 未来集成时维护个性化改动。 |

每 30 秒读取核心 state=pending 的到期待办，最多 100 条。重复执行依靠核心原生 dedup 防止重复扣费；重试次数/退避在核心数据库中，12 次失败转人工核查。
只拥有浏览器 SSO 时可人工重试，后台需要持久管理员认证。查单复用 provider-monitor 的业务同步样本，不发测试推理。唯一 request ID、历史映射、未截断才确定匹配；相似时间/模型/token 不能授权扣费。
首次补记为 review，确认后 prepared，再调用原生事务写 usage_logs 和扣费。已结算案例提交最终累计用量，由核心生成差额子记录；进一步差额基于最新已结算子节点继续。没有历史价格时运营填写并提供证据。
验证：运营中心 npm test、npm run check；桌面及 390px 手机验证保存→确认→结算，无未捕获脚本错误和整页横向溢出。本次不连接生产，不补扣真实用户。

后续推送轮次只读核验了部署环境：实际主站二进制 0.2.17，冻结镜像保留 0.1.160 元数据；运营中心持久管理员认证和供应商监控集成已配置。GitHub 首次 ARM64 构建遇到 QEMU Illegal instruction，重跑已成功，未因此改动源码。更新手册只提供命令，未执行部署、数据库迁移或真实补扣。

## 2026-10-23：构建检查与核查范围说明

`.github/workflows/docker-publish.yml` 在既有测试门禁中加入运营中心 npm ci / check / test，使用与其 Docker 基础镜像相同的 Node 22.20.0；测试失败不发布各服务镜像。

`operations-center/docs/billing-recovery-update.md` 首次切换改用主站 latest 与运营中心 operations-center-latest，增加 OCI revision 与远端分支完整 SHA 核对，明确 latest 代表最新成功发行以及固定版本的可选方式；后续只需 pull / up，不需要服务器源码。`operations-center/docs/billing-recovery-behavior.md` 与 README 明确已同步样本、手动查单、四类 Token 差额、历史价格核定、后台只恢复 prepared / 缓存待办、缺少全量自动对账及金额比较的现状。此次不改变计费或查单代码，不操作生产余额。

验证：运营中心 158 项测试与 npm run check 通过，更新手册全部 6 个 Bash 命令块通过 bash -n，工作流 YAML 的运营中心测试依赖关系通过校验。

更新手册补充 latest 通道的准确回滚：备份运行容器的镜像 ID，回滚时为旧 ID 创建本地标签并将目标服务 image 固定到它、pull_policy=never。不能仅恢复 image:latest 的 Compose 来回退版本。此轮仅文档，6 个 Bash 块继续通过语法检查；未在 VPS 执行这些更新或回滚命令。

## 2026-10-23：正式镜像部署与 2FA 后台认证适配

用户授权更新生产。主站切换到 fork 0.2.17000501 / ad94ed860，配套运营中心沿用原数据卷。备份统一放在 /root/sub2api-deploy/backups/billing-fix-20261023072212，包含原 Compose / env / Nginx 配置、旧镜像身份、数据库与角色、应用和 Redis 数据、校验清单及部署事件。隔离网络的完整数据库副本恢复、迁移和两个镜像的健康检查通过后才暂停流量；在途请求归零并静置后备份和切换。PostgreSQL / Redis 容器没有重建或重启。原生 90 天保留任务在启动时清理了 5 条过期零元历史记录，已从最终备份按原 ID、原字段原样恢复；余额和已计费总额不变，未修改原保留策略，未补扣用户。

实际认证探测发现原持久邮箱密码属于开启 2FA 的账号，配置存在不代表后台能登录。`operations-center/src/sub2api-client.js` 最小增加原生 admin- 管理员 API Key 的 x-api-key 认证；凭据验证和跨来源写入前的只读探测使用受保护 admin/system/version。显式浏览器 Authorization / X-Api-Key 不叠加持久管理员凭据，保留 JWT / SSO 及写请求不跨来源重放的规则。配置沿用 SUB2API_ADMIN_TOKEN，部署复用既有 Key，不轮换其他服务的密钥，不关闭 2FA。README、更新手册同步记录认证要求、90 天保留策略和专用备份路径。6 项认证回归覆盖原生 Key、拒绝无效 Key、凭据恢复、浏览器覆盖隔离以及不重放写入；需运行全部运营中心测试和语法检查后再发布镜像。

验证：运营中心 164 项测试、npm run check 和修改后的更新手册 6 个 Bash 块语法检查通过。新增角色备份及 pg_restore --list 校验步骤，避免仅备份单库后无法在空实例重建运营中心角色权限。主站恢复接单后，生产请求已形成 settled 恢复记录、cache_pending 为 false；unknown 仍等待上游最终结果，不自动按相似请求扣费。

## 2026-10-23：所有上游超时的持久查单、用户归属与核查草稿

此轮仅本地实现，未提交 / 推送 / 发布 / 部署，未补扣真实用户，不重发推理。配套主站新增同步转上游 SSE 和历史价格快照；无供应商 / 域名限定。保留前述核心恢复、人工 review → prepared → 原生使用记录与资金同事务的约定。

| 文件 | 本轮改动及后续必须保留的行为 |
| --- | --- |
| `operations-center/src/billing-recovery-store.js`（新增） | WAL / FULL SQLite 保存异常镜像、用户 / Key / 上游账号归属、观察用量、查单结果、退避、5 分钟租约及各状态发现游标。重启续跑；已验证的部分账单在核心版本 / 用量证据变化后重新核查，原证据不丢。 |
| `operations-center/src/services/billing-recovery-usage.js`（新增） | Anthropic / Chat / Responses / Gemini / xAI / Bedrock 等数值别名、缓存 / thinking 语义；未知不当零，无效维度不当最终用量。仅可信 dispatch / 上游响应 ID 可匹配；拒绝调用方复用 ID 及其回显。 |
| `operations-center/src/services/billing-recovery-service.js` | 用户 / Key / 账号 / 请求 / 超时筛选；后台分页发现 unknown / review / incomplete 并入持久队列。每轮最多查 20 条，按历史映射定向刷新上游日志，保留费用 / 币种 / 覆盖 / 差额；有效最终标准 Token 用历史只读 quote 生成 review 草稿，不批准或扣款。原 prepared / cache_pending 继续原生重试。 |
| `operations-center/src/server.js` | 已有进程中初始化、注入、关闭 `<dataDir>/billing-recovery/billing-recovery.sqlite`，不新建服务或资金账本。 |
| `operations-center/src/provider-monitor-client.js` | 复用集成 Token 或 SSO + CSRF 调用有界的 billing-samples 刷新；不将短期浏览器 token 当后台凭据。 |
| `operations-center/src/app.js` | 新增 `/api/billing-recovery/:id/draft`，保留管理员鉴权和 CSRF；不接受余额差额。 |
| `operations-center/public/index.html`、`billing-recovery-ui.js`、`billing-recovery.css` | 展示用户 / Key / 上游账号 / 分组快照、独立的已观察 Token 与本地使用记录、完整 / 部分状态、同步 / 流式 / 断开元数据、保存的查单证据 / 费用 / 差额；筛选和草稿入口及手机布局。 |
| `operations-center/package.json` | 新增文件进入现有语法检查，无新增运行依赖。 |
| `operations-center/tests/billing-recovery.test.js`、`billing-recovery-durable.test.js`（新增） | 持久重启 / 退避 / 游标 / 租约、用户归属、Token 归一化、反回显误匹配、上游不可用 / 冲突 / 缺价阻止扣费、SSO CSRF、自动发现部分账单；后台生成草稿不审批。 |
| `provider-monitor/src/services/sync-service.js` | 按历史映射 Key 定向读取真实业务日志，串行限量 / 冷却 / 连接互斥，复用原样本与采购成本持久化，不将定向读取冒充全供应商同步。无模型调用。 |
| `provider-monitor/src/adapters/base.js` | 为账单完整性提供严格 Token 整数判定，禁止把小数、布尔、负数和异常字符串变成已确认计数。 |
| `provider-monitor/src/adapters/sub2api.js` | until 窗口、受控并发与分页间隔、按排序窗口提前停止、明确最终用量完整性；不支持的日志端点仍报不可用。 |
| `provider-monitor/src/adapters/one-api-family.js` | until 窗口保留毫秒覆盖语义、分页间隔、定向查询只接受 Key ID 归属，避免同名 Key 混入；无效或未支持的缓存 / 媒体等维度不确认为最终用量。 |
| `provider-monitor/src/services/latency-samples-service.js` | 返回费用、币种、usage_complete 与 billingCoverageComplete；历史映射有效、同步成功且覆盖完整、查询未截断才允许唯一账单匹配。 |
| `provider-monitor/src/server.js` | 集成 Token / 管理员 SSO 边界增加定向刷新接口；SSO 写操作继续受现有 CSRF 保护。 |
| `provider-monitor/src/db/index.js` | schema 33 仅新增可空 usage_complete，旧样本原计数保留而完整性未知，不伪造旧记录已验证。 |
| `provider-monitor/tests/adapter-contracts.test.js`、`billing-recovery.test.js`（新增） | 定向窗口 / 归属 / 无推理、覆盖 / 冷却 / 限流、迁移保旧、授权、严格计数及现有适配器契约回归。 |
| `.github/workflows/docker-publish.yml` | 现有镜像 build 再依赖供应商监控测试 job；使用 Docker 一致的 Node 20，运营中心仍用 Node 22.20.0；不绕过既有检查。 |
| `operations-center/docs/billing-recovery-behavior.md`、`operations-center/README.md`、`provider-monitor/README.md` | 重写已过时的“仅人工 / 仅读缓存 / 不返回金额”说明，写明新自动范围、历史价格 / 特殊维度边界、SQLite 一致性备份与三镜像升级。 |
| `operations-center/docs/billing-recovery-update.md` | 保留原首次部署步骤，补充供应商监控的同目录备份 / 原镜像 / 卷、三服务配套更新、schema 33 及生产现有超时覆盖保留；仅文档未执行。 |
| `CUSTOMIZATIONS.md` | 本节改造清单、验证、边界及后续集成依据。 |

后台查单需要已配置的主站持久管理员凭据和供应商监控集成 Token。每 30 秒原生待办最多 100 条；异常发现每状态一页 100 条，未知请求超过保护期限加 60 秒且最近一分钟无更新才处理，查单退避最长 6 小时。供应商日志定向读取按连接并发 1、分页延迟 300ms、上限 1000 条，普通冷却至少 60 秒 / 限流至少 5 分钟。查询缺覆盖、无唯一 ID、无历史映射或无最终用量均不能自动核定费用。

原生 HTTP / SSE 最终用量可独立于供应商监控生成历史标准 Token 草稿；上游单独提供最终账单时必须唯一可信匹配，且缺少缓存时长、特殊价格 / 多模态或数值冲突则转人工。上游实际费用只作证据，不当售卖费用。已结算但不完整的记录核对出差额时保留原账，由管理员向最后已结算节点补最终累计使用记录，核心生成差额子记录；后台不直接补扣。

运营中心新增 SQLite 位于已有数据卷；运行中备份应使用在线备份 API，或停止写入后归档完整目录，不能只复制主库遗漏 WAL。主站 PostgreSQL、供应商监控 SQLite、运营中心核查 SQLite 三者均需保留。新增列 / 索引不删除历史数据；更新生产只拉三个配套 fork 镜像，不拉源码，不轮换现有 Secret。历史无意图丢单不能凭相近时间 / 模型猜测用户；没有最终上游证据时只能保留已知数值待核查。

验证：运营中心 172 项、供应商监控 287 项全量测试全部通过，运营中心 check 与两服务全部 80 个 JS 源文件语法检查通过；桌面 / 390px 手机的查单 → 草稿 → 核查 → 结算交互使用本地模拟数据通过，无整页横向溢出或未捕获脚本错误。CI YAML 的 Node 20 / build 依赖与更新手册 8 个 Bash 块解析 / 语法验证通过。核心计费回归、真实 PostgreSQL 3 项和 Windows 二进制构建通过，原 service 全量 Windows 时间精度失败如核心台账所述。未运行 Docker 构建、Linux CI、真实上游推理或生产资金操作。保留无关的 `usage-leaderboard/public/assets/leaderboard.svg`，未修改它。

核心最终额外运行与 GitHub CI 相同版本的 golangci-lint 2.14.0，四个相关完整包为 0 issues，随后计费回归与 server 构建通过。两仓库最终 diff --check 通过；保留既有独立生产超时配置文档及其他未提交改动。

## 2026-10-23：CSV 自动匹配、扣费预览与确认补记

此轮仅本地实现，未提交 / 推送 / 发布 / 部署，不连接上游、不重发推理、不操作生产资金。保留此前未提交的所有功能和无关 `usage-leaderboard/public/assets/leaderboard.svg`。核心仅新增历史来源预留和列表日期过滤，见相邻核心台账；运营流程仍由本服务负责。

| 文件 | 本轮改动和后续必须保留的语义 |
| --- | --- |
| `operations-center/src/services/billing-import-csv.js`（新增） | 使用 csv-parse 解析引号 / BOM / 中英文表头及显式映射，Luxon 解析时区 / 起止时间 / 时钟修正；严格整数和大小限制，未知缓存保留未知。供应商身份摘要保留原始时间的小数精度，不随运营时区 / 时钟 / 输入缓存解释变化；重复行保守标记。 |
| `operations-center/src/services/billing-import-source.js`（新增） | 已有只读 PostgreSQL + 主站恢复列表读取原版错误、原生用量和持久意图，按账号 / ID / 模型 / 开始时间生成候选；区分多次尝试、未知耗时，合并同一次请求的多种来源。只读取无正文的关联 / 数值元数据；SQL 对 JSON null / 非数组错误列表安全处理。查询截断失败阻断，多候选不猜用户，同本地请求多行争用标记冲突。已有用量或缺本地关联 / 归属时不能整笔补扣。 |
| `operations-center/src/billing-import-store.js`（新增） | 与既有核查队列共用 SQLite WAL / FULL；新增 import_batches / import_rows，保存原 CSV、选项、轻量元数据、匹配、冻结预览、核心案件及回执。SQL 分页 / 汇总 / 预览占用查询，避免对 15000 行反复完整解析；版本 CAS、5 分钟确认租约，失败 / 已开始确认冻结匹配配置，重启可按原预览续办。没有新增资金表。 |
| `operations-center/src/services/billing-import-service.js`（新增） | 导入 / 匹配 / 预览 / 确认编排；支持手工历史模型价格、缓存时长核定及核心冻结售价只读 quote。Decimal 计算金额，最终金额按原生 float64 乘法后再量化到 8 位，避免半单位边界预览不一致。已有最终观察数值冲突、特殊维度或不支持的快照阻止预览。归属、价格证据和最终用量必须核对；预留 → usage review → prepared → 原生 settle，丢回包后重读状态，绝不直接改余额。 |
| `operations-center/src/server.js` | 初始化导入 store / source / service，复用同一数据库与现有只读池、恢复客户端，没有新服务或计划任务。 |
| `operations-center/src/app.js` | 新增 `/api/billing-imports` 的 inspect / options / detail / match / preview / confirm；保持管理员会话、no-store 和 CSRF。仅上传 / 表头检查使用大 JSON parser，且在鉴权和 CSRF 后执行；其他接口保持原 64 KiB 限制。 |
| `operations-center/src/services/billing-recovery-service.js` | 原有列表代理接受 from / to 日期，用于限定批次源查询；保留此前查单 / 草稿 / 恢复行为。 |
| `operations-center/public/index.html`、`billing-import-ui.js`（新增）、`billing-recovery-ui.js`、`billing-recovery.css` | “计费核查”内新增 CSV 补记子页，编码 / 字段 / 上游账号映射、时间配置、候选详情、历史价、逐笔和按用户汇总预览、确认和续办、筛选 / 分页。显示用户 ID / Key / 账号、原生来源与时间、倍率、余额 / 订阅类型和核心回执；更改配置 / 价格禁用旧确认，退出清除当前 DOM 中的批次信息。供应商字段全部转义，表格手机内滚动不撑开整页。 |
| `operations-center/package.json`、`package-lock.json` | 新增 csv-parse 7.0.3+、Luxon、decimal.js；新源码 / 演示 / 浏览器检查纳入语法检查，增加隔离预览与检查命令。锁文件仅定向升级既有传递依赖 ip-address 到 10.7.4+，修复 GHSA-rxp7-6hxx-x8q5，不关闭审计或执行 force 更新。 |
| `operations-center/tests/billing-import.test.js`、`billing-import-source.test.js`（新增） | CSV 格式 / 时间 / 精度 / 计数 / 未知缓存 / 重复行、125s 本地错误对 174s 上游、并发用户、多次尝试、已有账单、无关联 ID、争用归属、预览无扣费、价格缺失 / 快照冲突、原生结算 / 丢回包 / 重启 / 租约 / CAS / 并发确认、筛选、鉴权及上传 CSRF；源 SQL 用真实 PGlite 验证。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs`（新增） | 只绑定本地的隔离模拟数据预览，无真实 DB / 凭据 / 供应商连接，结算仅改演示状态。可选外部 Playwright 包验证桌面 / 手机导入至确认、重载恢复和无页面溢出，不把浏览器加进生产依赖或镜像。 |
| `operations-center/docs/billing-csv-import.md`（新增）、`docs/billing-recovery-behavior.md`、`README.md` | 操作步骤、Lingsu 导出例子、原版日志与 fork 执行边界、手工历史价格需按实际用户 / 分组分别核定、20 笔批次确认、幂等 / 中断 / 备份 / 部署限制。修正历史“无 CSV 导入”的说明。 |
| `CUSTOMIZATIONS.md` | 本节改动、验证和个性化契约。 |

处理限制：每批 8 MiB / 20000 行 / 100 列 / 单行 64 KiB、31 天、最多 20 个上游 Key 映射；每类原生源 / 持久案件最多 20000 条，超限必须缩小范围，不能把截断样本当完整核对。每次预览 / 确认最多 20 笔，候选超过 30 个不批准。时间匹配即使唯一也需核对；多个候选要明确选择和归属依据。缺缓存 / 时长 / 历史价不能当零猜测。手工模型价格应用于当前所选行，历史用户 / 分组价格不同须分别选取生成预览，不能把一组价格静默套所有用户；核心冻结快照则按请求独立报价。

同内容回到原批次，核心对上游账单与本地请求双重唯一预留，预览摘要不可在确认中变化。已有记录但用量不同只标出核查，不再收整笔；有持久案件的差额继续使用原有累计补记链，仅有原版使用记录的差额不在本轮自动建账。原日志已清理或全部本地关联 ID 丢失时，CSV 不能凭上游 Key 名恢复用户。Lingsu 无逐条日志 API 不影响人工 CSV 输入，但仍需最终账单、可核对本地归属及历史售价；CSV 导入不会自动读取供应商监控。

验证：实际上游导出 15100 行全部解析有效，38 条重复候选保守标记，解析 / SQLite 保存 / 首屏分页约 619ms（未连接生产匹配用户）；运营中心 197 项全量测试通过，包含 25 项 CSV / 原版源 SQL 专项，check 与生产依赖审计通过（0 vulnerabilities）。1440px / 390px 浏览器完成真实本地 HTTP 上传、自动匹配、预览、确认模拟结算、刷新读取回执、筛选和布局验证，无页面横向溢出和未捕获脚本错误，最终截图已复核；截图为本地 Temp/sub2api-csv-billing-ui-qa。主站回归、4 项真实 SQL、server 构建及最终 lint 0 issues 见核心台账，两仓库 diff --check 通过。尚未进行 Docker / Linux CI、真实上游推理和生产补扣，部署必须另行授权。

## 2026-10-23：授权提交与推送计费修复

用户授权提交并推送本轮持久核查、供应商定向查单与 CSV 补记功能，extra 使用 `main`，配套核心使用 `dev`。保留镜像构建前的运营中心和供应商监控等测试门禁；无关的 `usage-leaderboard/public/assets/leaderboard.svg` 继续保留本地，不纳入本轮提交。暂存新增文件后发现并移除 `operations-center/tests/billing-import.test.js` 末尾多余空行，仅调整空白；复核暂存区 diff --check。不连接或更新服务器，不执行生产数据迁移及真实扣费，等待用户后续通知再部署。

## 2026-10-23：修正生产 Compose 镜像拉取通道

用户明确授权修改服务器 `/root/sub2api-extra/<服务名>/compose.yaml`。北京时间 22:50:03 完成五份生产配置调整：`provider-monitor`、`recharge-center`、`usage-leaderboard`、`degradation-detector` 从 `migration20261021/sub2api-<服务名>:frozen` / `pull_policy: never` 改为 `ghcr.io/fjiangming/sub2api-extra:<服务名>-latest` / `pull_policy: always`；`operations-center` 保留同仓库 `operations-center-latest`，仅将 `missing` 改为 `always`。

上述是服务器迁移遗留覆盖的修正，不用本地模板整体覆盖生产配置。本地五份 Compose 模板已使用正确的 GHCR 默认镜像，本轮未修改模板或业务源码。保留生产 build 字段、环境、端口、网络、卷及运行参数；后续升级可直接拉取镜像，无须拉取源码。真正部署时应使用 `--no-build` 防止本地构建，并配套验证主站、运营中心、供应商监控版本，不能把配置切换视为计费新功能已上线。

原始五份文件、候选、逐行差异、前后完整 Compose 解析、容器快照、受保护文件散列、GHCR 标签摘要及执行回执统一保存在 `/root/sub2api-deploy/backups/extra-image-channel-20261023225003/`，目录 0700，目标文件原 0600 / root 属主保持。验证 GHCR 五个标签均已发布且包含 linux/amd64；完整 Compose 前后仅有 image / pull_policy 差异；14 个运行容器的 ID、镜像、启动时间、重启次数、运行和健康状态完全一致。根 Compose、各 .env、主站 Compose 与 Nginx 配置散列保持一致。Compose `--dry-run pull` 五项均预演 Pulling / Pulled，未再按原策略 Skipped；这不是实际下载或运行新镜像的验收。

本轮没有实际 pull / up / restart、更新数据库或补扣用户；仅追加本台账及核心配套台账和服务器改动清单，不提交、推送或触发 GitHub 发布。

## 2026-10-24：修正 CSV 漏计费匹配与历史取消请求归属

用户要求修改匹配逻辑并与此前服务器检测结果自测对比。本轮只改本地运营中心，extra 保持 `main`；核心保持 `dev` 且没有源码改动。未连接或变更生产，没有提交 / 推送 / 发布 / 部署，也没有预留或补扣用户。保留本台账原有生产镜像通道记录、核心已有文档改动，以及无关未跟踪的 `usage-leaderboard/public/assets/leaderboard.svg`。

| 文件 | 改动与后续必须保留的约定 |
| --- | --- |
| `operations-center/src/services/billing-import-matcher.js`（新增） | 从原 source 模块分离纯匹配。先以同账号 / 模型的完整四类 Token、原生用量时间和 ID 排除已有账单，再找未占用的精确时间候选；开始 / 结束两种时间均用于防误补扣。每 Key 至少 3 个有区分度样本、90% 一致才自动校准，显式时间设置冲突阻止补记。缺耗时的四小时区间不再淹没精确候选，也不允许仅靠区间生成扣费预览。区分用户归属唯一与具体 dispatch 唯一；一笔本地收费不能排除多笔不同上游账单。ID 与 Token 矛盾、用量差异及一对多冲突单列核查。算法版本为 2。 |
| `operations-center/src/services/billing-import-source.js` | SQL 只读读取原生 dedup 热表和归档，按 request_id + api_key_id 核实处理证明，缺表不冒充已扣费。保留已有用量的零费 / 未核实状态，区分 prepared 使用草稿与 settled。合并原生使用记录时保留持久意图的真实开始时间，附原生结束时间、三种模型别名及缓存 TTL 明细。读取范围兼容两种 CSV 时间解释；整次源读取失败或截断仍停止。接入可选文件日志并只对同一原生请求归属补全开始时间。 |
| `operations-center/src/services/billing-import-logs.js`（新增） | 可选只读流式读取主站结构化 `.log` / `.log.gz`，只保留时间、请求 ID、用户 / Key / 分组 / 账号、模型、流式和状态元数据，丢弃正文和错误明文；通过同一服务端 ID 的唯一账号选择、用户归属和访问结束关联历史取消请求。不递归 / 不跟随文件链接，128 文件 / 1 GiB 解压数据 / 600000 事件 / 64 KiB 单行上限，超限或损坏失败而非使用部分证据。文件日志不声明完整覆盖；仅文件日志不能伪造原生错误或成为直接扣费来源。 |
| `operations-center/src/services/billing-import-service.js` | 默认自动时间校准，持久化匹配诊断和修正后的开始时间；新增归属 / 未核实扣费筛选。预览前、首次确认前重新读源，阻止已有账单、候选变化、过多候选、时间证据变化和旧算法预览；冻结证据摘要。已开始的新版本确认保留原生预留幂等与失败续办，不增加第二套结算。 |
| `operations-center/src/billing-import-store.js` | 原 JSON 表结构中增加已定位用户 / 扣费待核查 / 时间不足 / 争用记录状态筛选，无数据库迁移或资金表。 |
| `operations-center/src/config.js`、`.env.example`、`src/server.js` | 可选 `OPERATIONS_CENTER_BILLING_LOG_DIR`，未配置不读文件日志，显式挂载不可读则阻断匹配并给出原因；只在现有进程中注入读源。 |
| `operations-center/public/index.html`、`public/billing-import-ui.js` | 展示时间校准证据、各类数量、原生扣费是否核实、零实际费及用户 / Key / 分组，未知费用保留未知；新增已定位 / 扣费待核查筛选，禁止仅文件来源和时间不足项被勾选补扣。旧匹配要求重跑，未匹配不再显示“时间匹配待确认”，退出清理诊断文本。保留价格核定和原生计费流程。 |
| `operations-center/scripts/billing-import-replay.cjs`（新增） | 从外部审计文件离线回放，断言旧误报排除、完整用量保护、文件日志用户一致、完整 Token / 原生扣费证明和一对一排除。没有 DB / API / 预留 / 结算调用，真实源文件不入 Git。 |
| `operations-center/tests/billing-import-matching.test.js`、`billing-import-logs.test.js`（新增）、`billing-import-source.test.js`、`billing-import.test.js` | 匿名回归覆盖错误时间含义、4 条类零费场景、实际 SQL dedup / 归档 / 错 Key 排除、模型别名 / 缓存 TTL、四小时区间、同用户并发与跨 Key / 分组冲突、一笔记录争用、多来源合并、gzip / 损坏 / 限制 / 秘密字段剔除、旧预览、预览后新账单 / 新候选、文件来源禁止预留及原确认幂等 / 重启 / 租约。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 隔离演示扩展已收费 / 文件归属 / 零费用状态，桌面 / 手机验证新增筛选与不可扣费项。浏览器测试使用 OS 分配临时端口；手动演示探测占用端口后递增，避免 Windows 下读到本机旧演示。所有测试创建的服务均关闭，不停止已有演示进程。 |
| `operations-center/package.json` | 新模块和离线脚本纳入原 check，原 test glob 自动运行新测试，无新增依赖或发行工作流改动。 |
| `operations-center/docs/billing-csv-import.md`、`README.md` | 改正实际 Lingsu CSV 的 Time 为结束时间；说明新状态、自动校准、读源 / 确认防重、仅文件日志的原生预留限制、可选只读日志挂载及旧批次重匹配。挂载示例仅文档，本轮不修改生产 Compose 或权限。 |
| `CUSTOMIZATIONS.md` | 本节登记全部改动及验证；不覆盖前轮维护记录。 |

资金边界保持原约定：已有用量但未核实扣费不能按 CSV 再建整笔消费；少计用量在已有原生案件差额链核查。仅文件日志可定位用户，但当前核心导入 API 仅接受原生恢复案件或 ops_error_logs，故保留待核查，不向原生错误表造记录，不改余额。含原生候选的同用户并发也需具体请求归属证据，不能随机选择一个 dispatch。旧算法的已开始确认批次先核对核心预留 / 回执，不绕过冻结另建批次。

验证：运营中心全量 216 项测试、npm run check、1440px / 390px Playwright 导入 → 自动校准 → 新筛选 / 禁选 → 报价预览 → 原生模拟结算 → 刷新回执全部通过，无未捕获脚本错误、按钮溢出或整页横向溢出。使用此前保存的生产快照离线回放 14,480 行：旧 24 条误报全部正确排除；此前 13,045 条已有关联用量全部保护，其中 4 条无扣费证明单列异常；此前 761 条文件日志归属逐条一致。新结果 13,176 已核实扣费、1,111 已定位用户待核查（757 仅文件、354 含原生来源）、5 条唯一原生时间候选、4 条扣费未核实、16 条用量差异、122 条多归属、12 条时间不足、34 条重复。新增排除项也逐条验证四类完整 Token、原生处理证明及一对一关系。上游支出不能当已确认损失或用户补扣金额。只读挂载未配置时不能复现文件归属结果。

详细本机验证报告位于用户 Downloads 的 `sub2api-billing-audit-20261023/MATCHING-FIX-VALIDATION.md`；真实快照仅位于该外部目录，未加入仓库。没有运行 Docker 构建、GitHub CI 或真实资金结算；核心无需新迁移。

用户随后明确授权提交 GitHub。本次仅提交并推送上述运营中心匹配修复、配置示例、文档、匿名测试及离线回放脚本到 `fjiangming/sub2api-extra` 的 `main`，沿用既有测试门禁和镜像自动构建；本地验证结果见上文，发布结果以本次 SHA 的 GitHub Actions 为准。此前生产镜像通道维护记录、核心两份文档及无关 SVG 继续保留本地未提交，真实 CSV、服务器快照、日志和凭据不进入 Git；本次不更新服务器或执行生产补扣。

## 2026-10-24：CSV 扣费预览增加上游余额差额

用户授权实现、验证后提交并推送 GitHub。本轮只修改 `sub2api-extra/operations-center`，保持 `main`；主站核心无需修改、迁移或重新发行。上游多扣余额差额定义为 CSV 的实际上游 USD 支出减本站拟补扣，负差额显示“本站拟多收”；仅为金额比较，不表示已回款或判定供应商错扣，不能把上游费用当作用户补扣金额。

| 文件 | 改动及后续保留要求 |
| --- | --- |
| `operations-center/src/services/billing-import-service.js` | 在详情返回时为已有预览派生 `costComparison`，Decimal 计算并返回 8 位定点金额。接受非负十进制、USD / 美元符号和规范千分位；缺失、负数、其他币种或无法识别的金额返回未知。订阅只返回支出与用量金额，余额差额为空。兼容旧持久预览；不写入预览、摘要或主站，不改变定价 / 预留 / 幂等 / 确认事务。 |
| `operations-center/public/billing-import-ui.js`、`public/index.html`、`public/billing-recovery.css` | 增加逐笔差额列、本页所选合计和按用户汇总的上游支出 / 本站拟补记 / 差额。前端以 8 位定点整数汇总，正负差额明确区分；余额与订阅单列，已知支出与未知条数同时保留，费用不完整则合计差额未知。勾选变化立即更新；表格在手机内部横向滚动，不撑宽整页。 |
| `operations-center/tests/billing-import.test.js` | 增加实际费用与售卖价正负 / 零差额、规范金额 / 非法金额、半单位舍入、未知不当零、订阅不当余额、旧预览重启可读、只读派生不改变原生结算的回归。 |
| `operations-center/scripts/billing-import-browser-check.cjs` | 验证桌面 / 手机及正差额 / 缺上游费用四组隔离模拟流程，核对逐笔、按用户和所选合计、取消勾选、订阅隔离、原生模拟结算及刷新回执。没有新增生产依赖。 |
| `operations-center/docs/billing-csv-import.md`、`CUSTOMIZATIONS.md` | 记录操作、金额公式、范围和验证；保留先前未提交的生产镜像通道维护记录。 |

验证：运营中心完整 219 项测试、`npm run check`、四组 Playwright 模拟流程全部通过，1440px 桌面 / 390px 手机没有整页或按钮溢出、没有未捕获脚本错误，截图已复核。前端和详情读取均未触发补扣；原生模拟确认仍只结算一次。浏览器测试依赖仅安装在本机临时目录，不改锁文件或镜像依赖。沿用 GitHub 既有测试和镜像构建流程，发行结果以本次 SHA 的 Actions 为准；本轮不连接或更新生产、不补扣真实用户，无关 SVG 和核心已有文档继续保留本地。

## 2026-10-24：修复跨日测试和 ARM64 镜像构建失败

用户要求修复 GitHub 构建失败，沿用此前提交 / 推送授权；本轮仅修改 extra 的测试及发布工作流，不更新服务器、不补扣用户、不改变主站源码或资金契约。保留原有未提交的生产镜像通道维护记录、核心文档及无关 SVG。

完整 Actions 日志确认两处不同原因：`b6522e4` 的供应商监控测试在 UTC 00:34 运行，相对当前时间的 40 / 20 / 10 分钟样本跨越 UTC 午夜，趋势实际为 2 天，测试却固定断言 1 天；`9b5ddb8` 的运营中心在 `linux/arm64` 的依赖安装阶段触发 `qemu: uncaught target signal 4 (Illegal instruction)` / 132，AMD64 阶段已成功。不能将测试失败解释为 CSV 计费功能失败，也不能将失败发行的 latest 当作新版本。

| 文件 | 改动及后续保留要求 |
| --- | --- |
| `provider-monitor/tests/account-monitor.test.js` | 将同窗口成本比较用例的完整时钟固定，复用既有断言覆盖白天和实际失败的 UTC 跨午夜时间；核对趋势日期、请求合计和所有原有金额 / 覆盖 / 归属保护。不放宽生产匹配，不移除或重试失败测试。 |
| `.github/workflows/docker-publish.yml` | 四类测试使用固定 Ubuntu 24.04。七个服务分别使用 `ubuntu-24.04` / `ubuntu-24.04-arm` 原生构建 AMD64 / ARM64，移除 QEMU；缓存按服务及架构隔离。先按 digest 推送候选，在各原生 runner 校验 Node 架构、SQLite 原生模块和完整 OCI revision，成功后导出当前运行专用 digest；所有构建完成后再合并双架构并更新原 latest / 分支 / SHA / 版本标签，检查最终架构。PR 保留测试和双架构构建但不推送；测试和构建失败不推进正式标签，保留 provenance 和原有 GHCR 仓库 / 标签契约。 |
| `CUSTOMIZATIONS.md` | 本节记录原因、改动和验证；不纳入此前独立生产维护记录。 |

验证：Linux / Node 20.20.2 完整 288 项供应商监控测试全部通过，Windows 两个固定时钟用例通过；actionlint、14 个原生构建矩阵项 / 7 个发布项 / 原四类测试门禁关系及 14 个 Bash 步骤语法检查通过，diff --check 通过。本机 Docker daemon 未运行，镜像原生构建 / 运行检查及正式标签发布结果以本次 SHA 的 GitHub Actions 为准，推送后继续核验；不能将推送成功声明为发布成功或生产已上线。

## 2026-10-24：简化 CSV 补记并自动读取主站售价

用户同意简化流程，并要求自动读取服务器主站模型价格、尽量不手配售卖规则。本轮 extra 保持 `main`，核心配套改动保持 `dev`，仅本地实现及隔离验证。没有连接生产、推送、发行、部署、预留或补扣真实用户。保留既有未提交的生产镜像通道记录、核心服务器改动清单及无关 SVG。

| 文件 | 本轮改动及后续必须保留的约定 |
| --- | --- |
| `operations-center/src/services/billing-import-service.js` | 默认自动调用原生 imports/quote；历史快照优先，缺失时主站当前模型 / 渠道价及用户 / 原分组倍率，显示来源 / 时间。人工规则仅可选；报价失败不估价。预览只读资金，不再要求先勾选最终确认，确认时统一核对归属 / 最终用量 / 价格来源 / 金额；冻结每行费用与摘要后按原预留 → usage review → prepared → settle 执行。支持管理员核对的完整文件日志来源，保留原生防重与丢回包恢复；匹配证明纳入选定关系及整批唯一分配摘要。 |
| `operations-center/src/services/billing-import-matcher.js` | MATCH_VERSION=3。完整且可用的精确候选按连通分量做整批一对一分析，只选所有完整分配中都必需的边，不选最近请求。分量超过 160 行 / 400 来源、触及不确定来源或无法完整分配保持核查；同用户和跨用户仍存在的歧义不强行解开。 |
| `operations-center/src/services/billing-import-logs.js` | 完整的唯一账号选择 / 访问结束 / 一致用户-Key-分组关联可生成管理员核对来源，含稳定 log:服务端ID、失败状态 / 时间 / 耗时与 sanitized 事件 SHA-256，不伪造原生错误，不保存正文或密钥。 |
| `operations-center/src/services/billing-import-source.js` | 只读核对文件来源对应的现存 Key / 用户 / 原分组，补邮箱、分组名与余额 / 订阅类型；已删除或不一致实体阻断。保留原生已有账单排除及多来源合并。 |
| `operations-center/src/billing-import-store.js` | 从最近 50 个批次读取相同表头 / Key 集合最近成功分析的映射与时间设置，导入后仍展示供核对。已开始批次禁止更改选项；允许原选项重新分析其余未开始行，不覆盖已预留 / 失败 / 结算中 / 已结算行、冻结预览或回执。无新表 / 迁移。 |
| `operations-center/public/index.html`、`public/billing-import-ui.js` | 主操作“分析账单并生成预览”，时间 / 缓存配置及人工售价折叠；默认自动报价，不输入价格。主筛选简化为可补记 / 待核查 / 已核平 / 已补记 / 全部记录；当前页最多 20 条唯一候选自动报价，单个最终确认包含价格来源。展示历史快照 / 当前主站价格与报价时间；报价全失败显示待核查与原因，确认完可查看已补记。保留金额差额、订阅隔离、输入变化后重报及转义。 |
| `operations-center/tests/billing-import.test.js` | 自动原生报价、来源 / 时间与归属、当前价格与历史价格区分、报价失败阻断、确认冻结费用、文件日志原生预留及结算、不制造 ops_error_logs、记忆映射、原选项重分析保留回执；适配预览只读 / 单次确认语义。 |
| `operations-center/tests/billing-import-matching.test.js`、`billing-import-source.test.js` | 只有强制唯一的整批关系才选定，歧义 / 来源不足不猜测；完整日志来源、真实 PGlite 的用户 / Key / 分组核对及订阅类型。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 模拟 2 条原生请求和 1 条完整文件日志的自动报价；验证无需填价格、历史 0.7 与当前分组 0.9 / 账号 0.79 区分、单次最终确认、金额差额、订阅隔离、重载回执及桌面 / 手机布局。只连接本地演示，没有真实 DB 或供应商凭据。 |
| `operations-center/docs/billing-csv-import.md`、`docs/billing-recovery-behavior.md`、`README.md` | 重写简化操作、自动当前价与历史价、整批唯一分配、文件来源的管理员信任边界、未开始行重分析、核心和运营中心同时升级要求。 |
| `CUSTOMIZATIONS.md` | 本节登记改动、验证及当前行为，历史章节中的仅文件不可预留 / 必须手配价格要求以本节为准。 |

本轮没有把 CSV 上游支出当售价，也没有按上游倍率反推下游价格。自动价格由主站复用原生模型、渠道、用户 / 原分组倍率计算；账号倍率不再次乘入用户费用。有不可用的历史价格快照仍阻断，当前报价不冒充历史价格、不写回已有快照；严格历史价可用可选人工规则核定。报价和预览不预留、不写使用记录或资金，最终确认使用冻结金额。未知缓存不能当零，有创建总数但无 TTL 时仍须核定缓存时长，这不需要填写价格。

完整文件日志是运营中心读取并由管理员确认的结构化来源声明，SHA-256 不是签名；核心不独立认证原文件。日志仍须完整关联和唯一匹配，核心在原事务锁下再核对身份、原请求期限、用量、持久意图和 dedup / 归档。没有日志挂载、日志已缺失、同用户并发仍不唯一、缺价格或特殊维度不能强行补扣。部署需配套更新核心和运营中心，现有 CSV schema 无新增迁移；供应商监控原查单流程不受改变。

验证：运营中心完整 225 项测试、npm run check、1440px / 390px / 正差额 / 未知上游费四组 Playwright 流程通过，截图复核无整页溢出或未捕获脚本错误。无需输入售卖价即可分析并预览 3 条模拟补记，确认后仅生成模拟原生结算回执；新预览的价格来源、金额冻结和重复确认行为均验证。

旧生产快照的离线回放保留 13,176 条已核实计费和此前排除的 24 条误报。14,480 行中，147 条唯一时间候选可进入核价（上游支出合计 47.23870787 USD，不是已确认补扣金额）、969 条已定位用户仍待具体请求核查（615 仅文件 / 354 原生）、122 条歧义、16 条用量差异、12 条时间不足、4 条扣费未核实及 34 条重复；此前 13,045 条已有关联用量和 761 条文件归属均通过保护断言。无法把此前 1,111 条全部宣称为可扣费。回放仅读外部快照，自动价格与确认使用隔离模拟；未执行实际服务器价格读取、资金结算、Docker / Linux CI 或 GitHub 发布。

配套核心定价 / 导入 / 结算专项、4 项真实 PostgreSQL 回归、Windows server 构建通过；新增 Key 迁组和报价空依赖回归通过，原 CI 默认配置的三个完整核心包 golangci-lint 为 0 issues。两仓库最终 diff --check 通过。隔离本地预览 HTTP 为 200，确认包含自动分析与主站报价选项；不影响此前运行中的旧预览进程，无新增生产配置或运行依赖。

用户随后授权验证后推送 GitHub。本次仅将上述 CSV 简化、自动报价、完整日志来源、测试与说明提交到 main，核心配套提交到 dev。推送前 fetch 确认与远端同步，复核验证记录与暂存差异；保留现有镜像构建门禁，发布结果以本次 SHA 的 Actions 为准。此前独立生产镜像通道维护台账和无关 usage-leaderboard SVG 继续保留本地未提交，不纳入本轮；没有更新服务器、预留或补扣真实用户。

## 2026-10-24：按 CSV 请求时段重构计费核查匹配

用户要求按最终讨论流程实施，以 CSV 对应请求时段的历史证据为准，不能绑定昨天或以未来新增日志字段补历史。本轮只修改 extra 既有运营中心，保留 main 及主站 dev；没有修改主站源码、数据库迁移、生产文件 / 余额，没有提交、推送、发布或部署。保留此前独立生产镜像通道台账、主站两份文档及无关 SVG。

| 文件 | 改动及后续集成须保留的行为 |
| --- | --- |
| `operations-center/src/services/billing-import-source.js` | 提取共享 `billingImportWindow`，按有效、非重复、已映射 CSV 的时间 / 时钟修正和完整耗时计算证据范围，同时读取两种时间含义；支持任意日期、跨日和超过四小时的请求。未提供耗时仅增加读源余量，不增加归属确定性。原生 SQL、核心案件和文件日志共用范围；返回时间 / 来源诊断，保留原有查询上限及失败阻断。 |
| `operations-center/src/services/billing-import-matcher.js` | MATCH_VERSION=4。相同四类 Token 先按开始 / 结束时间缩小范围，再做已有用量的一对一分析，避免要求全天 Token 唯一而漏排已扣费项。时间校准每个独立原生请求最多一票；已计费与未记账分阶段复用有界强制分配，冲突 / 超限 / 无完整分配的分量转核查，不选择最近请求。返回匹配依据、请求起止及阶段汇总；未知耗时、用量差异、无扣费凭据不当作新整笔消费。 |
| `operations-center/src/billing-import-store.js` | 共用原表与参数化 SQL，增加跨整批的待核查用户分组和分页用户筛选，包含 Key / 上游账号数量；不创建资金表或新迁移，不改变冻结回执和唯一预览约束。 |
| `operations-center/src/services/billing-import-service.js` | 验证用户筛选；报价前和首次确认前复查来源身份、时间 / 状态 / 计费类型及文件摘要，摘要变化即停止。新匹配版本要求未开始预览重跑；已进入 confirming / failed 的版本 3 补记按原冻结预览及原生预留幂等续办，禁止因此另建扣款。自动报价 / 原生使用记录 / review → prepared → settle 资金契约不变。 |
| `operations-center/public/index.html`、`public/billing-import-ui.js`、`public/billing-recovery.css` | 展示 CSV 时间、读取时段 / 时区、来源数量 / 留存范围、每行的请求起止与匹配依据；已核平改名已计费。待核查按用户集中筛选 / 翻页，归属唯一但请求不唯一仍显示待核查；恢复中的版本 3 保留可选确认。沿用自动报价、金额对比和单次最终人工确认，不将候选费用冒充已回收金额。 |
| `operations-center/tests/billing-import-matching.test.js`、`billing-import-source.test.js`、`billing-import.test.js` | 新增重复 Token 跨时段 / 唯一分配、同一本地请求不得提供多票、任意历史日期 / 跨日七小时的真实 PostgreSQL 读源、时钟偏移 / 无效与未映射不扩范围、整批用户分页、文件摘要变化阻断及版本 3 恢复回归。保留已有预览只读、原生幂等、并发确认 / 租约和历史用量保护测试。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 隔离模拟显示同一范围诊断；桌面 / 手机增加按用户筛选及禁选已有账单，桌面验证旧版已开始记录可恢复。演示返回本地服务实例供测试操作，不增加 HTTP 测试接口；不连接真实凭据、DB 或上游。 |
| `operations-center/scripts/billing-import-replay.cjs` | 外部历史快照按与正式源相同的 CSV 范围过滤后回放，保留 24 条误报排除、13,045 条原生用量和 761 条文件归属保护断言。仅读本地文件，无主站 / 供应商请求或资金动作。 |
| `operations-center/docs/billing-csv-import.md`、`README.md`、`CUSTOMIZATIONS.md` | 记录按文件时段、两阶段核对、新状态和按用户核查、旧预览 / 在途兼容及部署范围。具备现有自动报价 / 文件来源接口时，只需更新运营中心。 |

验证：运营中心完整 233 项测试、npm run check 及四组 1440px / 390px Playwright 模拟导入、自动报价、金额差额、用户筛选、确认 / 刷新通过；版本 3 已开始补记的恢复通过，桌面 / 手机截图已复核。真实快照离线回放 14,480 行：13,262 已计费（较前版多排除 86 条）、148 唯一请求候选待报价、961 用户归属已定位但具体请求待核查、9 多归属、27 已有记录争用、8 未记账来源争用、16 用量差异、11 时间不足、4 扣费待核查、34 重复。此前误报 / 原生用量 / 文件归属断言全部通过。148 条上游支出合计 47.47758491 USD，只是报价候选的采购支出，不是确定的用户补扣金额；未执行生产报价或扣费。真实快照不进入 Git。

## 2026-10-24：自动关联候选证据与并发组核查

用户继续要求通过程序自动匹配候选。本轮仍在 extra main 实现，主站 dev 源码不变；沿用现有主站自动报价 / 导入 / 原生使用记录与资金事务，无新服务、配置或数据库迁移。没有提交 / 推送 / 发布 / 部署、连接生产、预留或补扣真实用户。保留既有未提交的前一轮匹配改造、独立生产台账、主站文档和无关 SVG。

| 文件 | 本轮改动及后续必须保留的约定 |
| --- | --- |
| `operations-center/src/services/billing-import-source.js` | 同账号 / 用户 / Key / 分组 / 模型下，用共同服务端请求 ID 或上游请求 ID 关联多份证据，记录来源引用及文件 SHA-256。客户端可复用 ID 和相近时间不能合并；多个 dispatch 案件分别保留，同账号重复尝试缺独立 ID 不压成一个。复用原有 Token 归一化读取已观察标准用量；缓存拆分未知的含缓存输入不假设缓存为零。 |
| `operations-center/src/services/billing-import-matcher.js` | MATCH_VERSION=5。先按可靠的最终计数一致 / 未完成计数下限排除不符候选，再复用整批强制唯一分配；请求 ID 与观察用量冲突时核查。对未解决的连通组自动返回账单数、候选来源数 / 类型、归属是否一致、是否存在完整分配、原始行号及关联 ID 缺口；数量相等不证明实际调用已完整覆盖。不会用同用户或任意完整分配假装逐笔确定，也不自动执行整组补扣。 |
| `operations-center/src/services/billing-import-service.js` | 关联来源摘要、已观察用量、组分析和排除关系纳入冻结匹配证明；预览及首次确认均检查证据变化。未开始的旧预览须重分析；版本 3 / 4 已开始确认可按原冻结预览 / 原生幂等继续，不另建资金事件。原报价和 review → prepared → settle 不变。 |
| `operations-center/public/billing-import-ui.js`、`public/billing-recovery.css` | 展示自动组分析、观察用量排除数量、每行组账单 / 来源数和原因、已关联证据份数与已有观察 Token。结果列最小 220px，表内横向滚动，手机上不把长原因挤成几字一行；不会把待核查组计为可补记。 |
| `operations-center/tests/billing-import-matching.test.js`、`billing-import.test.js` | 共同服务端 / 上游 ID、多 dispatch 保留、同账号多次尝试、复用客户端 ID / 分组隔离、最终 / 部分 / 无效 / 含缓存未知用量、同归属 / 跨归属 / 来源不足组、同组不得自动收费、关联文件和观察用量变化、版本 3 / 4 在途恢复回归。旧的观察用量冲突测试改为核对更早的证据变化阻断，并确认无第二次报价。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 隔离演示增加可关联错误证据和可被观察用量排除的并发案件；浏览器验证组诊断、来源证据份数、自动报价和版本 4 续办，增加桌面 / 手机待核查截图。仅模拟数据，无真实资金或 HTTP 测试后门。 |
| `operations-center/scripts/billing-import-replay.cjs` | 离线输出自动候选组和观察用量排除统计，保留原有误报 / 已扣费 / 历史归属保护断言。 |
| `operations-center/docs/billing-csv-import.md`、`README.md`、`CUSTOMIZATIONS.md` | 记录自动分析和仍需核查的条件、没有整组资金功能、快照实际结果、版本 5 和旧在途兼容、只升级运营中心的条件。 |

验证：运营中心完整 242 项测试及 npm run check 通过，四组桌面 / 手机 Playwright 导入、证据关联、观察 Token 排除、组诊断、自动报价、确认 / 刷新和旧版续办通过；截图复核及最终 diff --check 通过。真实快照 14,480 行回放仍有 13,262 条已计费、148 条唯一候选（上游 47.47758491 USD）、961 条同用户候选（上游 262.18099088 USD，607 仅文件 / 354 含原生）。旧案件缺关联 ID / 最终用量，本次不能编造证据提高可扣费数量。整批自动核查 279 组，其中 274 组归属一致、4 组不同归属、1 组来源不足，组分析不构成扣费许可；1 条原时间不足记录因取消不可靠客户端 ID 合并改为未匹配，其余金额与保护断言保持一致。没有执行生产报价、实际 Docker 构建或 GitHub 发行。

## 2026-10-25：CSV 整组报价等价核查、原子认领与跨批次防重

用户要求改造自动核查和去重。本轮 extra 保持 `main`，主站配套保持 `dev`。仅修改本地代码、文档和隔离测试，不提交、推送、发布、部署、连接生产或补扣真实用户。保留此前版本 4 / 5 的未提交改动、独立生产台账及无关文件。

| 文件 | 本轮增量与后续集成须保留的约定 |
| --- | --- |
| `operations-center/src/services/billing-import-matcher.js` | MATCH_VERSION=6。先按主站认领排除已结算账单、标记未完成原案件；候选来源及关联别名被其他账单认领时清除选择并转核查。完整一对一同归属余额历史组、2–20 独立来源、标准 Token / 缓存时长完整且无组外可能来源才标 group_candidate；稳定分配按账单摘要 / 来源排序，不称为历史精确对应。未接入完整历史认领接口时不开组功能。 |
| `operations-center/src/services/billing-import-source.js` | 按 CSV 证据时段逐账号读取主站 `/imports/claims`，验证账号、账单摘要和完整列表；404 / 503 保留旧逐笔流程并关闭组功能，多账号失败不能残留部分认领。原生异常分页同时检查总数稳定、完整页数及无重复案件，避免缺页被当完整覆盖。无效、截断或其他读取故障阻止匹配，不能降级为无重复。 |
| `operations-center/src/services/billing-import-groups.js`（新增） | 预览只读核对全组，逐账单检查每个可能来源的原生当前报价，计费维度 / 金额不等价或 Key / 账号额度导致时间分配不等价则阻断，不能用人工售价绕过。SQLite 原事务保存全组冻结预览；最终确认须显式包含所有成员，整组取得 CAS 租约，调用主站事务预留后才逐笔原生结算。丢回包、部分结算和重启沿原案件续办；无已提交认领的失败重试必须重新核对证据。 |
| `operations-center/src/services/billing-import-service.js` | 路由整组预览 / 确认；detail 返回触及组的全部 relatedRows 供跨页展示；原逐笔结算提取复用，不直扣余额。确认最多 400 条组成员、逐笔仍最多 20；请求不能混入其他批次。版本 3 / 4 / 5 已开始结算可按旧冻结预览续办，未开始须重分析。 |
| `operations-center/src/billing-import-store.js` | 原筛选包含整组待报价 / 认领状态；复用现有 preview JSON 保存组清单和摘要，无 SQLite 新表或迁移。保留现有双唯一、CAS 和在途记录保护。 |
| `operations-center/public/billing-import-ui.js`、`public/index.html`、`public/billing-recovery.css` | 默认自动分析 / 主站报价，整组选中带齐跨页成员；展示全组 CSV 时间、用户 / Key、模型、输入 / 输出 / 缓存 Token、费用、状态及原预览合计。区分稳定记账分配和历史对应，已成功成员在续办时完整展示但不纳入剩余扣费汇总。表内滚动及组表最小宽度防止手机压缩，确认仍须管理员勾选。 |
| `operations-center/tests/billing-import-groups.test.js`（新增） | 确定排序、隐藏来源 / 订阅 / 缓存 / 大小阻断、认领与别名防重、所有对应报价等价、人工规则不可绕过、跨页完整确认、预览无资金、并发操作、认领回包丢失、重启 / 部分成功续办、重导不重复及失败后证据变化阻断。使用隔离 SQLite 和模拟主站。 |
| `operations-center/tests/billing-import-source.test.js` | 完整多账号认领、旧主站部分响应清空、无效 / 超限结果和读取故障阻断。保留此前真实 PostgreSQL 时段 / 来源测试。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 独立模拟主站组认领 / 回执并加入两笔同用户历史错误；CLI 演示含组，旧四种浏览器场景保留，增加桌面 / 手机整组展示、联动选择、原生认领及确认模拟。无真实凭据、供应商或生产数据。 |
| `operations-center/scripts/billing-import-replay.cjs` | 输出组阻断原因；可选 `--saved-balance-context` 从外部已保存无订阅案件推断文件来源类型，明确标记为离线推断，不能当现存 Key / 配额 / 价格或认领验证。保留此前误报、原生用量及历史归属保护断言，真实数据不进入 Git。 |
| `operations-center/package.json` | npm run check 的 precheck 纳入新增组编排模块语法检查，不改依赖和锁文件。 |
| `operations-center/docs/billing-csv-import.md`、`README.md`、`CUSTOMIZATIONS.md` | 更新版本 6 全组操作、资金 / 非精确分配边界、快照实际结果及主站 / 运营中心配套升级要求，取代前轮“本次只升运营中心”的条件。 |

配套主站仅增加可选整组认领 / 历史认领接口、新组回执表迁移，以及冻结用量和额度保护；详细源码清单位于主站 `CUSTOMIZATIONS.md` 同日章节。主站 PostgreSQL 的账号锁、同账单 / 同来源双唯一和原生 usage + dedup + 资金事务才是最终防重依据，SQLite 并非资金账本。组认领全成或全回滚，资金仍逐笔提交，失败保留原映射，不重新配对或直接扣余额。启用功能需同时更新两个组件，无新增机器、服务、生产依赖或供应商 API 凭据。

历史快照实际回放：14,480 行仍为 13,262 已计费、148 唯一请求报价候选（上游采购支出 47.47758491 USD）、961 同用户待核查（采购支出 262.18099088 USD）、34 重复，其余差异 / 冲突 / 时间不足保持原样。新增可整组报价为 0；原快照缺文件来源的余额类型，即使补入同快照无订阅案件推断，仍有 108 组缺共同关联 ID、170 组有组外无耗时错误重叠、1 组来源不足。原生错误最长四小时范围不能凭数量相等排除。不能宣称 961 条已确定可补扣；补扣金额要以未来实际主站核价和管理员确认为准。24 条旧误报、13,045 条既有关联用量及 761 条文件归属断言全部保持通过。

验证：完整运营中心 252 项测试、npm run check 和两仓库 diff --check 通过。六组 Playwright 覆盖 1440px / 390px、正差额 / 未知上游费、旧版在途恢复和新增整组联动选择 / 全成员展示 / 认领 / 模拟结算；截图复核后将组表和汇总移到确认按钮之前，手机组表保持水平滚动、不压缩长字段。核心计费专项、5 项 PostgreSQL/PGlite SQL、三个完整包的默认配置 golangci-lint 0 issues 和最终 Windows 构建通过。两种历史回放均只读本地快照；没有生产报价、预留或资金写入，没有实际 Docker / Linux CI 或 GitHub 发布。所有本轮改动保留本地待审核，未推送或部署。

用户随后明确授权提交并推送 GitHub。本轮将上述匹配版本 4 / 5 / 6、整组编排、界面、测试和文档提交到 extra main，主站配套原子认领 / 防重接口和迁移提交到 dev。推送前 fetch 确认两仓库均与远端同分支同步；独立生产镜像通道台账、无关 SVG 和其他项目文件继续保留本地。沿用现有测试门禁和 GHCR 镜像发布流程，构建与发布结果以此次提交 SHA 的 Actions 为准；本次不部署服务器、预留请求或补扣真实用户。完整功能升级需主站和运营中心同时更新。

## 2026-10-27：生产运营中心历史日志只读挂载

用户撤回自动读取实现，明确授权连接服务器，仅增加只读日志挂载与日志目录环境变量，不重启主站。本轮没有修改业务源码、测试、发行或仓库 Compose 模板，没有提交 / 推送 GitHub、拉取镜像或执行 CSV 分析 / 资金操作；保留此前未提交的独立生产台账和无关文件。

服务器仅修改 `/root/sub2api-extra/operations-center/compose.yaml`：新增 `OPERATIONS_CENTER_BILLING_LOG_DIR=/app/billing-evidence`，增加 `/root/sub2api-deploy/billing-log-evidence/2026-10-23` 到该容器路径的只读 bind、`create_host_path=false`，保留原 `/app/data` 卷和其他解析配置。以原 `sub2api-extra` 项目 / 环境文件，仅 `up --no-deps --no-build --pull never --force-recreate operations-center`，沿用相同镜像 ID，不改主站、网络或其他服务。

重新检查发现之前四个档案中前三个已轮转清理，未用残缺目录冒充全量。由上次只读排查实际保存的 `live-log-events.json` 生成独立 `sub2api-saved-metadata-2026-10-23.log.gz`，仅序列化原允许字段，不推断事件；同目录 `evidence-manifest.json` 明确原文件、摘要、账号 356 / CSV 时间窗口、非全站档案和不保证完整覆盖。122160 个原事件经正式读取器产生的 1365 个候选及每个字段 / digest 与原保存数据完全一致；不得同扫描重叠原档案或称为恢复了完整原始文件。目录 UID / GID 1000、0750，文件 0600，容器 UID1000 可读，不需特权或改原日志权限。

备份统一位于 `/root/sub2api-deploy/backups/operations-center-billing-logs-20261027-215116`，含修改前 Compose / 环境 / 设置、容器身份、SQLite 在线一致性备份及 quick_check、剩余原档案、候选配置、证据和验收。操作与改动详情见该目录 `SERVER-CHANGES.md`；本机副本在 Downloads 的 `sub2api-csv37-audit-20261027/deployment/`，真实日志与脚本不纳入 Git。

验收：只有运营中心容器身份 / StartedAt 变化，主站、PostgreSQL、Redis 及其他容器未重启；两服务健康，原镜像 / 数据卷和持久设置摘要保留。导入库仍 1 批 / 14480 行且各状态不变。容器正式只读加载 `status=read`、1 文件、34153036 解压字节、122160 事件、1365 候选，摘要一致。管理员需在原 CSV 批次重新“分析账单并生成预览”，旧预览不直接确认；148 条唯一报价候选不等于最终通过报价的补扣数。历史证据目录不会自动覆盖其他日期，本轮未实现自动读取功能。

## 2026-10-27：修复生产 CSV 重分析 SQLite 临时空间不足

用户反馈挂载后仍显示旧条数。生产日志定位 `BillingImportStore.configure` 批量更新抛 `SQLITE_FULL`，整批事务回滚，旧诊断仍 `not_configured`；挂载本身已生效。主磁盘剩余约 116 GB、SQLite 页数未达上限，但容器仅 32 MiB `/tmp`，SQLite `TEMP_STORE=1`。此前只验证读取而未验收完整写入。本轮使用隔离在线备份副本复现：原临时目录失败，数据卷临时目录同一 14480 行更新成功 / 主动回滚；完整正式匹配与保存也通过。

沿用用户授权的生产配置工作，仅在服务器 `/root/sub2api-extra/operations-center/compose.yaml` 原环境中增加 `SQLITE_TMPDIR=/app/data/sqlite-tmp`，原卷内新目录 UID/GID1000、0700；保留原 tmpfs、只读根目录、日志只读挂载和所有其他解析配置。仅重建运营中心，原镜像 / 卷不变，无主站 / 其他容器重启，不修改业务源码或实现自动读取。后续更新服务器 Compose 须保留此覆盖，否则大批次仍可能失败。

完整副本正式 `BillingImportService.match` 结果 148 条唯一请求候选、961 条同用户待核查，与之前排查一致。配置生效后以同一方法重新分析原批次，仅更新派生匹配并清除未开始的旧预览，核心请求仅 GET；没有报价、预留、创建补记案件、使用记录或扣费。最终生产保存：148 候选、1070 待核查（含 34 重复）、13262 已计费，共14480；日志诊断 `read`，数据库 quick_check=ok，设置 / 收支 / 消息摘要不变。148 中 4 条缺缓存 TTL 拆分，核价时仍须核查，不能把148当最终可扣费数。

本次配置 / 在线 SQLite 备份、复现、副本匹配、生产匹配及验收位于 `/root/sub2api-deploy/backups/operations-center-sqlite-temp-20261027-230922`，详情 `SERVER-CHANGES.md`；隔离演练目录已归档到该备份，不留在生产数据卷。真实数据与维护脚本仅保留服务器受限备份及 Downloads 的审计目录，不入 Git；本轮未推送或发布，保留既有未提交维护记录及无关文件。

## 2026-10-28：CSV 扣费预览支持整批分批处理

用户希望生成扣费预览时不再只覆盖默认条数。本轮仅修改运营中心，沿用 `main` 分支；不修改主站或结算契约，不连接生产，不报价真实请求、不预留或扣费。用户随后授权提交并推送本节实现；生产部署仍需单独授权。

| 文件 | 改动与保留要求 |
| --- | --- |
| `operations-center/public/billing-import-ui.js` | 自动模式分页读取整批“可补记”记录，筛出已有确定匹配的请求并以最多 20 行分块调用既有预览 API；整组只提交一个入口，避免跨块重复处理成员。显式选择也不再静默 `slice(0,20)` 丢弃其余选择，而是同样分块处理。逐块顺序执行并保留成功结果；批次切换或离开时停止后续请求。单个 API 请求大小和最终确认限制不变。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 添加 21 条可报价样本，验证完整扫描 20 + 1 两个请求并保存所有预览；保持现有桌面 / 手机与整组流程回归。演示数据不连接生产或真实主站。 |
| `operations-center/docs/billing-csv-import.md` | 更新自动整批报价、手动选择分批及确认仍需逐笔分批的说明。 |
| `CUSTOMIZATIONS.md` | 记录本次实现、测试及不可放宽的单次确认界限。 |

API 每请求最多 20 行；前端串行分块以控制负载。最多 20,000 行的批次仍受既有 CSV / 源读取限制。确认端仍只接受每次最多 20 笔逐笔，整组确认上限仍为 400 个成员；“全批生成预览”不代表自动批准或自动扣款。进程中断时已保存的预览保留，重新打开同一批次只会处理仍处于可补记状态的行。验证：运营中心完整 252 项测试、`npm run check`、桌面 / 手机和整组 Playwright 回归通过；21 条待补记样本分成 20 + 1 两批全部生成预览，无预留或结算。未部署生产。

## 2026-10-29：CSV 确认回执与跨页选择

用户要求排查“确认补记并扣费”无反应，并支持跨页选择后生成预览。本轮只改 extra main 的运营中心；主站仍保留 dev 和既有原生资金事务，不改迁移、价格或匹配标准。实现与验证完成后，用户明确要求提交 GitHub，本次据此提交并推送；不部署或补扣生产用户。保留此前独立生产台账、核心两份文档、其他工程和无关 SVG。

生产只读核对：运营中心运行 b77ec22，主站实际二进制 0.2.18001201。北京时间 10/29 00:33 复查的 80 条预览均未过期，重新读取完整来源后 80 条匹配证明全部相同；该 CSV 所有行 case_id 为空，尚无 confirming / failed / settled，确认流程没有留下认领或结算结果。运营中心 Nginx 关闭访问日志，不能从缺少访问记录推断按钮是否发出请求或当次报错原因。代码确认存在长时间自动报价期间无明确说明的禁用状态、仅在上方显示错误、HTTP 200 内逐行失败只提示零成功，以及确认后先自动报价才提示回执的问题；本次修正反馈和调用顺序，不声称已复现生产的某个特定提交错误。

| 文件 | 改动和后续保留要求 |
| --- | --- |
| `operations-center/public/billing-import-ui.js` | 按批次缓存选择与行快照，翻页 / 筛选保留勾选和取消；增加全选当前筛选所有页、清空选择和跨页金额 / 用户汇总。选择变化重置最终确认；切换批次 / 重新分析 / 退出清除，浏览器刷新不持久化选择。普通歧义候选组不合并预览入口；只有已核查整组 / 冻结预览组去重。预览请求只携带当前块的价格和归属，避免大批量请求体超限。 |
| 同上 | 确认前只读刷新跨页行并核对版本 / preview ID；所选须全部有预览，过期 / 在途租约 / 设置变更显示阻断原因。最多 20 个成员一块串行确认，整组始终完整，遇错停止后续块；成功和失败均刷新原回执，不自动重试不确定的资金请求。显示进度、已核实消费笔数、余额金额、订阅用量和失败原因；确认后不启动剩余项目自动报价。保留 preview / failed / confirming 的原冻结金额和核心幂等续办。 |
| `operations-center/public/index.html`、`public/billing-recovery.css` | 增加跨页选择控制、禁用原因和按钮下方的可访问状态 / 错误回执；表内及手机保持既有滚动布局，核查明细仍在确认前展示，无新增弹窗。 |
| `operations-center/src/services/billing-import-service.js`、`src/app.js` | 新增管理员 + CSRF 保护的 POST /billing-imports/:id/rows，只读返回最多 400 个所选行及冻结组完整成员 / 金额，校验所属批次。没有预留、报价、结算或余额写入；原确认 API 限制和原生 review → prepared → settle 保持不变。 |
| `operations-center/tests/billing-import.test.js`、`billing-import-groups.test.js` | 验证跨页读取不扣费、版本 / 回执 / 金额、跨批次拒绝、请求上限、认证 / CSRF 和只选一个入口仍披露全部组成员；保留已有丢回包、租约、幂等、用量 / 证据变化保护。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 纯模拟账本增加独立消费记录、余额和单次扣费计数；浏览器覆盖 21 行跨页选择 / 取消 / 筛选 / 全选、20 + 1 预览 / 确认、跨页完整组、过期重报、双击、部分失败 / 原案件续办、确认 HTTP 回包丢失后读回执。仅隔离本地数据，不连接生产或真实上游。 |
| `operations-center/docs/billing-csv-import.md`、`CUSTOMIZATIONS.md` | 更新跨页步骤、选择生命周期、自动分块确认、原位回执、过期和部分成功行为；此节取代前节需管理员手动拆分确认的 UI 说明。 |

验证：运营中心完整 253 项测试、语法检查及 11 组桌面 / 手机 Playwright 流程通过；21 笔模拟消费 / 余额和重复确认仅扣一次、跨页整组的 19 + 2 完整分批、过期、双击、部分失败及回包丢失场景通过。新增组读取专项通过；截图复核后去除预览 / 确认的浮动长消息，保留原位回执，避免手机提示遮住结果。主站既有 BillingRecovery / BillingImport 专项和 5 项真实 PostgreSQL / PGlite SQL 回归通过，没有修改主站文件。最终 diff --check 通过。独立本地演示 http://127.0.0.1:19879/preview 返回 200，仅模拟数据，可查看新版界面，不连接生产。未进行实际 Docker 构建、GitHub 发布或生产资金结算。

本次提交仅包含上述运营中心源码、测试、文档与本节台账；此前生产镜像通道 / 只读日志挂载 / SQLite 临时目录维护章节保留本地，不纳入源码发行。沿用既有 GitHub 测试门禁和 GHCR 镜像构建流程，发布以本次完整提交 SHA 对应的 Actions 为准；提交 / 推送成功不代表镜像已经发布或服务器已更新。本次无需修改或重新发行主站。

## 2026-10-29：可补记全部展示与显式报价

用户反馈分页 / 自动报价卡顿，要求可补记记录一次展示，全选生成预览后确认原生使用记录与扣费。本轮仅修改 extra main 的运营中心；主站 dev、匹配版本 6、来源核查和原生 reserve → restore → review → settle 契约不变。实现和验证完成后，用户明确要求提交 GitHub，本轮据此提交并推送；未部署或操作生产资金，保留既有独立维护台账和无关文件。

| 文件 | 改动和后续保留要求 |
| --- | --- |
| `operations-center/public/billing-import-ui.js`、`public/index.html` | 可补记筛选使用只读 view=all 一次展示整批可操作记录，表头直接选择全部，不逐页读取。其他筛选保留分页和跨页选择。“分析账单”仅匹配；报价只在显式点击“生成所选扣费预览”时执行，切换筛选 / 打开批次 / 翻页不再隐式报价。保持默认主站自动定价，无需售卖规则。更新静态资源版本。 |
| 同上 | 报价失败转待核查的行取消勾选，避免已隐藏但仍选中的未报价行阻断成功项确认。确认分块后读取原持久回执，核对 settled、核心案件 ID、冻结金额才继续；不完整或失败停止后续块。成功计数和金额仅基于上述回执，保留重复点击、过期、失联和原案件续办保护，不把 HTTP 200 等同结算成功。 |
| `operations-center/public/billing-recovery.css` | 列表在有界高度内滚动、表头固定，避免全量列表把确认操作推到页面末尾；复用既有样式变量及手机水平滚动。 |
| `operations-center/src/services/billing-import-service.js` | 仅 actionable 支持 view=all（最大 20,000 行，等于现有 CSV 行数上限），默认 API 分页兼容。整组关联成员按 ID 读取并检查所属批次，避免为少量成员解析整批 JSON。只读展示不核价、不取主站证据、不预留或扣费。 |
| `operations-center/src/services/billing-import-groups.js` | 普通逐笔预览在确认没有整组入口后直接返回，避免每 20 条都无条件解析整批行；实际整组核查和资金语义不变。 |
| `operations-center/tests/billing-import.test.js`、`scripts/billing-import-browser-check.cjs`、`scripts/billing-import-preview.cjs` | 验证 148 条完整展示、默认分页兼容、列表无报价和资金效果、逐笔不走全库 JSON 解析、显式报价 / 全选 / 失败项移出 / 完整组 / 回执及去重；演示支持指定样本数，桌面 / 手机各验证 148 笔完整报价、使用记录及独立模拟余额，无生产连接。 |
| `operations-center/docs/billing-csv-import.md`、`CUSTOMIZATIONS.md` | 更新简化后的分析 → 全选 → 预览 → 确认步骤和失败 / 回执边界；本节取代前节自动打开时整批报价的界面行为。 |

另外复用 Intl.DateTimeFormat，选择汇总用 ID Set 替代重复扫描整表，降低全部展示时的格式化与勾选开销。每块报价和首次确认仍重新读取对应 CSV 时段的完整主站证据，保留当前全局一对一分配 / 重复计费核查，未为加速复用过期资金证据。真实主站核查和逐笔原生结算仍需等待网络与数据库响应。

验证：运营中心完整 255 项测试、53 项计费专项和 npm run check 通过。15 组 Playwright 场景覆盖桌面 / 390px 手机、148 条一次读取和本地全选、148 笔全量报价 / 模拟使用记录 / 余额变化、20 + 1 / 19 + 2 完整分块、报价失败项移出后继续确认、过期、重复点击、部分失败续办、回包丢失及回执金额不符即停止下一块；每笔模拟余额仅扣一次。148 行模拟切回列表约 55–91ms，全选约 50–110ms，此为本地演示观测，不代表生产主站证据读取或结算延迟。截图保留在本机临时 QA 目录。生产使用效果以部署后原生回执为准，本地模拟不冒充真实用户扣款。

本次只提交上述运营中心实现、测试、操作文档和本节台账；此前生产配置维护章节及无关文件继续保留本地。推送至 fjiangming/sub2api-extra main 后沿用原有 GitHub 测试与 GHCR 构建流程，镜像发布结果须按此次完整提交 SHA 核对；服务器仅需在发布成功后更新运营中心，无需更新主站。本次不部署。

## 2026-10-30：CSV 长时间预览与确认改为后台任务，修复 524

用户反馈新版全选可补记后生成预览仍返回 524。本轮仅改 extra main 的既有运营中心；不改主站 dev、匹配版本 6、价格规则、原生 reserve → restore → review → settle 和数据库资金事务。只读连接生产排查，没有真实预留、补记、扣费或配置改动；没有提交、推送、发布或部署本轮代码。保留此前独立生产维护台账和无关文件。

生产核对运行镜像为 `9d71d32903d3f4cbf7ce1d44e0f8c8cb6922e99c`，不是未更新。Nginx `proxy_read_timeout 600s`、无该站错误日志；站点关闭访问日志，无法引用本次 524 的精确访问轨迹。当前块已保存 16 条预览、4 条缺缓存 TTL 拆分转核查，case_id 全空，尚无补扣。保存时间显示逐笔核价约 6–8 秒；只读测量完整来源读取 13.866 秒、匹配 7.485 秒、单条主站报价 7.214 秒，20 条串行报价加全量复核足以超 Cloudflare 等待时限。前轮快速模拟未覆盖这个生产延迟；本轮补充阻塞读源 / 核价 / 原生结算验证，不通过放宽计费检查或仅增加反代超时解决。

| 文件 | 改动与后续集成须保留的行为 |
| --- | --- |
| `operations-center/src/services/billing-import-tasks.js` | 新增同进程后台任务执行，提交立即 202、短 GET 读取进度与终态。同任务 UUID / 同参数幂等返回，改参数拒绝；单实例一次一个任务，不将凭据 / 操作参数落盘。启动标记旧在途任务中断，不自动重放资金命令；正常退出等待当前块。 |
| `operations-center/src/billing-import-store.js` | 在原 SQLite / 原数据卷新增 import_tasks 与索引，保存身份、参数摘要、进度、终态和结果，同批次仅一条活动任务；不改原导入行、历史预览、原生认领或资金数据。 |
| `operations-center/src/services/billing-import-service.js` | 提取原预览 / 确认校验供任务复用，执行仍走原完整来源复核和资金契约。同步 / 后台操作共用批次互斥，匹配不能覆盖正在处理的预览；detail 披露最后任务以便刷新续看。新增逐笔进度，保留预览过期、版本 CAS、租约、证据变化阻断和原生去重。 |
| `operations-center/src/services/billing-import-groups.js` | 增加整组核价 / 结算进度钩子；每个可能对应的财务等价检查、全组冻结 / 原子认领、完整成员与部分成功续办保持原样。 |
| `operations-center/src/app.js`、`src/server.js` | 同管理员 / CSRF 边界新增提交与状态 API，启动识别中断、退出在关闭 SQLite 前等待任务。旧同步接口兼容保留，新页面不再使用它们执行长任务。 |
| `operations-center/public/billing-import-ui.js`、`public/index.html` | 预览 / 确认每块改提交任务并轮询，显示阶段和逐笔进度；刷新原批次恢复当前块，不新建重复任务。回包丢失只读原任务，轮询短暂失败只重试读取，失败刷新持久行结果；连续失联明确提示核对。运行中禁改匹配 / 归属 / 核价与重复确认，保留完整组、跨页选择、部分成功停止后续块和真实回执校验。静态资源版本更新。 |
| `operations-center/tests/billing-import-tasks.test.js` | 验证读源 / 报价阻塞时快速 202 和可轮询、同 ID 幂等 / 改参数拒绝、认证 / CSRF / 跨批次 / 原上限、原生已提交后回包丢失只扣一次、实际 SQLite 关闭重开后中断恢复、部分成功后异常保留及退出等待 / 拒绝新任务。 |
| `operations-center/scripts/billing-import-preview.cjs`、`billing-import-browser-check.cjs` | 演示加入任务生命周期，原 15 场景适配后台接口；增加桌面 / 390px 手机慢报价与已提交结算期间刷新恢复、无重复提交 / 扣费和进度布局。全部仅隔离模拟，不连接生产。 |
| `operations-center/package.json`、`README.md`、`docs/billing-csv-import.md`、`CUSTOMIZATIONS.md` | 语法门禁纳入新模块，记录后台步骤、同 ID 重读、刷新 / 重启 / 凭据过期与部分成功边界、仅运营中心更新范围，无新依赖或生产配置。 |

多块仍由页面串行提交，当前块不依赖浏览器连接，离开后未提交的后续块不会自动扣费；管理员重新打开后核对原结果再续办。强制终止可能中断当前块，已保存预览 / 主站回执保留，原 5 分钟租约未到期时须等待，不能把任务表当资金账本。新任务本身不会缩短真实主站的核查 / 结算耗时；故障、缺完整 Token / TTL 或证据变化仍须阻断。单实例 / 单进程使用原数据卷，不支持多个运营中心进程共享 SQLite 同时执行。

验证：完整运营中心 261 项测试（含 6 项新增后台任务回归）、npm run check 和 diff --check 通过；17 组 Playwright 覆盖原 15 场景及新增桌面 / 390px 手机后台报价和原生已提交结算期间刷新恢复。148 条一次展示 / 全选、20 + 1 / 19 + 2 完整分块、回包丢失、部分失败 / 原案件续办和回执金额不一致停止后续块仍通过；每笔模拟余额只扣一次。桌面 / 手机进度截图已复核，无页面溢出或遮挡。延迟使用可控阻塞模拟，未将其宣称为真实 Cloudflare 端到端验收；真实生产只进行了前述只读诊断。本轮未进行 Docker / Linux CI、GitHub 发布、生产补扣或部署。

用户随后明确要求提交 GitHub，本次据此将上述 524 后台任务修复、测试、文档和本节台账提交并推送 extra main。推送前 fetch 核对远端和当前分支，沿用现有测试门禁与 GHCR 镜像工作流；构建 / 发布结果须按本次 SHA 的 Actions 核实。此前独立生产配置维护台账、主站已有文档和无关未跟踪文件继续保留本地，不纳入本次提交；不更新服务器或操作真实用户资金。

## 2026-10-30：用户授权清理计费核查临时材料

用户确认已完成补记，要求清理不影响运行的相关文件。本轮无业务源码 / 测试 / 发行修改，仅追加本台账；主站配套清单位于 `docs/server-cleanup-2026-10-30.md`。没有提交 / 推送 GitHub、拉取镜像、执行新的匹配 / 报价 / 预留或补扣，不删除本地无关工程或文件。

生产仅修改 `/root/sub2api-extra/operations-center/compose.yaml`，删除 `OPERATIONS_CENTER_BILLING_LOG_DIR=/app/billing-evidence` 和该路径的历史日志只读 bind；完整 Compose 前后只变这两项。保留 `SQLITE_TMPDIR=/app/data/sqlite-tmp` / 原目录，原环境、设置 / 密钥、网络 / 卷和安全参数保持。使用原项目 / 环境文件 `up --no-deps --no-build --pull never --force-recreate --wait operations-center`，镜像 ID 与 revision d440edf 保持；其余 13 个容器没有重启。正式日志读取返回 not_configured，不会读取已删除目录；后续正常持久计费不依赖此临时挂载。

先备份当前完整 PostgreSQL（pg_restore --list 校验）、在线一致性 SQLite（quick_check / 全部导入行摘要 / 压缩 SHA-256 校验）、当前配置和必要历史证据，统一留在权限 0700 的 `/root/sub2api-deploy/backups/billing-audit-cleanup-20261030-231306/`。将七个旧维护备份目录的配置 / 清单 / 日志合并归档后删除原目录及 `/root/sub2api-deploy/billing-log-evidence/2026-10-23`，排除重复旧数据库快照和 isolated-probe 演练，原占用 3,451,846,656 字节，新增必要备份约 536 MiB，净释放约 2.69 GiB。旧快照不再保留，旧 rollback 路径失效，未来不能照旧文档直接执行。没有删除 Docker 镜像、卷、正常日志、在用 SQLite / WAL / SHM、认领或防重表。

验收：执行前后无 CSV 在途任务 / 结算行，14,480 条导入状态 / 版本 / 预览 / 结果摘要相同，144 条已补记合计 52.03179180 USD，与主站 settled、每笔唯一 usage / claim、原生 dedup / archive 全部一致。受保护配置 / 价格 / 收支 / 消息摘要不变，运营中心和主站本地及外部健康 HTTP 200。仍保留未决候选及原 CSV / 回执，但再核查文件来源时须从历史归档恢复日志和只读挂载，再重新核查；撤挂载不会恢复过去未扣的资金，也不表示全部候选已经获准扣费。
