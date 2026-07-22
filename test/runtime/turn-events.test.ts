import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pathToFileURL } from "node:url";

type TurnEventsModule = typeof import("../../src/runtime/turn-events.js");

function turnEventsUrl(instance: string): string {
  return `${pathToFileURL(new URL("../../src/runtime/turn-events.ts", import.meta.url).pathname).href}?instance=${instance}`;
}

test("turn rendered listeners are shared across separately loaded module instances", async () => {
  const subscriber = await import(turnEventsUrl(randomUUID())) as TurnEventsModule;
  const publisher = await import(turnEventsUrl(randomUUID())) as TurnEventsModule;

  subscriber.resetTurnListenersForTest();
  publisher.resetTurnListenersForTest();

  let seen = 0;
  const unsubscribe = subscriber.onTurnRendered(async (event) => {
    seen += 1;
    assert.equal(event.saveId, "save-1");
    assert.equal(event.playerInput, "开始游戏");
    assert.equal(event.prose, "rendered prose");
  });

  try {
    await publisher.emitTurnRendered({
      ctx: { sessionManager: { getSessionId: () => "session-1" } },
      saveId: "save-1",
      playerInput: "开始游戏",
      prose: "rendered prose"
    });

    assert.equal(seen, 1);
  } finally {
    unsubscribe();
    subscriber.resetTurnListenersForTest();
    publisher.resetTurnListenersForTest();
  }
});
