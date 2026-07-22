import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInitialState } from "../../src/state/schema.ts";
import { createSave } from "../../src/state/save-repository.ts";
import { initializeSchema, openRpDatabase } from "../../src/state/sqlite.ts";
import { createStateStore } from "../../src/state/store.ts";
import { defineSystem } from "../../src/systems/define-system.ts";
import { SystemRuntimeError } from "../../src/systems/errors.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";
import { createSystemRuntime } from "../../src/systems/runtime.ts";
import type {
  RuntimeStateCommitRequest,
  SystemCommandContext,
  SystemRuntimeLifecycle
} from "../../src/systems/types.ts";
import { commitTurnTool } from "../../src/tools/state/commit-turn.ts";

test("commit_turn scopes a GM request and advances System state without terminating", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rp-commit-turn-"));
  const db = openRpDatabase(join(directory, "state.sqlite"));

  try {
    initializeSchema(db);
    const save = createSave(db);
    const stateStore = createStateStore(db);
    stateStore.replaceState(save.id, createInitialState());

    let handlerContext: SystemCommandContext | undefined;
    const progression = defineSystem({
      name: "progression",
      version: 1,
      initialize: () => ({ xp: 0 }),
      parse: (payload) => payload as { xp: number },
      commands: {
        gain_xp: {
          parseInput: (input) => input as { amount: number },
          execute: (context, state, input) => {
            handlerContext = context;
            const xp = state.xp + (input as { amount: number }).amount;
            return { nextState: { xp }, result: { xp } };
          }
        }
      },
      project: (_context, state) => state
    });
    const registry = createSystemRegistry([progression], { capabilities: new Map() });
    const runtime = createSystemRuntime({ db, registry });
    runtime.activateSave(save.id);

    const seenRequests: RuntimeStateCommitRequest[] = [];
    const recordingRuntime: SystemRuntimeLifecycle = {
      activateSave: (saveId) => runtime.activateSave(saveId),
      project: (request) => runtime.project(request),
      commit(request) {
        seenRequests.push(request);
        return runtime.commit(request);
      }
    };

    const result = await commitTurnTool.execute(
      "call-17",
      {
        operations: [
          { system: "progression", command: "gain_xp", input: { amount: 25 } }
        ]
      },
      undefined,
      undefined,
      { db, stateStore, systemRuntime: recordingRuntime, piSessionId: "session-a" } as never
    );

    const requestId = createHash("sha256")
      .update(JSON.stringify(["pi-tool", "session-a", "call-17"]))
      .digest("hex");
    assert.deepEqual(seenRequests, [
      {
        saveId: save.id,
        requestId,
        caller: { kind: "gm", sessionId: "session-a" },
        operations: [
          { system: "progression", command: "gain_xp", input: { amount: 25 } }
        ]
      }
    ]);
    assert.deepEqual(Object.keys(handlerContext ?? {}).sort(), ["capability", "read"]);
    assert.equal(result.terminate, undefined);
    assert.equal(result.details.ok, true);
    assert.equal(result.details.requestId, requestId);
    assert.notEqual(result.details.requestId, "call-17");
    assert.equal(result.details.revision, 1);
    assert.equal(result.details.branchEpoch, 0);

    await commitTurnTool.execute(
      "call-17",
      {
        operations: [
          { system: "progression", command: "gain_xp", input: { amount: 25 } }
        ]
      },
      undefined,
      undefined,
      { db, stateStore, systemRuntime: recordingRuntime, piSessionId: "session-a" } as never
    );
    const otherSessionResult = await commitTurnTool.execute(
      "call-17",
      {
        operations: [
          { system: "progression", command: "gain_xp", input: { amount: 25 } }
        ]
      },
      undefined,
      undefined,
      { db, stateStore, systemRuntime: recordingRuntime, piSessionId: "session-b" } as never
    );

    assert.equal(seenRequests[1]?.requestId, requestId);
    assert.notEqual(seenRequests[2]?.requestId, requestId);
    assert.equal(otherSessionResult.details.revision, 2);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("commit_turn rejects malformed operation envelopes before calling the runtime", async () => {
  let commitCalls = 0;
  const context = {
    db: { prepare() {}, exec() {} },
    stateStore: {
      getState() {},
      replaceState() {},
      mutateState() {},
      getActiveSaveId: () => "save-a"
    },
    systemRuntime: {
      activateSave: () => ({ saveId: "save-a", revision: 0, branchEpoch: 0 }),
      project: async () => [],
      commit: async () => {
        commitCalls += 1;
        throw new Error("runtime should not be called");
      }
    },
    piSessionId: "session-a"
  };
  const invalidInputs = [
    {},
    { operations: "invalid" },
    { operations: [] },
    { operations: [{}] },
    { operations: [{ system: "progression", input: {} }] },
    { operations: [{ system: "progression", command: "gain_xp" }] }
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      async () => commitTurnTool.execute("call-invalid", input, undefined, undefined, context as never),
      TypeError
    );
  }
  assert.equal(commitCalls, 0);
});

test("commit_turn renders known System runtime failures without terminating", async () => {
  const errors = [
    new SystemRuntimeError("COMMAND_INPUT_INVALID", {
      index: 0,
      system: "progression",
      command: "gain_xp"
    }),
    new SystemRuntimeError("STATE_COMMIT_CONFLICT", {
      expectedRevision: 0,
      currentRevision: 1
    })
  ];

  for (const error of errors) {
    const context = {
      db: { prepare() {}, exec() {} },
      stateStore: {
        getState() {},
        replaceState() {},
        mutateState() {},
        getActiveSaveId: () => "save-a"
      },
      systemRuntime: {
        activateSave: () => ({ saveId: "save-a", revision: 0, branchEpoch: 0 }),
        project: async () => [],
        commit: async () => {
          throw error;
        }
      },
      piSessionId: "session-a"
    };

    const result = await commitTurnTool.execute(
      "call-failure",
      {
        operations: [
          { system: "progression", command: "gain_xp", input: { amount: 0 } }
        ]
      },
      undefined,
      undefined,
      context as never
    );

    assert.equal(result.terminate, undefined);
    assert.match(result.content[0]?.text ?? "", new RegExp(`State commit failed \\[${error.code}\\]`));
    assert.deepEqual(result.details, {
      ok: false,
      error: { code: error.code, context: error.context }
    });
  }
});

test("commit_turn requires a trusted session and an active save", async () => {
  let commitCalls = 0;
  const context = {
    db: { prepare() {}, exec() {} },
    stateStore: {
      getState() {},
      replaceState() {},
      mutateState() {},
      getActiveSaveId: () => "save-a" as string | undefined
    },
    systemRuntime: {
      activateSave: () => ({ saveId: "save-a", revision: 0, branchEpoch: 0 }),
      project: async () => [],
      commit: async () => {
        commitCalls += 1;
        throw new Error("runtime should not be called");
      }
    }
  };
  const input = {
    operations: [
      { system: "progression", command: "gain_xp", input: { amount: 25 } }
    ]
  };

  await assert.rejects(
    async () => commitTurnTool.execute("call-scope", input, undefined, undefined, context as never),
    /Pi session id/
  );
  context.stateStore.getActiveSaveId = () => undefined;
  await assert.rejects(
    async () =>
      commitTurnTool.execute(
        "call-scope",
        input,
        undefined,
        undefined,
        { ...context, piSessionId: "session-a" } as never
      ),
    /活跃存档/
  );
  assert.equal(commitCalls, 0);
});

test("commit_turn rethrows unknown runtime errors", async () => {
  const programmerError = new Error("broken runtime invariant");
  const context = {
    db: { prepare() {}, exec() {} },
    stateStore: {
      getState() {},
      replaceState() {},
      mutateState() {},
      getActiveSaveId: () => "save-a"
    },
    systemRuntime: {
      activateSave: () => ({ saveId: "save-a", revision: 0, branchEpoch: 0 }),
      project: async () => [],
      commit: async () => {
        throw programmerError;
      }
    },
    piSessionId: "session-a"
  };

  await assert.rejects(
    async () =>
      commitTurnTool.execute(
        "call-programmer-error",
        {
          operations: [
            { system: "progression", command: "gain_xp", input: { amount: 25 } }
          ]
        },
        undefined,
        undefined,
        context as never
      ),
    (error: unknown) => error === programmerError
  );
});
