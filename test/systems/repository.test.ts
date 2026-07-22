import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSave } from "../../src/state/save-repository.ts";
import { initializeSchema, openRpDatabase, type RpDatabase } from "../../src/state/sqlite.ts";
import {
  listSystemStates,
  readSystemState,
  writeSystemState
} from "../../src/systems/repository.ts";

function withDatabase(run: (db: RpDatabase) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "rp-system-repository-"));
  const db = openRpDatabase(join(directory, "state.sqlite"));
  try {
    initializeSchema(db);
    run(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("system state round-trips an opaque versioned payload", () => {
  withDatabase((db) => {
    const save = createSave(db);

    writeSystemState(db, save.id, {
      name: "progression",
      version: 2,
      payload: { level: 3, perks: ["swift"], metadata: { source: null } }
    });

    assert.deepEqual(readSystemState(db, save.id, "progression"), {
      name: "progression",
      version: 2,
      payload: { level: 3, perks: ["swift"], metadata: { source: null } }
    });
  });
});

test("writing the same save namespace replaces its version and payload", () => {
  withDatabase((db) => {
    const save = createSave(db);
    writeSystemState(db, save.id, { name: "progression", version: 1, payload: { level: 1 } });
    writeSystemState(db, save.id, { name: "progression", version: 2, payload: { level: 2 } });

    assert.deepEqual(readSystemState(db, save.id, "progression"), {
      name: "progression",
      version: 2,
      payload: { level: 2 }
    });
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM system_states WHERE save_id = ? AND system_name = ?")
      .get(save.id, "progression") as { count: number };
    assert.equal(row.count, 1);
  });
});

test("listSystemStates sorts namespaces by system name", () => {
  withDatabase((db) => {
    const save = createSave(db);
    writeSystemState(db, save.id, { name: "quest", version: 1, payload: { active: [] } });
    writeSystemState(db, save.id, { name: "generator", version: 3, payload: { seed: 4 } });

    assert.deepEqual(listSystemStates(db, save.id).map((state) => state.name), ["generator", "quest"]);
  });
});

test("system state requires an existing save", () => {
  withDatabase((db) => {
    assert.throws(() => {
      writeSystemState(db, "missing-save", { name: "progression", version: 1, payload: {} });
    });
  });
});

test("readSystemState returns undefined for a missing namespace", () => {
  withDatabase((db) => {
    const save = createSave(db);
    assert.equal(readSystemState(db, save.id, "missing"), undefined);
  });
});

test("repository JSON boundaries isolate stored payloads from caller mutation", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const payload = { nested: { value: 1 } };
    writeSystemState(db, save.id, { name: "progression", version: 1, payload });
    payload.nested.value = 2;

    const first = readSystemState(db, save.id, "progression");
    assert.ok(first);
    (first.payload as { nested: { value: number } }).nested.value = 3;

    assert.deepEqual(readSystemState(db, save.id, "progression")?.payload, { nested: { value: 1 } });
  });
});

test("repository rejects values that JSON serialization would silently coerce", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const sparse = new Array<unknown>(1);
    const invalidPayloads: unknown[] = [
      { nested: undefined },
      { value: Number.NaN },
      { callback: () => null },
      sparse,
      new Date(0)
    ];

    for (const payload of invalidPayloads) {
      assert.throws(
        () => writeSystemState(db, save.id, { name: "invalid", version: 1, payload }),
        /not JSON-compatible/
      );
      assert.equal(readSystemState(db, save.id, "invalid"), undefined);
    }
  });
});
