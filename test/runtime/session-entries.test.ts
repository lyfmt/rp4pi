import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const sessionEntries = await import(
  pathToFileURL(new URL("../../src/runtime/session-entries.ts", import.meta.url).pathname).href
);

const findPendingDirectionPacket =
  sessionEntries.findPendingDirectionPacket as typeof import("../../src/runtime/session-entries.js").findPendingDirectionPacket;

const PACKET = { needsRender: true, directReply: "", storyElements: {} };

function submitEntry(packet: unknown, toolCallId: string): unknown {
  return {
    type: "message",
    message: { role: "toolResult", toolName: "submit_direction_packet", toolCallId, details: { packet } }
  };
}

function proseEntry(): unknown {
  return { type: "custom_message", customType: "writer-prose", content: "rendered prose" };
}

test("findPendingDirectionPacket returns the latest submitted packet and its tool call id", () => {
  const pending = findPendingDirectionPacket([
    { type: "message", message: { role: "user", content: "do something" } },
    submitEntry(PACKET, "call-1")
  ]);
  assert.deepEqual(pending, { packet: PACKET, toolCallId: "call-1" });
});

test("findPendingDirectionPacket treats a packet already followed by prose as not pending", () => {
  const pending = findPendingDirectionPacket([submitEntry(PACKET, "call-1"), proseEntry()]);
  assert.equal(pending, undefined);
});

test("findPendingDirectionPacket finds a fresh packet submitted after prior prose", () => {
  const pending = findPendingDirectionPacket([
    submitEntry(PACKET, "call-1"),
    proseEntry(),
    { type: "message", message: { role: "user", content: "next turn" } },
    submitEntry(PACKET, "call-2")
  ]);
  assert.deepEqual(pending, { packet: PACKET, toolCallId: "call-2" });
});

test("findPendingDirectionPacket ignores non-submit tool results", () => {
  const pending = findPendingDirectionPacket([
    { type: "message", message: { role: "toolResult", toolName: "update_scene", toolCallId: "c", details: {} } }
  ]);
  assert.equal(pending, undefined);
});

test("findPendingDirectionPacket returns undefined with no submit at all", () => {
  assert.equal(findPendingDirectionPacket([]), undefined);
  assert.equal(
    findPendingDirectionPacket([{ type: "message", message: { role: "user", content: "hi" } }]),
    undefined
  );
});
