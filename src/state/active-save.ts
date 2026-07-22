import { materializeDynamicRoles } from "../world/materialize-dynamic-roles.ts";
import type { SystemRuntimeLifecycle } from "../systems/types.ts";
import type { RpDatabase } from "./sqlite.ts";
import type { StateStore } from "./store.ts";
import type { StorySnapshotCoordinator } from "./story-snapshot-coordinator.ts";

// The single place a save becomes "the active save" for a running process. Every
// entry point that binds a save (the /load command, initialize_new_game, and the
// per-tool hydrate in the tool registry) routes through here so four things
// always happen together and in one order:
//   1. activate and migrate every registered System namespace;
//   2. promote the latest legacy snapshot baseline, if one exists;
//   3. hydrate the state store to that save;
//   4. expose the save id to child subagent processes via RP_ACTIVE_SAVE
//      (pi-subagents inherits the parent env — this is how forge_character /
//      forge_role / role-runtime learn which save they belong to);
//   5. project that save's GM-forged roles into `.pi/agents/` so they are
//      discoverable/spawnable, and so switching saves never leaves another
//      save's forged roles visible.
//
// Step 3 is the only expensive one (filesystem rewrite), so it is guarded to run
// only when the active save actually changes, keeping the hot per-tool path cheap.

let lastProjectedSave: string | undefined;

/** Reset the projection guard — for tests that reuse the module across saves. */
export function resetActiveSaveProjectionForTest(): void {
  lastProjectedSave = undefined;
}

export function activateSave(input: {
  projectRoot?: string;
  db: RpDatabase;
  stateStore: StateStore;
  systemRuntime?: SystemRuntimeLifecycle;
  storySnapshots?: StorySnapshotCoordinator;
  saveId: string;
}): void {
  input.systemRuntime?.activateSave(input.saveId);
  input.storySnapshots?.promoteLegacySnapshotBaseline(input.saveId);
  input.stateStore.hydrateSave(input.saveId);
  process.env.RP_ACTIVE_SAVE = input.saveId;

  if (input.projectRoot && lastProjectedSave !== input.saveId) {
    materializeDynamicRoles(input.projectRoot, input.db, input.saveId);
    lastProjectedSave = input.saveId;
  }
}

/** Force re-projection of the active save's forged roles on the next
 * activateSave for that save (e.g. after forge_role adds one). */
export function invalidateActiveSaveProjection(): void {
  lastProjectedSave = undefined;
}
