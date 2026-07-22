import { deliverWhenIdle, runtimeMessageToOutbound } from "../runtime/idle-delivery.ts";
import { createHookNoticeMessage } from "../runtime/prose-message.ts";
import { createTextComponent } from "../runtime/tui-text-component.ts";
import type { ExtensionContextLike, PiLike } from "../types/pi.ts";
import type { HookDelivery } from "./engine.ts";
import { queueActiveHookPrompt, queuePendingHookPrompt } from "./pending-prompts.ts";

// The seam between the pure hook engine and pi's real delivery channels. The
// engine calls `delivery.prompt` / `delivery.notice`; this builds those two
// callbacks for a given anchor:
//   - prompt  → staged in the pending-prompts buckets, spliced into GM context
//               by core.ts's `context` handler (never a real message send, so it
//               cannot re-trigger the turn).
//   - notice  → a player-facing styled message, delivered idle exactly like the
//               writer-prose / OV-error notices so it does not re-trigger the GM
//               loop either.
// `target` selects which prompt bucket the anchor writes to: `session_start` /
// `turn_start` fire before the turn and want THIS turn (`active`); `turn_committed`
// fires after and wants the NEXT turn (`pending`).

export type HookPromptTarget = "active" | "pending";

export function createHookDelivery(input: {
  ctx: ExtensionContextLike;
  sendMessage: PiLike["sendMessage"];
  target: HookPromptTarget;
  setTimeoutFn?: (callback: () => void, delayMs: number) => void;
}): HookDelivery {
  const { ctx, sendMessage, target, setTimeoutFn } = input;
  return {
    prompt: (text) => {
      if (target === "active") {
        queueActiveHookPrompt(text);
      } else {
        queuePendingHookPrompt(text);
      }
    },
    notice: (text) => {
      void deliverWhenIdle({
        ctx,
        sendMessage,
        message: runtimeMessageToOutbound(createHookNoticeMessage(HOOK_NOTICE_SOURCE, text)),
        setTimeoutFn
      }).catch((error: unknown) => {
        console.error(`[hook_delivery] ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  };
}

/** Marker recorded on a hook notice message; the engine's `notice(text)` carries
 * no hook name, so a single stable source tags every hook-emitted notice. */
export const HOOK_NOTICE_SOURCE = "hook";

/** Register the player-facing renderer for hook notices (inject `as: notice`).
 * Owned here since the `hook-notice` custom type is entirely this axis's. */
export function registerHookNoticeRenderer(pi: PiLike): void {
  pi.registerMessageRenderer?.("hook-notice", (message) => createTextComponent(readNoticeText(message)));
}

function readNoticeText(message: unknown): string {
  if (typeof message === "object" && message !== null && !Array.isArray(message)) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
  }
  return "";
}
