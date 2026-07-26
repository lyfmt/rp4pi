import { getRuntimeInfrastructure } from "../../src/runtime/bootstrap.ts";
import { findProjectRoot } from "../../src/runtime/paths.ts";
import { onTurnRendered } from "../../src/runtime/turn-events.ts";
import { drainStoryCommits } from "../../src/runtime/story-commit-tracker.ts";
import { emitLiveProgress } from "../../src/runtime/live-progress.ts";
import { deliverWhenIdle, runtimeMessageToOutbound } from "../../src/runtime/idle-delivery.ts";
import { createOpenVikingMemoryErrorMessage } from "../../src/runtime/prose-message.ts";
import { createTextComponent } from "../../src/runtime/tui-text-component.ts";
import { appendTurnToMemory } from "../../src/ov/turn-memory-hook.ts";
import type { PiLike } from "../../src/types/pi.ts";

// OpenViking long-term memory: an independent extension that appends each
// rendered turn to OV memory. It does NOT listen on pi's agent_end — the prose
// it needs only exists inside the render handler's scope, so it subscribes to
// the in-process turn-rendered event (turn-events.ts) that two-pass-render
// emits. This keeps the story commit authoritative: OV is eventual memory, so a
// failure here surfaces as a styled notice but never blocks or rolls back the
// turn. Disabling this extension (drop its `-e` flag) loses long-term memory
// while the rest of the game keeps working.
//
// It also registers the renderer for the openviking-memory-error custom type,
// since that message is owned entirely by this feature.
export function activate(pi: PiLike): void {
  const projectRoot = findProjectRoot(import.meta.url);
  const { db, ovClient, world } = getRuntimeInfrastructure(projectRoot);

  registerMemoryErrorRenderer(pi);

  // No OV client configured → nothing to append to. The renderer is still
  // registered (harmless) but we never subscribe, so no work happens per turn.
  if (!ovClient) {
    return;
  }

  // Memory policy comes from the active world: which memory types to extract,
  // and which built-in types to fall back to if OV hasn't loaded this world's
  // custom schemas. Previously these were hardcoded constants.
  const memoryPolicy = world.memory.policy;
  const fallbackMemoryPolicy = {
    self: world.memory.policy.self,
    peer: world.memory.policy.peer,
    memory_types: world.memory.fallbackMemoryTypes
  };

  const unsubscribe = onTurnRendered(async ({ ctx, saveId, playerInput, prose, progress }) => {
    if (playerInput === undefined) {
      return;
    }
    await emitLiveProgress(progress, { type: "stage_start", stage: "openviking", detail: "append_turn" });
    try {
      await appendTurnToMemory({
        db,
        client: ovClient,
        saveId,
        playerInput,
        writerProse: prose,
        memoryPolicy,
        fallbackMemoryPolicy
      });
      await emitLiveProgress(progress, { type: "stage_end", stage: "openviking", detail: "append_turn" });
    } catch (error) {
      await emitLiveProgress(progress, { type: "stage_error", stage: "openviking", error: error instanceof Error ? error.message : String(error) });
      // OpenViking is eventual long-term memory; the story commit already
      // succeeded. Surface the failure as a styled notice, delivered idle like
      // any other injected message so it does not re-trigger the agent loop.
      void deliverWhenIdle({
        ctx,
        sendMessage: (message, options) => pi.sendMessage(message, options),
        message: runtimeMessageToOutbound(createOpenVikingMemoryErrorMessage(saveId, error))
      }).catch((deliveryError: unknown) => {
        console.error(
          `[openviking_delivery] ${deliveryError instanceof Error ? deliveryError.message : String(deliveryError)}`
        );
      });
    }
  });
  pi.on("session_shutdown", async () => {
    // The final turn's memory append may still be in flight through the
    // turn-rendered bus — drain before unsubscribing (see story-commit-tracker).
    await drainStoryCommits();
    unsubscribe();
  });
}

export default activate;

function registerMemoryErrorRenderer(pi: PiLike): void {
  pi.registerMessageRenderer?.("openviking-memory-error", (message) => {
    const details = readDetails(message);
    return createTextComponent(
      [
        "⚠ OpenViking memory append failed",
        `save: ${readString(details.saveId)}`,
        `reason: ${readString(details.error) || readString((message as { content?: unknown }).content)}`
      ].join("\n")
    );
  });
}

function readDetails(message: unknown): Record<string, unknown> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return {};
  }
  const details = (message as { details?: unknown }).details;
  return typeof details === "object" && details !== null && !Array.isArray(details) ? details as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
