# sub2api 与灵速视频协议兼容性评估

评估日期：2026-10-11。sub2api 基准为官方 `main` 的 `3a6fd1c9db07203ca308aaba69e502bc1f35b307`，不是本机旧的工作区版本。灵速基准为公开视频文档 v1.1.0，更新于 2026-10-07 15:35（北京时间）。文档价格是公开快照，当前 Key 的规格接口与订单回执仍需单独验收。

本文是源码与文档评估，以及尚未实现的上游桥接接口设计。此次只新增评估文档，没有改变现有服务、扣款方式或部署路由，没有调用付费供应商。

## 1. 结论

**不能把现有服务称为 sub2api 原生视频协议与灵速协议的完美转换。** 原生 Grok 视频协议可以承载基本生成、查询和鉴权下载；灵速的混合参考素材、人脸开关等能力需要扩展 JSON。接口路径、状态、幂等、历史读取和资金生命周期存在实质差异。

| 评估层次 | 结论 |
|---|---|
| 基本生成参数 | 可以转换，但必须按型号校验，统一秒数和档位 |
| 灵速完整创作参数 | 可以设计扩展字段保留；标准 Grok 字段无法独立表达所有能力 |
| sub2api 参数变量 | 基本字段有内部变量；混合参考、人脸开关等只是原始 JSON 透传，不进入原生参数和校验体系 |
| 查询与原片下载 | 可以转换成 Grok 的状态与 `/content` 链路，原片不需要转码 |
| 原版 HTTP 行为 | 不完全相同：HEAD、下载别名、规格接口、幂等头等需要额外处理 |
| 订单和计费行为 | 不等价：15 秒计费上限、异步任务冻结、结算触发、退款、零余额读取等有缺口 |
| 当前 video-adapter | 是直接处理客户资金的独立入口，尚不是下述纯协议上游桥 |

严格同时要求“不改 sub2api、适配器不处理客户账务、完整保留灵速功能和订单语义、避免可预见的漏扣与低价接单”，现有官方源码无法满足。

推荐的原生计费目标链路是：

```text
客户端 -> sub2api 的 Grok 视频入口 -> video-adapter 协议桥 -> 灵速
              |                        |
              +-- 客户鉴权与原生账务     +-- 参数转换、任务映射、供应商凭证与重试状态
```

应选 Grok 视频协议。Seedance 虽然有多模态 `content[]`，但完成计费依赖真实 `usage.completion_tokens`，灵速不提供该字段。不能捏造 token 数来实现扣费。

## 2. 创建参数逐项对应

“原生识别”指进入 `GrokMediaRequestInfo` 或原生计费用量。“扩展透传”只表示当前 Grok 视频 JSON 转发路径通常保留该字段，不表示 SDK、客户端界面或原生内容检查会理解它。

| 灵速参数或能力 | sub2api Grok 对应 | 原生识别情况 | 正确转换与限制 |
|---|---|---|---|
| `model` | `model` | 有 | 对外用稳定模型别名，桥内映射准确供应商型号；完成响应继续返回可计价的公开别名 |
| `prompt` | `prompt` | 有 | 保留文本、素材编号和顺序，不代补 `@图片1`；校验不同型号的 4000/6000 字符上限 |
| 特价 `duration` | 数字 `duration` | 有 | 只接受该型号允许的整数秒数；禁止静默缩短 |
| 其他型号 `seconds` | 数字 `duration` | 只识别 `duration` | 桥将 `duration` 改名为 `seconds`；不要只向原生入口发送 `seconds` 或字符串秒数 |
| 特价 `ratio` | `aspect_ratio` | 只识别 `aspect_ratio` | 桥改名为 `ratio`，其他型号仍用 `aspect_ratio`；别名同时存在时必须一致 |
| `resolution` | `resolution` | 有，计价只支持 480p/720p/1080p | 请求显式写合法档位，桥与原生保持一致；H3 的 1080p 档位不保证文件一定是 1920x1080 |
| 特价 `images[]` | JSON `images[]` | 能提取图像输入，但并非特价专用类型 | 视频转发可保留字符串/Base64 数组；桥校验 PNG/JPEG/WebP、大小及数量，发送原图数据 |
| 原生 `image` / `reference_images` | 相同字段 | 能提取图片 | 到灵速须按型号转换；不能默认把一般参考图片当作首帧，或把 HTTPS 地址直接塞进特价 `images` |
| `references[].type` | 扩展 `references` | 无混合参考内部变量 | 桥完整保留 image/video/audio，按型号限制数量和组合；标准 Grok 图片字段无法代替 |
| `references[].source` | 扩展字段 | 不进入原生图像提取 | 必须是供应商可读的公开媒体直链；保留有效期和素材顺序，不能用本地路径或网页地址代替 |
| `references[].role` | 扩展字段 | 无对应内部变量 | 只开放型号明确支持的角色；H3 不支持首尾帧，特价图片数组没有角色字段，不应静默丢弃首尾帧语义 |
| `references[].duration_seconds` | 扩展字段 | 无音视频参考时长变量 | 这是参考素材时长，不是生成秒数；全参/SD/WAN 音视频要求真实正数，图片及 H3 所有参考禁止传此字段 |
| `face_direct` | 扩展布尔字段 | 无对应内部变量 | 只允许两款特价；true 必须有图片；原样保留开关，不可固定为 false |
| `n` | `n` | 有 | 灵速每次一条：拒绝大于 1；特价发给灵速时移除 n，其他型号仅省略或 1 |
| `Idempotency-Key` | 客户请求头 | 不动态转发给上游 | 无核心修改时需要自定义请求体操作编号，并由桥生成、持久化供应商幂等头；这是扩展契约 |
| `seed` / `fps` / `callback_url` | 部分客户端可自定义 JSON | 不提供供应商能力 | 灵速不接受，明确拒绝；不得伪装为已生效 |
| multipart / 文件上传 | Grok 有 multipart 解析 | 有部分图像解析 | 不会自动变成灵速的 JSON 或公网素材地址；当前适配器只收 JSON，上传转换须单独实现和验收 |

原生视频转发只会把已知图像对象的旧 `.image_url` 改为 `.url`，不会把视频请求里的所有 Base64 字符串统一改成图像对象；图像编辑接口的另一套重写逻辑不能套用于视频。

建议对外强制显式填写数字 `duration`、`resolution`、`aspect_ratio`。否则 sub2api 的默认 8 秒/480p 可能与桥或供应商默认值不同，尤其 H3 只接受 1080p。原生解析将内部时长上限归一到 15 秒，但不代表转发中的原始 30 秒请求被改成了 15 秒。

扩展参数可通过支持额外 JSON 的客户端传递，例如某些 SDK 的 `extra_body`。普通 SDK 的固定参数表、视频网页表单未必允许它们。`/v1/videos` 路径相同也不意味着 OpenAI Sora SDK 的 `seconds`、`size`、`input_reference` 和 multipart 格式可以直接使用。

桥应重建供应商字段白名单，而不是把扩展后的完整 JSON 原样发给灵速。灵速拒绝未知字段、重复键、大小写变体和非法 null；桥接专用字段必须移除。若要求忠实拒绝重复键，不能仅靠 JSON.parse 之后的对象校验。

## 3. 型号能力与价格能否保留

以下均为灵速公开快照，金额是人民币等额额度，不是 sub2api 的美元售价。简称只用于表格；实际调用必须使用供应商完整型号。

| 型号 | 生成时长/秒 | 档位 | 素材上限：图/视频/音频/总数 | 公开成本 | 原生计价适配 |
|---|---|---|---|---|---|
| H3-KS | 5-15 整数 | 1080p | 6/0/2/8 | 3.70/条 | 渠道 `per_request`，不能误配为 3.70/秒 |
| 特价 2.0 | 5、10、15 | 720p | 9/0/0/9 | 2.10/条 | 渠道 `per_request` |
| 特价 2.5 | 固定 30 | 720p | 30/0/0/30 | 2.10/条 | 金额可用 `per_request`，原生秒数日志仍可能被记为 15 |
| 全参 2.0 | 4-15 整数 | 480p/720p/1080p | 9/3/3/12 | 0.57/0.67/1.32 每秒 | 分组逐模型秒价或渠道 `video` 可表达 |
| 全参 2.5 | 4-30 整数 | 480p/720p | 30/10/10/50 | 0.52/0.87 每秒 | 超过 15 秒直接按秒使用会少计单位，必须修正核心或拆固定时长别名按条卖 |
| SD 官方 2.0 | 4-15 整数 | 480p/720p/1080p | 9/3/3/15 | 0.90/2.10/3.60 每条 | 渠道按条、按档位配置；文档目前标记不可用 |
| WAN 3.0 可参考视频 | 固定 4 | 720p | 1/1/1/3 | 0.32/秒，即 1.28/条 | 按秒或固定规格按条均可 |
| WAN 3.0 不可参考视频 | 固定 4 | 720p | 1/0/1/2 | 0.32/秒，即 1.28/条 | 按秒或固定规格按条均可 |

全参 2.0 的每份音视频参考为 2-15 秒，全参 2.5 为 2-30 秒；SD/WAN 没有灵速额外规定的参考秒数上下限，但仍需真实正数并通过生成服务校验。SD 的音频必须搭配图片或视频。

H3 比例只允许 16:9、9:16。SD 支持 16:9、9:16、1:1、4:3、3:4；其他型号还支持 21:9，以当前规格接口为准。不能把 Grok 支持的任意尺寸、比例或编辑能力强行转换成供应商不支持的能力。

按条价应配置在渠道 `per_request`；原生分组的逐模型视频价及旧视频档位价按秒计算，且会优先于渠道按条价，需要清除会命中的覆盖。源码支持自定义模型键，不必把所有供应商都伪装成同一个 Grok 型号。

如果不能修改 15 秒上限，全参 2.5 可以拆为例如 `lingsu-full-2.5-720p-30s` 的固定时长别名，按完整订单金额配置 `per_request`，桥强制校验 duration=30。这样能避免该规格金额少计，但改变了公开型号与定价表达，用量秒数仍不忠实；不属于完美转换。

公开文档存在一个价格矛盾：全参 2.5 的 720p 单价 0.87、30 秒应是 26.10，但示例写 24.20。不能使用较低示例金额作为安全成本上限，需以当前 Key 的 `/v1/video-models` 和真实回执核对。

原生单价可表达不等于确保收入覆盖成本。必须把人民币成本换算为保守美元成本，考虑客户/分组/视频倍率、充值折扣、手续费、下载和运营成本。原生视频路径不会自动用灵速成本卡拒绝亏损订单，也不完整锁定创建时的单价与倍率。

## 4. 与原版灵速的接口和生命周期差异

### 状态与资金字段

| 灵速状态 | Grok 目标状态 | 附加信息 |
|---|---|---|
| queued / submitting | pending | 保留原 `task_status`、进度和时间 |
| in_progress / processing | pending | 继续查询，不新建 |
| in_progress / review | pending | 保留 review，需核查；不能改为失败或自动退款 |
| completed | done | 提供 `video.url` 和数字 `video.duration` |
| failed | failed | 保留安全的错误码与说明 |

sub2api 只有在 `status=done` 且 `video.url` 非空时才观察到可计费完成。创建返回 202 不是完成，也不在创建入口按成功视频扣费。重复状态查询和下载共享稳定任务计费编号，已有防重复机制。

灵速 `funds_status` 描述供应商账号的 reserved/captured/released/refunded，`quoted_price` 是供应商人民币报价，不能等同于 sub2api 客户的预留、扣款和售价。纯桥应在供应商元数据中记录或对外隐藏批发成本，不假称客户已扣款/已退款。灵速已完成任务后来退款，也不会自动触发原生客户退款。

### 幂等与任务身份

sub2api 向桥使用的是配置在上游账号上的凭证，不是原客户 Key，也没有动态复制客户 `Idempotency-Key`。静态账号请求头不能为每个独立任务提供正确操作编号。

不改核心的可用扩展是 `adapter_options.idempotency_key`：每次新操作一个 UUID，重试同一操作保留该编号和请求。桥在发送前持久化供应商 Key 选择、实际供应商请求字节、幂等键、供应商任务 ID；创建回执未知时不换 Key/供应商重建。桥接字段要在供应商 JSON 中删除。这一扩展尚未在现有适配器实现。

该替代方式仍不完全等于“原客户同 Key 的幂等”：桥看到的是共享上游账号身份，不能仅靠调用者自报的 user_id/key_id 可信地区分原客户。无核心修改的扩展契约必须要求租户内高熵且全局唯一的操作编号；若要按原客户 Key 严格隔离幂等空间，应由 sub2api 传递可信身份标识，并避免调度换账号把同一次未知操作变成新供应商订单。

原生可能重写模型和图像对象，桥也需要改字段名，所以不能承诺原客户 JSON 的原始字节与灵速请求一致。可以保存并重放首次发给灵速的精确字节；若要求完整保留灵速对“原客户原始字节不同”的冲突判定，还需要可信的原始请求指纹契约。不能把同提示词去重当作幂等，用户可能有意生成第二条。

桥即使不处理客户资金，也需要持久任务存储，并隔离桥凭证对应的租户。供应商侧查询和下载必须使用创建时的原 Key；不能随机选另一个供应商 Key。

原生按用户、Key、分组绑定任务和上游账号，查询下载应使用原客户 Key。该绑定主要依赖 Redis，默认至少保存 24 小时，配置较长 sticky TTL 可以延长绑定；创建时计费元数据的 TTL 固定 24 小时。供应商任务还存在不代表原生入口仍能定位，Redis 丢失/过期或原账号不可用都可能影响旧任务读取。适配器自己的持久任务表不能单独修复原生绑定丢失。

### HTTP 能力

| 能力 | 灵速 | 官方 sub2api Grok 入口 |
|---|---|---|
| 创建 | POST /v1/videos | 支持，并有 generations 别名 |
| 查询单任务 | GET /v1/videos/{id} | 支持 |
| 原片 | /download 或 /content | 原生走 /content，不直接开放 /download |
| HEAD 文件信息 | 支持 | 没有视频 HEAD 路由，需要核心/受控入口增加 |
| Range 续传 | 支持 206/416 | 转发 Range，能流式代理；ETag、Last-Modified、If-Range 等不完整保留 |
| 规格与实时报价 | /v1/video-models | 没有对应透明代理；原生 /v1/models 是配置生成的目录 |
| 任务列表 | 文档没有列表 API，网页另有列表 | 没有通用 Grok 视频列表 API；客户端必须保存任务 ID |
| 编辑/延长 | 文档未提供 | 原生有对应 Grok 路由，桥必须拒绝供应商未提供的操作 |
| 回调、取消、批量 | 文档未提供 | 不能通过桥凭空获得供应商能力 |

原生视频 GET 仍经过余额、Key 额度以及 handler 的计费资格检查。**第一次完成状态查询扣完余额后，下一次下载可能被拦截。** 灵速允许符合身份条件的零余额旧任务读取，两者不等价。下游桥无法修复进入桥之前被拒绝的请求。

修正时不能简单豁免所有视频 GET：应保持身份、权限和归属检查，为已结算或已足额冻结的任务提供读取能力，未结算任务仍必须安全结算，避免成为免付费下载通道。还需明确禁用、删除或过期 Key 的政策。

### 原生异步账务并非灵速的资金生命周期

原生的请求期间在途余额预留，不是覆盖视频任务完整生命周期的持久冻结。创建 HTTP 请求结束后，任务继续占用供应商资金，但原生不会据此持续占用客户余额。

原生在客户查询或下载观察到完成后才提交计费任务；未看到其他独立视频后台任务自动对全部成功订单结算。用户不再轮询、耗尽余额或计费任务失败，均可能导致供应商已经花费而客户账务未可靠完成。状态响应/视频流是在提交用量扣费前交付的，不能视为“先扣款成功再交片”的事务。

因此若适配器只转换协议，可靠冻结、自动结算、退款和价格锁定应放入 sub2api；不能靠添加 `funds_status` 字段就让原生自动获得这些行为。

## 5. 现有适配器的具体缺口

1. 架构是 `客户端 -> Nginx -> video-adapter`，由服务直接读写客户账务；它校验真实 sub2api 客户 Key。把它直接设为 Grok 上游，会收到上游桥凭证，无法获得原来的客户身份，并可能造成双重计费。
2. `src/request.js` 的严格 schema 不接受 `image`、`images`、`reference_images`、`face_direct`、`n` 或 `adapter_options`。因此不能直接承载原生 Grok 创建请求与完整灵速参数。
3. `src/providers.js` 特价转换只接受 image Data URL，去掉前缀后生成 images，并固定 `face_direct=false`。不支持原版纯 Base64 images；首尾帧角色也不能被图片数组保留。
4. 应用 JSON 上限 20MB，Nginx 样例 20m，单条 source 最多 1200 万字符。灵速特价允许单图 50MiB、图片合计 70MiB、JSON 128MiB，当前请求容量明显更小。原生 gateway 默认 256MiB，但实际全局/代理配置仍须核对。
5. 尚未完整校验提示词上限、参考音视频时长、H3 禁止 duration_seconds、SD 音频组合等供应商规则；不能把适配器 schema 通过当作灵速参数合法。
6. 三个灵速示例型号均关闭，其他五个没有完整示例配置；H3 示例禁止所有素材且错误列了 1:1，其他型号比例也未覆盖公开规格。
7. 当前公开状态部分返回 queued/running/in_progress，尚未统一为 Grok 的 pending；有 id 可被原生提取，但缺 request_id 并非唯一或主要问题。
8. 幂等键当前限制 8-128 字符，灵速为 8-200；当前下载还有单笔数量/流量保护限制，不能宣称与原版完全同样的读取行为。

已执行隔离 Node 结构检查：`image`、`images`、`face_direct`、`n` 均产生 `unrecognized_keys`；即使直接向特价 buildBody 传 true，实际供应商 JSON 仍生成 false。检查使用占位素材，只验证字段路径，不代表真实生成验收。

## 6. 转换完成后用户如何查询与下载

**本节是目标桥接模式的调用契约，当前代码尚未实现 `adapter_options`。** 中转站域名的创建、查询、下载均应进入 sub2api，再访问内网协议桥。不能继续用当前 Nginx 样例直接绕过原生入口。

### 创建

以下为 PowerShell 示例，模型别名需要先由运营者配置并映射到 H3-KS。操作编号只在新建逻辑任务时生成；网络重试应复用已有 `$payload`，不要重新生成 UUID。

```powershell
$relay = 'https://relay.example'
$headers = @{ Authorization = 'Bearer YOUR_SUB2API_KEY' }
$operation = [guid]::NewGuid().ToString()
$payload = @{
  model = 'lingsu-h3-ks'
  prompt = '晴天的海面，固定镜头'
  duration = 5
  resolution = '1080p'
  aspect_ratio = '16:9'
  adapter_options = @{ idempotency_key = $operation }
} | ConvertTo-Json -Depth 10 -Compress
$created = Invoke-RestMethod -Method Post -Uri "$relay/v1/videos" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
$taskId = $created.request_id
```

目标创建响应至少返回稳定任务 ID；可以同时返回 id 兼容原调用端：

```json
{"request_id":"va_example","id":"va_example","model":"lingsu-h3-ks","status":"pending"}
```

### 查询

用同一个 sub2api Key 查询中转站，间隔数秒，遵守可用的 Retry-After；不访问灵速域名。pending 等待，failed 检查错误，review 保留原任务并交由核查。

```powershell
$task = Invoke-RestMethod -Method Get -Uri "$relay/v1/videos/$taskId" -Headers $headers
```

目标完成响应示例：

```json
{
  "request_id": "va_example",
  "id": "va_example",
  "model": "lingsu-h3-ks",
  "status": "done",
  "video": { "url": "/v1/videos/va_example/content", "duration": 5 },
  "task_status": "completed",
  "progress": 100
}
```

原生在首次观察到 done+video.url 时走完成计费。同一个任务后续查询/下载按正常去重路径不重复收生成费；这不解决未足额冻结、结算失败和历史读取资格问题。

### 下载原片

确认 done 后，将相对 video.url 拼接到中转站根域名，仍携带原 sub2api Key：

```powershell
curl.exe --fail-with-body "$relay$($task.video.url)" -H "Authorization: Bearer YOUR_SUB2API_KEY" --output result.mp4
```

续传可使用同一条链接：

```powershell
curl.exe --fail-with-body -C - "$relay$($task.video.url)" -H "Authorization: Bearer YOUR_SUB2API_KEY" --output result.mp4
```

链路为 `客户端 -> sub2api /content -> 桥 /content -> 灵速 /download`。桥携带创建时的供应商 Key；用户不会拿到灵速 Key。原生下载会先查一次桥的任务状态，再取内容。

桥必须返回形如 `/v1/videos/{同一个任务ID}/content` 的受保护路径。不能把灵速 `/download` 或任意 CDN URL 直接当作 Grok video.url；原生外部签名地址校验只认可特定 xAI 域名，会导致下载失败。

下载无需裁剪、补帧或转码，可以转发原 MP4 字节及 Range。应通过同一供应商任务的 SHA-256 和分段重组验收确认原片不变，不能只看扩展名。普通浏览器点击链接不会自动带 Bearer，需要支持认证的客户端或你的网站后端代下载；原生没有自动给出免鉴权临时下载链接。

下载失败只重试原任务下载，不重新生成、不换幂等键，也不把超时当退款。原片应在供应商可访问期间取回；该链路不是永久作品库。官方版本的零余额/耗尽 Key 额度拦截仍需修正，才可承诺扣完最后一笔后仍能取片。

## 7. 实现边界与必要验收

若坚持不修改 sub2api，可以实现受限的 Grok 兼容上游桥：基本生成、扩展素材、供应商幂等持久化、状态映射和原片代理；按条价可以配置，按秒价限制到 15 秒或改成严格固定时长别名。必须明确接受历史访问、零余额下载、账务自动化和日志时长的差异，不能给出“不亏损”保证。

若要求适配器仅处理供应商协议，同时满足完整功能和可靠收款，建议在 sub2api 中增加：

1. 供应商/型号级时长和规格能力，去掉套用 xAI 15 秒上限的通用计费假设。
2. 动态幂等操作编号、可信客户身份和原始请求指纹、创建时完整报价与倍率快照，以及持久任务归属/渠道绑定。
3. 原生事务冻结、提交恢复、后台结算、失败释放和供应商退款对账；未完成客户结算不能仅靠成功响应完成交付。
4. 已结算/已足额冻结旧任务的读取资格，保留所有权与停用权限检查，修正中间件和 handler 两处额度检查。
5. 根据承诺的公开 API 增加 HEAD、下载别名和规格目录；补齐条件请求头，而不是让公共下载绕过原生鉴权与账务。

高价值验收应覆盖：各型号合法/非法参数；混合素材与开关无损；30 秒金额和日志；创建超时重试同一操作；客户不轮询仍结算；并发余额与额度；跨用户/跨 Key 读不到他人任务；耗尽余额后的已付旧任务下载；重复查询和 Range 不重复扣生成费；review/退款；Redis 丢失与重启恢复；同任务直接原片和代理原片哈希一致。

此次完成的是文档和源码核对及隔离结构检查，没有生产 PostgreSQL/Redis 联调、原生入口端到端生成或付费供应商验收。运行代码保持原状，不能按目标示例直接宣称已可上线。

## 8. 核心依据

- [灵速视频 API 文档](https://lingsu.xyz/docs/video-api/)：规格、价格、素材、幂等、状态、资金和下载契约。
- [原生参数解析](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/grok_media.go#L124)：只提取部分字段，其余依赖 JSON 透传。
- [转发与请求头](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/grok_media.go#L675)：模型改写、账号凭证和上游请求头。
- [图像对象规范化](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/grok_media.go#L1081)：视频字段规范化范围。
- [完成状态计费条件](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/grok_media.go#L559)：done+video.url、video.duration 和创建时档位。
- [15 秒归一化](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/video_billing_resolution.go#L11)：硬编码秒数上限与默认值。
- [客户完成结算入口](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/handler/grok_media.go#L519)：状态/内容观察触发，稳定任务去重。
- [视频 GET 资格检查](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/handler/grok_media.go#L166)：handler 仍检查账务资格。
- [中间件读取豁免范围](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/server/middleware/api_key_auth.go#L168)：当前包括异步图片读取，不包括视频。
- [原生视频下载链路](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/grok_media.go#L799)：状态检查、受保护 content 路径、Range 代理。
- [任务绑定与元数据 TTL](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/grok_media.go#L297)：至少 24 小时绑定，计费元数据固定 24 小时。
- [公开原生视频路由](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/server/routes/gateway.go#L270)：创建/查询/content，缺少 HEAD 和 download 别名。

现有适配器对应文件为 `src/request.js`、`src/providers.js`、`src/app.js`、`config/catalog.example.json` 与 `docs/nginx.conf.example`。
