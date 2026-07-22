import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSave } from "../../src/state/save-repository.ts";
import { initializeSchema, openRpDatabase, type RpDatabase } from "../../src/state/sqlite.ts";
import { activateSystemSave } from "../../src/systems/activation.ts";
import { defineSystem } from "../../src/systems/define-system.ts";
import { SystemRuntimeError, type SystemRuntimeErrorCode } from "../../src/systems/errors.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";
import { readSystemState, writeSystemState } from "../../src/systems/repository.ts";
import type { SystemDefinition } from "../../src/systems/types.ts";

type Progression = { level: number; xp: number; perks: string[] };

function withDatabase(run: (db: RpDatabase) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "rp-system-activation-"));
  const db = openRpDatabase(join(directory, "state.sqlite"));
  try {
    initializeSchema(db);
    run(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseProgression(payload: unknown): Progression {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("progression payload must be an object");
  }
  const candidate = payload as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.level) ||
    !Number.isInteger(candidate.xp) ||
    !Array.isArray(candidate.perks) ||
    !candidate.perks.every((perk) => typeof perk === "string")
  ) {
    throw new Error("invalid progression payload");
  }
  return candidate as Progression;
}

function progressionSystem(
  overrides: Partial<{
    name: string;
    version: number;
    dependsOn: string[];
    initialize: () => unknown;
    parse: (payload: unknown) => Progression;
    migrate: (fromVersion: number, payload: unknown) => { version: number; payload: unknown };
  }> = {}
) {
  return defineSystem({
    name: overrides.name ?? "progression",
    version: overrides.version ?? 2,
    dependsOn: overrides.dependsOn,
    initialize: overrides.initialize ?? (() => ({ level: 1, xp: 0, perks: [] })),
    parse: overrides.parse ?? parseProgression,
    migrate:
      overrides.migrate ??
      ((fromVersion, payload) => ({
        version: fromVersion + 1,
        payload: { ...(payload as object), perks: [] }
      })),
    commands: {},
    project: (_context, state) => state
  });
}

function registry(...definitions: SystemDefinition<unknown>[]) {
  return createSystemRegistry(definitions, { capabilities: new Map() });
}

function hasCode(code: SystemRuntimeErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof SystemRuntimeError && error.code === code;
}

test("activateSystemSave initializes a missing namespace at the current version", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const activated = activateSystemSave({ db, saveId: save.id, registry: registry(progressionSystem()) });

    assert.deepEqual(activated.get("progression"), {
      version: 2,
      state: { level: 1, xp: 0, perks: [] }
    });
    assert.deepEqual(readSystemState(db, save.id, "progression"), {
      name: "progression",
      version: 2,
      payload: { level: 1, xp: 0, perks: [] }
    });
  });
});

test("activateSystemSave migrates old payloads and persists the current version", () => {
  withDatabase((db) => {
    const save = createSave(db);
    writeSystemState(db, save.id, {
      name: "progression",
      version: 1,
      payload: { level: 2, xp: 50 }
    });

    const activated = activateSystemSave({ db, saveId: save.id, registry: registry(progressionSystem()) });

    assert.deepEqual(activated.get("progression"), {
      version: 2,
      state: { level: 2, xp: 50, perks: [] }
    });
    assert.deepEqual(readSystemState(db, save.id, "progression"), {
      name: "progression",
      version: 2,
      payload: { level: 2, xp: 50, perks: [] }
    });
  });
});

test("activateSystemSave repeatedly migrates until the definition version", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const visited: number[] = [];
    writeSystemState(db, save.id, {
      name: "progression",
      version: 1,
      payload: { level: 2, xp: 50 }
    });
    const definition = progressionSystem({
      version: 3,
      migrate: (fromVersion, payload) => {
        visited.push(fromVersion);
        return {
          version: fromVersion + 1,
          payload: fromVersion === 1 ? { ...(payload as object), perks: [] } : payload
        };
      }
    });

    activateSystemSave({ db, saveId: save.id, registry: registry(definition) });

    assert.deepEqual(visited, [1, 2]);
    assert.equal(readSystemState(db, save.id, "progression")?.version, 3);
  });
});

test("a thrown migration leaves the original payload unchanged", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const original = { name: "progression", version: 1, payload: { level: 2, xp: 50 } };
    writeSystemState(db, save.id, original);
    const definition = progressionSystem({
      migrate: () => {
        throw new Error("broken migration");
      }
    });

    assert.throws(
      () => activateSystemSave({ db, saveId: save.id, registry: registry(definition) }),
      hasCode("MIGRATION_FAILED")
    );
    assert.deepEqual(readSystemState(db, save.id, "progression"), original);
  });
});

for (const returnedVersion of [1, 0]) {
  test(`migration version ${returnedVersion} is rejected without changing the original payload`, () => {
    withDatabase((db) => {
      const save = createSave(db);
      const original = { name: "progression", version: 1, payload: { level: 2, xp: 50 } };
      writeSystemState(db, save.id, original);
      const definition = progressionSystem({
        migrate: (_fromVersion, payload) => ({ version: returnedVersion, payload })
      });

      assert.throws(
        () => activateSystemSave({ db, saveId: save.id, registry: registry(definition) }),
        hasCode("MIGRATION_FAILED")
      );
      assert.deepEqual(readSystemState(db, save.id, "progression"), original);
    });
  });
}

test("an old payload without a migration function is rejected", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const original = { name: "progression", version: 1, payload: { level: 2, xp: 50 } };
    writeSystemState(db, save.id, original);
    const definition = defineSystem({
      name: "progression",
      version: 2,
      initialize: () => ({ level: 1, xp: 0, perks: [] }),
      parse: parseProgression,
      commands: {},
      project: (_context, state) => state
    });

    assert.throws(
      () => activateSystemSave({ db, saveId: save.id, registry: registry(definition) }),
      hasCode("MIGRATION_FAILED")
    );
    assert.deepEqual(readSystemState(db, save.id, "progression"), original);
  });
});

test("a parser rejection after migration leaves the original payload unchanged", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const original = { name: "progression", version: 1, payload: { level: 2, xp: 50 } };
    writeSystemState(db, save.id, original);
    const definition = progressionSystem({
      migrate: () => ({ version: 2, payload: { invalid: true } })
    });

    assert.throws(
      () => activateSystemSave({ db, saveId: save.id, registry: registry(definition) }),
      hasCode("SYSTEM_STATE_INVALID")
    );
    assert.deepEqual(readSystemState(db, save.id, "progression"), original);
  });
});

test("a future stored version is rejected without invoking the current parser", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const original = {
      name: "progression",
      version: 3,
      payload: { level: 9, xp: 0, perks: ["future"] }
    };
    writeSystemState(db, save.id, original);
    let parsed = false;
    const definition = progressionSystem({
      parse: (payload) => {
        parsed = true;
        return parseProgression(payload);
      }
    });

    assert.throws(
      () => activateSystemSave({ db, saveId: save.id, registry: registry(definition) }),
      hasCode("SYSTEM_VERSION_FUTURE")
    );
    assert.equal(parsed, false);
    assert.deepEqual(readSystemState(db, save.id, "progression"), original);
  });
});

test("a later migration failure rolls back an earlier namespace initialization", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const first = progressionSystem({ name: "first", version: 1 });
    const secondOriginal = { name: "second", version: 1, payload: { level: 2, xp: 50 } };
    writeSystemState(db, save.id, secondOriginal);
    const second = progressionSystem({
      name: "second",
      dependsOn: ["first"],
      migrate: () => {
        throw new Error("broken migration");
      }
    });

    assert.throws(
      () => activateSystemSave({ db, saveId: save.id, registry: registry(second, first) }),
      hasCode("MIGRATION_FAILED")
    );
    assert.equal(readSystemState(db, save.id, "first"), undefined);
    assert.deepEqual(readSystemState(db, save.id, "second"), secondOriginal);
  });
});

test("a later initialization failure rolls back an earlier namespace migration", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const firstOriginal = { name: "first", version: 1, payload: { level: 2, xp: 50 } };
    writeSystemState(db, save.id, firstOriginal);
    const first = progressionSystem({ name: "first" });
    const second = progressionSystem({
      name: "second",
      version: 1,
      dependsOn: ["first"],
      initialize: () => ({ invalid: true })
    });

    assert.throws(
      () => activateSystemSave({ db, saveId: save.id, registry: registry(second, first) }),
      hasCode("SYSTEM_STATE_INVALID")
    );
    assert.deepEqual(readSystemState(db, save.id, "first"), firstOriginal);
    assert.equal(readSystemState(db, save.id, "second"), undefined);
  });
});

test("persisted namespaces absent from the registry fail without data loss", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const original = { name: "retired", version: 1, payload: { value: 4 } };
    writeSystemState(db, save.id, original);

    assert.throws(
      () => activateSystemSave({ db, saveId: save.id, registry: registry() }),
      (error) =>
        error instanceof SystemRuntimeError &&
        error.code === "DEPENDENCY_UNAVAILABLE" &&
        error.context.system === "retired"
    );
    assert.deepEqual(readSystemState(db, save.id, "retired"), original);
  });
});

test("non-JSON-compatible initialization fails without creating the namespace", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const definition = defineSystem({
      name: "invalid-json",
      version: 1,
      initialize: () => ({ value: undefined }),
      parse: (payload) => payload,
      commands: {},
      project: (_context, state) => state
    });

    assert.throws(
      () => activateSystemSave({ db, saveId: save.id, registry: registry(definition) }),
      hasCode("SYSTEM_STATE_INVALID")
    );
    assert.equal(readSystemState(db, save.id, "invalid-json"), undefined);
  });
});

test("non-JSON-compatible migration fails and preserves the original payload", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const original = { name: "invalid-json", version: 1, payload: { value: 1 } };
    writeSystemState(db, save.id, original);
    const definition = defineSystem({
      name: "invalid-json",
      version: 2,
      initialize: () => ({ value: 0 }),
      parse: (payload) => payload,
      migrate: () => ({ version: 2, payload: { value: undefined } }),
      commands: {},
      project: (_context, state) => state
    });

    assert.throws(
      () => activateSystemSave({ db, saveId: save.id, registry: registry(definition) }),
      hasCode("MIGRATION_FAILED")
    );
    assert.deepEqual(readSystemState(db, save.id, "invalid-json"), original);
  });
});
