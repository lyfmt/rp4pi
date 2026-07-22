import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNewGame } from "../../src/state/new-game.ts";
import { createInitialState } from "../../src/state/schema.ts";
import { getBoundSave } from "../../src/state/session-binding.ts";
import { initializeSchema, openRpDatabase, readLatestState } from "../../src/state/sqlite.ts";
import { createStateStore } from "../../src/state/store.ts";
import { readSaveCommitMetadata } from "../../src/systems/commit-repository.ts";
import { defineSystem } from "../../src/systems/define-system.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";
import { listSystemStates } from "../../src/systems/repository.ts";

test("createNewGame atomically initializes core and every registered System namespace", () => {
  const directory = mkdtempSync(join(tmpdir(), "rp-new-game-systems-"));
  const db = openRpDatabase(join(directory, "state.sqlite"));
  const previousActiveSave = process.env.RP_ACTIVE_SAVE;

  try {
    initializeSchema(db);
    const stateStore = createStateStore(db);
    const progression = defineSystem({
      name: "progression",
      version: 1,
      initialize: () => ({ xp: 0 }),
      parse: (payload) => payload as { xp: number },
      commands: {},
      project: (_context, state) => state
    });
    const reputation = defineSystem({
      name: "reputation",
      version: 2,
      initialize: () => ({ factions: {} }),
      parse: (payload) => payload as { factions: Record<string, number> },
      commands: {},
      project: (_context, state) => state
    });
    const systemRegistry = createSystemRegistry([progression, reputation], {
      capabilities: new Map()
    });
    const state = createInitialState({
      player: { name: "Ari", location: "Border Relay", status: "Awake" },
      scene: { summary: "A wounded courier waits." }
    });

    const save = createNewGame({
      db,
      stateStore,
      systemRegistry,
      state,
      piSessionId: "session-a"
    });

    assert.deepEqual(readLatestState(db, save.id), state);
    assert.deepEqual(listSystemStates(db, save.id), [
      { name: "progression", version: 1, payload: { xp: 0 } },
      { name: "reputation", version: 2, payload: { factions: {} } }
    ]);
    assert.deepEqual(readSaveCommitMetadata(db, save.id), {
      revision: 0,
      branchEpoch: 0
    });
    assert.equal(getBoundSave(db, "session-a"), save.id);
    assert.equal(stateStore.getActiveSaveId(), save.id);
    assert.deepEqual(stateStore.getState(), state);
  } finally {
    restoreActiveSave(previousActiveSave);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("createNewGame rolls back every persisted artifact when System initialization fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "rp-new-game-rollback-"));
  const db = openRpDatabase(join(directory, "state.sqlite"));
  const previousActiveSave = process.env.RP_ACTIVE_SAVE;

  try {
    initializeSchema(db);
    const stateStore = createStateStore(db);
    const first = defineSystem({
      name: "first",
      version: 1,
      initialize: () => ({ ready: true }),
      parse: (payload) => payload as { ready: boolean },
      commands: {},
      project: (_context, state) => state
    });
    const second = defineSystem({
      name: "second",
      version: 1,
      initialize: () => {
        throw new Error("initialization failed");
      },
      parse: (payload) => payload,
      commands: {},
      project: (_context, state) => state
    });
    const systemRegistry = createSystemRegistry([first, second], {
      capabilities: new Map()
    });

    assert.throws(
      () =>
        createNewGame({
          db,
          stateStore,
          systemRegistry,
          state: createInitialState(),
          piSessionId: "session-a"
        }),
      /SYSTEM_STATE_INVALID/
    );

    for (const table of [
      "saves",
      "latest_states",
      "system_states",
      "system_save_revisions",
      "system_commit_receipts",
      "session_bindings"
    ]) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      assert.equal(row.count, 0, `${table} must be empty after rollback`);
    }
    assert.equal(stateStore.getActiveSaveId(), undefined);
    assert.equal(process.env.RP_ACTIVE_SAVE, previousActiveSave);
  } finally {
    restoreActiveSave(previousActiveSave);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function restoreActiveSave(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.RP_ACTIVE_SAVE;
  } else {
    process.env.RP_ACTIVE_SAVE = value;
  }
}
