import { ensureSaveCommitMetadata } from "../systems/commit-repository.ts";
import { activateSystemSaveInTransaction } from "../systems/activation.ts";
import type { SystemRegistry } from "../systems/registry.ts";
import type { SystemRuntimeLifecycle } from "../systems/types.ts";
import { activateSave } from "./active-save.ts";
import { createSave, type SaveRecord } from "./save-repository.ts";
import { parseState, type RpState } from "./schema.ts";
import { bindSessionToSave } from "./session-binding.ts";
import type { RpDatabase } from "./sqlite.ts";
import { writeLatestState } from "./sqlite.ts";
import type { StateStore } from "./store.ts";
import type { StorySnapshotCoordinator } from "./story-snapshot-coordinator.ts";

export type CreateNewGameOptions = Readonly<{
  db: RpDatabase;
  stateStore: StateStore;
  systemRegistry: SystemRegistry;
  systemRuntime?: SystemRuntimeLifecycle;
  storySnapshots?: StorySnapshotCoordinator;
  state: RpState;
  piSessionId?: string;
  projectRoot?: string;
}>;

export function createNewGame(options: CreateNewGameOptions): SaveRecord {
  const state = parseState(options.state);
  let transactionActive = false;
  let save: SaveRecord;

  try {
    options.db.exec("BEGIN IMMEDIATE");
    transactionActive = true;

    save = createSave(options.db);
    writeLatestState(options.db, save.id, state);
    activateSystemSaveInTransaction({
      db: options.db,
      saveId: save.id,
      registry: options.systemRegistry
    });
    ensureSaveCommitMetadata(options.db, save.id);
    if (options.piSessionId) {
      bindSessionToSave(options.db, options.piSessionId, save.id);
    }

    options.db.exec("COMMIT");
    transactionActive = false;
  } catch (error) {
    if (transactionActive) {
      rollback(options.db);
    }
    throw error;
  }

  activateSave({
    projectRoot: options.projectRoot,
    db: options.db,
    stateStore: options.stateStore,
    systemRuntime: options.systemRuntime,
    storySnapshots: options.storySnapshots,
    saveId: save.id
  });
  return save;
}

function rollback(db: RpDatabase): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the initialization error that caused the rollback.
  }
}
