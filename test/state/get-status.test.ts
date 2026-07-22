import assert from "node:assert/strict";
import test from "node:test";

import { createInitialState } from "../../src/state/schema.ts";
import { createSave } from "../../src/state/save-repository.ts";
import { initializeSchema, openRpDatabase } from "../../src/state/sqlite.ts";
import { createStateStore } from "../../src/state/store.ts";
import { getStatusTool } from "../../src/tools/state/get-status.ts";
import { resultText, type ToolResult } from "../../src/tools/runtime/result.ts";
import { registerAllTools } from "../../src/tools/registry.ts";

test("get_status returns current GM brief", async () => {
  const harness = withActiveState();
  try {
    const result = await getStatusTool.execute(
      "c1",
      {},
      undefined,
      undefined,
      harness.ctx as never
    ) as ToolResult;

    assert.match(resultText(result), /玩家：Ari/);
    assert.match(resultText(result), /地点：Gate/);
  } finally {
    harness.cleanup();
  }
});

test("get_status requests GM projections and exposes only their public values", async () => {
  const harness = withActiveState();
  let projectionRequest: unknown;

  try {
    const projections = [
      { system: "progression", revision: 3, value: { level: 2, xp: 75 } }
    ];
    const systemRuntime = {
      activateSave: () => ({ saveId: harness.saveId, revision: 3, branchEpoch: 0 }),
      commit: async () => {
        throw new Error("not used");
      },
      project: async (request: unknown) => {
        projectionRequest = request;
        return projections;
      }
    };

    const result = await getStatusTool.execute(
      "c1",
      {},
      undefined,
      undefined,
      { ...harness.ctx, systemRuntime } as never
    ) as ToolResult;

    assert.deepEqual(projectionRequest, {
      saveId: harness.saveId,
      audience: { kind: "gm" }
    });
    assert.match(resultText(result), /玩家：Ari/);
    assert.match(resultText(result), /系统状态：/);
    assert.match(resultText(result), /progression \(revision 3\): \{"level":2,"xp":75\}/);
    assert.deepEqual(result.details, { projections });
    assert.doesNotMatch(JSON.stringify(result.details), /payload_json/);
  } finally {
    harness.cleanup();
  }
});

test("core.state registers get_status", () => {
  const harness = withActiveState();
  try {
    const registeredTools: Array<{ name: string }> = [];
    registerAllTools(
      { on() {}, registerTool: (tool) => registeredTools.push(tool), registerCommand() {}, sendMessage() {} },
      harness.ctx,
      undefined,
      { include: ["core.state"] }
    );
    assert.ok(registeredTools.some((tool) => tool.name === "get_status"));
  } finally {
    harness.cleanup();
  }
});

function withActiveState() {
  const db = openRpDatabase(":memory:");
  initializeSchema(db);
  const stateStore = createStateStore(db);
  const save = createSave(db);
  stateStore.replaceState(
    save.id,
    createInitialState({
      player: { name: "Ari", status: "Ready", location: "Gate" },
      scene: { summary: "Opening." }
    })
  );
  return {
    ctx: { db, stateStore },
    saveId: save.id,
    cleanup: () => db.close()
  };
}
