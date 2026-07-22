import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { recordEmptySystemStorySnapshot } from "../helpers/story-snapshots.ts";
import { parseStorySnapshotEnvelope } from "../../src/state/snapshot-envelope.ts";

const schema = await import(pathToFileURL(new URL("../../src/state/schema.ts", import.meta.url).pathname).href);
const saveRepository = await import(
  pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href
);
const sessionBinding = await import(
  pathToFileURL(new URL("../../src/state/session-binding.ts", import.meta.url).pathname).href
);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const store = await import(pathToFileURL(new URL("../../src/state/store.ts", import.meta.url).pathname).href);
const snapshots = await import(pathToFileURL(new URL("../../src/state/snapshots.ts", import.meta.url).pathname).href);

const createInitialState = schema.createInitialState as typeof import("../../src/state/schema.js").createInitialState;
const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const listSaves = saveRepository.listSaves as typeof import("../../src/state/save-repository.js").listSaves;
const bindSessionToSave =
  sessionBinding.bindSessionToSave as typeof import("../../src/state/session-binding.js").bindSessionToSave;
const getBoundSave = sessionBinding.getBoundSave as typeof import("../../src/state/session-binding.js").getBoundSave;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const readLatestState = sqlite.readLatestState as typeof import("../../src/state/sqlite.js").readLatestState;
const writeLatestState = sqlite.writeLatestState as typeof import("../../src/state/sqlite.js").writeLatestState;
const createStateStore = store.createStateStore as typeof import("../../src/state/store.js").createStateStore;

function withTempDatabase(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rp-state-"));
  try {
    fn(join(dir, "state.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("initializeSchema creates all state tables", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);

      const tableNames = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);

      assert.deepEqual(tableNames, [
        "character_summaries",
        "character_trajectories",
        "dynamic_roles",
        "hook_fire_state",
        "latest_states",
        "lore_aliases",
        "lore_entries",
        "lore_relations",
        "lore_search_index",
        "lore_sources",
        "ov_session_bindings",
        "saves",
        "session_bindings",
        "system_commit_receipts",
        "system_save_revisions",
        "system_states",
        "turn_snapshots"
      ]);
    } finally {
      db.close();
    }
  });
});

test("snapshot storage does not expose a core-only production capture", () => {
  assert.equal("recordSuccessfulStorySnapshot" in snapshots, false);
});

test("system commit metadata cascades when its save is deleted", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      db.prepare(
        "INSERT INTO system_save_revisions (save_id, revision, branch_epoch) VALUES (?, ?, ?)"
      ).run(save.id, 2, 1);
      db.prepare(`
        INSERT INTO system_commit_receipts (
          save_id, branch_epoch, request_id, request_hash, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(save.id, 1, "request-1", "hash-1", "{}", "t1");

      db.prepare("DELETE FROM saves WHERE id = ?").run(save.id);

      const revisionRows = db
        .prepare("SELECT COUNT(*) AS count FROM system_save_revisions WHERE save_id = ?")
        .get(save.id) as { count: number };
      const receiptRows = db
        .prepare("SELECT COUNT(*) AS count FROM system_commit_receipts WHERE save_id = ?")
        .get(save.id) as { count: number };
      assert.equal(revisionRows.count, 0);
      assert.equal(receiptRows.count, 0);
    } finally {
      db.close();
    }
  });
});

test("system_states uses a save-scoped namespace key", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const firstSave = createSave(db);
      const secondSave = createSave(db);
      const write = db.prepare(`
        INSERT INTO system_states (save_id, system_name, version, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(save_id, system_name) DO UPDATE SET
          version = excluded.version,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `);

      write.run(firstSave.id, "progression", 1, '{"level":1}', "t1");
      write.run(secondSave.id, "progression", 1, '{"level":3}', "t1");
      write.run(firstSave.id, "progression", 2, '{"level":2}', "t2");

      const rows = db
        .prepare("SELECT save_id, version FROM system_states WHERE system_name = ? ORDER BY save_id")
        .all("progression") as Array<{ save_id: string; version: number }>;
      assert.equal(rows.length, 2);
      assert.equal(rows.find((row) => row.save_id === firstSave.id)?.version, 2);
      assert.equal(rows.find((row) => row.save_id === secondSave.id)?.version, 1);
    } finally {
      db.close();
    }
  });
});

test("initializeSchema migrates legacy character trajectories with game time columns", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE saves (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE character_trajectories (
          save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
          character TEXT NOT NULL,
          turn_no INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (save_id, character, seq)
        );
      `);
      db.prepare("INSERT INTO saves (id, created_at, updated_at) VALUES (?, ?, ?)").run("save-1", "t", "t");
      db.prepare(
        "INSERT INTO character_trajectories (save_id, character, turn_no, seq, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("save-1", "韩越", 1, 1, "旧轨迹", "t");

      initializeSchema(db);

      const columns = db
        .prepare("PRAGMA table_info(character_trajectories)")
        .all()
        .map((row) => row.name);
      assert.ok(columns.includes("game_day"));
      assert.ok(columns.includes("game_hour"));

      const row = db
        .prepare("SELECT game_day, game_hour FROM character_trajectories WHERE save_id = ? AND character = ?")
        .get("save-1", "韩越") as { game_day: number; game_hour: number };
      assert.equal(row.game_day, 1);
      assert.equal(row.game_hour, 8);
    } finally {
      db.close();
    }
  });
});

test("createSave inserts a save and listSaves returns it", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);

      const save = createSave(db);
      const saves = listSaves(db);

      assert.match(save.id, /^[0-9a-f-]{36}$/);
      assert.equal(saves.length, 1);
      assert.equal(saves[0]?.id, save.id);
      assert.equal(typeof saves[0]?.createdAt, "string");
      assert.equal(typeof saves[0]?.updatedAt, "string");
    } finally {
      db.close();
    }
  });
});

test("writeLatestState and readLatestState round-trip state JSON", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      const state = createInitialState({
        player: {
          name: "Mira",
          status: "Focused",
          location: "Archive"
        }
      });

      writeLatestState(db, save.id, state);

      assert.deepEqual(readLatestState(db, save.id), state);
    } finally {
      db.close();
    }
  });
});

test("latest states are isolated by save_id", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const firstSave = createSave(db);
      const secondSave = createSave(db);
      const firstState = createInitialState({ player: { location: "North Pier" } });
      const secondState = createInitialState({ player: { location: "South Pier" } });

      writeLatestState(db, firstSave.id, firstState);
      writeLatestState(db, secondSave.id, secondState);

      assert.equal(readLatestState(db, firstSave.id)?.player.location, "North Pier");
      assert.equal(readLatestState(db, secondSave.id)?.player.location, "South Pier");
    } finally {
      db.close();
    }
  });
});

test("latest states require an existing save", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);

      assert.throws(() => {
        writeLatestState(db, "missing-save", createInitialState());
      });
    } finally {
      db.close();
    }
  });
});

test("session bindings require an existing save", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);

      assert.throws(() => {
        bindSessionToSave(db, "session-1", "missing-save");
      });
    } finally {
      db.close();
    }
  });
});

test("story snapshots require an existing save", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);

      assert.throws(() => {
        recordEmptySystemStorySnapshot(db, "missing-save", createInitialState());
      });
    } finally {
      db.close();
    }
  });
});

test("session bindings map a PI session to a save", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);

      bindSessionToSave(db, "session-1", save.id);

      assert.equal(getBoundSave(db, "session-1"), save.id);
      assert.equal(getBoundSave(db, "missing-session"), undefined);
    } finally {
      db.close();
    }
  });
});

test("state store hydrates latest state for a save", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      const state = createInitialState({ player: { location: "Lantern Room" } });
      writeLatestState(db, save.id, state);

      const stateStore = createStateStore(db);
      const hydrated = stateStore.hydrateSave(save.id);

      assert.deepEqual(hydrated, state);
      assert.equal(stateStore.getActiveSaveId(), save.id);
    } finally {
      db.close();
    }
  });
});

test("state store persists successful mutations immediately", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      const stateStore = createStateStore(db);
      stateStore.replaceState(save.id, createInitialState());

      stateStore.mutateState((draft) => {
        draft.player.status = "Injured";
      });

      assert.equal(readLatestState(db, save.id)?.player.status, "Injured");
    } finally {
      db.close();
    }
  });
});

test("state store does not commit failed mutations", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      const stateStore = createStateStore(db);
      stateStore.replaceState(save.id, createInitialState({ player: { status: "Ready" } }));

      assert.throws(() => {
        stateStore.mutateState((draft) => {
          draft.player.status = "Broken";
          throw new Error("stop");
        });
      }, /stop/);

      assert.equal(readLatestState(db, save.id)?.player.status, "Ready");
    } finally {
      db.close();
    }
  });
});

test("state store does not update hot state when persistence fails", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    initializeSchema(db);
    const save = createSave(db);
    const stateStore = createStateStore(db);
    stateStore.replaceState(save.id, createInitialState({ player: { status: "Ready" } }));

    db.close();

    assert.throws(() => {
      stateStore.mutateState((draft) => {
        draft.player.status = "Broken";
      });
    });
    assert.equal(stateStore.getState().player.status, "Ready");
  });
});

test("state store hydrates different saves without leaking state", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const firstSave = createSave(db);
      const secondSave = createSave(db);
      writeLatestState(db, firstSave.id, createInitialState({ player: { location: "East Gate" } }));
      writeLatestState(db, secondSave.id, createInitialState({ player: { location: "West Gate" } }));

      const stateStore = createStateStore(db);
      assert.equal(stateStore.hydrateSave(firstSave.id).player.location, "East Gate");
      assert.equal(stateStore.hydrateSave(secondSave.id).player.location, "West Gate");
    } finally {
      db.close();
    }
  });
});

test("story snapshots increment per save and keep only the latest two", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const firstSave = createSave(db);
      const secondSave = createSave(db);

      recordEmptySystemStorySnapshot(db, firstSave.id, createInitialState({ scene: { summary: "one" } }));
      recordEmptySystemStorySnapshot(db, firstSave.id, createInitialState({ scene: { summary: "two" } }));
      recordEmptySystemStorySnapshot(db, firstSave.id, createInitialState({ scene: { summary: "three" } }));
      recordEmptySystemStorySnapshot(db, secondSave.id, createInitialState({ scene: { summary: "other" } }));

      const firstRows = db
        .prepare("SELECT turn_no, state_json FROM turn_snapshots WHERE save_id = ? ORDER BY turn_no")
        .all(firstSave.id) as Array<{ turn_no: number; state_json: string }>;

      assert.deepEqual(
        firstRows.map((row) => row.turn_no),
        [2, 3]
      );
      assert.equal(JSON.parse(firstRows[0]?.state_json ?? "{}").core.payload.scene.summary, "two");
      assert.equal(readPreviousSnapshotSummary(db, firstSave.id), "two");
      assert.equal(readPreviousSnapshotSummary(db, secondSave.id), undefined);
    } finally {
      db.close();
    }
  });
});

function readPreviousSnapshotSummary(
  db: ReturnType<typeof openRpDatabase>,
  saveId: string
): string | undefined {
  const row = db
    .prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ? ORDER BY turn_no DESC LIMIT 1 OFFSET 1")
    .get(saveId) as { state_json: string } | undefined;
  return row === undefined
    ? undefined
    : parseStorySnapshotEnvelope(JSON.parse(row.state_json)).core.payload.scene.summary;
}
