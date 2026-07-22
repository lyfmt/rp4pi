import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const saveRepository = await import(
  pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href
);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const dynamicRoles = await import(pathToFileURL(new URL("../../src/state/dynamic-roles.ts", import.meta.url).pathname).href);

const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const upsertDynamicRole = dynamicRoles.upsertDynamicRole as typeof import("../../src/state/dynamic-roles.js").upsertDynamicRole;
const listDynamicRoles = dynamicRoles.listDynamicRoles as typeof import("../../src/state/dynamic-roles.js").listDynamicRoles;
const readDynamicRole = dynamicRoles.readDynamicRole as typeof import("../../src/state/dynamic-roles.js").readDynamicRole;
const replaceDynamicRoles =
  dynamicRoles.replaceDynamicRoles as typeof import("../../src/state/dynamic-roles.js").replaceDynamicRoles;

function withTempDatabase(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rp-dyn-"));
  try {
    fn(join(dir, "state.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("upsert then list/read returns a forged role, scoped per save", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      const other = createSave(db);

      upsertDynamicRole(db, save.id, { name: "han-yue", description: "守门人", persona: "你是韩越。" });
      upsertDynamicRole(db, save.id, { name: "luo", description: "商队向导", persona: "你是罗。" });
      upsertDynamicRole(db, other.id, { name: "han-yue", description: "别档同名", persona: "你是另一个韩越。" });

      assert.deepEqual(listDynamicRoles(db, save.id).map((r) => r.name), ["han-yue", "luo"]);
      assert.equal(readDynamicRole(db, save.id, "han-yue")?.persona, "你是韩越。");
      // Same name in another save is a distinct row.
      assert.equal(readDynamicRole(db, other.id, "han-yue")?.persona, "你是另一个韩越。");
      assert.equal(readDynamicRole(db, save.id, "absent"), undefined);
    } finally {
      db.close();
    }
  });
});

test("re-forging a name updates persona/description but preserves created_at", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      upsertDynamicRole(db, save.id, { name: "han-yue", description: "v1", persona: "p1" });
      const first = readDynamicRole(db, save.id, "han-yue");
      upsertDynamicRole(db, save.id, { name: "han-yue", description: "v2", persona: "p2" });
      const second = readDynamicRole(db, save.id, "han-yue");

      assert.equal(second?.description, "v2");
      assert.equal(second?.persona, "p2");
      assert.equal(second?.createdAt, first?.createdAt, "created_at preserved across re-forge");
      assert.equal(listDynamicRoles(db, save.id).length, 1, "still one row for the name");
    } finally {
      db.close();
    }
  });
});

test("forging for a missing save is rejected by the foreign key", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      assert.throws(() => upsertDynamicRole(db, "missing", { name: "x", description: "d", persona: "p" }));
    } finally {
      db.close();
    }
  });
});

test("replaceDynamicRoles exactly restores one save without changing another", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      const other = createSave(db);
      const snapshotRoles = [
        {
          name: "han-yue",
          description: "旧守门人",
          persona: "旧人格",
          createdAt: "2026-07-10T01:00:00.000Z",
          updatedAt: "2026-07-10T02:00:00.000Z"
        }
      ];

      upsertDynamicRole(db, save.id, { name: "han-yue", description: "新守门人", persona: "新人格" });
      upsertDynamicRole(db, save.id, { name: "new-role", description: "应删除", persona: "应删除" });
      upsertDynamicRole(db, other.id, { name: "other-role", description: "保留", persona: "保留" });

      replaceDynamicRoles(db, save.id, snapshotRoles);

      assert.deepEqual(listDynamicRoles(db, save.id), snapshotRoles);
      assert.deepEqual(listDynamicRoles(db, other.id).map((role) => role.name), ["other-role"]);
    } finally {
      db.close();
    }
  });
});
