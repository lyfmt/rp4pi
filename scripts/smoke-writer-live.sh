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

timeout_seconds="${RP_WRITER_LIVE_TIMEOUT_SECONDS:-300}"
session_id="writer-live-smoke-$(date +%s)-$$"
prompt="${RP_WRITER_LIVE_PROMPT:-开始新游戏，使用默认 demo 世界。用一个很短的开场回合完成初始化，并提交需要 writer 渲染的 direction packet。}"
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

  const snapshot = JSON.parse(snapshotRow.state_json);
  const latest = JSON.parse(latestRow.state_json);
  if (latest.time?.hour !== snapshot.time?.hour + 1) {
    throw new Error(`clock-drift did not advance latest state: snapshot=${snapshot.time?.hour}, latest=${latest.time?.hour}`);
  }
} finally {
  db.close();
}
NODE
echo "PASS live writer smoke: clock-drift and OpenViking append reached"
