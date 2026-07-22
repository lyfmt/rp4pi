#!/usr/bin/env bash
set -euo pipefail

if ! command -v pi >/dev/null 2>&1; then
  echo "错误: pi 未安装，请先安装 pi coding agent" >&2
  exit 1
fi

cd "$(dirname "$(readlink -f "$0")")"

source ./scripts/load-env.sh

mkdir -p .pi/agent sessions

if [ ! -f .pi/agent/auth.json ] && [ -f "$HOME/.pi/agent/auth.json" ]; then
  cp "$HOME/.pi/agent/auth.json" .pi/agent/auth.json
fi

if [ ! -f .pi/agent/settings.json ]; then
  cp .pi/agent/settings.example.json .pi/agent/settings.json
fi

export PI_CODING_AGENT_DIR=".pi/agent"

pi \
  --no-skills \
  --skill ./skills/ \
  -e ./extensions/core.ts \
  -e ./extensions/two-pass-render/index.ts \
  -e ./extensions/openviking-memory/index.ts \
  --session-dir ./sessions \
  --no-context-files \
  "$@"
