#!/usr/bin/env python3
"""从 SillyTavern 角色卡中提取内置 JSON。

收编自 tavern2agent（https://github.com/Xerxes-2/tavern2agent，MIT License，
见同目录 LICENSE.tavern2agent）。收编时上游 commit：
cbef6af4fb7c034028a3e070b8bc1466da7e9d76。
需要 Python >= 3.10（使用了 `dict | None` 等语法）。

支持格式：
  PNG  — tEXt / iTXt / zTXt 块
  WEBP — RIFF / EXIF / XMP，未识别时回退到原始字节扫描
  JPEG — EXIF / XMP / COM 标记，未识别时回退到原始字节扫描
  JSON — 直接读取

支持卡片规范：V1（平铺）/ V2（chara_card_v2，data 嵌套）/ V3（chara_card_v3 / ccv3）。

零外部依赖。WEBP/JPEG 走原始字节扫描——SillyTavern 导出的卡片通常把
base64 编码的 JSON 塞在 EXIF UserComment 或 XMP 包里，扫 `chara\\x00`
或 `ccv3\\x00` 之类的 marker 直接拿到 base64 串就能解。

Usage:
    python3 extract_card.py <card_file> [output.json]
    python3 extract_card.py <card_file>          # 输出到 stdout
"""

import sys

if sys.version_info < (3, 10):
    sys.exit("extract_card.py 需要 Python >= 3.10（当前 %d.%d）" % sys.version_info[:2])

import base64
import json
import struct
import zlib
from pathlib import Path


# ─── PNG ────────────────────────────────────────────────────────

def _png_text_chunks(raw: bytes) -> dict[str, str]:
    """解析 PNG 的 tEXt / zTXt / iTXt 块，返回 keyword → value 映射。"""
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是合法的 PNG 文件")

    out: dict[str, str] = {}
    pos = 8
    while pos < len(raw):
        if pos + 8 > len(raw):
            break
        length = struct.unpack(">I", raw[pos:pos + 4])[0]
        chunk_type = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + length]
        pos += 8 + length + 4  # +4 for CRC

        try:
            if chunk_type == b"tEXt":
                keyword, _, value = data.partition(b"\x00")
                out[keyword.decode("latin-1")] = value.decode("latin-1")

            elif chunk_type == b"zTXt":
                keyword, _, rest = data.partition(b"\x00")
                comp_method = rest[0]
                if comp_method == 0:
                    value = zlib.decompress(rest[1:]).decode("latin-1")
                    out[keyword.decode("latin-1")] = value

            elif chunk_type == b"iTXt":
                keyword, _, rest = data.partition(b"\x00")
                comp_flag, comp_method = rest[0], rest[1]
                rest = rest[2:]
                _, _, rest = rest.partition(b"\x00")  # language tag
                _, _, payload = rest.partition(b"\x00")  # translated keyword
                if comp_flag and comp_method == 0:
                    value = zlib.decompress(payload).decode("utf-8")
                else:
                    value = payload.decode("utf-8")
                out[keyword.decode("utf-8")] = value

            elif chunk_type == b"IEND":
                break
        except Exception:
            continue

    return out


def _from_png(raw: bytes) -> dict:
    texts = _png_text_chunks(raw)
    for key in ("ccv3", "chara"):
        if key in texts:
            return json.loads(base64.b64decode(texts[key]))
    raise ValueError("PNG 中未找到 chara/ccv3 文本块")


# ─── 原始字节扫描（WEBP/JPEG 共用）─────────────────────────────

_B64_CHARS = set(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r ")


# base64 段尾部回退重试上限（4 字符/步）
_B64_TAIL_RETRY = 5


def _try_decode_card(b64: bytes) -> dict | None:
    """尝试把一段 base64 字节解码为卡片 JSON object，失败返回 None。

    段尾可能混入紧邻数据里恰好属于 base64 字母表的字节（如下一个 RIFF
    chunk 的 fourcc `ICCP` / `XMP `）：先截到 4 的倍数长度，解码或 JSON
    解析失败时从尾部按 4 字符步长回退重试（上限 `_B64_TAIL_RETRY` 步）。
    解码成功且 JSON 解析为 object 才算命中。
    """
    b64 = b64[: len(b64) - len(b64) % 4]
    for _ in range(_B64_TAIL_RETRY + 1):
        if len(b64) < 100:
            return None
        try:
            obj = json.loads(base64.b64decode(b64).decode("utf-8"))
        except Exception:
            obj = None
        if isinstance(obj, dict):
            return obj
        b64 = b64[:-4]
    return None


def _scan_for_card(raw: bytes) -> dict | None:
    """在原始字节里找 base64 编码的卡片 JSON。

    SillyTavern 导出 WEBP/JPEG 时通常把卡片 base64 后塞进 EXIF UserComment
    或 XMP 包，前缀类似 `chara\\x00` / `ccv3\\x00` / `chara:` / `ccv3:`。
    每个 marker 遍历其全部出现位置——第一处解码失败时继续尝试后面的出现，
    而不是直接放弃整个 marker。
    """
    for marker in (b"ccv3\x00", b"chara\x00", b"ccv3:", b"chara:"):
        idx = raw.find(marker)
        while idx >= 0:
            start = idx + len(marker)
            # 跳过空白
            while start < len(raw) and raw[start:start + 1] in (b"\x00", b" ", b"\t", b"\n", b"\r"):
                start += 1
            # 截 base64 区
            end = start
            while end < len(raw) and raw[end] in _B64_CHARS:
                end += 1
            b64 = bytes(c for c in raw[start:end] if c not in (ord(" "), ord("\n"), ord("\r")))
            if len(b64) >= 100:
                card = _try_decode_card(b64)
                if card is not None:
                    return card
            idx = raw.find(marker, idx + 1)

    # 退一步：找原始 JSON（非 base64 的卡也存在）
    for pattern in (b'"spec":"chara_card', b'"chara_card_v', b'"data":{"name"'):
        idx = raw.find(pattern)
        if idx < 0:
            continue
        brace = raw.rfind(b"{", max(0, idx - 500), idx)
        if brace < 0:
            continue
        text = raw[brace:].decode("utf-8", errors="replace")
        depth = 0
        for i, ch in enumerate(text):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[:i + 1])
                        if isinstance(obj, dict) and ("data" in obj or "name" in obj or "char_name" in obj):
                            return obj
                    except Exception:
                        pass
                    break
    return None


def _from_webp(raw: bytes) -> dict:
    if raw[:4] != b"RIFF" or raw[8:12] != b"WEBP":
        raise ValueError("不是合法的 WEBP 文件")
    card = _scan_for_card(raw)
    if card is None:
        raise ValueError("WEBP 中未找到角色卡数据（请用 PNG 版本，或确认这是 ST 导出的角色卡）")
    return card


def _from_jpeg(raw: bytes) -> dict:
    if raw[:2] != b"\xff\xd8":
        raise ValueError("不是合法的 JPEG 文件")
    card = _scan_for_card(raw)
    if card is None:
        raise ValueError("JPEG 中未找到角色卡数据（请用 PNG 版本，或确认这是 ST 导出的角色卡）")
    return card


# ─── JSON ───────────────────────────────────────────────────────

def _from_json(raw: bytes) -> dict:
    obj = json.loads(raw.decode("utf-8"))
    if not isinstance(obj, dict):
        raise ValueError("JSON 文件根节点不是 object")
    return obj


# ─── v1 归一化 ─────────────────────────────────────────────────

# 老 v1 字段名（TavernAI / 早期 ST）→ v2 schema 字段名
_V1_LEGACY_MAP = {
    "char_name": "name",
    "char_persona": "personality",
    "char_greeting": "first_mes",
    "world_scenario": "scenario",
    "example_dialogue": "mes_example",
}

# v1 卡可能直接在顶层用的字段（v1.5 起多用 v2 风格名）
_V1_FLAT_FIELDS = (
    "name", "description", "personality", "scenario",
    "first_mes", "mes_example", "creator_notes", "system_prompt",
    "post_history_instructions", "alternate_greetings", "tags", "creator",
    "character_version", "extensions", "character_book",
)


# 角色卡标志字段：ST 独立世界书顶层不会出现这些字段。
# 注意刻意不含 `name`——世界书导出也可能带顶层 name。
_CARD_MARKER_FIELDS = (
    "spec", "data", "first_mes", "char_greeting", "char_name",
    "description", "char_persona", "personality", "scenario", "mes_example",
)


def _looks_like_standalone_worldbook(card: dict) -> bool:
    """判断是否为 ST 独立世界书 JSON：顶层有 entries 且无任何角色卡标志字段。"""
    return "entries" in card and not any(f in card for f in _CARD_MARKER_FIELDS)


def _normalize_v1(card: dict) -> dict:
    """把 v1 平铺结构抬升为 v2 schema（`spec` + `data: {...}`）。

    检测条件：无 v2/v3 `spec` 字段。已是 v2/v3 的卡原样返回。
    ST 独立世界书 JSON 不是角色卡，归一化前直接报错（否则会静默产出
    空 data、丢掉全部条目）。
    """
    spec = card.get("spec", "")
    if spec in ("chara_card_v2", "chara_card_v3"):
        return card

    if _looks_like_standalone_worldbook(card):
        raise ValueError(
            "输入是 ST 独立世界书 JSON（顶层为 entries、无角色卡字段），不是角色卡；"
            "extract_card.py 只处理角色卡。请改用 list_entries.py / get_entry.py "
            "直接读取该世界书的条目。"
        )

    data: dict = {}
    # 1. 老字段名 → 新字段名
    for old, new in _V1_LEGACY_MAP.items():
        if old in card and new not in card:
            data[new] = card[old]
    # 2. v1.5 风格的平铺字段直接搬
    for field in _V1_FLAT_FIELDS:
        if field in card and field not in data:
            data[field] = card[field]
    # 3. 如果原卡已有 data 块（罕见的混合形态），合并
    if isinstance(card.get("data"), dict):
        for k, v in card["data"].items():
            data.setdefault(k, v)

    return {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": data,
        "_normalized_from_v1": True,  # 标记，便于下游/调试识别
    }


# ─── 入口 ───────────────────────────────────────────────────────

def extract_card(path: str) -> dict:
    """按文件扩展名分派；扩展名缺失或不匹配时按 magic bytes 兜底。

    v1 卡（平铺、无 spec 字段）自动归一化为 v2 schema，下游脚本/agent
    无需区分版本。归一化的卡带 `_normalized_from_v1: true` 标记。
    """
    raw = Path(path).read_bytes()
    ext = Path(path).suffix.lower()

    dispatch = {
        ".png": _from_png,
        ".webp": _from_webp,
        ".jpg": _from_jpeg,
        ".jpeg": _from_jpeg,
        ".json": _from_json,
    }
    if ext in dispatch:
        return _normalize_v1(dispatch[ext](raw))

    # 按 magic bytes 兜底
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return _normalize_v1(_from_png(raw))
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return _normalize_v1(_from_webp(raw))
    if raw[:2] == b"\xff\xd8":
        return _normalize_v1(_from_jpeg(raw))
    if raw.lstrip()[:1] == b"{":
        return _normalize_v1(_from_json(raw))
    raise ValueError(f"无法识别文件格式: {path}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    in_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        card = extract_card(in_path)
    except ValueError as e:
        sys.exit(f"错误: {e}")

    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(card, f, ensure_ascii=False, indent=2)
        print(f"Saved to {out_path}")
    else:
        print(json.dumps(card, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
