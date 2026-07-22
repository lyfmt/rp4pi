import type { RpDatabase } from "../state/sqlite.ts";
import { SystemRuntimeError, type SystemRuntimeErrorCode } from "./errors.ts";
import type { SystemRegistry } from "./registry.ts";
import { listSystemStates, writeSystemState, type StoredSystemState } from "./repository.ts";
import type { SystemDefinition } from "./types.ts";

export type ActivatedSystemState = Readonly<{
  version: number;
  state: unknown;
}>;

export type ActivateSystemSaveOptions = Readonly<{
  db: RpDatabase;
  saveId: string;
  registry: SystemRegistry;
}>;

export function activateSystemSave(
  options: ActivateSystemSaveOptions
): ReadonlyMap<string, ActivatedSystemState> {
  const { db } = options;
  let transactionActive = false;

  try {
    db.exec("BEGIN IMMEDIATE");
    transactionActive = true;
    const activated = activateSystemSaveInTransaction(options);

    db.exec("COMMIT");
    transactionActive = false;
    return activated;
  } catch (error) {
    if (transactionActive) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the lifecycle error that caused the rollback.
      }
    }
    throw error;
  }
}

/** Core orchestration helper. The caller owns the surrounding transaction. */
export function activateSystemSaveInTransaction(
  options: ActivateSystemSaveOptions
): ReadonlyMap<string, ActivatedSystemState> {
  const { db, saveId, registry } = options;
  const activated = new Map<string, ActivatedSystemState>();
  const storedStates = listSystemStates(db, saveId);
  const storedByName = new Map(storedStates.map((stored) => [stored.name, stored]));
  const registeredNames = new Set(registry.names());

  for (const stored of storedStates) {
    if (!registeredNames.has(stored.name)) {
      throw new SystemRuntimeError("DEPENDENCY_UNAVAILABLE", {
        system: stored.name,
        saveId,
        reason: "persisted namespace is not registered"
      });
    }
  }

  for (const definition of registry.definitions()) {
    const stored = storedByName.get(definition.name);
    const result = buildSystemActivationCandidate(definition, stored);
    activated.set(
      definition.name,
      Object.freeze({ version: definition.version, state: result.state })
    );
    if (result.changed) {
      persistChangedState(db, saveId, definition, result.payload, result.source);
    }
  }

  return activated;
}

export type SystemActivationCandidate = {
  state: unknown;
  payload: unknown;
  changed: boolean;
  source: "initialize" | "migration" | "stored";
};

export function buildSystemActivationCandidate(
  definition: SystemDefinition<unknown>,
  stored: StoredSystemState | undefined
): SystemActivationCandidate {
  if (stored === undefined) {
    const payload = initializePayload(definition);
    return {
      payload,
      state: parsePayload(definition, payload, "initialize"),
      changed: true,
      source: "initialize"
    };
  }

  if (stored.version > definition.version) {
    throw new SystemRuntimeError("SYSTEM_VERSION_FUTURE", {
      system: definition.name,
      storedVersion: stored.version,
      currentVersion: definition.version
    });
  }

  if (stored.version === definition.version) {
    return {
      payload: stored.payload,
      state: parsePayload(definition, stored.payload, "stored"),
      changed: false,
      source: "stored"
    };
  }

  const migrated = migratePayload(definition, stored);
  return {
    payload: migrated.payload,
    state: parsePayload(definition, migrated.payload, "migration"),
    changed: true,
    source: "migration"
  };
}

function initializePayload(definition: SystemDefinition<unknown>): unknown {
  try {
    return definition.initialize();
  } catch (cause) {
    throw lifecycleError(
      "SYSTEM_STATE_INVALID",
      definition,
      { phase: "initialize", reason: "initialize failed" },
      cause
    );
  }
}

function parsePayload(
  definition: SystemDefinition<unknown>,
  payload: unknown,
  phase: SystemActivationCandidate["source"]
): unknown {
  try {
    const state = definition.parse(payload);
    if (isPromiseLike(state)) {
      throw new TypeError("system parser must be synchronous");
    }
    return state;
  } catch (cause) {
    throw lifecycleError(
      "SYSTEM_STATE_INVALID",
      definition,
      { phase, reason: "parser rejected payload" },
      cause
    );
  }
}

function migratePayload(
  definition: SystemDefinition<unknown>,
  stored: StoredSystemState
): { version: number; payload: unknown } {
  let version = stored.version;
  let payload = stored.payload;

  while (version < definition.version) {
    const fromVersion = version;
    if (definition.migrate === undefined) {
      throw lifecycleError("MIGRATION_FAILED", definition, {
        fromVersion,
        targetVersion: definition.version,
        reason: "migration function is missing"
      });
    }

    let next: { version: number; payload: unknown };
    try {
      next = definition.migrate(fromVersion, payload);
    } catch (cause) {
      throw lifecycleError(
        "MIGRATION_FAILED",
        definition,
        { fromVersion, targetVersion: definition.version, reason: "migration threw" },
        cause
      );
    }

    if (
      typeof next !== "object" ||
      next === null ||
      !Number.isInteger(next.version) ||
      next.version <= fromVersion ||
      next.version > definition.version
    ) {
      throw lifecycleError("MIGRATION_FAILED", definition, {
        fromVersion,
        returnedVersion:
          typeof next === "object" && next !== null ? (next as { version?: unknown }).version : undefined,
        targetVersion: definition.version,
        reason: "migration did not advance toward the current version"
      });
    }

    version = next.version;
    payload = next.payload;
  }

  return { version, payload };
}

function persistChangedState(
  db: RpDatabase,
  saveId: string,
  definition: SystemDefinition<unknown>,
  payload: unknown,
  source: SystemActivationCandidate["source"]
): void {
  try {
    writeSystemState(db, saveId, {
      name: definition.name,
      version: definition.version,
      payload
    });
  } catch (cause) {
    const code = source === "migration" ? "MIGRATION_FAILED" : "SYSTEM_STATE_INVALID";
    throw lifecycleError(code, definition, { phase: source, reason: "payload persistence failed" }, cause);
  }
}

function lifecycleError(
  code: SystemRuntimeErrorCode,
  definition: SystemDefinition<unknown>,
  context: Readonly<Record<string, unknown>>,
  cause?: unknown
): SystemRuntimeError {
  return new SystemRuntimeError(
    code,
    { system: definition.name, currentVersion: definition.version, ...context },
    cause === undefined ? undefined : { cause }
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
