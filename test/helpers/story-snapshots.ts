import type { RpState } from "../../src/state/schema.ts";
import type { RpDatabase } from "../../src/state/sqlite.ts";
import { createStorySnapshotCoordinator } from "../../src/state/story-snapshot-coordinator.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";

export function recordEmptySystemStorySnapshot(
  db: RpDatabase,
  saveId: string,
  state: RpState
): number {
  const registry = createSystemRegistry([], { capabilities: new Map() });
  return createStorySnapshotCoordinator({ db, registry }).captureSuccessfulStory(saveId, state);
}
