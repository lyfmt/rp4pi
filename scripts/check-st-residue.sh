#!/usr/bin/env bash
set -euo pipefail

# ST 迁移残渣扫描:确认迁移产物里没有 SillyTavern 运行时语法残留。
# 用法: bash scripts/check-st-residue.sh <world-slug>
# 通过: 运行时文件零命中(迁移审计目录 worlds/<slug>/migration/ 除外)→ exit 0
# 失败: 打印命中 file:line → exit 1;参数/环境错误 → exit 2
#
# 之前这是 project-mapping.md 里两条手工 rg 长命令,依赖"rg 退出码 1 才算干净"
# 的反直觉语义;这里封装成正向 PASS/FAIL,残渣特征模式集中维护在本脚本。

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."

if [ $# -ne 1 ]; then
  echo "用法: bash scripts/check-st-residue.sh <world-slug>" >&2
  exit 2
fi
slug="$1"

if [ ! -d "worlds/$slug" ]; then
  echo "FAIL 世界不存在: worlds/$slug" >&2
  exit 2
fi

# 优先 ripgrep,没装则回退 grep -rE(排除任何 migration/ 目录,跳过二进制)。
if command -v rg >/dev/null 2>&1; then
  scanner="rg"
else
  scanner="grep"
fi

scan() {
  local pattern="$1"
  if [ "$scanner" = "rg" ]; then
    rg -n "$pattern" "${targets[@]}" --glob "!worlds/$slug/migration/**"
  else
    grep -rEnI --exclude-dir=migration -e "$pattern" "${targets[@]}"
  fi
}

# ST 运行时语法特征:变量指令/JSON Patch/EJS 模板标记/中文指令残片,以及
# {{user}} 一类的 ST 宏。语义规则应已映射进世界包模块,这些字面量不该留下。
patterns=(
  "UpdateVariable|JSON Patch|<%_|__结束__|强化思考要求"
  "\\{\\{(user|char|random|roll|pick|getvar|setvar)"
)

targets=("worlds/$slug" data skills/start-game)
status=0
for pattern in "${patterns[@]}"; do
  # rg/grep 退出码同义:0=有命中(即残渣) 1=零命中(干净) ≥2=执行错误。
  if hits="$(scan "$pattern" 2>&1)"; then
    echo "FAIL ST 残渣命中(模式: $pattern):"
    printf '%s\n' "$hits"
    status=1
  else
    rc=$?
    if [ "$rc" -ne 1 ]; then
      echo "FAIL 扫描器($scanner)执行出错(模式: $pattern):" >&2
      printf '%s\n' "$hits" >&2
      exit 2
    fi
  fi
done

if [ "$status" -eq 0 ]; then
  echo "PASS 无 ST 运行时残渣:${targets[*]}(已排除 worlds/$slug/migration/)"
fi
exit "$status"
