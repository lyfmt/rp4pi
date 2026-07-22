import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listDynamicRoles, replaceDynamicRoles } from "../../src/state/dynamic-roles.ts";
import { createSave } from "../../src/state/save-repository.ts";
import { createInitialState } from "../../src/state/schema.ts";
import { parseStorySnapshotEnvelope } from "../../src/state/snapshot-envelope.ts";
import {
  initializeSchema,
  openRpDatabase,
  readLatestState,
  writeLatestState,
  type RpDatabase
} from "../../src/state/sqlite.ts";
import { createStorySnapshotCoordinator } from "../../src/state/story-snapshot-coordinator.ts";
import { appendCharacterTrajectory, writeCharacterSummary } from "../../src/state/trajectory.ts";
import { defineSystem } from "../../src/systems/define-system.ts";
import {
  ensureSaveCommitMetadata,
  readCommitReceipt,
  readSaveCommitMetadata,
  writeCommitReceipt,
  writeSaveRevision
} from "../../src/systems/commit-repository.ts";
import { SystemRuntimeError } from "../../src/systems/errors.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";
import { listSystemStates, readSystemState, writeSystemState } from "../../src/systems/repository.ts";
import { createSystemRuntime } from "../../src/systems/runtime.ts";
import type { SystemDefinition } from "../../src/systems/types.ts";

test("capture stores every deterministic participant in stable namespace order", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const registry = createSystemRegistry([opaqueSystem("progression"), opaqueSystem("generator")], {
      capabilities: new Map()
    });
    writeSystemState(db, save.id, {
      name: "progression",
      version: 2,
      payload: { level: 2, xp: 50, perks: [] }
    });
    writeSystemState(db, save.id, { name: "generator", version: 1, payload: { seed: 7 } });
    replaceDynamicRoles(db, save.id, [
      {
        name: "han-yue",
        description: "守门人",
        persona: "你是韩越。",
        createdAt: "2026-07-10T01:00:00.000Z",
        updatedAt: "2026-07-10T02:00:00.000Z"
      }
    ]);
    appendCharacterTrajectory(db, save.id, {
      character: "han-yue",
      turnNo: 1,
      content: "检查证件",
      gameTime: { day: 1, hour: 9 }
    });
    writeCharacterSummary(db, save.id, {
      character: "han-yue",
      summary: "已在门口值守",
      coversUpToSeq: 1,
      lastTime: { day: 1, hour: 9 }
    });
    const core = createInitialState({ scene: { summary: "Gate scene" } });
    const coordinator = createStorySnapshotCoordinator({ db, registry });

    const turnNo = coordinator.captureSuccessfulStory(save.id, core);
    const row = db
      .prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ? AND turn_no = ?")
      .get(save.id, turnNo) as { state_json: string };
    const envelope = parseStorySnapshotEnvelope(JSON.parse(row.state_json));

    assert.equal(turnNo, 1);
    assert.equal(envelope.core.payload.scene.summary, "Gate scene");
    assert.deepEqual(Object.keys(envelope.systems), ["generator", "progression"]);
    assert.deepEqual(envelope.systems.generator, { version: 1, payload: { seed: 7 } });
    assert.deepEqual(envelope.systems.progression, {
      version: 2,
      payload: { level: 2, perks: [], xp: 50 }
    });
    assert.equal(envelope.dynamicRoles[0]?.persona, "你是韩越。");
    assert.deepEqual(envelope.trajectory.watermarks, { "han-yue": 1 });
    assert.equal(envelope.trajectory.summaries[0]?.summary, "已在门口值守");
    assert.deepEqual(envelope.capabilities, {});
  });
});

test("capture rejects an incomplete registered namespace set before inserting", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const registry = createSystemRegistry([opaqueSystem("generator"), opaqueSystem("progression")], {
      capabilities: new Map()
    });
    writeSystemState(db, save.id, { name: "progression", version: 1, payload: { level: 1 } });
    const coordinator = createStorySnapshotCoordinator({ db, registry });

    assert.throws(
      () => coordinator.captureSuccessfulStory(save.id, createInitialState()),
      (error) => error instanceof SystemRuntimeError && error.code === "SNAPSHOT_INCOMPATIBLE"
    );
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM turn_snapshots WHERE save_id = ?")
      .get(save.id) as { count: number };
    assert.equal(row.count, 0);
  });
});

test("capture keeps the latest two active story snapshots", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const registry = createSystemRegistry([], { capabilities: new Map() });
    const coordinator = createStorySnapshotCoordinator({ db, registry });

    coordinator.captureSuccessfulStory(save.id, createInitialState({ scene: { summary: "one" } }));
    coordinator.captureSuccessfulStory(save.id, createInitialState({ scene: { summary: "two" } }));
    coordinator.captureSuccessfulStory(save.id, createInitialState({ scene: { summary: "three" } }));

    const turns = db
      .prepare("SELECT turn_no FROM turn_snapshots WHERE save_id = ? ORDER BY turn_no")
      .all(save.id)
      .map((row) => row.turn_no);
    assert.deepEqual(turns, [2, 3]);
  });
});

test("promote upgrades the latest legacy row from current participants without advancing metadata", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const registry = createSystemRegistry([opaqueSystem("progression")], {
      capabilities: new Map()
    });
    const coordinator = createStorySnapshotCoordinator({ db, registry });
    const currentCore = createInitialState({ scene: { summary: "current state" } });
    writeLatestState(db, save.id, currentCore);
    writeSystemState(db, save.id, {
      name: "progression",
      version: 2,
      payload: { level: 2, xp: 50 }
    });
    replaceDynamicRoles(db, save.id, [
      {
        name: "han-yue",
        description: "守门人",
        persona: "current persona",
        createdAt: "2026-07-10T01:00:00.000Z",
        updatedAt: "2026-07-10T02:00:00.000Z"
      }
    ]);
    appendCharacterTrajectory(db, save.id, {
      character: "han-yue",
      turnNo: 5,
      content: "current trajectory",
      gameTime: { day: 2, hour: 10 }
    });
    insertLegacySnapshot(db, save.id, 4, createInitialState({ scene: { summary: "legacy four" } }));
    insertLegacySnapshot(db, save.id, 5, createInitialState({ scene: { summary: "legacy five" } }));
    ensureSaveCommitMetadata(db, save.id);

    const result = coordinator.promoteLegacySnapshotBaseline(save.id);

    assert.deepEqual(result, { promoted: true, turnNo: 5 });
    const rows = snapshotRows(db, save.id);
    assert.deepEqual(rows.map((row) => row.turn_no), [4, 5]);
    assert.equal(JSON.parse(rows[0]!.state_json).schemaVersion, undefined);
    const promoted = parseStorySnapshotEnvelope(JSON.parse(rows[1]!.state_json));
    assert.equal(promoted.core.payload.scene.summary, "current state");
    assert.deepEqual(promoted.systems.progression, {
      version: 2,
      payload: { level: 2, xp: 50 }
    });
    assert.equal(promoted.dynamicRoles[0]?.persona, "current persona");
    assert.deepEqual(promoted.trajectory.watermarks, { "han-yue": 1 });
    assert.deepEqual(readSaveCommitMetadata(db, save.id), { revision: 0, branchEpoch: 0 });

    coordinator.captureSuccessfulStory(save.id, currentCore);
    assert.deepEqual(snapshotRows(db, save.id).map((row) => row.turn_no), [5, 6]);
  });
});

test("promote is a no-op without a snapshot or when the latest row is already an envelope", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const registry = createSystemRegistry([], { capabilities: new Map() });
    const coordinator = createStorySnapshotCoordinator({ db, registry });
    const current = createInitialState();
    writeLatestState(db, save.id, current);

    assert.deepEqual(coordinator.promoteLegacySnapshotBaseline(save.id), { promoted: false });
    coordinator.captureSuccessfulStory(save.id, current);
    const before = snapshotRows(db, save.id);

    assert.deepEqual(coordinator.promoteLegacySnapshotBaseline(save.id), { promoted: false });
    assert.deepEqual(snapshotRows(db, save.id), before);
  });
});

test("promote leaves the legacy row and current core unchanged when participants are incompatible", () => {
  for (const failure of ["systems", "core", "trajectory"] as const) {
    withDatabase((db) => {
      const save = createSave(db);
      const registry = createSystemRegistry(
        failure === "systems" ? [opaqueSystem("missing-system")] : [],
        { capabilities: new Map() }
      );
      const coordinator = createStorySnapshotCoordinator({ db, registry });
      const current = createInitialState({ scene: { summary: `current-${failure}` } });
      writeLatestState(db, save.id, current);
      if (failure === "core") {
        db.prepare("UPDATE latest_states SET state_json = ? WHERE save_id = ?").run('{"player":null}', save.id);
      }
      if (failure === "trajectory") {
        db.prepare(
          `INSERT INTO character_summaries (
             save_id, character, summary, covers_up_to_seq, last_day, last_hour, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(save.id, "han-yue", "invalid", 1, 1, 8, "t1");
      }
      insertLegacySnapshot(db, save.id, 5, createInitialState({ scene: { summary: "legacy" } }));
      const snapshotBefore = snapshotRows(db, save.id);
      const coreBefore = db.prepare("SELECT state_json FROM latest_states WHERE save_id = ?").get(save.id);

      assert.throws(
        () => coordinator.promoteLegacySnapshotBaseline(save.id),
        (error) => error instanceof SystemRuntimeError && error.code === "SNAPSHOT_INCOMPATIBLE"
      );
      assert.deepEqual(snapshotRows(db, save.id), snapshotBefore, failure);
      assert.deepEqual(
        db.prepare("SELECT state_json FROM latest_states WHERE save_id = ?").get(save.id),
        coreBefore,
        failure
      );
    });
  }
});

test("promote rolls back when SQLite rejects the baseline update", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const coordinator = createStorySnapshotCoordinator({
      db,
      registry: createSystemRegistry([], { capabilities: new Map() })
    });
    const current = createInitialState({ scene: { summary: "current" } });
    writeLatestState(db, save.id, current);
    insertLegacySnapshot(db, save.id, 5, createInitialState({ scene: { summary: "legacy" } }));
    db.exec(
      `CREATE TRIGGER reject_snapshot_promotion
       BEFORE UPDATE OF state_json ON turn_snapshots
       BEGIN SELECT RAISE(ABORT, 'snapshot update rejected'); END`
    );
    const before = snapshotRows(db, save.id);

    assert.throws(() => coordinator.promoteLegacySnapshotBaseline(save.id), /snapshot update rejected/);
    assert.deepEqual(snapshotRows(db, save.id), before);
    assert.deepEqual(readLatestState(db, save.id), current);
  });
});

test("restore atomically replaces every participant, supersedes latest, and advances branch metadata", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const progression = statefulSystem("progression");
    const quest = statefulSystem("quest");
    const registry = createSystemRegistry([progression, quest], { capabilities: new Map() });
    const runtime = createSystemRuntime({ db, registry });
    runtime.activateSave(save.id);
    const coordinator = createStorySnapshotCoordinator({ db, registry, systemRuntime: runtime });

    const targetCore = createInitialState({ scene: { summary: "target" } });
    writeLatestState(db, save.id, targetCore);
    writeSystemState(db, save.id, { name: "progression", version: 1, payload: { value: 10 } });
    writeSystemState(db, save.id, { name: "quest", version: 1, payload: { value: 20 } });
    replaceDynamicRoles(db, save.id, [role("old-role", "old persona")]);
    appendCharacterTrajectory(db, save.id, {
      character: "old-role",
      turnNo: 1,
      content: "target entry",
      gameTime: { day: 1, hour: 9 }
    });
    writeCharacterSummary(db, save.id, {
      character: "old-role",
      summary: "target summary",
      coversUpToSeq: 1,
      lastTime: { day: 1, hour: 9 }
    });
    coordinator.captureSuccessfulStory(save.id, targetCore);

    const latestCore = createInitialState({ scene: { summary: "latest" } });
    writeLatestState(db, save.id, latestCore);
    writeSystemState(db, save.id, { name: "progression", version: 1, payload: { value: 99 } });
    writeSystemState(db, save.id, { name: "quest", version: 1, payload: { value: 88 } });
    replaceDynamicRoles(db, save.id, [role("new-role", "new persona")]);
    appendCharacterTrajectory(db, save.id, {
      character: "old-role",
      turnNo: 2,
      content: "latest entry",
      gameTime: { day: 2, hour: 9 }
    });
    appendCharacterTrajectory(db, save.id, {
      character: "new-role",
      turnNo: 2,
      content: "new branch entry",
      gameTime: { day: 2, hour: 9 }
    });
    coordinator.captureSuccessfulStory(save.id, latestCore);
    writeSaveRevision(db, save.id, 2);

    const restored = coordinator.restorePreviousAndSupersedeLatest(save.id);

    assert.deepEqual(restored, {
      restoredTurnNo: 1,
      supersededTurnNo: 2,
      revision: 3,
      branchEpoch: 1
    });
    assert.equal(readLatestState(db, save.id)?.scene.summary, "target");
    assert.deepEqual(listSystemStates(db, save.id), [
      { name: "progression", version: 1, payload: { value: 10 } },
      { name: "quest", version: 1, payload: { value: 20 } }
    ]);
    assert.deepEqual(listDynamicRoles(db, save.id), [role("old-role", "old persona")]);
    assert.deepEqual(
      db
        .prepare("SELECT character, seq, content FROM character_trajectories WHERE save_id = ? ORDER BY character, seq")
        .all(save.id)
        .map((row) => ({ ...row })),
      [{ character: "old-role", seq: 1, content: "target entry" }]
    );
    assert.equal(
      (db.prepare("SELECT summary FROM character_summaries WHERE save_id = ?").get(save.id) as { summary: string }).summary,
      "target summary"
    );
    assert.deepEqual(snapshotRows(db, save.id).map((row) => row.turn_no), [1]);
    assert.deepEqual(readSaveCommitMetadata(db, save.id), { revision: 3, branchEpoch: 1 });
  });
});

test("restore initializes a registry module absent from the snapshot and replaces the exact namespace set", () => {
  withDatabase((db) => {
    const save = createSave(db);
    writeLatestState(db, save.id, createInitialState({ scene: { summary: "current" } }));
    writeSystemState(db, save.id, { name: "progression", version: 1, payload: { value: 99 } });
    writeSystemState(db, save.id, { name: "obsolete", version: 1, payload: { value: 7 } });
    ensureSaveCommitMetadata(db, save.id);
    const target = snapshotEnvelope({
      coreSummary: "target",
      systems: { progression: { version: 1, payload: { value: 10 } } }
    });
    insertEnvelopeSnapshot(db, save.id, 1, target);
    insertEnvelopeSnapshot(db, save.id, 2, snapshotEnvelope({ coreSummary: "latest", systems: {} }));
    const generator = statefulSystem("generator", { initialize: () => ({ value: 42 }) });
    const registry = createSystemRegistry([statefulSystem("progression"), generator], {
      capabilities: new Map()
    });
    const coordinator = createStorySnapshotCoordinator({ db, registry });

    coordinator.restorePreviousAndSupersedeLatest(save.id);

    assert.deepEqual(listSystemStates(db, save.id), [
      { name: "generator", version: 1, payload: { value: 42 } },
      { name: "progression", version: 1, payload: { value: 10 } }
    ]);
  });
});

test("restore invalidates stale revisions and isolates idempotency receipts by branch epoch", async () => {
  await withAsyncDatabase(async (db) => {
    const save = createSave(db);
    const executions = { count: 0 };
    const progression = commandSystem(executions);
    const registry = createSystemRegistry([progression], { capabilities: new Map() });
    const runtime = createSystemRuntime({ db, registry });
    runtime.activateSave(save.id);
    const coordinator = createStorySnapshotCoordinator({ db, registry, systemRuntime: runtime });
    const core = createInitialState();
    writeLatestState(db, save.id, core);
    coordinator.captureSuccessfulStory(save.id, core);
    coordinator.captureSuccessfulStory(save.id, core);

    const request = {
      saveId: save.id,
      requestId: "call-1",
      caller: { kind: "gm" as const, sessionId: "session-test" },
      operations: [{ system: "progression", command: "add", input: { amount: 1 } }] as const
    };
    const branchZeroReceipt = await runtime.commit(request);
    assert.equal(branchZeroReceipt.revision, 1);
    coordinator.restorePreviousAndSupersedeLatest(save.id);

    await assert.rejects(
      runtime.commit({ ...request, requestId: "stale", expectedRevision: 1 }),
      (error) => error instanceof SystemRuntimeError && error.code === "STATE_COMMIT_CONFLICT"
    );
    const branchOneReceipt = await runtime.commit(request);

    assert.notEqual(branchOneReceipt.commitId, branchZeroReceipt.commitId);
    assert.equal(branchOneReceipt.branchEpoch, 1);
    assert.equal(executions.count, 2);
    assert.deepEqual(
      readCommitReceipt(db, save.id, 0, "call-1")?.receipt,
      branchZeroReceipt
    );
    assert.deepEqual(readCommitReceipt(db, save.id, 1, "call-1")?.receipt, branchOneReceipt);
  });
});

test("restore failure matrix leaves all participants, chain metadata, and receipts unchanged", () => {
  const cases: Array<{
    name: string;
    target: ReturnType<typeof snapshotEnvelope>;
    definitions: () => SystemDefinition<unknown>[];
  }> = [
    {
      name: "snapshot module is no longer registered",
      target: snapshotEnvelope({
        coreSummary: "target",
        systems: {
          progression: { version: 2, payload: { value: 10 } },
          removed: { version: 1, payload: { value: 1 } }
        }
      }),
      definitions: () => [statefulSystem("progression", { version: 2 })]
    },
    {
      name: "snapshot version is from the future",
      target: snapshotEnvelope({
        coreSummary: "target",
        systems: { progression: { version: 3, payload: { value: 10 } } }
      }),
      definitions: () => [statefulSystem("progression", { version: 2 })]
    },
    {
      name: "migration throws",
      target: snapshotEnvelope({
        coreSummary: "target",
        systems: { progression: { version: 1, payload: { value: 10 } } }
      }),
      definitions: () => [
        statefulSystem("progression", {
          version: 2,
          migrate: () => {
            throw new Error("migration failed");
          }
        })
      ]
    },
    {
      name: "migration result does not advance",
      target: snapshotEnvelope({
        coreSummary: "target",
        systems: { progression: { version: 1, payload: { value: 10 } } }
      }),
      definitions: () => [
        statefulSystem("progression", {
          version: 2,
          migrate: (_version, payload) => ({ version: 1, payload })
        })
      ]
    },
    {
      name: "new module initialization fails",
      target: snapshotEnvelope({
        coreSummary: "target",
        systems: { progression: { version: 2, payload: { value: 10 } } }
      }),
      definitions: () => [
        statefulSystem("progression", { version: 2 }),
        statefulSystem("generator", {
          initialize: () => {
            throw new Error("initialize failed");
          }
        })
      ]
    },
    {
      name: "dynamic role participant is invalid",
      target: {
        ...snapshotEnvelope({ coreSummary: "target", systems: {} }),
        dynamicRoles: [{ name: 1 }]
      } as unknown as ReturnType<typeof snapshotEnvelope>,
      definitions: () => []
    },
    {
      name: "trajectory summary is past its watermark",
      target: {
        ...snapshotEnvelope({ coreSummary: "target", systems: {} }),
        trajectory: {
          watermarks: { "han-yue": 0 },
          summaries: [
            {
              character: "han-yue",
              summary: "invalid",
              coversUpToSeq: 1,
              lastDay: 1,
              lastHour: 8,
              updatedAt: "t1"
            }
          ]
        }
      },
      definitions: () => []
    },
    {
      name: "second System parser rejects",
      target: snapshotEnvelope({
        coreSummary: "target",
        systems: {
          first: { version: 1, payload: { value: 10 } },
          second: { version: 1, payload: { value: 20 } }
        }
      }),
      definitions: () => [
        statefulSystem("first"),
        statefulSystem("second", {
          parse: () => {
            throw new Error("second parser failed");
          }
        })
      ]
    }
  ];

  for (const failure of cases) {
    withDatabase((db) => {
      const save = createSave(db);
      writeLatestState(db, save.id, createInitialState({ scene: { summary: "current" } }));
      writeSystemState(db, save.id, { name: "progression", version: 2, payload: { value: 99 } });
      replaceDynamicRoles(db, save.id, [role("current-role", "current persona")]);
      appendCharacterTrajectory(db, save.id, {
        character: "current-role",
        turnNo: 2,
        content: "current trajectory",
        gameTime: { day: 2, hour: 9 }
      });
      ensureSaveCommitMetadata(db, save.id);
      writeSaveRevision(db, save.id, 4);
      writeCommitReceipt(db, save.id, 0, "existing", "hash", { commitId: "old" });
      insertEnvelopeSnapshot(db, save.id, 1, failure.target);
      insertEnvelopeSnapshot(
        db,
        save.id,
        2,
        snapshotEnvelope({ coreSummary: "latest", systems: {} })
      );
      const coordinator = createStorySnapshotCoordinator({
        db,
        registry: createSystemRegistry(failure.definitions(), { capabilities: new Map() })
      });
      const before = dumpRestoreState(db, save.id);

      assert.throws(
        () => coordinator.restorePreviousAndSupersedeLatest(save.id),
        (error) => error instanceof Error,
        failure.name
      );
      assert.deepEqual(dumpRestoreState(db, save.id), before, failure.name);
    });
  }
});

function opaqueSystem(name: string): SystemDefinition<unknown> {
  return defineSystem({
    name,
    version: 1,
    initialize: () => ({}),
    parse: () => {
      throw new Error("capture must not call the domain parser");
    },
    commands: {},
    project: () => ({})
  });
}

function statefulSystem(
  name: string,
  overrides: Partial<{
    version: number;
    initialize: () => unknown;
    parse: (payload: unknown) => { value: number };
    migrate: (fromVersion: number, payload: unknown) => { version: number; payload: unknown };
  }> = {}
): SystemDefinition<{ value: number }> {
  return defineSystem({
    name,
    version: overrides.version ?? 1,
    initialize: overrides.initialize ?? (() => ({ value: 0 })),
    parse: overrides.parse ?? parseValueState,
    migrate: overrides.migrate,
    commands: {},
    project: (_context, state) => state
  });
}

function commandSystem(executions: { count: number }): SystemDefinition<{ value: number }> {
  return defineSystem({
    name: "progression",
    version: 1,
    initialize: () => ({ value: 0 }),
    parse: parseValueState,
    commands: {
      add: {
        parseInput(input) {
          const amount = (input as { amount?: unknown })?.amount;
          if (!Number.isInteger(amount)) throw new Error("invalid amount");
          return { amount: amount as number };
        },
        execute(_context, state, input) {
          executions.count += 1;
          const value = state.value + (input as { amount: number }).amount;
          return { nextState: { value }, result: { value } };
        }
      }
    },
    project: (_context, state) => state
  });
}

function parseValueState(payload: unknown): { value: number } {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Number.isInteger((payload as { value?: unknown }).value)
  ) {
    throw new Error("invalid value state");
  }
  return payload as { value: number };
}

function role(name: string, persona: string) {
  return {
    name,
    description: `${name} description`,
    persona,
    createdAt: "2026-07-10T01:00:00.000Z",
    updatedAt: "2026-07-10T02:00:00.000Z"
  };
}

type TestSnapshotEnvelope = {
  schemaVersion: 1;
  core: { version: 1; payload: ReturnType<typeof createInitialState> };
  systems: Record<string, { version: number; payload: unknown }>;
  dynamicRoles: unknown[];
  trajectory: { watermarks: Record<string, number>; summaries: unknown[] };
  capabilities: Record<string, unknown>;
};

function snapshotEnvelope(input: {
  coreSummary: string;
  systems: Record<string, { version: number; payload: unknown }>;
}): TestSnapshotEnvelope {
  return {
    schemaVersion: 1,
    core: {
      version: 1,
      payload: createInitialState({ scene: { summary: input.coreSummary } })
    },
    systems: input.systems,
    dynamicRoles: [],
    trajectory: { watermarks: {}, summaries: [] },
    capabilities: {}
  };
}

function insertEnvelopeSnapshot(
  db: RpDatabase,
  saveId: string,
  turnNo: number,
  envelope: unknown
): void {
  db.prepare(
    "INSERT INTO turn_snapshots (save_id, turn_no, state_json, created_at) VALUES (?, ?, ?, ?)"
  ).run(saveId, turnNo, JSON.stringify(envelope), `turn-${turnNo}`);
}

function insertLegacySnapshot(db: RpDatabase, saveId: string, turnNo: number, state: unknown): void {
  db.prepare(
    "INSERT INTO turn_snapshots (save_id, turn_no, state_json, created_at) VALUES (?, ?, ?, ?)"
  ).run(saveId, turnNo, JSON.stringify(state), `turn-${turnNo}`);
}

function snapshotRows(db: RpDatabase, saveId: string): Array<{ turn_no: number; state_json: string }> {
  return db
    .prepare("SELECT turn_no, state_json FROM turn_snapshots WHERE save_id = ? ORDER BY turn_no")
    .all(saveId) as Array<{ turn_no: number; state_json: string }>;
}

function dumpRestoreState(db: RpDatabase, saveId: string): unknown {
  return {
    core: db.prepare("SELECT * FROM latest_states WHERE save_id = ?").all(saveId),
    systems: db
      .prepare("SELECT * FROM system_states WHERE save_id = ? ORDER BY system_name")
      .all(saveId),
    roles: db.prepare("SELECT * FROM dynamic_roles WHERE save_id = ? ORDER BY name").all(saveId),
    trajectories: db
      .prepare("SELECT * FROM character_trajectories WHERE save_id = ? ORDER BY character, seq")
      .all(saveId),
    summaries: db
      .prepare("SELECT * FROM character_summaries WHERE save_id = ? ORDER BY character")
      .all(saveId),
    snapshots: db
      .prepare("SELECT * FROM turn_snapshots WHERE save_id = ? ORDER BY turn_no")
      .all(saveId),
    metadata: db.prepare("SELECT * FROM system_save_revisions WHERE save_id = ?").all(saveId),
    receipts: db
      .prepare(
        "SELECT * FROM system_commit_receipts WHERE save_id = ? ORDER BY branch_epoch, request_id"
      )
      .all(saveId)
  };
}

function withDatabase(run: (db: RpDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rp-story-snapshot-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withAsyncDatabase(run: (db: RpDatabase) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rp-story-snapshot-async-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    await run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
