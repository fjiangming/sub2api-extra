# 成本分析设计与口径

## 目标

成本分析把 Sub2API 的充值实收与运营人员维护的支出台账放在同一时间轴中，提供日、周、月、年汇总。它不修改 Sub2API 源码或业务表，也不把供应商凭据复制到运营中心。

## 数据流

1. 收入从 Sub2API PostgreSQL `payment_orders` 按需读取。
2. 供应商目录从 Provider Monitor 同步，只保留脱敏字段和最近同步状态。
3. 供应商成本与自定义支出由管理员手工录入本地成本台账。
4. 查询时先按资金时区生成自然日数据，再在应用层归并为日、周、月或年周期。

周以周一为起点。查询范围首尾不足完整周期时，周期标签按实际查询边界截断。

## 计算公式

| 指标 | 公式 |
| --- | --- |
| 充值收入 | 所选币种已支付订单 `SUM(pay_amount)` |
| 支出 | 所选币种手工支出金额之和 |
| 利润 | 充值收入 - 支出 |
| 利润率 | 利润 / 充值收入；收入为 0 时返回空值 |
| 平均充值 | 充值收入 / 已支付订单数 |

不同币种分别查询，不自动换汇。退款、税费、赠送额度和未录入成本不进入利润；退款仍在“收款与入账”页按估算口径单独审计。

## 本地台账

`OPERATIONS_CENTER_DATA_DIR/cost-ledger.json` 是版本化、原子替换的 JSON 文件，权限为 `0600`。单进程写入通过队列串行化，默认最多保存 50,000 条支出记录。部署时必须持久化 `/app/data`，并把该数据卷纳入运营备份。

支出记录包含：

- `kind`：`provider` 或 `custom`
- `providerId`：供应商支出使用的 Provider Monitor ID
- `name`：供应商名称快照或自定义支出项名称
- `date`：资金时区下的发生日期
- `amountMinor`：以百分之一币种单位保存的整数金额
- `currency`、`note`
- 创建/更新管理员和时间

供应商改名或删除不会改写历史支出的名称快照。相同自定义名称在成本构成中归为同一项。

## 供应商同步

优先使用 `PROVIDER_MONITOR_INTEGRATION_TOKEN` 调用只读接口 `GET /api/integrations/providers`。未配置服务间 Token 时，运营中心可使用当前或持久化的 Sub2API 管理员 Token，通过 Provider Monitor SSO 换取短期本地会话后调用原有供应商接口。

同步失败会记录错误并继续返回上次成功快照。供应商支出只能绑定当前快照中存在的供应商；自定义支出不依赖 Provider Monitor。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/cost-analysis` | 返回区间汇总、周期序列和成本构成 |
| `GET` | `/api/cost-analysis/providers` | 返回供应商快照；`refresh=true` 强制同步 |
| `GET` | `/api/cost-analysis/expenses` | 返回日期范围内的支出台账 |
| `POST` | `/api/cost-analysis/expenses` | 新增支出 |
| `PUT` | `/api/cost-analysis/expenses/:id` | 更新支出 |
| `DELETE` | `/api/cost-analysis/expenses/:id` | 删除支出 |

所有接口要求运营中心管理员会话；写接口额外要求 CSRF Token。金额必须大于零且最多两位小数，日期必须是真实的 `YYYY-MM-DD` 日期。

## 故障边界

- Sub2API 数据库不可用：报表查询失败，但已保存的本地台账不丢失。
- Provider Monitor 不可用：保留上次供应商快照，自定义支出可继续维护。
- 本地数据卷不可写或台账文件损坏：拒绝启动或拒绝写入，不用空台账覆盖原文件。
- 供应商被删除：历史记录继续参与统计，新记录不能再绑定该供应商。
