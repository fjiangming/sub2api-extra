# Scripts

sub2api-extra 辅助脚本集合。

---

## build_import_payload.py

将目录下的 token JSON 文件批量转换为 sub2api 导入格式（`DataImportRequest`）。

### 适用场景

- 批量注册后产出的 token 文件需要导入 sub2api
- 从其他系统迁移账号到 sub2api

### 输入格式

每个 JSON 文件可以是**单个对象**或**对象数组**，典型结构如下：

```json
{
  "id_token": "eyJ...",
  "access_token": "eyJ...",
  "refresh_token": "rt_...",
  "account_id": "e777d1ca-...",
  "email": "user@example.com",
  "type": "codex",
  "expired": "2026-04-30T09:15:13+08:00"
}
```

### 输出格式

生成符合 sub2api `ImportData` API 的 JSON 文件：

```json
{
  "type": "sub2api-data",
  "version": 1,
  "exported_at": "2026-04-25T05:00:00Z",
  "proxies": [],
  "accounts": [
    {
      "name": "user@example.com",
      "platform": "openai",
      "type": "oauth",
      "credentials": { "..." : "..." },
      "concurrency": 10,
      "priority": 50,
      "group_name": "MyGroup"
    }
  ]
}
```

### 用法

```bash
# 基本用法：扫描指定目录下所有 .json 文件
python scripts/build_import_payload.py -i ./tokens

# 指定输出文件
python scripts/build_import_payload.py -i ./tokens -o my_import.json

# 递归扫描子目录
python scripts/build_import_payload.py -i ./tokens --recursive

# 只匹配特定模式
python scripts/build_import_payload.py -i ./tokens --include "token_*.json"

# 自定义分组名 (导出到 JSON 供后端处理)
python scripts/build_import_payload.py -i ./tokens --group "vip-group"

# 自定义并发数和优先级
python scripts/build_import_payload.py -i ./tokens --concurrency 5 --priority 100
```

### 参数说明

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-i, --input` | `.` | 输入目录 |
| `-o, --output` | `sub2api_import.json` | 输出文件路径 |
| `--include` | `*.json` | 文件名匹配模式 |
| `--exclude` | `sub2api_import*.json` | 排除模式（可多次使用） |
| `--recursive` | `false` | 是否递归扫描子目录 |
| `--platform` | `openai` | 账号平台（`openai` / `anthropic` / `gemini`） |
| `--account-type` | `oauth` | 账号类型（`oauth` / `setup-token` / `apikey` / `upstream`） |
| `--concurrency` | `10` | 账号并发数 |
| `--priority` | `50` | 账号优先级 |
| `--group` | `(空)` | 自定义分组名 (导出到 JSON `group_name` 字段) |

### 账号命名规则

按以下优先级自动提取账号名：

1. JSON 中的 `email` 字段
2. JSON 中的 `account_id` 字段
3. 文件名（不含扩展名）

重名自动追加序号（如 `user@example.com-2`）。
