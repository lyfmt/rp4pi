import { activateSave, invalidateActiveSaveProjection } from "../state/active-save.ts";
import { getBoundSave } from "../state/session-binding.ts";
import type { StorySnapshotCoordinator } from "../state/story-snapshot-coordinator.ts";
import { SystemRuntimeError } from "../systems/errors.ts";
import type { CommandDefinition } from "./context.ts";

export const rollCommand: CommandDefinition = {
  name: "roll",
  description: "Roll back to previous successful story snapshot and rerun latest user message.",
  async execute(_input, context) {
    if (!context.rerunTurn) {
      return "Cannot roll back: Pi rerun capability is unavailable in this environment.";
    }
    const latestUserMessage = context.getLatestUserMessage?.();
    if (!latestUserMessage) {
      return "Cannot roll back: no latest user message is available.";
    }

    const saveId = getBoundSave(context.db, context.piSessionId);
    if (!saveId) {
      throw new Error("当前会话没有绑定存档。");
    }
    if (!context.storySnapshots) {
      return "Cannot roll back: story snapshot coordinator is unavailable.";
    }

    let restored: ReturnType<StorySnapshotCoordinator["restorePreviousAndSupersedeLatest"]>;
    try {
      restored = context.storySnapshots.restorePreviousAndSupersedeLatest(saveId);
    } catch (error) {
      if (isMissingPredecessor(error)) {
        return "No previous story snapshot is available.";
      }
      if (error instanceof SystemRuntimeError) {
        return `Cannot roll back: restore failed [${error.code}].`;
      }
      throw error;
    }

    invalidateActiveSaveProjection();
    activateSave({
      projectRoot: context.projectRoot,
      db: context.db,
      stateStore: context.stateStore,
      systemRuntime: context.systemRuntime,
      storySnapshots: context.storySnapshots,
      saveId
    });

    try {
      await context.rerunTurn(latestUserMessage);
    } catch (error) {
      return `Story restore completed at turn ${restored.restoredTurnNo}, but rerun failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    return "Rolled back to previous story snapshot and reran latest user message.";
  }
};

function isMissingPredecessor(error: unknown): boolean {
  return (
    error instanceof SystemRuntimeError &&
    error.code === "SNAPSHOT_INCOMPATIBLE" &&
    typeof error.context.reason === "string" &&
    error.context.reason.includes("requires two active story snapshots")
  );
}
