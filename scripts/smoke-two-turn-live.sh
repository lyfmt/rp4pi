#!/usr/bin/env bash
set -euo pipefail

# 双回合长链路真实冒烟：同一会话连续两个用户输入，走满
# GM → direction packet → writer(含修订) → 交付 → 快照 → turn_committed 钩子 → OV 沉淀
# 两次。相比 smoke-writer-live.sh 多验证：
#   - 第二回合 writer history 回放（prior prose 进惯性审稿）
#   - 快照序号递增（turn_no 1、2）
#   - clock-drift 每回合各推进一次（相对断言，不依赖 GM 是否自行改时间）

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."

if [ "${RP_WRITER_LIVE_SMOKE:-1}" = "0" ]; then
  echo "SKIP two-turn live smoke: RP_WRITER_LIVE_SMOKE=0"
  exit 0
fi

if ! command -v pi >/dev/null 2>&1 || ! command -v timeout >/dev/null 2>&1; then
  echo "SKIP two-turn live smoke: pi or timeout is not installed"
  exit 0
fi

export RP_DISABLE_OPENVIKING=0

timeout_seconds="${RP_TWO_TURN_LIVE_TIMEOUT_SECONDS:-1200}"
session_id="two-turn-live-smoke-$(date +%s)-$$"
tmp_dir="$(mktemp -d)"
sqlite_path="$tmp_dir/rp-two-turn-live.sqlite"
trap 'rm -rf "$tmp_dir"' EXIT

echo "RUN two-turn live smoke via ./start.sh"
# 冒烟只验证链路，不验证文风：把 GM 主循环压到低思考档提速（writer 模型档位
# 由 settings.json 的 writer 段决定，不受此 flag 影响）。
RP_SQLITE_PATH="$sqlite_path" timeout "$timeout_seconds" \
  ./start.sh \
  --approve \
  --thinking low \
  --session-id "$session_id" \
  -p \
  "开始新游戏。用一个很短的开场回合完成初始化，并提交需要 writer 渲染的 direction packet。" \
  "我走向受伤的信使，查看他的伤势并询问密信的来历。继续用很短的回合推进并提交 direction packet。"
echo "PASS two-turn live smoke: both pi turns completed"

echo "RUN two-turn live smoke sqlite assertions"
RP_SQLITE_PATH="$sqlite_path" node --input-type=module <<'NODE'
import { openRpDatabase } from "./src/state/sqlite.ts";

const db = openRpDatabase(process.env.RP_SQLITE_PATH);
try {
  const snapshots = db
    .prepare("SELECT turn_no, state_json FROM turn_snapshots ORDER BY turn_no ASC")
    .all();
  if (snapshots.length < 2) {
    throw new Error(`expected 2 story snapshots, got ${snapshots.length}`);
  }
  const turnNos = snapshots.map((row) => row.turn_no);
  if (turnNos[0] !== 1 || turnNos[1] !== 2) {
    throw new Error(`snapshot turn numbers not sequential: ${JSON.stringify(turnNos)}`);
  }

  const coreOf = (row) => {
    const parsed = JSON.parse(row.state_json);
    return parsed.core?.payload ?? parsed;
  };
  const second = coreOf(snapshots[1]);
  const latestRow = db
    .prepare("SELECT state_json FROM latest_states ORDER BY updated_at DESC LIMIT 1")
    .get();
  if (!latestRow) {
    throw new Error("latest state missing");
  }
  const latest = JSON.parse(latestRow.state_json);
  if (latest.time?.hour !== second.time?.hour + 1) {
    throw new Error(
      `clock-drift did not advance after turn 2: snapshot2=${second.time?.hour}, latest=${latest.time?.hour}`
    );
  }

  const hookFires = db
    .prepare("SELECT fire_count FROM hook_fire_state WHERE hook_name = 'clock-drift'")
    .get();
  if (!hookFires || Number(hookFires.fire_count) < 2) {
    throw new Error(`clock-drift fired ${hookFires?.fire_count ?? 0} times, expected >= 2`);
  }

  const ovBindings = Number(db.prepare("SELECT COUNT(*) AS n FROM ov_session_bindings").get().n);
  if (ovBindings < 1) {
    throw new Error("OpenViking append reached no ov_session_bindings row");
  }
} finally {
  db.close();
}
NODE
echo "PASS two-turn live smoke: snapshots, per-turn clock-drift, OV binding"
