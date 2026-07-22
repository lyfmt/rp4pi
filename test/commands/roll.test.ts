import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rollCommand } from "../../src/commands/roll.ts";
import { resetActiveSaveProjectionForTest } from "../../src/state/active-save.ts";
import { listDynamicRoles, replaceDynamicRoles } from "../../src/state/dynamic-roles.ts";
import { createSave } from "../../src/state/save-repository.ts";
import { createInitialState } from "../../src/state/schema.ts";
import { bindSessionToSave } from "../../src/state/session-binding.ts";
import { initializeSchema, openRpDatabase, readLatestState, type RpDatabase } from "../../src/state/sqlite.ts";
import {
  createStorySnapshotCoordinator,
  type StorySnapshotCoordinator
} from "../../src/state/story-snapshot-coordinator.ts";
import { createStateStore, type StateStore } from "../../src/state/store.ts";
import { appendCharacterTrajectory } from "../../src/state/trajectory.ts";
import {
  readCommitReceipt,
  readSaveCommitMetadata,
  writeSaveRevision
} from "../../src/systems/commit-repository.ts";
import { defineSystem } from "../../src/systems/define-system.ts";
import { SystemRuntimeError } from "../../src/systems/errors.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";
import { readSystemState, writeSystemState } from "../../src/systems/repository.ts";
import { createSystemRuntime } from "../../src/systems/runtime.ts";

type Harness = {
  db: RpDatabase;
  stateStore: StateStore;
  saveId: string;
  projectRoot: string;
  systemRuntime: ReturnType<typeof createSystemRuntime>;
  storySnapshots: StorySnapshotCoordinator;
};

test("/roll checks rerun capability and latest input before starting restore", async () => {
  await withRollHarness(async (harness) => {
    seedTwoSnapshots(harness);
    let restores = 0;
    const storySnapshots: StorySnapshotCoordinator = {
      ...harness.storySnapshots,
      restorePreviousAndSupersedeLatest(saveId) {
        restores += 1;
        return harness.storySnapshots.restorePreviousAndSupersedeLatest(saveId);
      }
    };

    const missingCapability = await rollCommand.execute({}, commandContext(harness, { storySnapshots, rerunTurn: undefined }));
    const missingInput = await rollCommand.execute({}, commandContext(harness, {
      storySnapshots,
      getLatestUserMessage: () => null
    }));

    assert.match(missingCapability, /rerun capability is unavailable/);
    assert.match(missingInput, /no latest user message/);
    assert.equal(restores, 0);
    assert.deepEqual(snapshotTurns(harness.db, harness.saveId), [1, 2]);
  });
});

test("/roll reports an unavailable predecessor without mutating the save", async () => {
  await withRollHarness(async (harness) => {
    const before = dumpRestoreState(harness.db, harness.saveId);
    const output = await rollCommand.execute({}, commandContext(harness));

    assert.match(output, /No previous story snapshot/);
    assert.deepEqual(dumpRestoreState(harness.db, harness.saveId), before);
  });
});

test("/roll restores all participants before rerun and advances revision and branch epoch", async () => {
  await withRollHarness(async (harness) => {
    seedTwoSnapshots(harness);
    let observedRestoredProjection = false;

    const output = await rollCommand.execute(
      {},
      commandContext(harness, {
        rerunTurn() {
          observedRestoredProjection =
            listDynamicRoles(harness.db, harness.saveId)[0]?.name === "old-role" &&
            existsSync(join(harness.projectRoot, ".pi", "agents", "old-role.md")) &&
            !existsSync(join(harness.projectRoot, ".pi", "agents", "new-role.md"));
        }
      })
    );

    assert.equal(observedRestoredProjection, true);
    assert.equal(harness.stateStore.getState().scene.summary, "previous");
    assert.deepEqual(readSystemState(harness.db, harness.saveId, "progression")?.payload, { value: 10 });
    assert.deepEqual(
      (await harness.systemRuntime.project({
        saveId: harness.saveId,
        audience: { kind: "gm" },
        systems: ["progression"]
      }))[0]?.value,
      { value: 10 }
    );
    assert.deepEqual(listDynamicRoles(harness.db, harness.saveId).map((role) => role.name), ["old-role"]);
    assert.deepEqual(
      harness.db
        .prepare("SELECT character, seq FROM character_trajectories WHERE save_id = ? ORDER BY character, seq")
        .all(harness.saveId)
        .map((row) => ({ ...row })),
      [{ character: "old-role", seq: 1 }]
    );
    assert.deepEqual(readSaveCommitMetadata(harness.db, harness.saveId), { revision: 3, branchEpoch: 1 });
    assert.deepEqual(snapshotTurns(harness.db, harness.saveId), [1]);
    assert.match(output, /reran latest user message/);

    await assert.rejects(
      harness.systemRuntime.commit({
        saveId: harness.saveId,
        requestId: "stale-revision",
        expectedRevision: 2,
        caller: { kind: "gm", sessionId: "session-1" },
        operations: [{ system: "progression", command: "add", input: { amount: 1 } }]
      }),
      (error) => error instanceof SystemRuntimeError && error.code === "STATE_COMMIT_CONFLICT"
    );
  });
});

test("/roll leaves the full active chain unchanged when compatibility preflight fails", async () => {
  await withRollHarness(async (harness) => {
    seedTwoSnapshots(harness);
    const target = harness.db
      .prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ? AND turn_no = 1")
      .get(harness.saveId) as { state_json: string };
    const incompatible = JSON.parse(target.state_json);
    incompatible.systems.progression.version = 2;
    harness.db
      .prepare("UPDATE turn_snapshots SET state_json = ? WHERE save_id = ? AND turn_no = 1")
      .run(JSON.stringify(incompatible), harness.saveId);
    const before = dumpRestoreState(harness.db, harness.saveId);
    let reran = false;

    const output = await rollCommand.execute({}, commandContext(harness, { rerunTurn: () => { reran = true; } }));

    assert.match(output, /SYSTEM_VERSION_FUTURE/);
    assert.equal(reran, false);
    assert.deepEqual(dumpRestoreState(harness.db, harness.saveId), before);
  });
});

test("/roll does not resurrect the superseded turn when rerun fails after a State commit", async () => {
  await withRollHarness(async (harness) => {
    seedTwoSnapshots(harness);

    const output = await rollCommand.execute(
      {},
      commandContext(harness, {
        async rerunTurn() {
          await harness.systemRuntime.commit({
            saveId: harness.saveId,
            requestId: "rerun-state-commit",
            caller: { kind: "gm", sessionId: "session-1" },
            operations: [{ system: "progression", command: "add", input: { amount: 5 } }]
          });
          throw new Error("rerun failed");
        }
      })
    );

    assert.match(output, /restore completed.*rerun failed/i);
    assert.equal(readLatestState(harness.db, harness.saveId)?.scene.summary, "previous");
    assert.deepEqual(readSystemState(harness.db, harness.saveId, "progression")?.payload, { value: 15 });
    assert.deepEqual(snapshotTurns(harness.db, harness.saveId), [1]);
  });
});

test("/roll isolates old receipts and executes the same request id on the new branch", async () => {
  await withRollHarness(async (harness) => {
    seedTwoSnapshots(harness, { revision: 0 });
    const request = {
      saveId: harness.saveId,
      requestId: "call-1",
      caller: { kind: "gm" as const, sessionId: "session-1" },
      operations: [{ system: "progression", command: "add", input: { amount: 1 } }] as const
    };
    const oldReceipt = await harness.systemRuntime.commit(request);
    let newCommitId = "";

    await rollCommand.execute(
      {},
      commandContext(harness, {
        async rerunTurn() {
          newCommitId = (await harness.systemRuntime.commit(request)).commitId;
        }
      })
    );

    assert.notEqual(newCommitId, oldReceipt.commitId);
    assert.equal(
      readCommitReceipt<{ commitId: string }>(harness.db, harness.saveId, 0, "call-1")?.receipt.commitId,
      oldReceipt.commitId
    );
    assert.equal(
      readCommitReceipt<{ commitId: string }>(harness.db, harness.saveId, 1, "call-1")?.receipt.commitId,
      newCommitId
    );
  });
});

test("replacement snapshots reuse the logical turn and consecutive rolls keep the same predecessor", async () => {
  await withRollHarness(async (harness) => {
    seedTwoSnapshots(harness);
    let replacement = 0;
    const rerunTurn = () => {
      replacement += 1;
      harness.stateStore.mutateState((state) => {
        state.scene.summary = `replacement-${replacement}`;
      });
      const turnNo = harness.storySnapshots.captureSuccessfulStory(
        harness.saveId,
        harness.stateStore.getState()
      );
      assert.equal(turnNo, 2);
    };

    await rollCommand.execute({}, commandContext(harness, { rerunTurn }));
    assert.deepEqual(snapshotTurns(harness.db, harness.saveId), [1, 2]);
    assert.equal(snapshotCoreSummary(harness.db, harness.saveId, 2), "replacement-1");

    await rollCommand.execute({}, commandContext(harness, { rerunTurn }));
    assert.deepEqual(snapshotTurns(harness.db, harness.saveId), [1, 2]);
    assert.equal(snapshotCoreSummary(harness.db, harness.saveId, 1), "previous");
    assert.equal(snapshotCoreSummary(harness.db, harness.saveId, 2), "replacement-2");
  });
});

async function withRollHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), "rp-roll-"));
  const db = openRpDatabase(join(projectRoot, "state.sqlite"));
  const previousActiveSave = process.env.RP_ACTIVE_SAVE;
  try {
    initializeSchema(db);
    resetActiveSaveProjectionForTest();
    const save = createSave(db);
    const stateStore = createStateStore(db);
    stateStore.replaceState(save.id, createInitialState({ scene: { summary: "current" } }));
    bindSessionToSave(db, "session-1", save.id);
    const progression = defineSystem({
      name: "progression",
      version: 1,
      initialize: () => ({ value: 0 }),
      parse(payload) {
        if (typeof payload !== "object" || payload === null || !Number.isInteger((payload as { value?: unknown }).value)) {
          throw new Error("invalid progression");
        }
        return payload as { value: number };
      },
      commands: {
        add: {
          parseInput(input) {
            const amount = (input as { amount?: unknown })?.amount;
            if (!Number.isInteger(amount)) throw new Error("invalid amount");
            return { amount: amount as number };
          },
          execute(_context, state, input) {
            const value = state.value + (input as { amount: number }).amount;
            return { nextState: { value }, result: { value } };
          }
        }
      },
      project: (_context, state) => state
    });
    const registry = createSystemRegistry([progression], { capabilities: new Map() });
    const systemRuntime = createSystemRuntime({ db, registry });
    systemRuntime.activateSave(save.id);
    const storySnapshots = createStorySnapshotCoordinator({ db, registry, systemRuntime });
    await run({
      db,
      stateStore,
      saveId: save.id,
      projectRoot,
      systemRuntime,
      storySnapshots
    });
  } finally {
    if (previousActiveSave === undefined) delete process.env.RP_ACTIVE_SAVE;
    else process.env.RP_ACTIVE_SAVE = previousActiveSave;
    resetActiveSaveProjectionForTest();
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function seedTwoSnapshots(harness: Harness, options: { revision?: number } = {}): void {
  harness.stateStore.replaceState(
    harness.saveId,
    createInitialState({ scene: { summary: "previous" } })
  );
  writeSystemState(harness.db, harness.saveId, {
    name: "progression",
    version: 1,
    payload: { value: 10 }
  });
  replaceDynamicRoles(harness.db, harness.saveId, [role("old-role")]);
  appendCharacterTrajectory(harness.db, harness.saveId, {
    character: "old-role",
    turnNo: 1,
    content: "old timeline",
    gameTime: { day: 1, hour: 9 }
  });
  harness.storySnapshots.captureSuccessfulStory(harness.saveId, harness.stateStore.getState());

  harness.stateStore.replaceState(
    harness.saveId,
    createInitialState({ scene: { summary: "latest" } })
  );
  writeSystemState(harness.db, harness.saveId, {
    name: "progression",
    version: 1,
    payload: { value: 20 }
  });
  replaceDynamicRoles(harness.db, harness.saveId, [role("new-role")]);
  appendCharacterTrajectory(harness.db, harness.saveId, {
    character: "old-role",
    turnNo: 2,
    content: "superseded old role action",
    gameTime: { day: 2, hour: 9 }
  });
  appendCharacterTrajectory(harness.db, harness.saveId, {
    character: "new-role",
    turnNo: 2,
    content: "superseded new role action",
    gameTime: { day: 2, hour: 9 }
  });
  harness.storySnapshots.captureSuccessfulStory(harness.saveId, harness.stateStore.getState());
  writeSaveRevision(harness.db, harness.saveId, options.revision ?? 2);
}

function commandContext(harness: Harness, overrides: Record<string, unknown> = {}) {
  return {
    db: harness.db,
    stateStore: harness.stateStore,
    systemRuntime: harness.systemRuntime,
    storySnapshots: harness.storySnapshots,
    piSessionId: "session-1",
    projectRoot: harness.projectRoot,
    getLatestUserMessage: () => "I try again.",
    rerunTurn: () => undefined,
    ...overrides
  };
}

function role(name: string) {
  return {
    name,
    description: `${name} description`,
    persona: `${name} persona`,
    createdAt: "2026-07-10T01:00:00.000Z",
    updatedAt: "2026-07-10T02:00:00.000Z"
  };
}

function snapshotTurns(db: RpDatabase, saveId: string): number[] {
  return db
    .prepare("SELECT turn_no FROM turn_snapshots WHERE save_id = ? ORDER BY turn_no")
    .all(saveId)
    .map((row) => row.turn_no as number);
}

function snapshotCoreSummary(db: RpDatabase, saveId: string, turnNo: number): string {
  const row = db
    .prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ? AND turn_no = ?")
    .get(saveId, turnNo) as { state_json: string };
  return JSON.parse(row.state_json).core.payload.scene.summary as string;
}

function dumpRestoreState(db: RpDatabase, saveId: string): unknown {
  return {
    core: db.prepare("SELECT * FROM latest_states WHERE save_id = ?").all(saveId),
    systems: db.prepare("SELECT * FROM system_states WHERE save_id = ? ORDER BY system_name").all(saveId),
    roles: db.prepare("SELECT * FROM dynamic_roles WHERE save_id = ? ORDER BY name").all(saveId),
    trajectory: db.prepare("SELECT * FROM character_trajectories WHERE save_id = ? ORDER BY character, seq").all(saveId),
    snapshots: db.prepare("SELECT * FROM turn_snapshots WHERE save_id = ? ORDER BY turn_no").all(saveId),
    metadata: db.prepare("SELECT * FROM system_save_revisions WHERE save_id = ?").all(saveId),
    receipts: db.prepare("SELECT * FROM system_commit_receipts WHERE save_id = ? ORDER BY branch_epoch, request_id").all(saveId)
  };
}
