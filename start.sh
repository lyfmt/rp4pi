#!/usr/bin/env bash
set -euo pipefail

if ! command -v pi >/dev/null 2>&1; then
  echo "错误: pi 未安装，请先安装 pi coding agent" >&2
  exit 1
fi

cd "$(dirname "$(readlink -f "$0")")"

source ./scripts/load-env.sh

mkdir -p .pi/agent sessions

if [ ! -f .pi/agent/auth.json ]; then
  if [ -f "$HOME/.pi/agent/auth.json" ]; then
    cp "$HOME/.pi/agent/auth.json" .pi/agent/auth.json
  else
    echo "提示: 未发现已有 pi 认证，首次进入后请用 /login 登录"
  fi
fi

if [ ! -f .pi/agent/settings.json ]; then
  cp .pi/agent/settings.example.json .pi/agent/settings.json
fi

# 必须是绝对路径：pi-subagents 子进程 spawn 时 cwd 可能漂移，相对路径会解析到不存在的目录而丢失 auth/settings
export PI_CODING_AGENT_DIR="$PWD/.pi/agent"

pi \
  --no-skills \
  --skill ./skills/ \
  -e ./extensions/core.ts \
  -e ./extensions/two-pass-render/index.ts \
  -e ./extensions/openviking-memory/index.ts \
  --session-dir ./sessions \
  --no-context-files \
  "$@"
