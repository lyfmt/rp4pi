import type { RpDatabase } from "../state/sqlite.ts";
import { getBoundSave } from "../state/session-binding.ts";
import type { StateStore } from "../state/store.ts";
import type { ExtensionContextLike, PiLike } from "../types/pi.ts";
import { resolveSessionId } from "../types/pi.ts";
import { parseDirectionPacket } from "./direction-packet.ts";
import {
  findPendingDirectionPacket,
  latestPlayerInput,
  writerHistoryFromEntries
} from "./session-entries.ts";
import { commitTurn } from "./turn-commit.ts";
import { deliverWhenIdle, runtimeMessageToOutbound } from "./idle-delivery.ts";
import { emitLiveProgress } from "./live-progress.ts";
import { emitTurnRendered } from "./turn-events.ts";
import { createTurnProgressSink } from "./turn-activity-widget.ts";
import type { WriterClient } from "./writer-client.ts";
import type { StorySnapshotCoordinator } from "../state/story-snapshot-coordinator.ts";

// Pass A is the GM agent loop; submit_direction_packet ends it (terminate:true).
// We render the turn on `agent_end` — after the loop is finished — instead of
// reacting to the mid-loop `tool_result`. Delivering prose while the agent is
// still running re-triggers the loop, which is the "GM keeps working after the
// writer output" bug; see the two-pass-rendering reference.
//
// After the prose is committed we emit a turn-rendered event (turn-events.ts)
// carrying the rendered prose. The OpenViking-memory extension subscribes to it
// independently — this is the seam that lets long-term memory be a separate
// extension while still receiving prose that only exists in this handler's
// scope. The story commit completes regardless of whether anyone listens.
export type CreateAgentEndHandlerInput = {
  db: RpDatabase;
  stateStore: StateStore;
  storySnapshots: StorySnapshotCoordinator;
  createWriterClient: (ctx: ExtensionContextLike) => WriterClient;
  sendMessage: PiLike["sendMessage"];
  setTimeoutFn?: (callback: () => void, delayMs: number) => void;
  observeCompletion?: (completion: Promise<void>) => void;
};

export function createAgentEndHandler(input: CreateAgentEndHandlerInput) {
  // Tool call ids we've already rendered, so re-firing agent_end (e.g. after a
  // follow-up turn) does not render the same packet twice.
  const renderedToolCallIds = new Set<string>();

  return async function onAgentEnd(_event: unknown, ctx: ExtensionContextLike): Promise<void> {
    const entries = readEntries(ctx);
    const pending = findPendingDirectionPacket(entries);
    if (pending === undefined || renderedToolCallIds.has(pending.toolCallId)) {
      return;
    }

    const saveId = hydrateBoundSave(input, ctx);
    if (saveId === undefined) {
      return;
    }
    renderedToolCallIds.add(pending.toolCallId);

    const playerInput = latestPlayerInput(entries);
    // Rich sink: turn-activity widget (animated stages, streaming prose tail,
    // memory-sedimentation icon) composed with the single-line working label.
    const progress = createTurnProgressSink(ctx);
    let completionRegistered = false;
    try {
      const result = await commitTurn({
        stateStore: input.stateStore,
        storySnapshots: input.storySnapshots,
        packet: parseDirectionPacket(pending.packet),
        history: writerHistoryFromEntries(entries),
        writerClient: input.createWriterClient(ctx),
        progress,
        deliverCustomMessage: (message) =>
          deliverWhenIdle({
            ctx,
            sendMessage: input.sendMessage,
            message: runtimeMessageToOutbound(message),
            setTimeoutFn: input.setTimeoutFn
          })
      });

      const background = result.completion
        .then(async () => {
          if (result.rendered) {
            await emitTurnRendered({ ctx, saveId, playerInput, prose: result.prose, progress });
          }
        })
        .catch((error: unknown) => {
          console.error(`[turn_commit] ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => emitLiveProgress(progress, { type: "pipeline_done" }));
      void background;
      input.observeCompletion?.(background);
      completionRegistered = true;
    } finally {
      if (!completionRegistered) {
        await emitLiveProgress(progress, { type: "pipeline_done" });
      }
    }
  };
}

function hydrateBoundSave(input: CreateAgentEndHandlerInput, ctx: ExtensionContextLike): string | undefined {
  const piSessionId = resolveSessionId(ctx);
  if (!piSessionId) {
    return undefined;
  }
  const saveId = getBoundSave(input.db, piSessionId);
  if (!saveId) {
    return undefined;
  }
  input.stateStore.hydrateSave(saveId);
  return saveId;
}

function readEntries(ctx: ExtensionContextLike): unknown[] {
  const entries = ctx.sessionManager?.getEntries?.();
  return Array.isArray(entries) ? entries : [];
}
