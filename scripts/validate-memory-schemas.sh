#!/usr/bin/env bash
set -euo pipefail

# 用本机 OpenViking 安装的 Python 校验世界包 memory schema 的 OV 侧形状:
# MemoryTypeRegistry 能否从 worlds/<slug>/memory 加载,且每个 schema 文件声明的
# memory_type 都注册成功。这是 OV 服务端真正执行的加载路径,比手抄 heredoc 可靠。
#
# 用法: bash scripts/validate-memory-schemas.sh [world-slug]
#   slug 缺省取 $RP_WORLD;两者都没有则报用法。
# 解释器:优先 $OPENVIKING_PYTHON;否则从 PATH 上的 openviking-server 同目录推导。
# 退出码:0=全部通过;1=schema 未注册/形状不符;2=用法或环境错误。

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."

slug="${1:-${RP_WORLD:-}}"
if [ -z "$slug" ]; then
  echo "用法: bash scripts/validate-memory-schemas.sh <world-slug>(或设 RP_WORLD)" >&2
  exit 2
fi

schema_dir="worlds/$slug/memory"
if [ ! -d "$schema_dir" ]; then
  echo "FAIL schema 目录不存在: $schema_dir" >&2
  exit 2
fi

python_bin="${OPENVIKING_PYTHON:-}"
if [ -z "$python_bin" ]; then
  if server_bin="$(command -v openviking-server 2>/dev/null)"; then
    python_bin="$(dirname "$server_bin")/python"
  fi
fi
if [ -z "$python_bin" ] || [ ! -x "$python_bin" ]; then
  echo "FAIL 找不到 OpenViking 的 Python:设 OPENVIKING_PYTHON=/path/to/openviking-venv/bin/python,或把 openviking-server 放上 PATH" >&2
  exit 2
fi

"$python_bin" - "$schema_dir" <<'PY'
import sys
from pathlib import Path

import yaml
from openviking.session.memory.memory_type_registry import MemoryTypeRegistry

schema_dir = Path(sys.argv[1])
registry = MemoryTypeRegistry(load_schemas=False)
loaded = registry.load_from_directory(str(schema_dir))
names = registry.list_names(include_disabled=True)
print(f"registry 加载 {schema_dir}: loaded={loaded}, names={names}")

problems = []
for schema_file in sorted(schema_dir.glob("*.yaml")):
    data = yaml.safe_load(schema_file.read_text(encoding="utf-8")) or {}
    memory_type = data.get("memory_type")
    if not memory_type:
        problems.append(f"{schema_file.name}: 缺 memory_type 字段(旧 shorthand 形状?见 openviking.md)")
    elif not registry.get(memory_type):
        problems.append(f"{schema_file.name}: memory_type '{memory_type}' 未被 registry 注册")

if problems:
    print("FAIL " + "; ".join(problems))
    sys.exit(1)
print(f"PASS {schema_dir} 的全部 schema 均可被本机 OV 注册")
PY
