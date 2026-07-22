import { buildSystemActivationCandidate } from "../systems/activation.ts";
import {
  advanceSaveBranchMetadata,
  readSaveCommitMetadata
} from "../systems/commit-repository.ts";
import { SystemRuntimeError } from "../systems/errors.ts";
import type { SystemRegistry } from "../systems/registry.ts";
import {
  listSystemStates,
  normalizeSystemStatesForStorage,
  readExactSystemStates,
  replaceSystemStates,
  type StoredSystemState
} from "../systems/repository.ts";
import type { JsonValue, SystemRuntimeLifecycle } from "../systems/types.ts";
import {
  listDynamicRoles,
  replaceDynamicRoles,
  validateDynamicRolesSnapshot
} from "./dynamic-roles.ts";
import type { RpState } from "./schema.ts";
import { parseState } from "./schema.ts";
import {
  parseStorySnapshotEnvelope,
  type StorySnapshotEnvelope
} from "./snapshot-envelope.ts";
import { readLatestState, writeLatestState, type RpDatabase } from "./sqlite.ts";
import {
  captureTrajectorySnapshot,
  preflightTrajectorySnapshot,
  restoreTrajectorySnapshot,
  validateTrajectorySnapshot
} from "./trajectory-snapshot.ts";

export type StorySnapshotCoordinator = Readonly<{
  captureSuccessfulStory(saveId: string, coreState: RpState): number;
  promoteLegacySnapshotBaseline(saveId: string):
    | Readonly<{ promoted: true; turnNo: number }>
    | Readonly<{ promoted: false }>;
  restorePreviousAndSupersedeLatest(saveId: string): Readonly<{
    restoredTurnNo: number;
    supersededTurnNo: number;
    revision: number;
    branchEpoch: number;
  }>;
}>;

export type CreateStorySnapshotCoordinatorOptions = Readonly<{
  db: RpDatabase;
  registry?: SystemRegistry;
  systemRuntime?: SystemRuntimeLifecycle;
}>;

export function createStorySnapshotCoordinator(
  options: CreateStorySnapshotCoordinatorOptions
): StorySnapshotCoordinator {
  const { db, registry, systemRuntime } = options;

  return Object.freeze({
    captureSuccessfulStory(saveId: string, coreState: RpState): number {
      return withImmediateTransaction(db, () => {
        const envelope = captureEnvelope(db, saveId, coreState, registry);
        const nextTurnNo = nextStoryTurnNo(db, saveId);
        db.prepare(
          "INSERT INTO turn_snapshots (save_id, turn_no, state_json, created_at) VALUES (?, ?, ?, ?)"
        ).run(saveId, nextTurnNo, JSON.stringify(envelope), new Date().toISOString());
        retainLatestSnapshots(db, saveId, 2);
        return nextTurnNo;
      });
    },
    promoteLegacySnapshotBaseline(saveId: string) {
      return withImmediateTransaction(db, () => {
        const row = db
          .prepare(
            `SELECT turn_no, state_json
             FROM turn_snapshots
             WHERE save_id = ?
             ORDER BY turn_no DESC
             LIMIT 1`
          )
          .get(saveId) as { turn_no: number; state_json: string } | undefined;
        if (row === undefined) {
          return { promoted: false } as const;
        }

        const stored = parseStoredJson(row.state_json, "latest snapshot");
        if (hasSchemaVersion(stored)) {
          parseStorySnapshotEnvelope(stored);
          return { promoted: false } as const;
        }
        parseLegacyCore(stored);

        const currentCore = readCurrentCore(db, saveId);
        const envelope = captureEnvelope(db, saveId, currentCore, registry);
        db.prepare(
          "UPDATE turn_snapshots SET state_json = ? WHERE save_id = ? AND turn_no = ?"
        ).run(JSON.stringify(envelope), saveId, row.turn_no);
        return { promoted: true, turnNo: row.turn_no } as const;
      });
    },
    restorePreviousAndSupersedeLatest(saveId: string) {
      const restored = withImmediateTransaction(db, () =>
        restoreInTransaction(db, saveId, requireRegistry(registry))
      );
      if (systemRuntime !== undefined) {
        systemRuntime.invalidateSave?.(saveId);
        systemRuntime.activateSave(saveId);
      }
      return restored;
    }
  });
}

function restoreInTransaction(
  db: RpDatabase,
  saveId: string,
  registry: SystemRegistry
): Readonly<{
  restoredTurnNo: number;
  supersededTurnNo: number;
  revision: number;
  branchEpoch: number;
}> {
  const rows = db
    .prepare(
      `SELECT turn_no, state_json
       FROM turn_snapshots
       WHERE save_id = ?
       ORDER BY turn_no DESC
       LIMIT 2`
    )
    .all(saveId) as Array<{ turn_no: number; state_json: string }>;
  const superseded = rows[0];
  const target = rows[1];
  if (superseded === undefined || target === undefined) {
    throw snapshotIncompatible("snapshot", "restore requires two active story snapshots");
  }

  const envelope = parseStorySnapshotEnvelope(parseStoredJson(target.state_json, "restore target"));
  if (Object.keys(envelope.capabilities).length > 0) {
    throw snapshotIncompatible("capabilities", "capability snapshot participants are not supported yet");
  }
  const systemStates = buildRestoreSystemStates(registry, envelope);
  validateDynamicRolesSnapshot(envelope.dynamicRoles);
  preflightTrajectorySnapshot(db, saveId, envelope.trajectory);
  if (readSaveCommitMetadata(db, saveId) === undefined) {
    throw snapshotIncompatible("metadata", "save commit metadata is missing");
  }

  writeLatestState(db, saveId, envelope.core.payload);
  replaceSystemStates(db, saveId, systemStates);
  replaceDynamicRoles(db, saveId, envelope.dynamicRoles);
  restoreTrajectorySnapshot(db, saveId, envelope.trajectory);
  const metadata = advanceSaveBranchMetadata(db, saveId);
  const deletion = db
    .prepare("DELETE FROM turn_snapshots WHERE save_id = ? AND turn_no = ?")
    .run(saveId, superseded.turn_no);
  if (deletion.changes !== 1) {
    throw snapshotIncompatible("snapshot", "superseded story snapshot disappeared");
  }

  return {
    restoredTurnNo: target.turn_no,
    supersededTurnNo: superseded.turn_no,
    ...metadata
  };
}

function buildRestoreSystemStates(
  registry: SystemRegistry,
  envelope: StorySnapshotEnvelope
): StoredSystemState[] {
  const registeredNames = new Set(registry.names());
  for (const name of Object.keys(envelope.systems)) {
    if (!registeredNames.has(name)) {
      throw new SystemRuntimeError("SNAPSHOT_INCOMPATIBLE", {
        participant: "systems",
        system: name,
        reason: "snapshot namespace is not registered"
      });
    }
  }

  const candidates: StoredSystemState[] = [];
  for (const definition of registry.definitions()) {
    const participant = envelope.systems[definition.name];
    const stored = participant === undefined
      ? undefined
      : { name: definition.name, version: participant.version, payload: participant.payload };
    const candidate = buildSystemActivationCandidate(definition, stored);
    const state = {
      name: definition.name,
      version: definition.version,
      payload: candidate.payload
    };
    try {
      candidates.push(normalizeSystemStatesForStorage([state])[0]!);
    } catch (cause) {
      throw new SystemRuntimeError(
        candidate.source === "migration" ? "MIGRATION_FAILED" : "SYSTEM_STATE_INVALID",
        {
          system: definition.name,
          currentVersion: definition.version,
          phase: candidate.source,
          reason: "payload persistence validation failed"
        },
        { cause }
      );
    }
  }
  return candidates;
}

function requireRegistry(registry: SystemRegistry | undefined): SystemRegistry {
  if (registry === undefined) {
    throw snapshotIncompatible("systems", "restore requires the active System registry");
  }
  return registry;
}

function captureEnvelope(
  db: RpDatabase,
  saveId: string,
  coreState: RpState,
  registry: SystemRegistry | undefined
): StorySnapshotEnvelope {
  const expectedNames = registry?.names() ?? listSystemStates(db, saveId).map((state) => state.name);
  const states = readExactSystemStates(db, saveId, expectedNames);
  const systems: Record<string, { version: number; payload: JsonValue }> = {};
  for (const state of states) {
    systems[state.name] = {
      version: state.version,
      payload: state.payload as JsonValue
    };
  }

  const trajectory = captureTrajectorySnapshot(db, saveId);
  validateTrajectorySnapshot(trajectory);
  return parseStorySnapshotEnvelope({
    schemaVersion: 1,
    core: { version: 1, payload: coreState },
    systems,
    dynamicRoles: listDynamicRoles(db, saveId),
    trajectory,
    capabilities: {}
  });
}

function nextStoryTurnNo(db: RpDatabase, saveId: string): number {
  const row = db
    .prepare("SELECT MAX(turn_no) AS turn_no FROM turn_snapshots WHERE save_id = ?")
    .get(saveId) as { turn_no: number | null } | undefined;
  return (row?.turn_no ?? 0) + 1;
}

function readCurrentCore(db: RpDatabase, saveId: string): RpState {
  try {
    const state = readLatestState(db, saveId);
    if (state === undefined) {
      throw new TypeError("current core state is missing");
    }
    return parseState(state);
  } catch (cause) {
    throw snapshotIncompatible("core", "current core state is invalid", cause);
  }
}

function parseLegacyCore(value: unknown): void {
  try {
    parseState(value);
  } catch (cause) {
    throw snapshotIncompatible("core", "legacy snapshot core is invalid", cause);
  }
}

function parseStoredJson(stateJson: string, label: string): unknown {
  try {
    return JSON.parse(stateJson) as unknown;
  } catch (cause) {
    throw snapshotIncompatible("snapshot", `${label} is not valid JSON`, cause);
  }
}

function hasSchemaVersion(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "schemaVersion")
  );
}

function snapshotIncompatible(participant: string, reason: string, cause?: unknown): SystemRuntimeError {
  return new SystemRuntimeError(
    "SNAPSHOT_INCOMPATIBLE",
    { participant, reason },
    cause === undefined ? undefined : { cause }
  );
}

function retainLatestSnapshots(db: RpDatabase, saveId: string, count: number): void {
  db.prepare(
    `DELETE FROM turn_snapshots
     WHERE save_id = ?
       AND turn_no NOT IN (
         SELECT turn_no FROM turn_snapshots
         WHERE save_id = ?
         ORDER BY turn_no DESC
         LIMIT ?
       )`
  ).run(saveId, saveId, count);
}

function withImmediateTransaction<T>(db: RpDatabase, action: () => T): T {
  let transactionActive = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionActive = true;
    const result = action();
    db.exec("COMMIT");
    transactionActive = false;
    return result;
  } catch (error) {
    if (transactionActive) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the capture error that caused the rollback.
      }
    }
    throw error;
  }
}
