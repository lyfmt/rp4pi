import assert from "node:assert/strict";
import test from "node:test";

import { createInitialState, parseState } from "../../src/state/schema.ts";
import { formatStatus } from "../../src/state/status.ts";

test("parseState hydrates legacy saves with empty facts and relationships", () => {
  const state = parseState({
    player: { name: "Ari", status: "Ready", location: "Gate" },
    time: { day: 1, hour: 8 },
    scene: { summary: "Opening." },
    attributes: {}
  });

  assert.deepEqual(state.facts, []);
  assert.deepEqual(state.relationships, []);
});

test("formatStatus includes facts and relationships when present", () => {
  const state = createInitialState({
    player: { name: "Ari", status: "Ready", location: "Gate" },
    time: { day: 1, hour: 8 },
    scene: { summary: "Opening." }
  });
  state.facts.push({
    id: "fact.letter",
    kind: "quest",
    subject: "letter",
    text: "Ari carries an undelivered letter.",
    visibility: "public",
    source: "test"
  });
  state.relationships.push({
    source: "player",
    target: "npc.han-yue",
    stance: "trusted",
    summary: "韩越 trusts Ari.",
    evidence: "Ari helped him leave the gate.",
    visibility: "gm"
  });

  assert.equal(
    formatStatus(state),
    [
      "玩家：Ari",
      "状态：Ready",
      "地点：Gate",
      "时间：第 1 天 08:00",
      "场景：Opening.",
      "事实：",
      "- [quest] Ari carries an undelivered letter.",
      "关系：",
      "- player -> npc.han-yue：trusted；韩越 trusts Ari."
    ].join("\n")
  );
});
