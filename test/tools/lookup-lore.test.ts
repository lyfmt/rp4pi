import assert from "node:assert/strict";
import test from "node:test";

import { parseLoreEntries } from "../../src/lore/schema.ts";
import { importWorldLore } from "../../src/lore/importer.ts";
import { replaceWorldLore } from "../../src/lore/sqlite.ts";
import { initializeSchema, openRpDatabase } from "../../src/state/sqlite.ts";
import { createStateStore } from "../../src/state/store.ts";
import { lookupLoreTool } from "../../src/tools/lookup/lookup-lore.ts";
import { readLoreTool } from "../../src/tools/lookup/read-lore.ts";
import { resultText, type ToolResult } from "../../src/tools/runtime/result.ts";
import { registerAllTools } from "../../src/tools/registry.ts";
import { loadWorldFromDir } from "../../src/world/loader.ts";

const repoRoot = new URL("../../", import.meta.url).pathname;

test("lookup searches fixed lore for the active world", () => {
  const harness = withLoreHarness();
  try {
    const result = lookupLoreTool.execute(
      "c1",
      { query: "聚灵丹 炼气", kind: "medicine", limit: 5 },
      undefined,
      undefined,
      harness.ctx as never
    ) as ToolResult;

    assert.match(resultText(result), /聚气丹/);
    assert.equal((result.details.results as Array<{ id: string }>)[0]?.id, "medicine.gathering-qi-pill");
  } finally {
    harness.cleanup();
  }
});

test("lookup rejects an unknown kind with the available kinds instead of a false negative", () => {
  const harness = withLoreHarness();
  try {
    const result = lookupLoreTool.execute(
      "c1",
      { query: "聚灵丹", kind: "medcine" },
      undefined,
      undefined,
      harness.ctx as never
    ) as ToolResult;

    const text = resultText(result);
    assert.match(text, /未知资料类型 kind="medcine"/);
    assert.match(text, /medicine/);
    assert.doesNotMatch(text, /没有找到固定资料/);
    assert.deepEqual(result.details.results, []);
  } finally {
    harness.cleanup();
  }
});

test("read_lore returns full fixed lore by id", () => {
  const harness = withLoreHarness();
  try {
    const result = readLoreTool.execute("c1", { id: "medicine.gathering-qi-pill" }, undefined, undefined, harness.ctx as never) as ToolResult;

    assert.match(resultText(result), /适合炼气初中期。/);
    assert.match(resultText(result), /grade: 一阶/);
    assert.match(resultText(result), /usable_by -> rank\.qi-refining/);
  } finally {
    harness.cleanup();
  }
});

test("world tools declaration can include core.lookup", () => {
  const harness = withLoreHarness();
  try {
    const registeredTools: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];
    registerAllTools(
      { on() {}, registerTool: (tool) => registeredTools.push(tool as (typeof registeredTools)[number]), registerCommand() {}, sendMessage() {} },
      harness.ctx,
      undefined,
      { include: ["core.lookup"] }
    );

    assert.ok(registeredTools.some((tool) => tool.name === "lookup"));
    assert.ok(registeredTools.some((tool) => tool.name === "read_lore"));
  } finally {
    harness.cleanup();
  }
});

test("border-station lore can be looked up", () => {
  const db = openRpDatabase(":memory:");
  try {
    initializeSchema(db);
    const world = loadWorldFromDir(`${repoRoot}/worlds/border-station`);
    importWorldLore(db, world);
    const ctx = { db, stateStore: createStateStore(db), worldName: world.name };

    const result = lookupLoreTool.execute("c1", { query: "韩越 受伤信使" }, undefined, undefined, ctx as never) as ToolResult;

    assert.match(resultText(result), /韩越/);
  } finally {
    db.close();
  }
});

function withLoreHarness() {
  const db = openRpDatabase(":memory:");
  initializeSchema(db);
  replaceWorldLore(
    db,
    "cultivation",
    [],
    parseLoreEntries([
      {
        id: "medicine.gathering-qi-pill",
        kind: "medicine",
        subtype: "pill",
        name: "聚气丹",
        aliases: ["聚灵丹"],
        summary: "辅助炼气修士聚拢灵气。",
        body: "适合炼气初中期。",
        tags: ["丹药", "炼气"],
        fields: { grade: "一阶" },
        relations: [{ type: "usable_by", target: "rank.qi-refining" }]
      }
    ])
  );
  return {
    ctx: { db, stateStore: createStateStore(db), worldName: "cultivation" },
    cleanup: () => db.close()
  };
}
