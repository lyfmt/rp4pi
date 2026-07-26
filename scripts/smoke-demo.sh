#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."

echo "RUN npm run typecheck"
npm run typecheck

# 按世界冒烟(RP_WORLD=<slug> bash scripts/smoke-demo.sh)时,RP_WORLD 只应作用于
# 下方的扩展启动冒烟与 live 冒烟;单测是 world 无关的,且部分用例断言 RP_WORLD
# 未设时的自动选择行为,泄入会必挂(loader.test.ts 的世界选择用例)。
echo "RUN npm test"
env -u RP_WORLD npm test

if [ ! -x ./start.sh ]; then
  echo "FAIL start.sh is not executable" >&2
  exit 1
fi
echo "PASS start.sh is executable"

echo "RUN extension startup smoke"
startup_tmp_dir="$(mktemp -d)"
if startup_output="$(
  RP_DISABLE_OPENVIKING=1 \
    RP_SQLITE_PATH="$startup_tmp_dir/runtime.sqlite" \
    ./start.sh --mode rpc --offline --no-session --no-extensions </dev/null 2>&1
)"; then
  rm -rf "$startup_tmp_dir"
else
  startup_status=$?
  rm -rf "$startup_tmp_dir"
  printf '%s\n' "$startup_output" >&2
  echo "FAIL extensions did not load through start.sh" >&2
  exit "$startup_status"
fi
echo "PASS extensions load through start.sh"

bash ./scripts/smoke-demo-live.sh
