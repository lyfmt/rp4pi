import assert from "node:assert/strict";
import test from "node:test";

import {
  activeHookPrompts,
  beginTurnPrompts,
  hookPromptMessage,
  queueActiveHookPrompt,
  queuePendingHookPrompt,
  resetHookPromptsForTest
} from "../../src/hooks/pending-prompts.ts";
import { createHookDelivery, registerHookNoticeRenderer } from "../../src/hooks/wiring.ts";
import type { ExtensionContextLike, OutboundCustomMessage } from "../../src/types/pi.ts";

function idleCtx(): ExtensionContextLike {
  return { sessionManager: { getSessionId: () => "s1" }, isIdle: () => true };
}

test("active prompts are appended in this turn and survive repeated reads", () => {
  resetHookPromptsForTest();
  queueActiveHookPrompt("雾未散");
  queueActiveHookPrompt("远处有马蹄声");
  assert.deepEqual([...activeHookPrompts()], ["雾未散", "远处有马蹄声"]);
  // Read again: not drained, so multiple context builds in one turn all see them.
  assert.deepEqual([...activeHookPrompts()], ["雾未散", "远处有马蹄声"]);
});

test("beginTurnPrompts expires active guidance and promotes pending to active", () => {
  resetHookPromptsForTest();
  queueActiveHookPrompt("本回合提示");
  queuePendingHookPrompt("下回合提示");
  // Still this turn: only active is visible.
  assert.deepEqual([...activeHookPrompts()], ["本回合提示"]);
  // Turn boundary: active expires, pending is promoted.
  beginTurnPrompts();
  assert.deepEqual([...activeHookPrompts()], ["下回合提示"]);
  // Next boundary with nothing pending clears everything.
  beginTurnPrompts();
  assert.deepEqual([...activeHookPrompts()], []);
});

test("hookPromptMessage frames guidance as a user-role message", () => {
  assert.deepEqual(hookPromptMessage("提示文本"), { role: "user", content: "提示文本" });
});

test("createHookDelivery routes prompts to the requested bucket", () => {
  resetHookPromptsForTest();
  const active = createHookDelivery({ ctx: idleCtx(), sendMessage: () => {}, target: "active" });
  const pending = createHookDelivery({ ctx: idleCtx(), sendMessage: () => {}, target: "pending" });
  active.prompt("现在");
  pending.prompt("稍后");
  // active shows now; pending only after a rotation.
  assert.deepEqual([...activeHookPrompts()], ["现在"]);
  beginTurnPrompts();
  assert.deepEqual([...activeHookPrompts()], ["稍后"]);
});

test("createHookDelivery notice sends an idle hook-notice message", () => {
  resetHookPromptsForTest();
  const sent: Array<{ message: OutboundCustomMessage; options?: unknown }> = [];
  const delivery = createHookDelivery({
    ctx: idleCtx(),
    sendMessage: (message, options) => sent.push({ message, options }),
    target: "active"
  });
  delivery.notice("夜深了");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, "hook-notice");
  assert.equal(sent[0].message.content, "夜深了");
  assert.deepEqual(sent[0].options, { triggerTurn: false });
});

test("registerHookNoticeRenderer renders the notice text", () => {
  let rendered: unknown;
  registerHookNoticeRenderer({
    on() {},
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    registerMessageRenderer(customType, renderer) {
      if (customType === "hook-notice") {
        rendered = renderer({ content: "夜深了", details: { kind: "hook" } }, {});
      }
    }
  });
  assert.equal(typeof (rendered as { render?: unknown })?.render, "function");
  assert.deepEqual((rendered as { render(width: number): string[] }).render(80), ["夜深了"]);
});
