import type { RpDatabase } from "../state/sqlite.ts";
import { SystemRuntimeError } from "./errors.ts";
import type { JsonValue } from "./types.ts";

export type StoredSystemState = {
  name: string;
  version: number;
  payload: unknown;
};

type SystemStateRow = {
  system_name: string;
  version: number;
  payload_json: string;
};

export function writeSystemState(db: RpDatabase, saveId: string, state: StoredSystemState): void {
  const payloadJson = JSON.stringify(toJsonValue(state.payload, state.name, "$", new WeakSet()));

  db.prepare(`
    INSERT INTO system_states (save_id, system_name, version, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(save_id, system_name) DO UPDATE SET
      version = excluded.version,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(saveId, state.name, state.version, payloadJson, new Date().toISOString());
}

export function readSystemState(
  db: RpDatabase,
  saveId: string,
  systemName: string
): StoredSystemState | undefined {
  const row = db
    .prepare(`
      SELECT system_name, version, payload_json
      FROM system_states
      WHERE save_id = ? AND system_name = ?
    `)
    .get(saveId, systemName) as SystemStateRow | undefined;

  return row === undefined ? undefined : fromRow(row);
}

export function listSystemStates(db: RpDatabase, saveId: string): StoredSystemState[] {
  const rows = db
    .prepare(`
      SELECT system_name, version, payload_json
      FROM system_states
      WHERE save_id = ?
      ORDER BY system_name
    `)
    .all(saveId) as SystemStateRow[];

  return rows.map(fromRow);
}

export function readExactSystemStates(
  db: RpDatabase,
  saveId: string,
  expectedNames: readonly string[]
): StoredSystemState[] {
  const states = listSystemStates(db, saveId);
  const expected = [...expectedNames].sort();
  const actual = states.map((state) => state.name);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((name) => !actualSet.has(name));
  const unexpected = actual.filter((name) => !expectedSet.has(name));

  if (missing.length > 0 || unexpected.length > 0) {
    throw new SystemRuntimeError("SNAPSHOT_INCOMPATIBLE", {
      participant: "systems",
      saveId,
      missing,
      unexpected
    });
  }
  return states;
}

export function normalizeSystemStatesForStorage(
  states: readonly StoredSystemState[]
): StoredSystemState[] {
  const names = new Set<string>();
  return states.map((state) => {
    if (names.has(state.name)) {
      throw new SystemRuntimeError("SNAPSHOT_INCOMPATIBLE", {
        participant: "systems",
        system: state.name,
        reason: "duplicate namespace"
      });
    }
    names.add(state.name);
    if (!Number.isInteger(state.version) || state.version <= 0) {
      throw new SystemRuntimeError("SNAPSHOT_INCOMPATIBLE", {
        participant: "systems",
        system: state.name,
        reason: "version must be a positive integer"
      });
    }
    const payloadJson = JSON.stringify(toJsonValue(state.payload, state.name, "$", new WeakSet()));
    return {
      name: state.name,
      version: state.version,
      payload: JSON.parse(payloadJson) as JsonValue
    };
  });
}

/** Replace the complete namespace participant. The caller owns the transaction. */
export function replaceSystemStates(
  db: RpDatabase,
  saveId: string,
  states: readonly StoredSystemState[]
): void {
  const normalized = normalizeSystemStatesForStorage(states);
  db.prepare("DELETE FROM system_states WHERE save_id = ?").run(saveId);
  for (const state of normalized) {
    writeSystemState(db, saveId, state);
  }
}

function fromRow(row: SystemStateRow): StoredSystemState {
  return {
    name: row.system_name,
    version: row.version,
    payload: JSON.parse(row.payload_json) as unknown
  };
}

function toJsonValue(
  value: unknown,
  systemName: string,
  path: string,
  ancestors: WeakSet<object>
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      incompatiblePayload(systemName, path, "number must be finite and preserve its JSON value");
    }
    return value;
  }
  if (typeof value !== "object") {
    incompatiblePayload(systemName, path, `${typeof value} is not a JSON value`);
  }
  if (ancestors.has(value)) {
    incompatiblePayload(systemName, path, "circular reference");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          incompatiblePayload(systemName, `${path}[${index}]`, "sparse array entry");
        }
        result.push(toJsonValue(value[index], systemName, `${path}[${index}]`, ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      incompatiblePayload(systemName, path, "object must have a plain or null prototype");
    }
    const result: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    for (const key of Object.keys(value)) {
      result[key] = toJsonValue(
        (value as Record<string, unknown>)[key],
        systemName,
        `${path}.${key}`,
        ancestors
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function incompatiblePayload(systemName: string, path: string, reason: string): never {
  throw new TypeError(`System payload for "${systemName}" is not JSON-compatible at ${path}: ${reason}.`);
}
