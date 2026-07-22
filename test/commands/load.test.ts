import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { defineSystem } from "../../src/systems/define-system.ts";
import { parseStorySnapshotEnvelope } from "../../src/state/snapshot-envelope.ts";
import { createStorySnapshotCoordinator } from "../../src/state/story-snapshot-coordinator.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";
import { readSystemState, writeSystemState } from "../../src/systems/repository.ts";
import { createSystemRuntime } from "../../src/systems/runtime.ts";

const loadCommand = await import(pathToFileURL(new URL("../../src/commands/load.ts", import.meta.url).pathname).href);
const picker = await import(pathToFileURL(new URL("../../src/commands/picker.ts", import.meta.url).pathname).href);
const saveRepository = await import(pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href);
const sessionBinding = await import(pathToFileURL(new URL("../../src/state/session-binding.ts", import.meta.url).pathname).href);
const schema = await import(pathToFileURL(new URL("../../src/state/schema.ts", import.meta.url).pathname).href);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const store = await import(pathToFileURL(new URL("../../src/state/store.ts", import.meta.url).pathname).href);

const load = loadCommand.loadCommand as typeof import("../../src/commands/load.js").loadCommand;
const pickSave = picker.pickSave as typeof import("../../src/commands/picker.js").pickSave;
const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const touchSave = saveRepository.touchSave as typeof import("../../src/state/save-repository.js").touchSave;
const bindSessionToSave = sessionBinding.bindSessionToSave as typeof import("../../src/state/session-binding.js").bindSessionToSave;
const getBoundSave = sessionBinding.getBoundSave as typeof import("../../src/state/session-binding.js").getBoundSave;
const createInitialState = schema.createInitialState as typeof import("../../src/state/schema.js").createInitialState;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const writeLatestState = sqlite.writeLatestState as typeof import("../../src/state/sqlite.js").writeLatestState;
const createStateStore = store.createStateStore as typeof import("../../src/state/store.js").createStateStore;

function expectSyncString(result: string | Promise<string>): string {
  if (result instanceof Promise) {
    throw new TypeError("Expected synchronous command output");
  }
  return result;
}

test("pickSave lists saves by updated_at desc in pages of 10", async () => {
  const saves = Array.from({ length: 12 }, (_, index) => ({
    id: `save-${index}`,
    createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
  }));

  const picked = await pickSave(saves, { page: 0, selectNumber: 2 });

  assert.equal(picked?.id, "save-10");
});

test("pickSave uses native picker before numbered fallback", async () => {
  const saves = [
    { id: "a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "b", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }
  ];

  const picked = await pickSave(saves, {
    nativePickSave: async (items) => {
      assert.equal(items.length, 2);
      return "a";
    }
  });

  assert.equal(picked?.id, "a");
});

test("pickSave sends every save to the native picker for scroll navigation", async () => {
  const saves = Array.from({ length: 12 }, (_, index) => ({
    id: `save-${index}`,
    createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
  }));

  const picked = await pickSave(saves, {
    nativePickSave: async (items) => {
      // Full list, newest first — the native picker scrolls it with up/down.
      assert.equal(items.length, 12);
      assert.equal(items[0].id, "save-11");
      assert.equal(items[11].id, "save-0");
      return "save-0";
    }
  });

  assert.equal(picked?.id, "save-0");
});

test("pickSave ignores invalid page and selection values", async () => {
  const saves = [
    { id: "old", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "new", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }
  ];

  const picked = await pickSave(saves, { page: -1, selectNumber: 1.5 });

  assert.equal(picked, undefined);
});

test("/load without a selection renders numbered fallback instead of loading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-load-list-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const saveRecord = createSave(db);
    const stateStore = createStateStore(db);

    const output = await load.execute({}, { db, stateStore, piSessionId: "session-1" });

    assert.match(output, new RegExp(`1\\. .* \\| ${saveRecord.id}`));
    assert.equal(stateStore.getActiveSaveId(), undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/load reports invalid picker input distinctly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-load-invalid-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    createSave(db);
    const stateStore = createStateStore(db);

    const output = await load.execute({ page: -1, selectNumber: 1 }, { db, stateStore, piSessionId: "session-1" });

    assert.match(output, /存档选择无效/);
    assert.equal(stateStore.getActiveSaveId(), undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/load binds selected save, hydrates latest state, and prints status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-load-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const first = createSave(db);
    const second = createSave(db);
    touchSave(db, first.id);
    writeLatestState(db, first.id, createInitialState({ player: { name: "First", location: "Pier" } }));
    writeLatestState(db, second.id, createInitialState({ player: { name: "Second", location: "Tower" } }));
    bindSessionToSave(db, "session-1", first.id);
    const stateStore = createStateStore(db);
    stateStore.hydrateSave(first.id);

    const output = await load.execute({ selectNumber: 2 }, { db, stateStore, piSessionId: "session-1" });

    assert.equal(getBoundSave(db, "session-1"), second.id);
    assert.equal(stateStore.getActiveSaveId(), second.id);
    assert.match(output, /玩家：Second/);
    assert.match(output, /地点：Tower/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/load migrates System state before activating and binding the selected save", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-load-system-migration-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));

  try {
    initializeSchema(db);
    const current = createSave(db);
    const target = createSave(db);
    writeLatestState(db, current.id, createInitialState({ player: { name: "Current" } }));
    writeLatestState(db, target.id, createInitialState({ player: { name: "Target" } }));
    writeSystemState(db, target.id, {
      name: "progression",
      version: 1,
      payload: { xp: 25 }
    });
    bindSessionToSave(db, "session-1", current.id);
    const stateStore = createStateStore(db);
    stateStore.hydrateSave(current.id);

    const progression = defineSystem({
      name: "progression",
      version: 2,
      initialize: () => ({ xp: 0, level: 1 }),
      parse: (payload) => payload as { xp: number; level: number },
      migrate: (fromVersion, payload) => ({
        version: fromVersion + 1,
        payload: { ...(payload as { xp: number }), level: 1 }
      }),
      commands: {},
      project: (_context, state) => state
    });
    const systemRegistry = createSystemRegistry([progression], {
      capabilities: new Map()
    });
    const systemRuntime = createSystemRuntime({ db, registry: systemRegistry });

    await load.execute(
      {},
      {
        db,
        stateStore,
        systemRuntime,
        piSessionId: "session-1",
        nativePickSave: async () => target.id
      }
    );

    assert.deepEqual(readSystemState(db, target.id, "progression"), {
      name: "progression",
      version: 2,
      payload: { xp: 25, level: 1 }
    });
    assert.equal(stateStore.getActiveSaveId(), target.id);
    assert.equal(getBoundSave(db, "session-1"), target.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/load preserves the current save when System migration fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-load-system-rollback-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  const previousActiveSave = process.env.RP_ACTIVE_SAVE;

  try {
    initializeSchema(db);
    const current = createSave(db);
    const target = createSave(db);
    writeLatestState(db, current.id, createInitialState({ player: { name: "Current" } }));
    writeLatestState(db, target.id, createInitialState({ player: { name: "Target" } }));
    writeSystemState(db, target.id, {
      name: "progression",
      version: 1,
      payload: { xp: 25 }
    });
    bindSessionToSave(db, "session-1", current.id);
    const stateStore = createStateStore(db);
    stateStore.hydrateSave(current.id);
    process.env.RP_ACTIVE_SAVE = current.id;

    const progression = defineSystem({
      name: "progression",
      version: 2,
      initialize: () => ({ xp: 0, level: 1 }),
      parse: (payload) => payload as { xp: number; level: number },
      migrate: () => {
        throw new Error("migration failed");
      },
      commands: {},
      project: (_context, state) => state
    });
    const systemRegistry = createSystemRegistry([progression], {
      capabilities: new Map()
    });
    const systemRuntime = createSystemRuntime({ db, registry: systemRegistry });

    await assert.rejects(
      async () =>
        load.execute(
          {},
          {
            db,
            stateStore,
            systemRuntime,
            piSessionId: "session-1",
            nativePickSave: async () => target.id
          }
        ),
      /MIGRATION_FAILED/
    );

    assert.deepEqual(readSystemState(db, target.id, "progression"), {
      name: "progression",
      version: 1,
      payload: { xp: 25 }
    });
    assert.equal(stateStore.getActiveSaveId(), current.id);
    assert.equal(stateStore.getState().player.name, "Current");
    assert.equal(process.env.RP_ACTIVE_SAVE, current.id);
    assert.equal(getBoundSave(db, "session-1"), current.id);
  } finally {
    if (previousActiveSave === undefined) {
      delete process.env.RP_ACTIVE_SAVE;
    } else {
      process.env.RP_ACTIVE_SAVE = previousActiveSave;
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/load promotes a legacy baseline after System activation and before binding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-load-snapshot-promotion-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const target = createSave(db);
    const current = createInitialState({ scene: { summary: "current deterministic state" } });
    writeLatestState(db, target.id, current);
    db.prepare(
      "INSERT INTO turn_snapshots (save_id, turn_no, state_json, created_at) VALUES (?, ?, ?, ?)"
    ).run(target.id, 5, JSON.stringify(createInitialState({ scene: { summary: "legacy state" } })), "t5");
    const stateStore = createStateStore(db);
    const systemRegistry = createSystemRegistry([], { capabilities: new Map() });
    const systemRuntime = createSystemRuntime({ db, registry: systemRegistry });
    const storySnapshots = createStorySnapshotCoordinator({ db, registry: systemRegistry });

    await load.execute(
      {},
      {
        db,
        stateStore,
        systemRuntime,
        storySnapshots,
        piSessionId: "session-1",
        nativePickSave: async () => target.id
      }
    );

    const row = db
      .prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ? AND turn_no = 5")
      .get(target.id) as { state_json: string };
    assert.equal(parseStorySnapshotEnvelope(JSON.parse(row.state_json)).core.payload.scene.summary, "current deterministic state");
    assert.equal(stateStore.getActiveSaveId(), target.id);
    assert.equal(getBoundSave(db, "session-1"), target.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/load keeps hot state, env, roles boundary, and binding unchanged when baseline promotion fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-load-snapshot-promotion-failure-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  const previousActiveSave = process.env.RP_ACTIVE_SAVE;
  try {
    initializeSchema(db);
    const current = createSave(db);
    const target = createSave(db);
    writeLatestState(db, current.id, createInitialState({ player: { name: "Current" } }));
    writeLatestState(db, target.id, createInitialState({ player: { name: "Target" } }));
    writeSystemState(db, target.id, { name: "progression", version: 1, payload: { xp: 25 } });
    db.prepare(
      `INSERT INTO character_summaries (
         save_id, character, summary, covers_up_to_seq, last_day, last_hour, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(target.id, "han-yue", "invalid", 1, 1, 8, "t1");
    db.prepare(
      "INSERT INTO turn_snapshots (save_id, turn_no, state_json, created_at) VALUES (?, ?, ?, ?)"
    ).run(target.id, 5, JSON.stringify(createInitialState()), "t5");
    bindSessionToSave(db, "session-1", current.id);
    const stateStore = createStateStore(db);
    stateStore.hydrateSave(current.id);
    process.env.RP_ACTIVE_SAVE = current.id;

    const progression = defineSystem({
      name: "progression",
      version: 2,
      initialize: () => ({ xp: 0, level: 1 }),
      parse: (payload) => payload as { xp: number; level: number },
      migrate: (_fromVersion, payload) => ({
        version: 2,
        payload: { ...(payload as { xp: number }), level: 1 }
      }),
      commands: {},
      project: (_context, state) => state
    });
    const systemRegistry = createSystemRegistry([progression], { capabilities: new Map() });
    const systemRuntime = createSystemRuntime({ db, registry: systemRegistry });
    const storySnapshots = createStorySnapshotCoordinator({ db, registry: systemRegistry });

    await assert.rejects(
      async () =>
        load.execute(
          {},
          {
            db,
            stateStore,
            systemRuntime,
            storySnapshots,
            piSessionId: "session-1",
            nativePickSave: async () => target.id
          }
        ),
      /SNAPSHOT_INCOMPATIBLE/
    );

    assert.deepEqual(readSystemState(db, target.id, "progression"), {
      name: "progression",
      version: 2,
      payload: { xp: 25, level: 1 }
    });
    assert.equal(stateStore.getActiveSaveId(), current.id);
    assert.equal(stateStore.getState().player.name, "Current");
    assert.equal(process.env.RP_ACTIVE_SAVE, current.id);
    assert.equal(getBoundSave(db, "session-1"), current.id);
    const row = db
      .prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ? AND turn_no = 5")
      .get(target.id) as { state_json: string };
    assert.equal(JSON.parse(row.state_json).schemaVersion, undefined);
  } finally {
    if (previousActiveSave === undefined) delete process.env.RP_ACTIVE_SAVE;
    else process.env.RP_ACTIVE_SAVE = previousActiveSave;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
