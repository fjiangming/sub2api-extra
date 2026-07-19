#!/usr/bin/env python3
"""
将目录下的 token JSON 文件批量转换为 sub2api 导入格式。

用法:
    python scripts/build_import_payload.py -i ./tokens -o import.json
    python scripts/build_import_payload.py -i ./tokens --platform openai --account-type oauth
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def load_records(path: Path) -> list[dict[str, Any]]:
    """读取单个 JSON 文件，统一返回记录列表。"""
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict):
        return [data]
    return []


def derive_name(cred: dict[str, Any], path: Path) -> str:
    """从 credentials 中提取账号名：优先 email → account_id → 文件名。"""
    email = str(cred.get("email", "")).strip()
    if email:
        return email
    account_id = str(cred.get("account_id", "")).strip()
    if account_id:
        return account_id
    return path.stem


def dedupe(name: str, seen: dict[str, int]) -> str:
    """对重复名称追加序号。"""
    count = seen.get(name, 0) + 1
    seen[name] = count
    return name if count == 1 else f"{name}-{count}"


def build_payload(
    input_dir: Path,
    output_file: Path,
    *,
    platform: str,
    account_type: str,
    concurrency: int,
    priority: int,
    recursive: bool,
    include: str,
    exclude: list[str],
    group_name: str,
) -> dict[str, Any]:
    """扫描目录，构建 sub2api DataImportRequest。"""
    glob_fn = input_dir.rglob if recursive else input_dir.glob
    files = sorted(f for f in glob_fn(include) if f.is_file())

    output_resolved = output_file.resolve()
    files = [
        f for f in files
        if f.resolve() != output_resolved
        and not any(f.name == pat or (pat.startswith("*") and f.name.endswith(pat[1:])) for pat in exclude)
    ]

    if not files:
        print("未找到匹配的 JSON 文件。", file=sys.stderr)
        sys.exit(1)

    accounts: list[dict[str, Any]] = []
    seen_names: dict[str, int] = {}

    for path in files:
        try:
            records = load_records(path)
        except (json.JSONDecodeError, OSError) as e:
            print(f"跳过 {path}: {e}", file=sys.stderr)
            continue

        for cred in records:
            name = dedupe(derive_name(cred, path), seen_names)
            account_data = {
                "name": name,
                "platform": platform,
                "type": account_type,
                "credentials": cred,
                "concurrency": concurrency,
                "priority": priority,
            }
            if group_name:
                account_data["group_name"] = group_name
            accounts.append(account_data)

    if not accounts:
        print("所有文件均无有效记录。", file=sys.stderr)
        sys.exit(1)

    return {
        "type": "sub2api-data",
        "version": 1,
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "proxies": [],
        "accounts": accounts,
    }


def main():
    parser = argparse.ArgumentParser(description="批量生成 sub2api 账号导入文件")
    parser.add_argument("-i", "--input", default=".", help="输入目录 (默认: 当前目录)")
    parser.add_argument("-o", "--output", default="sub2api_import.json", help="输出文件 (默认: sub2api_import.json)")
    parser.add_argument("--include", default="*.json", help="文件名匹配模式 (默认: *.json)")
    parser.add_argument("--exclude", action="append", default=["sub2api_import*.json"],
                        help="排除的文件名模式 (可多次使用)")
    parser.add_argument("--recursive", action="store_true", help="递归扫描子目录")
    parser.add_argument("--platform", default="openai", help="账号平台 (默认: openai)")
    parser.add_argument("--account-type", default="oauth", help="账号类型 (默认: oauth)")
    parser.add_argument("--concurrency", type=int, default=10, help="并发数 (默认: 10)")
    parser.add_argument("--priority", type=int, default=50, help="优先级 (默认: 50)")
    parser.add_argument("--group", type=str, default="", help="自定义分组名 (将一并导出到 JSON)")
    args = parser.parse_args()

    input_dir = Path(args.input).resolve()
    output_file = Path(args.output).resolve()

    if not input_dir.is_dir():
        print(f"输入目录不存在: {input_dir}", file=sys.stderr)
        sys.exit(1)

    payload = build_payload(
        input_dir,
        output_file,
        platform=args.platform,
        account_type=args.account_type,
        concurrency=args.concurrency,
        priority=args.priority,
        recursive=args.recursive,
        include=args.include,
        exclude=args.exclude,
        group_name=args.group,
    )

    with output_file.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    count = len(payload["accounts"])
    print(f"已生成 sub2api 导入文件: {output_file}")
    print(f"共 {count} 个账号, platform={args.platform}, type={args.account_type}")


if __name__ == "__main__":
    main()
