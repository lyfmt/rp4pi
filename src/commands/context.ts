import type { RpDatabase } from "../state/sqlite.ts";
import { activateSave } from "../state/active-save.ts";
import { getBoundSave } from "../state/session-binding.ts";
import type { StateStore } from "../state/store.ts";
import type { SystemRuntimeLifecycle } from "../systems/types.ts";
import type { StorySnapshotCoordinator } from "../state/story-snapshot-coordinator.ts";

export type CommandContext = {
  db: RpDatabase;
  stateStore: StateStore;
  systemRuntime?: SystemRuntimeLifecycle;
  storySnapshots?: StorySnapshotCoordinator;
  piSessionId: string;
  /** Project root, so save-bind commands can project forged roles. */
  projectRoot?: string;
  /** Native picker backed by ctx.ui.select when available. */
  nativePickSave?: (items: Array<{ id: string; label: string }>) => string | Promise<string | undefined> | undefined;
  getLatestUserMessage?: () => string | null;
  /** Optional rerun capability; absent in environments without turn rerun. */
  rerunTurn?: (message: string) => void | Promise<void>;
};

export type CommandDefinition<TResult = string> = {
  name: string;
  description: string;
  execute: (input: unknown, context: CommandContext) => TResult | Promise<TResult>;
};

export function requireActiveSaveId(context: CommandContext): string {
  const saveId = requireSessionSave(context);
  if (!saveId) {
    throw new Error("当前没有活跃存档。");
  }
  return saveId;
}

export function requireSessionSave(context: CommandContext): string {
  const saveId = getBoundSave(context.db, context.piSessionId);
  if (!saveId) {
    throw new Error("当前会话没有绑定存档。");
  }
  activateSave({
    projectRoot: context.projectRoot,
    db: context.db,
    stateStore: context.stateStore,
    systemRuntime: context.systemRuntime,
    storySnapshots: context.storySnapshots,
    saveId
  });
  return saveId;
}
