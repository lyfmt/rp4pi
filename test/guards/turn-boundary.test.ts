import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { registerAllTools } from "../../src/tools/registry.ts";
import type { ToolDefinition } from "../../src/types/pi.ts";

test("commit_turn advances state without owning presentation handoff", () => {
  const registered: ToolDefinition[] = [];
  registerAllTools(
    { registerTool: (tool: ToolDefinition) => registered.push(tool) } as never,
    undefined,
    undefined,
    { include: ["core.state"], extra: [] }
  );

  const commit = registered.find((tool) => tool.name === "commit_turn");
  assert.ok(commit);
  assert.deepEqual(Object.keys((commit.parameters.properties as Record<string, unknown>) ?? {}), ["operations"]);
  assert.doesNotMatch(JSON.stringify(commit.parameters), /direction|events|summary/);

  const submit = registered.find((tool) => tool.name === "submit_direction_packet");
  assert.ok(submit);
});

test("active GM guidance separates core updates, System commits, and presentation handoff", () => {
  const guidanceFiles = [
    "worlds/border-station/prompts/gm-tools.md",
    "worlds/border-station/prompts/gm-output.md",
    "worlds/_template/prompts/gm.md",
    "skills/start-game/SKILL.md",
    "skills/build-rp-agent/SKILL.md",
    "skills/build-rp-agent/references/build-flow.md",
    "skills/development-guide/references/world-pack.md",
    "docs/demo.md"
  ];

  for (const path of guidanceFiles) {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    assert.match(
      source,
      /(?:Core|core|固定核心)[\s\S]{0,180}update_/,
      `${path}: scope update_* to core state`
    );
    assert.match(
      source,
      /(?:System|system)[\s\S]{0,180}commit_turn|commit_turn[\s\S]{0,180}(?:System|system)/,
      `${path}: route System state through commit_turn`
    );
    assert.doesNotMatch(
      source,
      /等待新的扩展能力设计|后续 runtime 提供/,
      `${path}: remove stale future-capability guidance`
    );
  }
});
