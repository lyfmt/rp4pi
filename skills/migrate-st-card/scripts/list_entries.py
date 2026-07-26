#!/usr/bin/env python3
"""列出角色卡 / 世界书 JSON 中所有世界书条目的概览。

收编自 tavern2agent（https://github.com/Xerxes-2/tavern2agent，MIT License，
见同目录 LICENSE.tavern2agent）。收编时上游 commit：
cbef6af4fb7c034028a3e070b8bc1466da7e9d76。
需要 Python >= 3.10（使用了 `str | None` 等语法）。

收编后修复/增强（相对上游）：
  - `character_book` 为 null 不再崩溃，视为无世界书；
  - 同时支持两种输入并归一化为统一形态：
      嵌入卡 JSON（`character_book.entries` 数组，字段 keys/enabled）
      ST 独立世界书 JSON（`entries` 为 uid 键控 dict，字段 key/disable）。

Usage:
    python3 list_entries.py card.json                  # 列出所有条目
    python3 list_entries.py worldbook.json             # ST 独立世界书同样可用
    python3 list_entries.py card.json --filter mvu     # 只看 MVU 条目
    python3 list_entries.py card.json --filter mvu_update  # 只看 [mvu_update]
    python3 list_entries.py card.json --filter initvar     # 只看 [initvar]
    python3 list_entries.py card.json --search 战斗      # 搜索含关键词的条目
"""

import sys

if sys.version_info < (3, 10):
    sys.exit("list_entries.py 需要 Python >= 3.10（当前 %d.%d）" % sys.version_info[:2])

import json

# --filter 支持的合法值
_VALID_FILTERS = ("mvu", "mvu_plot", "mvu_update", "initvar")


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


def list_entries(card: dict, filter_tag: str | None = None, search: str | None = None):
    entries = load_entries(card)
    print(f"共 {len(entries)} 条世界书条目\n")

    shown = 0
    for i, entry in enumerate(entries):
        comment = entry.get("comment", "") or "(无注释)"
        keys = entry.get("keys", []) or []
        content = entry.get("content", "") or ""
        content_preview = content[:80].replace("\n", " ").replace("\r", "") if content else "(空)"

        # 提取标签
        comment_lower = comment.lower()

        # 过滤（合法值已在 main 校验，未知值不会走到这里）
        if filter_tag:
            if filter_tag == "mvu":
                if "[mvu" not in comment_lower:
                    continue
            elif f"[{filter_tag}]" not in comment_lower:
                continue

        if search:
            combined = comment + " ".join(keys) + content[:200]
            if search.lower() not in combined.lower():
                continue

        # 标记类型
        tags = []
        if "[mvu_plot]" in comment_lower:
            tags.append("📖plot")
        elif "[mvu_update]" in comment_lower:
            tags.append("📝update")
        if "[initvar]" in comment_lower:
            tags.append("🔰initvar")
        if "[mvu" in comment_lower:
            pass  # already tagged
        if entry.get("constant"):
            tags.append("🔒常驻")
        if entry.get("selective"):
            tags.append("⚡选择性")
        if not entry.get("enabled", True):
            tags.append("❌禁用")

        tag_str = " ".join(tags) + " " if tags else ""

        print(f"[{i:3d}] {tag_str}{comment}")
        if keys:
            print(f"      触发词: {', '.join(keys[:6])}")
        print(f"      内容: {content_preview}")
        print()
        shown += 1

    print(f"\n显示 {shown} / {len(entries)} 条")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    card_path = sys.argv[1]

    with open(card_path, "r", encoding="utf-8") as f:
        card = json.load(f)

    filter_tag = None
    search = None

    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == "--filter" and i + 1 < len(args):
            filter_tag = args[i + 1]
            i += 2
        elif args[i] == "--search" and i + 1 < len(args):
            search = args[i + 1]
            i += 2
        else:
            print(f"未知参数: {args[i]}")
            sys.exit(1)

    if filter_tag is not None and filter_tag not in _VALID_FILTERS:
        sys.exit(
            f"未知的 --filter 值: {filter_tag}（合法值: {', '.join(_VALID_FILTERS)}）"
        )

    list_entries(card, filter_tag, search)


if __name__ == "__main__":
    main()
