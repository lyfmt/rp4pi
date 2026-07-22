import assert from "node:assert/strict";
import test from "node:test";

import {
  deliverWhenIdle,
  StoryDeliveryError,
  type StoryDeliveryFailureReason
} from "../../src/runtime/idle-delivery.ts";
import type { OutboundCustomMessage } from "../../src/types/pi.ts";

const message: OutboundCustomMessage = {
  customType: "writer-prose",
  content: "hello"
};

test("busy delivery stays pending until a later idle poll sends exactly once", async () => {
  let idle = false;
  let sends = 0;
  let settled = false;
  const timers: Array<() => void> = [];
  const delivery = deliverWhenIdle({
    ctx: { sessionManager: { getSessionId: () => "session-a" }, isIdle: () => idle },
    sendMessage() {
      sends += 1;
    },
    message,
    setTimeoutFn(callback) {
      timers.push(callback);
    }
  });
  void delivery.finally(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(sends, 0);
  assert.equal(timers.length, 1);

  idle = true;
  timers.shift()!();
  await delivery;
  assert.equal(sends, 1);
  assert.equal(settled, true);
});

test("delivery rejects with SESSION_STALE when the context can no longer be checked", async () => {
  await assertDeliveryFailure(
    deliverWhenIdle({
      ctx: {
        sessionManager: { getSessionId: () => "session-a" },
        isIdle() {
          throw new Error("stale context");
        }
      },
      sendMessage() {},
      message
    }),
    "SESSION_STALE"
  );
});

test("delivery rejects with IDLE_TIMEOUT after the configured poll limit", async () => {
  await assertDeliveryFailure(
    deliverWhenIdle({
      ctx: { sessionManager: { getSessionId: () => "session-a" }, isIdle: () => false },
      sendMessage() {},
      message,
      maxAttempts: 0
    }),
    "IDLE_TIMEOUT"
  );
});

test("delivery rejects with SEND_FAILED when Pi rejects the message", async () => {
  await assertDeliveryFailure(
    deliverWhenIdle({
      ctx: { sessionManager: { getSessionId: () => "session-a" }, isIdle: () => true },
      sendMessage() {
        throw new Error("send failed");
      },
      message
    }),
    "SEND_FAILED"
  );
});

async function assertDeliveryFailure(
  delivery: Promise<void>,
  reason: StoryDeliveryFailureReason
): Promise<void> {
  await assert.rejects(
    delivery,
    (error) => error instanceof StoryDeliveryError && error.reason === reason
  );
}
