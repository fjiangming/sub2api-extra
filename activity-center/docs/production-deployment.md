# 活动中心生产部署

本记录对应用户授权的首次上线。服务器 `154.36.173.220`，部署目录 `/root/sub2api-extra/activity-center`，访问入口 `https://activitycenter.yunhop.cc/`。主站已添加所有登录用户可见的「活动中心」菜单，使用原生 SSO；奖励账本继续仅管理员可用。本文不包含密码、主站密钥、集成令牌或数据库凭据。

## 发布版本

源码提交：[`f962a13e50d7867b6c094eebcc8d877c1e34f706`](https://github.com/fjiangming/sub2api-extra/commit/f962a13e50d7867b6c094eebcc8d877c1e34f706)。[Docker images 工作流 43897374132](https://github.com/fjiangming/sub2api-extra/actions/runs/43897374132) 的 6 项测试门禁、16 个双架构构建 / 运行检查和 8 个镜像发布全部成功。

本次运行的三个相关服务镜像 revision 均为上述完整源码提交，标签为 `ghcr.io/fjiangming/sub2api-extra:<服务名>-latest`。服务器核验的拉取摘要：

| 服务 | 摘要 |
| --- | --- |
| activity-center | `sha256:4b6fd81d1e1c3e43ecbd21a14140064067124ff3faaea1b31a9cb4202fb6ba2a` |
| recharge-center | `sha256:5f6627b288bdf7f68a8ec030e9bceedeb2319a12502fcea76f889f6cdc6ed99b` |
| operations-center | `sha256:3d10165856bc0594d14984e6156fde8f73cda47def143d253f06cb95b1698d5d` |

只新增活动中心，并重建充值中心 / 运营中心以接入只读充值核验和活动赠送识别。主站容器与其他所有原容器的 ID、镜像和启动时间均未改变；主站程序仍为 `48f1a533a323ac93657c782fc079ef762ff46116`。其他本地进行中的对话归档、域名和演示改动未提交或部署。

## 服务配置

- 根 `docker-compose.yml` 增加活动中心 include，`compose.services.env` 在原 profile 列表中追加 `activity-center`。
- 子目录包含 `compose.yaml` 和仅 root 可读的 `.env`；只绑定 `127.0.0.1:9878`，数据卷 `sub2api-extra_activity-center-data` 挂载 `/app/data`。
- 活动服务加入现有默认网络和 `sub2api-deploy_sub2api-network`，通过内部服务名访问主站和充值中心；没有向公网暴露数据库或新服务端口。
- 充值来源为 `official,recharge_center`。官方来源复用已有 SELECT-only 账号 `sub2api_ops_read`，已核验无 INSERT / UPDATE / DELETE 权限；充值中心使用独立随机令牌，只返回已核验个人付款合计。
- `/etc/nginx/conf.d/activity-center.conf` 新增独立域名，复用现有 `yunhop.cc` 通配符源站证书，支持 80 / 8443；原 Nginx 站点文件散列均未改变。活动请求不记录 URL 查询参数，浏览器 Token 在页面初始化时清除。
- 主站仅通过原生设置 API 追加 `activity-center` 菜单，回读核验唯一变化为 `custom_menu_items`，原菜单和其他设置保留。

## 充值起点

首次正式启动持久保存的起点为 **2026-11-16 23:43:19.172（Asia/Shanghai）**，即 `2026-11-16T15:43:19.172Z`。仅该时刻起的实际付款产生抽奖次数及高额奖品资格；历史付款即使之后才完成入账也不计入。

生产 SQLite 初始核验为 0 次抽奖、0 次消费，没有导入演示数据库或历史充值。按固定起点调用两种真实只读来源成功，管理员部署后实付合计为 0。更新或重启必须保留数据卷和此起点，不能删卷重开额度。

## 验证与备份

三个目标服务均 healthy，主站及原扩展服务健康接口均为 200。已从用户侧网络验证域名首页、健康 / 就绪、公开配置、JS / CSS / 图标资源全部 200，未登录的活动及管理员 API 均为 401；首页不包含已移除的顶部栏或充值按钮。源站 HTTP 和使用 Cloudflare CA 校验的 HTTPS 均通过。服务器本机的 Python 公网探测被 Cloudflare 返回 403，因此公网验收使用用户侧网络，未修改 Cloudflare 防护规则。

上线验收不创建生产充值、不调用生产抽奖，也不发放测试奖励；实际概率、权限、并发与恢复流程使用本地隔离测试及 Linux CI 核验。

本次配置、充值库与运营账本的一致备份位于 `/root/sub2api-extra/backups/activity-center-f962a13-20261116/`，目录 0700，敏感文件 0600；SQLite 使用 backup API 并执行完整性检查。保留旧充值 / 运营镜像的 `*-pre-activity-f962a13` 本机标签。无关的对话归档和计费恢复库未纳入本次最终账本备份，原文件保留。`state.json` 的 `applied`、`nginx`、`menu` 字段记录实际生效状态，其中包含私有配置，不得上传。

回退时先暂停新抽奖并保留活动数据卷、现有奖励及已用次数；不得恢复空库或重复发放。恢复配置、菜单或镜像前应核对备份与当前文件差异，避免覆盖后续维护。已有奖励的发放状态应继续按原回执核验。
