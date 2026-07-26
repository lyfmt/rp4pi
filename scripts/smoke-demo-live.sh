#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."

source ./scripts/load-env.sh

echo "RUN OpenViking health check"
ov_url="$(node --input-type=module -e 'import { readOpenVikingConfig } from "./src/ov/config.ts"; console.log(readOpenVikingConfig().baseUrl);')"
if ! curl -fsS "$ov_url/health" >/dev/null; then
  echo "SKIP live OpenViking smoke: health check unavailable at $ov_url/health"
  exit 0
fi
echo "PASS OpenViking health check"

echo "RUN OpenViking append+commit smoke"
node --input-type=module <<'NODE'
import { createOpenVikingClient } from "./src/ov/client.ts";
import { readOpenVikingConfig } from "./src/ov/config.ts";
import { appendTurnToMemory } from "./src/ov/turn-memory-hook.ts";
import { createSave } from "./src/state/save-repository.ts";
import { initializeSchema, openRpDatabase } from "./src/state/sqlite.ts";
import { getOrCreateOvSessionForSave } from "./src/ov/session-binding.ts";
import { userSpaceForSave } from "./src/ov/uri.ts";

const db = openRpDatabase(":memory:");
initializeSchema(db);
const save = createSave(db);
const client = createOpenVikingClient({ ...readOpenVikingConfig(), user: "rp-agent-smoke" });

await appendTurnToMemory({
  db,
  saveId: save.id,
  playerInput: "请把以下成功故事事实写入长期记忆：角色林澈是旧钟楼守夜人；林澈把刻有旧钟楼徽记的银色钥匙交给我；北门已经打开。",
  writerProse: "林澈把银色钥匙压进你的掌心，钥匙柄上刻着旧钟楼徽记。他低声确认北门已经开启，并请你记住这份托付。",
  client
});
const sessionId = getOrCreateOvSessionForSave(db, save.id);

const config = readOpenVikingConfig();
const baseUrl = config.baseUrl.replace(/\/+$/, "");
const taskHeaders = {
  "X-API-Key": config.apiKey,
  "X-OpenViking-Account": config.account,
  "X-OpenViking-User": userSpaceForSave(save.id)
};

// glm 级推理模型做记忆提取动辄 2~5 分钟（含上游 503 重试），120s 窗口会把
// "仍在运行" 误判成失败；默认放宽到 6 分钟，可用 RP_OV_SMOKE_TIMEOUT_SECONDS 覆盖。
const maxAttempts = Number(process.env.RP_OV_SMOKE_TIMEOUT_SECONDS ?? 360);
let task;
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
  const response = await fetch(
    `${baseUrl}/api/v1/tasks?task_type=session_commit&resource_id=${encodeURIComponent(sessionId)}&limit=1`,
    {
      headers: taskHeaders
    }
  );
  const payload = await response.json();
  if (!response.ok || payload.status === "error") {
    throw new Error(`OpenViking task list failed: ${JSON.stringify(payload)}`);
  }

  task = payload.result?.[0];
  if (task?.status === "completed" || task?.status === "failed") {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

if (!task?.task_id) {
  throw new Error(`OpenViking did not create a commit task for ${sessionId}`);
}

{
  const response = await fetch(`${baseUrl}/api/v1/tasks/${encodeURIComponent(task.task_id)}`, {
    headers: taskHeaders
  });
  const payload = await response.json();
  if (!response.ok || payload.status === "error") {
    throw new Error(`OpenViking task poll failed: ${JSON.stringify(payload)}`);
  }

  task = payload.result;
}

if (!task || task.status !== "completed") {
  throw new Error(`OpenViking memory task did not complete: ${JSON.stringify(task)}`);
}

const extracted = task.result?.memories_extracted ?? {};
const rpMemoryCount =
  Number(extracted.characters ?? 0) +
  Number(extracted.story_events ?? 0) +
  Number(extracted.entities ?? 0) +
  Number(extracted.events ?? 0) +
  Number(extracted.memory_write ?? 0);
if (rpMemoryCount <= 0) {
  throw new Error(`OpenViking did not extract RP memories: ${JSON.stringify(task.result)}`);
}
db.close();
NODE
echo "PASS OpenViking append+commit memory smoke"
