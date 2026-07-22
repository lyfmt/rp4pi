import assert from "node:assert/strict";
import test from "node:test";

import {
  forgeCharacterTool,
  parseForgeInput,
  renderNpcProse
} from "../../worlds/border-station/subagents/npc-generator/index.ts";
import type { ExtensionContextLike } from "../../src/types/pi.ts";

const ctx = {} as unknown as ExtensionContextLike;

// Restore any env this file mutates so it can't leak into sibling tests.
function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const keys = Object.keys(overrides);
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    return out instanceof Promise ? out.finally(restore) : (restore(), out);
  } catch (error) {
    restore();
    throw error;
  }
}

test("parseForgeInput trims fields and treats last_seen as optional", () => {
  assert.deepEqual(parseForgeInput({ name: " 林澈 ", summary: " 旧钟楼守夜人 " }), {
    name: "林澈",
    summary: "旧钟楼守夜人",
    lastSeen: undefined
  });
  assert.deepEqual(parseForgeInput({ name: "林澈", summary: "守夜人", last_seen: " 驿站大厅 " }), {
    name: "林澈",
    summary: "守夜人",
    lastSeen: "驿站大厅"
  });
});

test("parseForgeInput rejects malformed input", () => {
  assert.throws(() => parseForgeInput(null), /对象/);
  assert.throws(() => parseForgeInput("x"), /对象/);
  assert.throws(() => parseForgeInput({ summary: "no name" }), /name/);
  assert.throws(() => parseForgeInput({ name: "no summary" }), /summary/);
  assert.throws(() => parseForgeInput({ name: "  ", summary: "blank" }), /name/);
});

test("renderNpcProse names the character and appends last_seen when present", () => {
  assert.equal(renderNpcProse({ name: "林澈", summary: "旧钟楼守夜人" }), "林澈——旧钟楼守夜人");
  assert.equal(
    renderNpcProse({ name: "林澈", summary: "旧钟楼守夜人", lastSeen: "驿站大厅" }),
    "林澈——旧钟楼守夜人\n最近登场:驿站大厅"
  );
});

test("forge_character reports no active save when RP_ACTIVE_SAVE is unset", async () => {
  await withEnv({ RP_ACTIVE_SAVE: undefined }, async () => {
    const res = await forgeCharacterTool.execute("t", { name: "林澈", summary: "守夜人" }, undefined, undefined, ctx);
    assert.equal(res.details.persisted, false);
    assert.equal(res.details.reason, "no-active-save");
  });
});

test("forge_character reports no client when OpenViking is disabled", async () => {
  await withEnv({ RP_ACTIVE_SAVE: "save-1", RP_DISABLE_OPENVIKING: "1" }, async () => {
    const res = await forgeCharacterTool.execute("t", { name: "林澈", summary: "守夜人" }, undefined, undefined, ctx);
    assert.equal(res.details.persisted, false);
    assert.equal(res.details.reason, "no-ov-client");
  });
});
