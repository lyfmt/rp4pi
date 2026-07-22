import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const proseMessage = await import(pathToFileURL(new URL("../../src/runtime/prose-message.ts", import.meta.url).pathname).href);
const contextFilter = await import(pathToFileURL(new URL("../../src/runtime/context-filter.ts", import.meta.url).pathname).href);

const createWriterProseMessage =
  proseMessage.createWriterProseMessage as typeof import("../../src/runtime/prose-message.js").createWriterProseMessage;
const isWriterProseMessage =
  proseMessage.isWriterProseMessage as typeof import("../../src/runtime/prose-message.js").isWriterProseMessage;
const filterGmContextMessages =
  contextFilter.filterGmContextMessages as typeof import("../../src/runtime/context-filter.js").filterGmContextMessages;

test("writer prose custom message can be identified", () => {
  const message = createWriterProseMessage("The courier coughs.");

  assert.equal(isWriterProseMessage(message), true);
  assert.equal(isWriterProseMessage({ role: "assistant", content: "plain text" }), false);
});

test("GM context filter removes writer prose custom messages only", () => {
  const writerProse = createWriterProseMessage("Rendered prose.");
  const directReply = { role: "assistant", content: "Direct GM reply." };
  const plainAssistant = { role: "assistant", content: "Plain assistant text." };
  const user = { role: "user", content: "Look around." };

  assert.deepEqual(filterGmContextMessages([user, writerProse, directReply, plainAssistant]), [
    user,
    directReply,
    plainAssistant
  ]);
});
