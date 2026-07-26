import assert from "node:assert/strict";
import test from "node:test";

import { submitDirectionPacketTool } from "../../src/tools/state/submit-direction-packet.ts";
import { resultText, type ToolResult } from "../../src/tools/runtime/result.ts";

// schema 只强制 needsRender：storyElements / directReply 属于二选一分支，
// 把三个都设 required 会逼模型为不用的分支编造注定被丢弃的内容（或被
// pi 的 required 校验拒绝而空转重试）。
test("submit_direction_packet only requires needsRender", () => {
  assert.deepEqual(submitDirectionPacketTool.parameters.required, ["needsRender"]);
});

test("direct reply turn submits without storyElements", () => {
  const result = submitDirectionPacketTool.execute("c1", { needsRender: false, directReply: "好的，就这样。" }, undefined, undefined, undefined as never) as ToolResult;

  assert.match(resultText(result), /direct reply/);
  const packet = result.details.packet as { needsRender: boolean; directReply: string };
  assert.equal(packet.needsRender, false);
  assert.equal(packet.directReply, "好的，就这样。");
});

test("render turn submits without directReply", () => {
  const result = submitDirectionPacketTool.execute(
    "c1",
    {
      needsRender: true,
      storyElements: {
        currentSituation: "驿站前院，晨雾未散。",
        playerIntent: "玩家上前询问信使。",
        visibleChanges: ["信使抬起了头"],
        presentCharacters: ["韩越"],
        characterActions: [{ name: "韩越", action: "低声报出接头暗语。" }],
        tension: "密信仍未拆封。"
      }
    },
    undefined,
    undefined,
    undefined as never
  ) as ToolResult;

  assert.match(resultText(result), /writer render/);
  const packet = result.details.packet as { needsRender: boolean; storyElements: { currentSituation: string } };
  assert.equal(packet.needsRender, true);
  assert.equal(packet.storyElements.currentSituation, "驿站前院，晨雾未散。");
});
