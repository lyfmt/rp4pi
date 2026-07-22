import { createInitialState, parseState, type RpState } from "./schema.ts";
import type { RpDatabase } from "./sqlite.ts";
import { readLatestState, writeLatestState } from "./sqlite.ts";

export type StateStore = {
  hydrateSave(saveId: string): RpState;
  getState(): RpState;
  replaceState(saveId: string, state: RpState): RpState;
  mutateState(mutator: (draft: RpState) => void): RpState;
  getActiveSaveId(): string | undefined;
};

export function createStateStore(db: RpDatabase): StateStore {
  let activeSaveId: string | undefined;
  let currentState: RpState | undefined;

  function commit(saveId: string, state: RpState): RpState {
    const parsed = parseState(state);
    writeLatestState(db, saveId, parsed);
    activeSaveId = saveId;
    currentState = parsed;
    return parsed;
  }

  return {
    hydrateSave(saveId) {
      return commit(saveId, readLatestState(db, saveId) ?? createInitialState());
    },
    getState() {
      if (!currentState) {
        throw new Error("No active RP state");
      }
      return structuredClone(currentState);
    },
    replaceState(saveId, state) {
      return commit(saveId, state);
    },
    mutateState(mutator) {
      if (!activeSaveId || !currentState) {
        throw new Error("No active RP state");
      }

      const draft = structuredClone(currentState);
      mutator(draft);
      return commit(activeSaveId, draft);
    },
    getActiveSaveId() {
      return activeSaveId;
    }
  };
}
