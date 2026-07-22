import { loadRuntimeConfig } from "./config.ts";
import { importWorldLore } from "../lore/importer.ts";
import { createConfiguredOpenVikingClient } from "../ov/configured-client.ts";
import type { OpenVikingClient } from "../ov/client.ts";
import { initializeSchema, openRpDatabase, type RpDatabase } from "../state/sqlite.ts";
import { createStateStore, type StateStore } from "../state/store.ts";
import { loadSystemDefinitions } from "../systems/module-loader.ts";
import { createSystemRegistry, type SystemRegistry } from "../systems/registry.ts";
import { createSystemRuntime } from "../systems/runtime.ts";
import type { SystemRuntimeLifecycle } from "../systems/types.ts";
import { loadActiveWorld } from "../world/loader.ts";
import type { LoadedWorld } from "../world/schema.ts";
import {
  createStorySnapshotCoordinator,
  type StorySnapshotCoordinator
} from "../state/story-snapshot-coordinator.ts";

// The stateful backbone every extension registers against: an open SQLite
// database with its schema applied, a state store over it, and the optional
// long-term-memory client. Assembling these together (schema before any tool
// execute touches the db) keeps each extension's activate a pure wiring step.
export type RuntimeInfrastructure = {
  db: RpDatabase;
  stateStore: StateStore;
  systemRegistry: SystemRegistry;
  systemRuntime: SystemRuntimeLifecycle;
  storySnapshots: StorySnapshotCoordinator;
  ovClient: OpenVikingClient | undefined;
  /** The active world pack: initial state, attributes, prompts, memory policy. */
  world: LoadedWorld;
};

// Module-level singleton. Each extension file (core, two-pass-render,
// openviking-memory) is loaded into the SAME Node process by pi (`-e a -e b`)
// and imports this module once, so memoizing here means all extensions share
// one db/stateStore instead of opening competing handles on the same sqlite
// file. The fate-sandbox state-store uses the same pattern. Keyed by
// projectRoot so a different root (only happens in tests) rebuilds cleanly.
let cached: { projectRoot: string; infra: RuntimeInfrastructure } | undefined;

export function getRuntimeInfrastructure(projectRoot: string): RuntimeInfrastructure {
  if (cached?.projectRoot === projectRoot) {
    return cached.infra;
  }
  const infra = createRuntimeInfrastructure(projectRoot);
  cached = { projectRoot, infra };
  return infra;
}

export function createRuntimeInfrastructure(projectRoot: string): RuntimeInfrastructure {
  const config = loadRuntimeConfig(projectRoot);
  const db = openRpDatabase(config.sqlitePath);
  try {
    initializeSchema(db);
    const world = loadActiveWorld(projectRoot);
    const definitions = loadSystemDefinitions(world.systemModulePaths);
    const capabilities = new Map<string, unknown>();
    const systemRegistry = createSystemRegistry(definitions, { capabilities });
    const systemRuntime = createSystemRuntime({ db, registry: systemRegistry, capabilities });
    const storySnapshots = createStorySnapshotCoordinator({
      db,
      registry: systemRegistry,
      systemRuntime
    });
    importWorldLore(db, world);
    const stateStore = createStateStore(db);
    const ovClient = createConfiguredOpenVikingClient(projectRoot);
    return { db, stateStore, systemRegistry, systemRuntime, storySnapshots, ovClient, world };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Drop the memoized infrastructure so tests start from a clean process state.
 * Closes any cached db handle so a later activation on the same sqlite file
 * (via RP_SQLITE_PATH) does not race a stale handle — relevant on platforms
 * with stricter file locking (Windows).
 */
export function resetRuntimeInfrastructureForTest(): void {
  if (cached) {
    try {
      cached.infra.db.close();
    } catch {
      // Already closed or never opened — ignore.
    }
  }
  cached = undefined;
}
