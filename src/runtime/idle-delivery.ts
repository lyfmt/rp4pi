import type { ExtensionContextLike, OutboundCustomMessage, PiLike } from "../types/pi.ts";
import type { RuntimeMessage } from "./prose-message.ts";

// Delivering a custom message while the agent loop is still streaming
// re-triggers it (the injected message is picked up as a follow-up), which is
// the "GM keeps working after the writer output" bug. So we only deliver once
// the agent is idle. No isIdle() in the context (tests/headless) → deliver
// immediately. Shared by every extension that injects prose on agent_end.
const IDLE_POLL_INTERVAL_MS = 25;
const IDLE_POLL_MAX_ATTEMPTS = 400;

export type DeliverWhenIdleInput = {
  ctx: ExtensionContextLike;
  sendMessage: PiLike["sendMessage"];
  message: OutboundCustomMessage;
  setTimeoutFn?: (callback: () => void, delayMs: number) => void;
  maxAttempts?: number;
};

export type StoryDeliveryFailureReason = "SESSION_STALE" | "IDLE_TIMEOUT" | "SEND_FAILED";

export class StoryDeliveryError extends Error {
  readonly reason: StoryDeliveryFailureReason;

  constructor(reason: StoryDeliveryFailureReason, options?: ErrorOptions) {
    super(`Story delivery failed [${reason}]`, options);
    this.name = "StoryDeliveryError";
    this.reason = reason;
  }
}

export function deliverWhenIdle(input: DeliverWhenIdleInput): Promise<void> {
  const { ctx, sendMessage, message } = input;
  const maxAttempts = input.maxAttempts ?? IDLE_POLL_MAX_ATTEMPTS;
  const schedule = input.setTimeoutFn ?? ((callback, delayMs) => void setTimeout(callback, delayMs));

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const fail = (reason: StoryDeliveryFailureReason, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      reject(new StoryDeliveryError(reason, cause === undefined ? undefined : { cause }));
    };

    const poll = (attempt: number): void => {
      if (settled) return;
      let idle: boolean;
      try {
        idle = typeof ctx.isIdle !== "function" || ctx.isIdle();
      } catch (cause) {
        fail("SESSION_STALE", cause);
        return;
      }

      if (idle) {
        try {
          sendMessage(message, { triggerTurn: false });
          settled = true;
          resolve();
        } catch (cause) {
          fail("SEND_FAILED", cause);
        }
        return;
      }

      if (attempt >= maxAttempts) {
        fail("IDLE_TIMEOUT");
        return;
      }
      try {
        schedule(() => poll(attempt + 1), IDLE_POLL_INTERVAL_MS);
      } catch (cause) {
        fail("IDLE_TIMEOUT", cause);
      }
    };

    poll(0);
  });
}

// Map our internal RuntimeMessage onto the pi custom-message wire shape. The
// writer-prose entry carries the rendered prose under details.prose; every
// other source forwards its data verbatim under a `kind`-tagged details object.
export function runtimeMessageToOutbound(message: RuntimeMessage): OutboundCustomMessage {
  const source = message.source ?? "writer-prose";
  return {
    customType: source,
    content: typeof message.content === "string" ? message.content : "",
    display: true,
    details:
      source === "writer-prose"
        ? { kind: "rendered", prose: (message.data as { prose?: string })?.prose }
        : { kind: source, ...(message.data ?? {}) }
  };
}
