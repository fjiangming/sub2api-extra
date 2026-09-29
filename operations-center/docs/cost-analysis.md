# 成本分析设计与口径

## 目标

成本分析把 Sub2API 的自动充值实收、运营人员维护的手工收入和支出台账放在同一时间轴中，提供日、周、月、年汇总。它不修改 Sub2API 源码或业务表，也不把供应商凭据复制到运营中心。

## 数据流

1. 自动充值收入从 Sub2API PostgreSQL `payment_orders` 按需读取。
2. 手工收入以及供应商成本、自定义支出由管理员录入本地台账。
3. 供应商目录从 Provider Monitor 同步，只保留脱敏字段和最近同步状态。
4. 查询时先按资金时区生成自然日数据，再在应用层归并为日、周、月或年周期。

周以周一为起点。查询范围首尾不足完整周期时，周期标签按实际查询边界截断。

## 计算公式

| 指标 | 公式 |
| --- | --- |
| 自动充值收入 | 所选币种已支付订单 `SUM(pay_amount)` |
| 手工收入 | 所选币种手工收入台账金额之和 |
| 总收入 | 自动充值收入 + 手工收入 |
| 支出 | 所选币种手工支出金额之和 |
| 利润 | 总收入 - 支出 |
| 利润率 | 利润 / 总收入；总收入为 0 时返回空值 |
| 平均充值 | 自动充值收入 / 已支付订单数；手工收入不参与计算 |

不同币种分别查询，不自动换汇。退款、税费、赠送额度和未录入成本不进入利润；退款仍在“收款与入账”页按估算口径单独审计。

## 本地台账

`OPERATIONS_CENTER_DATA_DIR/cost-ledger.json` 是版本化、原子替换的 JSON 文件，权限为 `0600`。单进程写入通过队列串行化，收入和支出合计最多保存 50,000 条。部署时必须持久化 `/app/data`，并把该数据卷纳入运营备份。

手工收入记录包含名称、发生日期、金额、币种、备注以及创建/更新管理员和时间。新建收入和支出在页面上都默认使用 `CNY`，编辑时保留原记录币种。

支出记录包含：

- `kind`：`provider` 或 `custom`
- `providerId`：供应商支出使用的 Provider Monitor ID
- `name`：供应商名称快照或自定义支出项名称
- `date`：资金时区下的发生日期
- `amountMinor`：以百分之一币种单位保存的整数金额
- `currency`、`note`
- 创建/更新管理员和时间

供应商改名或删除不会改写历史支出的名称快照。相同自定义名称在成本构成中归为同一项。

台账版本从 v1 升级到 v2 时会在启动阶段自动添加空的手工收入列表，原支出、供应商快照和同步状态保持不变。升级无需新增环境变量或手工转换文件。

## 供应商同步

优先使用 `PROVIDER_MONITOR_INTEGRATION_TOKEN` 调用只读接口 `GET /api/integrations/providers`。未配置服务间 Token 时，运营中心可使用当前或持久化的 Sub2API 管理员 Token，通过 Provider Monitor SSO 换取短期本地会话后调用原有供应商接口。

同步失败会记录错误并继续返回上次成功快照。供应商支出只能绑定当前快照中存在的供应商；自定义支出不依赖 Provider Monitor。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/cost-analysis` | 返回区间汇总、周期序列和成本构成 |
| `GET` | `/api/cost-analysis/providers` | 返回供应商快照；`refresh=true` 强制同步 |
| `GET` | `/api/cost-analysis/incomes` | 返回日期范围内的手工收入台账 |
| `POST` | `/api/cost-analysis/incomes` | 新增手工收入 |
| `PUT` | `/api/cost-analysis/incomes/:id` | 更新手工收入 |
| `DELETE` | `/api/cost-analysis/incomes/:id` | 删除手工收入 |
| `GET` | `/api/cost-analysis/expenses` | 返回日期范围内的支出台账 |
| `POST` | `/api/cost-analysis/expenses` | 新增支出 |
| `PUT` | `/api/cost-analysis/expenses/:id` | 更新支出 |
| `DELETE` | `/api/cost-analysis/expenses/:id` | 删除支出 |

所有接口要求运营中心管理员会话；写接口额外要求 CSRF Token。金额必须大于零且最多两位小数，日期必须是真实的 `YYYY-MM-DD` 日期。

## 故障边界

- Sub2API 数据库不可用：报表查询失败，但已保存的本地台账不丢失。
- Provider Monitor 不可用：保留上次供应商快照，手工收入和自定义支出可继续维护。
- 本地数据卷不可写或台账文件损坏：拒绝启动或拒绝写入，不用空台账覆盖原文件。
- 供应商被删除：历史记录继续参与统计，新记录不能再绑定该供应商。
