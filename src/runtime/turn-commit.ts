import type { StorySnapshotCoordinator } from "../state/story-snapshot-coordinator.ts";
import type { StateStore } from "../state/store.ts";
import type { DirectionPacket } from "./direction-packet.ts";
import { emitLiveProgress, type LiveProgressSink } from "./live-progress.ts";
import { createWriterProseMessage, type RuntimeMessage } from "./prose-message.ts";
import type { WriterHistoryItem } from "./writer-history.ts";
import type { WriterClient } from "./writer-client.ts";

// Pass B core: render the GM's direction packet into player-facing prose, write
// it as a custom message, and snapshot the committed state. Long-term memory
// (OpenViking) is intentionally NOT part of this function — it is a separate
// extension that subscribes to the turn-rendered event (see turn-events.ts), so
// the story commit here stays authoritative and OV failures cannot affect it.
export type CommitTurnInput = {
  stateStore: StateStore;
  storySnapshots: StorySnapshotCoordinator;
  packet: DirectionPacket;
  history?: WriterHistoryItem[];
  writerClient: WriterClient;
  deliverCustomMessage: (message: RuntimeMessage) => Promise<void>;
  progress?: LiveProgressSink;
};

export type StoryCommitCompletion = Readonly<{ snapshotTurnNo: number }>;

export type CommitTurnResult =
  | Readonly<{
      rendered: true;
      prose: string;
      completion: Promise<StoryCommitCompletion>;
    }>
  | Readonly<{
      rendered: false;
      directReply: string;
      completion: Promise<void>;
    }>;

export async function commitTurn(input: CommitTurnInput): Promise<CommitTurnResult> {
  if (!input.packet.needsRender) {
    return {
      rendered: false,
      directReply: input.packet.directReply,
      completion: startDelivery(input, { role: "assistant", content: input.packet.directReply })
    };
  }

  const saveId = input.stateStore.getActiveSaveId();
  if (!saveId) {
    throw new Error("Cannot record story snapshot without an active save");
  }

  const state = input.stateStore.getState();
  const prose = await input.writerClient.render({ history: input.history ?? [], packet: input.packet, progress: input.progress });
  await emitLiveProgress(input.progress, { type: "stage_start", stage: "commit" });
  const completion = startDelivery(input, createWriterProseMessage(prose))
    .then(async (): Promise<StoryCommitCompletion> => {
      const snapshotTurnNo = input.storySnapshots.captureSuccessfulStory(saveId, state);
      await emitLiveProgress(input.progress, {
        type: "stage_end",
        stage: "commit",
        detail: `snapshotTurnNo=${snapshotTurnNo}`
      });
      return { snapshotTurnNo };
    })
    .catch(async (error: unknown): Promise<never> => {
      await emitLiveProgress(input.progress, {
        type: "stage_error",
        stage: "commit",
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    });
  return { rendered: true, prose, completion };
}

function startDelivery(input: CommitTurnInput, message: RuntimeMessage): Promise<void> {
  try {
    return Promise.resolve(input.deliverCustomMessage(message));
  } catch (error) {
    return Promise.reject(error);
  }
}
