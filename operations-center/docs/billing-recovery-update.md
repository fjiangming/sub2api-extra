# 现有 Docker 环境的计费修复更新步骤

2026-10-23 核验。本文件描述首次切换前的部署基线及后续更新步骤，实际部署记录见根目录 CUSTOMIZATIONS.md。本文件不包含服务器密码、数据库口令或管理员 Token。

## 已确认的部署

| 项目 | 当前情况 |
| --- | --- |
| 主站 | `/root/sub2api-deploy/docker-compose.yml`，服务/容器 `sub2api` |
| 运行版本 | 二进制 `0.2.17`，commit `060d0160417782cd962a0c7f460f6cd4565d4916` |
| 旧镜像 | `migration20261021/sub2api:frozen`，镜像元数据仍标记 `0.1.160` |
| 主站数据 | `/root/sub2api-deploy/data` -> `/app/data` |
| PostgreSQL / Redis | 容器 `sub2api-postgres` / `sub2api-redis`，保留当前镜像、挂载与网络 |
| 运营中心 | `/root/sub2api-extra/operations-center/compose.yaml`，服务 `operations-center` |
| 运营中心旧镜像 | `migration20261021/sub2api-operations-center:frozen` |
| 运营中心数据 | 命名卷 `sub2api-extra_operations-center-data` -> `/app/data` |
| 访问路径 | 主站 `127.0.0.1:9000`，运营中心 `127.0.0.1:9872`，已有反向代理 |
| 运营中心连接 | `http://sub2api:8080`；已接入 `sub2api-deploy_sub2api-network` |
| 自动恢复所需配置 | 持久管理员认证、供应商监控集成 Token 已配置；不在文档中输出其值 |
| 工具 | Docker Compose、Python 3、PyYAML 可用；没有 Git，也没有源码 checkout |

两处目标服务均有 `pull_policy: never`。直接执行旧 Compose 的 pull 或用主站旧网页按钮更新，都不能完成首次切换。不要用仓库里的 Compose 整体覆盖服务器配置，否则会丢失本机网络、冻结数据库镜像和其他部署设置。

## 1. 确认产物已发布

主站使用 [fork 的 Release](https://github.com/fjiangming/sub2api/releases)，运营中心使用现有 [extra 镜像流水线](https://github.com/fjiangming/sub2api-extra/actions/workflows/docker-publish.yml)。目标 commit 的构建通过后再更新。主站分支比生产二进制新，除个性化补丁外也包含这段时间的原作者更新和迁移。

主站 `latest` 只应在同一提交的 CI、安全检查、归档构建和镜像验证成功后提升。它表示最新成功发行；dev 有尚未构建或失败的提交时，latest 会暂时落后。首次切换及后续更新均不需要在 VPS 安装 Git、拉取源码或执行编译。

在 VPS 的 Bash 中拉取两个更新通道：

```bash
set -euo pipefail
export SUB2API_IMAGE="ghcr.io/fjiangming/sub2api:latest"
export OPERATIONS_IMAGE="ghcr.io/fjiangming/sub2api-extra:operations-center-latest"
printf '主站: %s\n运营中心: %s\n' "$SUB2API_IMAGE" "$OPERATIONS_IMAGE"
docker pull "$SUB2API_IMAGE"
docker pull "$OPERATIONS_IMAGE"

for image in "$SUB2API_IMAGE" "$OPERATIONS_IMAGE"; do
  docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}} {{index .Config.Labels "org.opencontainers.image.version"}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image"
done

expected_core="$(curl -fsSL https://api.github.com/repos/fjiangming/sub2api/branches/dev | python3 -c 'import json,sys; print(json.load(sys.stdin)["commit"]["sha"])')"
expected_ops="$(curl -fsSL https://api.github.com/repos/fjiangming/sub2api-extra/branches/main | python3 -c 'import json,sys; print(json.load(sys.stdin)["commit"]["sha"])')"
actual_core="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$SUB2API_IMAGE")"
actual_ops="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$OPERATIONS_IMAGE")"
if [ "$actual_core" != "$expected_core" ] || [ "$actual_ops" != "$expected_ops" ]; then
  printf '镜像尚未对应最新源码提交，请检查目标提交的 Actions，等待成功后重新拉取。\n' >&2
  exit 1
fi
```

需要固定版本时，将主站 latest 改成已发布版本号（不带 v），运营中心改成目标构建提供的 `operations-center-sha-<7 位 commit>`。此时应核对所选目标提交，而不是要求等于分支 HEAD。公开包不需要登录；若包仍为私有，请通过 GitHub Packages 的正常授权登录 GHCR，不要在脚本中写明文 Token。

## 2. 备份并安排短暂停机

选低峰时段，先暂停新请求并等待旧版本在途请求完成。旧二进制没有本次持久意图保护，直接重启不能追溯尚未记下的用量。主程序现有退出等待只有 5 秒，仅增大 Docker stop timeout 不能代替等待请求结束。

下面命令由管理员实际更新时执行；文档编写期间没有执行：

```bash
umask 077
backup_dir="/root/sub2api-deploy/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp -a /root/sub2api-deploy/docker-compose.yml "$backup_dir/sub2api-compose.yml"
cp -a /root/sub2api-deploy/.env "$backup_dir/sub2api.env"
cp -a /root/sub2api-extra/operations-center/compose.yaml "$backup_dir/operations-center-compose.yaml"
cp -a /root/sub2api-extra/operations-center/.env "$backup_dir/operations-center.env"
cp -a /root/sub2api-extra/compose.services.env "$backup_dir/compose.services.env"
docker inspect --format '{{.Image}}' sub2api > "$backup_dir/sub2api-image-id"
docker inspect --format '{{.Image}}' sub2api-operations-center > "$backup_dir/operations-center-image-id"
cd /root/sub2api-extra
docker compose --env-file compose.services.env stop operations-center
cd /root/sub2api-deploy
docker compose stop sub2api
docker exec sub2api-postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/sub2api.dump"
test -s "$backup_dir/sub2api.dump"
docker exec sub2api-postgres sh -c 'exec pg_dumpall -U "$POSTGRES_USER" --globals-only' > "$backup_dir/postgres-roles.sql"
test -s "$backup_dir/postgres-roles.sql"
docker exec -i sub2api-postgres pg_restore --list < "$backup_dir/sub2api.dump" > "$backup_dir/sub2api-dump-contents.txt"
tar -C /root/sub2api-deploy -czf "$backup_dir/sub2api-data.tgz" data
tar -C /var/lib/docker/volumes/sub2api-extra_operations-center-data/_data -czf "$backup_dir/operations-center-data.tgz" .
printf '备份目录: %s\n' "$backup_dir"
```

不停止或重建 PostgreSQL、Redis。不要执行 `docker compose down -v` 或镜像清理。保留冻结镜像供回滚。若备份失败，停止后续步骤；可用现有 Compose 启动原来的两个服务恢复访问。

## 3. 仅修改两处服务的镜像和拉取策略

在同一个 Bash 会话中执行，保留上面的两个镜像环境变量：

```bash
python3 - <<'PY'
import os
from pathlib import Path
import yaml

targets = [
    (Path('/root/sub2api-deploy/docker-compose.yml'), 'sub2api', os.environ['SUB2API_IMAGE']),
    (Path('/root/sub2api-extra/operations-center/compose.yaml'), 'operations-center', os.environ['OPERATIONS_IMAGE']),
]
for path, name, image in targets:
    config = yaml.safe_load(path.read_text())
    service = config['services'][name]
    service['image'] = image
    service['pull_policy'] = 'missing'
    path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
    print(f'{name}: {image}, pull_policy=missing')
PY
```

PyYAML 会调整 YAML 排版，但这里只修改目标服务的两个配置值。数据库、Redis、其他子服务、端口、环境变量、持久卷及网络定义均从原配置保留。核心默认开启计费保护，运营中心默认开启恢复调度，不需要新建数据卷或修改数据库连接。

## 4. 先更新主站，再更新运营中心

```bash
cd /root/sub2api-deploy
docker compose config --quiet
docker compose up -d --no-deps --wait --wait-timeout 180 sub2api
docker exec sub2api /app/sub2api -version
curl -fsS http://127.0.0.1:9000/health
docker exec sub2api-postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT to_regclass('\''sub2api_custom.billing_recovery'\'');"'

cd /root/sub2api-extra
docker compose --env-file compose.services.env config --quiet
docker compose --env-file compose.services.env up -d --no-deps --wait --wait-timeout 180 operations-center
curl -fsS http://127.0.0.1:9872/healthz
docker inspect --format '{{.Config.Image}} {{.State.Health.Status}}' sub2api sub2api-operations-center
```

主站启动自动应用迁移，查询应返回 `sub2api_custom.billing_recovery`。主站启动失败时先查看 `docker logs --tail 100 sub2api`，不要继续重启或绕过迁移错误。

两个服务健康后重新从管理菜单进入运营中心，查看“计费核查”tab：应显示“自动恢复已开启”，列表和详情可读取。若显示等待持久认证，到系统设置的 Sub2API 管理 API 检查原持久凭据是否仍有效，不需要打印或复制现有密码。查单继续使用供应商监控的历史业务样本，不重发推理。

开启 2FA 的管理员不能仅凭邮箱密码运行后台。持久认证可使用原生 `admin-` 管理员 API Key，运营中心按 `x-api-key` 调用原生 admin 接口；浏览器 SSO 仍使用当前管理员 JWT。复用已有集成 Key 时不要重新生成或轮换，否则会影响其他服务。验证应包含实际的 pending 列表读取及后台 lastError，不能只检查“凭据已配置”。

原生仪表盘默认保留请求日志 90 天，重启时可能清理刚到期的旧记录。升级前后核对记录 ID、计费总额及余额；发现差异时从备份确认具体记录和保留策略。不要整库恢复覆盖已恢复接单后的新交易。

保护只自动追踪升级后的调用，不会扫描历史 CSV 并扣费。人工补记仍需核对归属、最终用量和历史价格，确认后由使用记录结算。

## 5. 后续更新与回滚

首次按本手册把两个 image 切换到 latest 通道后，后续不用再修改源码或 Compose 镜像名称。先重复第 1 步拉取并核对镜像 revision，再按第 2 步安排低峰、等待在途请求和备份。之后只更新两个目标服务：

```bash
cd /root/sub2api-deploy
docker compose pull --policy always sub2api
docker compose up -d --no-deps --wait --wait-timeout 180 sub2api

cd /root/sub2api-extra
docker compose --env-file compose.services.env pull --policy always operations-center
docker compose --env-file compose.services.env up -d --no-deps --wait --wait-timeout 180 operations-center

docker exec sub2api /app/sub2api -version
docker inspect --format '{{.Name}} {{.Image}} {{.State.Health.Status}}' sub2api sub2api-operations-center
```

按第 4 步复核健康状态及计费核查功能。主站左上角更新源已改为 fork，但容器中的网页更新只替换运行时文件；持久升级仍应以 Compose 镜像为准，否则重建可能退回旧版本。

回滚前保持新流量暂停。使用第 2 步实际打印的备份目录恢复两个 Compose 文件，并固定到备份时运行的镜像。之后采用 latest 部署时，单纯恢复仍写着 latest 的 Compose 不会回到旧版本；因此这里同时记录旧镜像 ID 并在回滚时创建本地标签：

```bash
# backup_dir 必须指向本次真实备份目录。
cp -a "$backup_dir/sub2api-compose.yml" /root/sub2api-deploy/docker-compose.yml
cp -a "$backup_dir/operations-center-compose.yaml" /root/sub2api-extra/operations-center/compose.yaml
export ROLLBACK_CORE_IMAGE="sub2api-local-rollback:$(basename "$backup_dir")"
export ROLLBACK_OPERATIONS_IMAGE="operations-center-local-rollback:$(basename "$backup_dir")"
docker image tag "$(cat "$backup_dir/sub2api-image-id")" "$ROLLBACK_CORE_IMAGE"
docker image tag "$(cat "$backup_dir/operations-center-image-id")" "$ROLLBACK_OPERATIONS_IMAGE"
python3 - <<'PY'
import os
from pathlib import Path
import yaml

for filename, name, image in [
    ('/root/sub2api-deploy/docker-compose.yml', 'sub2api', os.environ['ROLLBACK_CORE_IMAGE']),
    ('/root/sub2api-extra/operations-center/compose.yaml', 'operations-center', os.environ['ROLLBACK_OPERATIONS_IMAGE']),
]:
    path = Path(filename)
    config = yaml.safe_load(path.read_text())
    config['services'][name].update(image=image, pull_policy='never')
    path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
PY
cd /root/sub2api-deploy
docker compose up -d --no-deps --wait --wait-timeout 180 sub2api
cd /root/sub2api-extra
docker compose --env-file compose.services.env up -d --no-deps --wait --wait-timeout 180 operations-center
```

新增计费 Schema 留在数据库中，程序回滚不会删除它。若原作者迁移导致旧二进制不兼容，数据库恢复需要另行评估；恢复备份会丢失备份之后的新交易，不能在已经恢复接单后直接覆盖数据库。回滚旧二进制后本次计费保护停止生效。

回滚使用本地固定镜像及 never 策略；下次正式升级时重复第 1、3 步切回更新通道，再按第 4 步启动。
