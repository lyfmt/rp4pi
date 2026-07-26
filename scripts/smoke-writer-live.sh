#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."

settings_path=".pi/agent/settings.json"
prompt_path=".pi/agents/writer.md"

if [ "${RP_WRITER_LIVE_SMOKE:-1}" = "0" ]; then
  echo "SKIP live writer smoke: RP_WRITER_LIVE_SMOKE=0"
  exit 0
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "SKIP live writer smoke: pi is not installed"
  exit 0
fi

if ! command -v timeout >/dev/null 2>&1; then
  echo "SKIP live writer smoke: timeout is not installed"
  exit 0
fi

if [ ! -f "$settings_path" ]; then
  echo "SKIP live writer smoke: $settings_path is missing"
  exit 0
fi

if [ ! -f "$prompt_path" ]; then
  echo "SKIP live writer smoke: $prompt_path is missing"
  exit 0
fi

# 本 smoke 断言的就是 OpenViking append 链路：.env 默认 RP_DISABLE_OPENVIKING=1
# 会让 openviking-memory 扩展在 activate 时直接 no-op，ov_session_bindings 断言
# 必然失败。configured-client 只在该值恰为 "1" 时禁用，且 load-env.sh 对已导出的
# 环境变量让位，所以这里显式 export 即可覆盖 .env。binding 行由 appendTurnToMemory
# 在发起任何 OV 网络请求之前写入本地 SQLite（server 不可达时链路降级为提示消息），
# 因此该断言不要求 OpenViking server 在线。
export RP_DISABLE_OPENVIKING=0

timeout_seconds="${RP_WRITER_LIVE_TIMEOUT_SECONDS:-300}"
session_id="writer-live-smoke-$(date +%s)-$$"
prompt="${RP_WRITER_LIVE_PROMPT:-开始新游戏。用一个很短的开场回合完成初始化，并提交需要 writer 渲染的 direction packet。}"
tmp_dir="$(mktemp -d)"
sqlite_path="$tmp_dir/rp-writer-live.sqlite"
trap 'rm -rf "$tmp_dir"' EXIT

echo "RUN live writer smoke via ./start.sh using current main model settings"
RP_SQLITE_PATH="$sqlite_path" timeout "$timeout_seconds" \
  ./start.sh \
  --approve \
  --session-id "$session_id" \
  -p "$prompt"
echo "PASS live writer smoke: real pi turn completed"

echo "RUN live writer smoke sqlite assertions"
RP_SQLITE_PATH="$sqlite_path" node --input-type=module <<'NODE'
import { openRpDatabase } from "./src/state/sqlite.ts";

const db = openRpDatabase(process.env.RP_SQLITE_PATH);
try {
  const hookFireState = Number(db.prepare("SELECT COUNT(*) AS n FROM hook_fire_state").get().n);
  const ovBindings = Number(db.prepare("SELECT COUNT(*) AS n FROM ov_session_bindings").get().n);
  const snapshotRow = db
    .prepare("SELECT state_json FROM turn_snapshots ORDER BY created_at DESC LIMIT 1")
    .get();
  const latestRow = db
    .prepare("SELECT state_json FROM latest_states ORDER BY updated_at DESC LIMIT 1")
    .get();

  if (!snapshotRow || !latestRow) {
    throw new Error("live writer smoke did not persist a snapshot and latest state");
  }
  if (hookFireState < 1) {
    throw new Error("clock-drift did not fire: hook_fire_state is empty");
  }
  if (ovBindings < 1) {
    throw new Error("OpenViking append reached no ov_session_bindings row");
  }

  // turn_snapshots 存的是 story-snapshot envelope（{core:{payload},systems,...}），
  // 核心状态在 core.payload 里；latest_states 才是扁平核心状态。
  const snapshot = JSON.parse(snapshotRow.state_json);
  const snapshotCore = snapshot.core?.payload ?? snapshot;
  const latest = JSON.parse(latestRow.state_json);
  if (latest.time?.hour !== snapshotCore.time?.hour + 1) {
    throw new Error(`clock-drift did not advance latest state: snapshot=${snapshotCore.time?.hour}, latest=${latest.time?.hour}`);
  }
} finally {
  db.close();
}
NODE
echo "PASS live writer smoke: clock-drift and OpenViking append reached"
