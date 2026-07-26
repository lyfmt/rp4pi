#!/usr/bin/env python3
"""再生本目录下的合成 ST 角色卡 / 世界书 fixture。

全部内容为本仓库自制的合成测试数据，不来自任何真实角色卡。
输出（写到脚本所在目录）：
  sample-card-v2.png        — V2 卡，tEXt `chara` 块内嵌 base64 JSON，含世界书 3 条（1 条禁用）
  sample-card-v2.webp       — 同一张卡，RIFF/WEBP EXIF 块内嵌 `chara\\x00` + base64
  sample-card-v2-mid-exif.webp — 同一张卡，但 EXIF 块不在末尾，后面紧跟
                              fourcc 属 base64 字符集的 ICCP 块（回归扫描吞尾缺陷）
  card-nullbook.json        — `character_book` 为 null 的 V2 JSON 卡
  worldbook-standalone.json — ST 独立世界书导出（entries 为 uid 键控 dict，字段 key/disable）

需要 Python >= 3.10，零外部依赖。

Usage:
    python3 make_fixtures.py
"""

import sys

if sys.version_info < (3, 10):
    sys.exit("make_fixtures.py 需要 Python >= 3.10（当前 %d.%d）" % sys.version_info[:2])

import base64
import json
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent


# ─── 合成卡内容 ─────────────────────────────────────────────────

CHARACTER_BOOK = {
    "name": "雾杉镇世界书",
    "entries": [
        {
            "keys": ["雾杉镇", "小镇"],
            "secondary_keys": [],
            "comment": "地点·雾杉镇",
            "content": "雾杉镇常年被雾气笼罩，镇口有一棵三人合抱的老杉树，镇民迷路时靠敲树上的铜铃辨向。",
            "enabled": True,
            "constant": True,
            "selective": False,
            "insertion_order": 0,
        },
        {
            "keys": ["断雨", "佩剑"],
            "secondary_keys": ["临风"],
            "comment": "物品·断雨",
            "content": "临风的佩剑名为断雨，剑身有一道旧裂纹，是她师父留下的遗物，从不离身。",
            "enabled": True,
            "constant": False,
            "selective": True,
            "insertion_order": 1,
        },
        {
            "keys": ["旧档案"],
            "secondary_keys": [],
            "comment": "草稿·旧档案",
            "content": "（作者草稿，尚未启用）镇长的密室里藏着二十年前的旧档案，记录了老杉树下埋过什么。",
            "enabled": False,
            "constant": False,
            "selective": False,
            "insertion_order": 2,
        },
    ],
}

SAMPLE_CARD = {
    "spec": "chara_card_v2",
    "spec_version": "2.0",
    "data": {
        "name": "临风",
        "description": "临风是雾杉镇的年轻守剑人，寡言，习惯用行动代替解释。",
        "personality": "冷静、重诺、不擅寒暄。",
        "scenario": "深秋的雾杉镇，镇口的雾比往年更浓，传闻雾里有人影徘徊。",
        "first_mes": "临风抱剑立在老杉树下，看见你走近，只是微微颔首。「雾大，跟紧我。」",
        "mes_example": "",
        "alternate_greetings": [
            "雨夜，临风替你撑着伞站在客栈门口。「镇长有请。别问，去了就知道。」",
            "临风蹲在河滩边擦拭断雨，头也不抬。「你来晚了，雾里的东西已经走了。」",
        ],
        "creator_notes": "合成测试卡：仅用于本仓库迁移工具链测试，无真实来源。",
        "system_prompt": "",
        "post_history_instructions": "",
        "tags": ["测试", "合成"],
        "creator": "my-rp-agent fixtures",
        "character_version": "1.0",
        "extensions": {},
        "character_book": CHARACTER_BOOK,
    },
}

NULLBOOK_CARD = {
    "spec": "chara_card_v2",
    "spec_version": "2.0",
    "data": {
        "name": "无书者",
        "description": "一张 character_book 为 null 的合成测试卡，用于验证提取脚本不崩溃。",
        "personality": "",
        "scenario": "",
        "first_mes": "……",
        "mes_example": "",
        "alternate_greetings": [],
        "creator_notes": "合成测试卡。",
        "tags": ["测试"],
        "creator": "my-rp-agent fixtures",
        "character_version": "1.0",
        "extensions": {},
        "character_book": None,
    },
}

# ST 独立世界书导出形态：entries 为 uid 键控 dict，字段 key/keysecondary/disable
STANDALONE_WORLDBOOK = {
    "entries": {
        "0": {
            "uid": 0,
            "key": ["灯塔", "海岬"],
            "keysecondary": [],
            "comment": "地点·白鲸灯塔",
            "content": "白鲸灯塔立在海岬尽头，灯已熄了七年，塔身的白漆被海风剥得斑驳。",
            "constant": True,
            "selective": False,
            "order": 100,
            "position": 0,
            "disable": False,
        },
        "1": {
            "uid": 1,
            "key": ["守灯人"],
            "keysecondary": ["老周"],
            "comment": "人物·守灯人",
            "content": "最后一任守灯人姓周，七年前某个起雾的夜晚之后，再没有人见过他。",
            "constant": False,
            "selective": True,
            "order": 90,
            "position": 1,
            "disable": False,
        },
        "2": {
            "uid": 2,
            "key": ["海雾"],
            "keysecondary": [],
            "comment": "草稿·海雾异象",
            "content": "（未启用草稿）起雾的夜里，灯塔顶层偶尔会亮起绿光，没人承认见过。",
            "constant": False,
            "selective": False,
            "order": 80,
            "position": 1,
            "disable": True,
        },
    },
}


# ─── PNG 组装 ───────────────────────────────────────────────────

def _png_chunk(ctype: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + ctype
        + data
        + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)
    )


def make_png(card: dict) -> bytes:
    """1x1 像素合法 PNG + tEXt `chara` 块（ST PNG 卡的标准嵌入方式）。"""
    b64 = base64.b64encode(json.dumps(card, ensure_ascii=False).encode("utf-8"))
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)  # 1x1, 8bit, truecolor
    idat = zlib.compress(b"\x00\x88\x99\xaa")  # filter 0 + 一个 RGB 像素
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"tEXt", b"chara\x00" + b64)
        + _png_chunk(b"IDAT", idat)
        + _png_chunk(b"IEND", b"")
    )


# ─── WEBP 组装 ──────────────────────────────────────────────────

def _riff_chunk(fourcc: bytes, data: bytes) -> bytes:
    pad = b"\x00" if len(data) % 2 else b""
    return fourcc + struct.pack("<I", len(data)) + data + pad


def make_webp(card: dict) -> bytes:
    """RIFF/WEBP 容器，EXIF 块内放 `chara\\x00` + base64（ST WEBP 卡的常见嵌入方式）。

    VP8 载荷为占位字节——提取脚本只认 RIFF/WEBP magic 与 chara marker，
    fixture 不需要能被图像解码器渲染。EXIF 置于末块，是最简单的布局；
    EXIF 后紧跟其他 chunk 的布局见 make_webp_mid_exif。
    """
    b64 = base64.b64encode(json.dumps(card, ensure_ascii=False).encode("utf-8"))
    chunks = _riff_chunk(b"VP8 ", b"\x00" * 32) + _riff_chunk(b"EXIF", b"chara\x00" + b64)
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WEBP" + chunks


def make_webp_mid_exif(card: dict) -> bytes:
    """EXIF 块不在末尾的 WEBP：其后紧跟 fourcc 属 base64 字符集的 ICCP 块。

    回归提取脚本的扫描吞尾缺陷——base64 连续段会把紧随其后的 `ICCP` 四个
    字节一并吞入，解出尾部垃圾导致 JSON 解析失败。为保证缺陷可被复现，
    JSON 载荷补空白到 3 的倍数使 base64 无 `=` 补齐（Python 的宽松解码
    遇到 `=` 会忽略其后字节，带补齐时吞尾不触发缺陷）；json.loads 会忽略
    尾随空白，载荷语义不变。
    """
    payload = json.dumps(card, ensure_ascii=False).encode("utf-8")
    payload += b" " * (-len(payload) % 3)  # 使 base64 无 padding
    b64 = base64.b64encode(payload)
    chunks = (
        _riff_chunk(b"VP8 ", b"\x00" * 32)
        + _riff_chunk(b"EXIF", b"chara\x00" + b64)
        + _riff_chunk(b"ICCP", b"\x00" * 16)
    )
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WEBP" + chunks


# ─── 入口 ───────────────────────────────────────────────────────

def main():
    (OUT_DIR / "sample-card-v2.png").write_bytes(make_png(SAMPLE_CARD))
    (OUT_DIR / "sample-card-v2.webp").write_bytes(make_webp(SAMPLE_CARD))
    (OUT_DIR / "sample-card-v2-mid-exif.webp").write_bytes(make_webp_mid_exif(SAMPLE_CARD))
    (OUT_DIR / "card-nullbook.json").write_text(
        json.dumps(NULLBOOK_CARD, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (OUT_DIR / "worldbook-standalone.json").write_text(
        json.dumps(STANDALONE_WORLDBOOK, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("fixtures written to", OUT_DIR)


if __name__ == "__main__":
    main()
