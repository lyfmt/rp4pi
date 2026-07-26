#!/usr/bin/env python3
"""获取角色卡 / 世界书 JSON 中特定世界书条目的完整内容。

收编自 tavern2agent（https://github.com/Xerxes-2/tavern2agent，MIT License，
见同目录 LICENSE.tavern2agent）。收编时上游 commit：
cbef6af4fb7c034028a3e070b8bc1466da7e9d76。
需要 Python >= 3.10（使用了 `list[int]`、`dict | None` 等语法）。

收编后修复/增强（相对上游）：
  - `character_book` 为 null 不再崩溃，视为无世界书；
  - 同时支持两种输入并归一化为统一形态：
      嵌入卡 JSON（`character_book.entries` 数组，字段 keys/enabled）
      ST 独立世界书 JSON（`entries` 为 uid 键控 dict，字段 key/disable）。

Usage:
    python3 get_entry.py card.json 0           # 查看第 0 条
    python3 get_entry.py card.json 0,3,5       # 查看第 0, 3, 5 条
    python3 get_entry.py card.json 0-5         # 查看第 0 到 5 条
    python3 get_entry.py card.json 0,3-5,8     # 混合
"""

import sys

if sys.version_info < (3, 10):
    sys.exit("get_entry.py 需要 Python >= 3.10（当前 %d.%d）" % sys.version_info[:2])

import json


def _normalize_entry(entry: dict) -> dict:
    """把 ST 独立世界书条目字段归一化为嵌入卡（V2）形态。

    补齐 keys / secondary_keys / enabled 三个统一字段；原始字段保留不动，
    嵌入卡条目原样通过（不回归）。
    """
    out = dict(entry)
    if "keys" not in out and isinstance(out.get("key"), list):
        out["keys"] = out["key"]
    if "secondary_keys" not in out and isinstance(out.get("keysecondary"), list):
        out["secondary_keys"] = out["keysecondary"]
    if "enabled" not in out and "disable" in out:
        out["enabled"] = not out["disable"]
    return out


def load_entries(card: dict) -> list[dict]:
    """从卡 JSON 或 ST 独立世界书 JSON 中取出归一化的条目列表。

    - 嵌入卡：`data.character_book.entries` 为数组；
    - `character_book` 为 null / 缺失：若顶层自带 `entries`，视为独立世界书；
    - 独立世界书：`entries` 为 uid 键控 dict，按 uid 数值排序保证索引稳定。
    """
    data = card.get("data") if isinstance(card.get("data"), dict) else card
    book = data.get("character_book")
    if not isinstance(book, dict):
        book = data if book is None and "entries" in data else {}

    raw = book.get("entries")
    if isinstance(raw, dict):
        def _uid_order(item):
            try:
                return (0, int(item[0]))
            except (TypeError, ValueError):
                return (1, str(item[0]))
        raw = [value for _, value in sorted(raw.items(), key=_uid_order)]
    if not isinstance(raw, list):
        return []
    return [_normalize_entry(entry) for entry in raw if isinstance(entry, dict)]


def parse_indices(raw: str, total: int) -> list[int]:
    indices = []
    for part in raw.split(","):
        part = part.strip()
        try:
            if "-" in part:
                start, end = part.split("-", 1)
                indices.extend(range(int(start), int(end) + 1))
            else:
                indices.append(int(part))
        except ValueError:
            sys.exit(
                f"无效的索引格式: '{part}'（支持单个索引 0、逗号列表 0,3,5、"
                f"区间 0-5 及其混合，如 0,3-5,8）"
            )
    return [i for i in indices if 0 <= i < total]


def show_entry(entry: dict):
    for key, value in entry.items():
        if key == "content":
            content = str(value) if value else "(空)"
            print(f"  {key} ({len(content)} 字符):")
            print(f"  {'─' * 40}")
            print(content)
            print(f"  {'─' * 40}")
        elif key == "extensions":
            if value:
                print(f"  {key}: {json.dumps(value, ensure_ascii=False, indent=4)}")
            else:
                print(f"  {key}: (空)")
        else:
            print(f"  {key}: {json.dumps(value, ensure_ascii=False)}")
    print()


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    card_path = sys.argv[1]
    index_spec = sys.argv[2]

    with open(card_path, "r", encoding="utf-8") as f:
        card = json.load(f)

    entries = load_entries(card)
    total = len(entries)

    indices = parse_indices(index_spec, total)
    if not indices:
        print(f"无效索引，共 {total} 条 (0-{total - 1})")
        sys.exit(1)

    print(f"共 {total} 条，显示 {len(indices)} 条\n")
    for i in indices:
        print(f"=== [{i}] {entries[i].get('comment', '(无注释)')} ===")
        show_entry(entries[i])


if __name__ == "__main__":
    main()
