import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSave } from "../../src/state/save-repository.ts";
import { initializeSchema, openRpDatabase, type RpDatabase } from "../../src/state/sqlite.ts";
import {
  advanceSaveBranchMetadata,
  readSaveCommitMetadata
} from "../../src/systems/commit-repository.ts";
import { defineSystem } from "../../src/systems/define-system.ts";
import { SystemRuntimeError, type SystemRuntimeErrorCode } from "../../src/systems/errors.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";
import { listSystemStates, readSystemState } from "../../src/systems/repository.ts";
import { createSystemRuntime } from "../../src/systems/runtime.ts";
import type {
  RuntimeStateCommitRequest,
  SystemCommandContext,
  SystemDefinition
} from "../../src/systems/types.ts";

type Progression = { level: number; xp: number; perks: string[] };

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

function parseAmount(input: unknown): { amount: number } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const amount = (input as Record<string, unknown>).amount;
  if (!Number.isInteger(amount) || (amount as number) <= 0) {
    throw new Error("amount must be a positive integer");
  }
  return { amount: amount as number };
}

async function withRuntime(
  run: (harness: {
    db: RpDatabase;
    saveId: string;
    runtime: ReturnType<typeof createSystemRuntime>;
    executions: { count: number };
  }) => Promise<void>,
  options: {
    activate?: boolean;
    parseInput?: (input: unknown) => unknown;
    execute?: (
      context: SystemCommandContext,
      state: Readonly<Progression>,
      input: unknown
    ) => unknown;
    project?: (state: Readonly<Progression>) => unknown;
  } = {}
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "rp-system-runtime-"));
  const db = openRpDatabase(join(directory, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);
    const executions = { count: 0 };
    const progression = defineSystem({
      name: "progression",
      version: 1,
      initialize: () => ({ level: 2, xp: 50, perks: [] }),
      parse: parseProgression,
      commands: {
        gain_xp: {
          parseInput: options.parseInput ?? parseAmount,
          execute: (context, state, input) => {
            executions.count += 1;
            if (options.execute !== undefined) {
              return options.execute(context, state, input) as {
                nextState: unknown;
                result: unknown;
              };
            }
            const { amount } = input as { amount: number };
            const nextState = { ...state, xp: state.xp + amount };
            return {
              nextState,
              result: { level: nextState.level, xp: nextState.xp }
            };
          }
        }
      },
      project: (_context, state) =>
        options.project === undefined ? state : options.project(state)
    });
    const registry = createSystemRegistry([progression], { capabilities: new Map() });
    const runtime = createSystemRuntime({ db, registry });
    if (options.activate !== false) {
      runtime.activateSave(save.id);
    }

    await run({ db, saveId: save.id, runtime, executions });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function request(
  saveId: string,
  requestId: string,
  operation: RuntimeStateCommitRequest["operations"][number]
): RuntimeStateCommitRequest {
  return {
    saveId,
    requestId,
    caller: { kind: "gm", sessionId: "session-test" },
    operations: [operation]
  };
}

function persistedCommitState(db: RpDatabase, saveId: string) {
  const receiptCount = db
    .prepare("SELECT COUNT(*) AS count FROM system_commit_receipts WHERE save_id = ?")
    .get(saveId) as { count: number };
  return {
    state: readSystemState(db, saveId, "progression"),
    metadata: readSaveCommitMetadata(db, saveId),
    receiptCount: receiptCount.count
  };
}

function persistedSystemRuntime(db: RpDatabase, saveId: string) {
  const receiptCount = db
    .prepare("SELECT COUNT(*) AS count FROM system_commit_receipts WHERE save_id = ?")
    .get(saveId) as { count: number };
  return {
    states: listSystemStates(db, saveId),
    metadata: readSaveCommitMetadata(db, saveId),
    receiptCount: receiptCount.count
  };
}

async function withDefinitions(
  definitions: readonly SystemDefinition<unknown>[],
  run: (harness: {
    db: RpDatabase;
    saveId: string;
    runtime: ReturnType<typeof createSystemRuntime>;
  }) => Promise<void>
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "rp-system-runtime-batch-"));
  const db = openRpDatabase(join(directory, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);
    const registry = createSystemRegistry(definitions, { capabilities: new Map() });
    const runtime = createSystemRuntime({ db, registry });
    runtime.activateSave(save.id);
    await run({ db, saveId: save.id, runtime });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function hasRuntimeError(
  code: SystemRuntimeErrorCode,
  context: Readonly<Record<string, unknown>> = {}
): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof SystemRuntimeError);
    assert.equal(error.code, code);
    for (const [key, value] of Object.entries(context)) {
      assert.deepEqual(error.context[key], value);
    }
    return true;
  };
}

test("a single command commits state and returns a stable replay receipt", async () => {
  await withRuntime(async ({ db, saveId, runtime, executions }) => {
    const request = {
      saveId,
      requestId: "call-1",
      caller: { kind: "gm" as const, sessionId: "session-test" },
      operations: [
        { system: "progression", command: "gain_xp", input: { amount: 25 } }
      ] as const
    };

    const receipt = await runtime.commit(request);
    const replay = await runtime.commit(request);

    assert.match(receipt.commitId, /^[0-9a-f-]{36}$/);
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.branchEpoch, 0);
    assert.deepEqual(receipt.operations, [
      { system: "progression", command: "gain_xp", result: { level: 2, xp: 75 } }
    ]);
    assert.deepEqual(replay, receipt);
    assert.equal(executions.count, 1);
    assert.deepEqual(readSaveCommitMetadata(db, saveId), { revision: 1, branchEpoch: 0 });
    assert.deepEqual(
      (
        await runtime.project({
          saveId,
          audience: { kind: "gm" },
          systems: ["progression"]
        })
      )[0],
      {
        system: "progression",
        revision: 1,
        value: { level: 2, xp: 75, perks: [] }
      }
    );
  });
});

test("an empty operation batch is rejected without writing", async () => {
  await withRuntime(async ({ db, saveId, runtime }) => {
    const before = persistedCommitState(db, saveId);

    await assert.rejects(
      runtime.commit({
        saveId,
        requestId: "call-empty",
        caller: { kind: "gm", sessionId: "session-test" },
        operations: [] as never
      }),
      hasRuntimeError("COMMAND_FAILED", { reason: "operations must be a non-empty array" })
    );

    assert.deepEqual(persistedCommitState(db, saveId), before);
  });
});

test("commit envelope validation happens before save readiness checks", async () => {
  await withRuntime(
    async ({ saveId, runtime }) => {
      await assert.rejects(
        runtime.commit({
          saveId,
          requestId: "call-empty-not-ready",
          caller: { kind: "gm", sessionId: "session-test" },
          operations: [] as never
        }),
        hasRuntimeError("COMMAND_FAILED", {
          reason: "operations must be a non-empty array"
        })
      );
    },
    { activate: false }
  );
});

test("an unknown system is rejected with operation context and no writes", async () => {
  await withRuntime(async ({ db, saveId, runtime }) => {
    const before = persistedCommitState(db, saveId);

    await assert.rejects(
      runtime.commit(
        request(saveId, "call-system", {
          system: "missing",
          command: "gain_xp",
          input: { amount: 25 }
        })
      ),
      hasRuntimeError("SYSTEM_NOT_REGISTERED", {
        index: 0,
        system: "missing",
        command: "gain_xp"
      })
    );

    assert.deepEqual(persistedCommitState(db, saveId), before);
  });
});

test("an unknown command is rejected with operation context and no writes", async () => {
  await withRuntime(async ({ db, saveId, runtime }) => {
    const before = persistedCommitState(db, saveId);

    await assert.rejects(
      runtime.commit(
        request(saveId, "call-command", {
          system: "progression",
          command: "missing",
          input: { amount: 25 }
        })
      ),
      hasRuntimeError("COMMAND_NOT_FOUND", {
        index: 0,
        system: "progression",
        command: "missing"
      })
    );

    assert.deepEqual(persistedCommitState(db, saveId), before);
  });
});

test("a save must be activated before commit or projection", async () => {
  await withRuntime(
    async ({ db, saveId, runtime }) => {
      const before = persistedCommitState(db, saveId);

      await assert.rejects(
        runtime.commit(
          request(saveId, "call-not-ready", {
            system: "progression",
            command: "gain_xp",
            input: { amount: 25 }
          })
        ),
        hasRuntimeError("SYSTEM_NOT_READY", { saveId })
      );
      await assert.rejects(
        runtime.project({ saveId, audience: { kind: "gm" } }),
        hasRuntimeError("SYSTEM_NOT_READY", { saveId })
      );

      assert.deepEqual(persistedCommitState(db, saveId), before);
    },
    { activate: false }
  );
});

test("an input parser rejection rolls back the operation", async () => {
  await withRuntime(
    async ({ db, saveId, runtime, executions }) => {
      const before = persistedCommitState(db, saveId);

      await assert.rejects(
        runtime.commit(
          request(saveId, "call-input", {
            system: "progression",
            command: "gain_xp",
            input: { amount: 25 }
          })
        ),
        hasRuntimeError("COMMAND_INPUT_INVALID", {
          index: 0,
          system: "progression",
          command: "gain_xp"
        })
      );

      assert.equal(executions.count, 0);
      assert.deepEqual(persistedCommitState(db, saveId), before);
    },
    {
      parseInput: () => {
        throw new Error("invalid input");
      }
    }
  );
});

test("a thrown command handler is wrapped and rolled back", async () => {
  await withRuntime(
    async ({ db, saveId, runtime }) => {
      const before = persistedCommitState(db, saveId);

      await assert.rejects(
        runtime.commit(
          request(saveId, "call-handler", {
            system: "progression",
            command: "gain_xp",
            input: { amount: 25 }
          })
        ),
        hasRuntimeError("COMMAND_FAILED", {
          index: 0,
          system: "progression",
          command: "gain_xp"
        })
      );

      assert.deepEqual(persistedCommitState(db, saveId), before);
    },
    {
      execute: () => {
        throw new Error("domain rejection");
      }
    }
  );
});

test("an asynchronous command handler is rejected and rolled back", async () => {
  await withRuntime(
    async ({ db, saveId, runtime }) => {
      const before = persistedCommitState(db, saveId);

      await assert.rejects(
        runtime.commit(
          request(saveId, "call-async", {
            system: "progression",
            command: "gain_xp",
            input: { amount: 25 }
          })
        ),
        hasRuntimeError("COMMAND_FAILED", {
          index: 0,
          system: "progression",
          command: "gain_xp"
        })
      );

      assert.deepEqual(persistedCommitState(db, saveId), before);
    },
    { execute: async () => ({ nextState: {}, result: null }) }
  );
});

test("a next-state parser rejection rolls back the operation", async () => {
  await withRuntime(
    async ({ db, saveId, runtime }) => {
      const before = persistedCommitState(db, saveId);

      await assert.rejects(
        runtime.commit(
          request(saveId, "call-next-state", {
            system: "progression",
            command: "gain_xp",
            input: { amount: 25 }
          })
        ),
        hasRuntimeError("SYSTEM_STATE_INVALID", {
          index: 0,
          system: "progression",
          command: "gain_xp"
        })
      );

      assert.deepEqual(persistedCommitState(db, saveId), before);
    },
    { execute: () => ({ nextState: { invalid: true }, result: null }) }
  );
});

test("a non-serializable command result rolls back the operation", async () => {
  await withRuntime(
    async ({ db, saveId, runtime }) => {
      const before = persistedCommitState(db, saveId);

      await assert.rejects(
        runtime.commit(
          request(saveId, "call-result", {
            system: "progression",
            command: "gain_xp",
            input: { amount: 25 }
          })
        ),
        hasRuntimeError("COMMAND_FAILED", {
          index: 0,
          system: "progression",
          command: "gain_xp"
        })
      );

      assert.deepEqual(persistedCommitState(db, saveId), before);
    },
    {
      execute: (_context, state) => ({
        nextState: state,
        result: { callback: () => undefined }
      })
    }
  );
});

test("a non-serializable projection fails without writing", async () => {
  await withRuntime(
    async ({ db, saveId, runtime }) => {
      const before = persistedCommitState(db, saveId);

      await assert.rejects(
        runtime.project({
          saveId,
          audience: { kind: "gm" },
          systems: ["progression"]
        }),
        hasRuntimeError("COMMAND_FAILED", {
          system: "progression",
          phase: "projection"
        })
      );

      assert.deepEqual(persistedCommitState(db, saveId), before);
    },
    { project: () => ({ hidden: undefined }) }
  );
});

test("a later operation failure rolls back every system in the batch", async () => {
  const generator = defineSystem({
    name: "generator",
    version: 1,
    initialize: () => ({ blueprints: [] as string[] }),
    parse: (payload) => payload as { blueprints: string[] },
    commands: {
      create_blueprint: {
        parseInput: (input) => input as { name: string },
        execute: (_context, state, input) => {
          const { name } = input as { name: string };
          return {
            nextState: { blueprints: [...state.blueprints, name] },
            result: { name }
          };
        }
      }
    },
    project: (_context, state) => state
  });
  const quest = defineSystem({
    name: "quest",
    version: 1,
    dependsOn: ["generator"],
    initialize: () => ({ recorded: [] as string[] }),
    parse: (payload) => payload as { recorded: string[] },
    commands: {
      record_blueprint: {
        parseInput: (input) => input,
        execute: () => {
          throw new Error("quest rejected blueprint");
        }
      }
    },
    project: (_context, state) => state
  });

  await withDefinitions([quest, generator], async ({ db, saveId, runtime }) => {
    const before = persistedSystemRuntime(db, saveId);

    await assert.rejects(
      runtime.commit({
        saveId,
        requestId: "call-batch",
        caller: { kind: "gm", sessionId: "session-test" },
        operations: [
          {
            system: "generator",
            command: "create_blueprint",
            input: { name: "vault" }
          },
          {
            system: "quest",
            command: "record_blueprint",
            input: { name: "vault" }
          }
        ]
      }),
      hasRuntimeError("COMMAND_FAILED", {
        index: 1,
        system: "quest",
        command: "record_blueprint"
      })
    );

    assert.deepEqual(persistedSystemRuntime(db, saveId), before);
  });
});

test("a declared dependency reads the earlier candidate projection", async () => {
  let projectedAudience: unknown;
  let observedProjection: unknown;
  let commandContextKeys: string[] = [];
  const generator = defineSystem({
    name: "generator",
    version: 1,
    initialize: () => ({ blueprints: [] as string[], privateToken: "raw-only" }),
    parse: (payload) => payload as { blueprints: string[]; privateToken: string },
    commands: {
      create_blueprint: {
        parseInput: (input) => input as { name: string },
        execute: (_context, state, input) => {
          const { name } = input as { name: string };
          return {
            nextState: { ...state, blueprints: [...state.blueprints, name] },
            result: { name }
          };
        }
      }
    },
    project: (context, state) => {
      projectedAudience = context.audience;
      return { blueprints: state.blueprints };
    }
  });
  const quest = defineSystem({
    name: "quest",
    version: 1,
    dependsOn: ["generator"],
    initialize: () => ({ recorded: [] as string[] }),
    parse: (payload) => payload as { recorded: string[] },
    commands: {
      record_blueprints: {
        parseInput: (input) => input,
        execute: (context, state) => {
          commandContextKeys = Object.keys(context).sort();
          observedProjection = context.read("generator");
          const projection = observedProjection as { blueprints: string[] };
          assert.equal("privateToken" in projection, false);
          return {
            nextState: { recorded: [...state.recorded, ...projection.blueprints] },
            result: { recorded: projection.blueprints }
          };
        }
      }
    },
    project: (_context, state) => state
  });

  await withDefinitions([quest, generator], async ({ saveId, runtime }) => {
    const receipt = await runtime.commit({
      saveId,
      requestId: "call-read-view",
      caller: { kind: "gm", sessionId: "session-test" },
      operations: [
        {
          system: "generator",
          command: "create_blueprint",
          input: { name: "vault" }
        },
        {
          system: "quest",
          command: "record_blueprints",
          input: null
        }
      ]
    });

    assert.equal(receipt.revision, 1);
    assert.deepEqual(observedProjection, { blueprints: ["vault"] });
    assert.deepEqual(projectedAudience, { kind: "system", name: "quest" });
    assert.deepEqual(commandContextKeys, ["capability", "read"]);
    assert.deepEqual(
      await runtime.project({ saveId, audience: { kind: "gm" }, systems: ["quest"] }),
      [
        {
          system: "quest",
          revision: 1,
          value: { recorded: ["vault"] }
        }
      ]
    );
  });
});

test("reading an undeclared dependency rejects the operation without writes", async () => {
  const generator = defineSystem({
    name: "generator",
    version: 1,
    initialize: () => ({ visible: true }),
    parse: (payload) => payload as { visible: boolean },
    commands: {},
    project: (_context, state) => state
  });
  const quest = defineSystem({
    name: "quest",
    version: 1,
    initialize: () => ({ recorded: false }),
    parse: (payload) => payload as { recorded: boolean },
    commands: {
      inspect_generator: {
        parseInput: (input) => input,
        execute: (context, state) => {
          context.read("generator");
          return { nextState: state, result: null };
        }
      }
    },
    project: (_context, state) => state
  });

  await withDefinitions([generator, quest], async ({ db, saveId, runtime }) => {
    const before = persistedSystemRuntime(db, saveId);

    await assert.rejects(
      runtime.commit({
        saveId,
        requestId: "call-undeclared",
        caller: { kind: "gm", sessionId: "session-test" },
        operations: [
          { system: "quest", command: "inspect_generator", input: null }
        ]
      }),
      hasRuntimeError("DEPENDENCY_UNAVAILABLE", {
        index: 0,
        system: "quest",
        command: "inspect_generator",
        dependency: "generator"
      })
    );

    assert.deepEqual(persistedSystemRuntime(db, saveId), before);
  });
});

test("operations on one system observe the previous candidate state", async () => {
  await withRuntime(async ({ saveId, runtime, executions }) => {
    const receipt = await runtime.commit({
      saveId,
      requestId: "call-sequential",
      caller: { kind: "gm", sessionId: "session-test" },
      operations: [
        { system: "progression", command: "gain_xp", input: { amount: 25 } },
        { system: "progression", command: "gain_xp", input: { amount: 10 } }
      ]
    });

    assert.deepEqual(receipt.operations, [
      { system: "progression", command: "gain_xp", result: { level: 2, xp: 75 } },
      { system: "progression", command: "gain_xp", result: { level: 2, xp: 85 } }
    ]);
    assert.equal(executions.count, 2);
    assert.deepEqual(
      await runtime.project({ saveId, audience: { kind: "gm" }, systems: ["progression"] }),
      [
        {
          system: "progression",
          revision: 1,
          value: { level: 2, xp: 85, perks: [] }
        }
      ]
    );
  });
});

test("a stale expected revision is rejected before executing the handler", async () => {
  await withRuntime(async ({ db, saveId, runtime, executions }) => {
    await runtime.commit(
      request(saveId, "call-current", {
        system: "progression",
        command: "gain_xp",
        input: { amount: 25 }
      })
    );
    const before = persistedCommitState(db, saveId);
    const executionsBeforeConflict = executions.count;

    await assert.rejects(
      runtime.commit({
        ...request(saveId, "call-stale", {
          system: "progression",
          command: "gain_xp",
          input: { amount: 10 }
        }),
        expectedRevision: 0
      }),
      hasRuntimeError("STATE_COMMIT_CONFLICT", {
        saveId,
        expectedRevision: 0,
        currentRevision: 1
      })
    );

    assert.equal(executions.count, executionsBeforeConflict);
    assert.deepEqual(persistedCommitState(db, saveId), before);
  });
});

test("reusing a request id with a different canonical batch conflicts", async () => {
  await withRuntime(async ({ db, saveId, runtime, executions }) => {
    await runtime.commit(
      request(saveId, "call-idempotent", {
        system: "progression",
        command: "gain_xp",
        input: { amount: 25 }
      })
    );
    const before = persistedCommitState(db, saveId);

    await assert.rejects(
      runtime.commit(
        request(saveId, "call-idempotent", {
          system: "progression",
          command: "gain_xp",
          input: { amount: 10 }
        })
      ),
      hasRuntimeError("IDEMPOTENCY_CONFLICT", {
        saveId,
        branchEpoch: 0,
        requestId: "call-idempotent"
      })
    );

    assert.equal(executions.count, 1);
    assert.deepEqual(persistedCommitState(db, saveId), before);
  });
});

test("an idempotent replay is returned before checking expected revision", async () => {
  await withRuntime(async ({ db, saveId, runtime, executions }) => {
    const operation = {
      system: "progression",
      command: "gain_xp",
      input: { amount: 25 }
    } as const;
    const original = await runtime.commit({
      ...request(saveId, "call-replay-order", operation),
      expectedRevision: 0
    });

    const replay = await runtime.commit({
      ...request(saveId, "call-replay-order", operation),
      expectedRevision: 999
    });

    assert.deepEqual(replay, original);
    assert.equal(executions.count, 1);
    assert.deepEqual(readSaveCommitMetadata(db, saveId), { revision: 1, branchEpoch: 0 });
  });
});

test("branch advancement isolates receipts and invalidates old revisions", async () => {
  await withRuntime(async ({ db, saveId, runtime, executions }) => {
    const operation = {
      system: "progression",
      command: "gain_xp",
      input: { amount: 25 }
    } as const;
    const original = await runtime.commit(
      request(saveId, "call-branch", operation)
    );

    db.exec("BEGIN IMMEDIATE");
    try {
      assert.deepEqual(advanceSaveBranchMetadata(db, saveId), {
        revision: 2,
        branchEpoch: 1
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    await assert.rejects(
      runtime.commit({
        ...request(saveId, "call-branch", operation),
        expectedRevision: 1
      }),
      hasRuntimeError("STATE_COMMIT_CONFLICT", {
        saveId,
        expectedRevision: 1,
        currentRevision: 2
      })
    );
    assert.equal(executions.count, 1);
    assert.equal(persistedCommitState(db, saveId).receiptCount, 1);

    const branched = await runtime.commit(request(saveId, "call-branch", operation));

    assert.notEqual(branched.commitId, original.commitId);
    assert.equal(branched.revision, 3);
    assert.equal(branched.branchEpoch, 1);
    assert.equal(executions.count, 2);
    assert.deepEqual(readSaveCommitMetadata(db, saveId), { revision: 3, branchEpoch: 1 });
    assert.equal(persistedCommitState(db, saveId).receiptCount, 2);
    assert.deepEqual(
      await runtime.project({ saveId, audience: { kind: "gm" }, systems: ["progression"] }),
      [
        {
          system: "progression",
          revision: 3,
          value: { level: 2, xp: 100, perks: [] }
        }
      ]
    );
  });
});

test("commits without an expected revision serialize against the latest state", async () => {
  await withRuntime(async ({ saveId, runtime }) => {
    const first = await runtime.commit(
      request(saveId, "call-latest-1", {
        system: "progression",
        command: "gain_xp",
        input: { amount: 25 }
      })
    );
    const second = await runtime.commit(
      request(saveId, "call-latest-2", {
        system: "progression",
        command: "gain_xp",
        input: { amount: 10 }
      })
    );

    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.deepEqual(
      await runtime.project({ saveId, audience: { kind: "gm" }, systems: ["progression"] }),
      [
        {
          system: "progression",
          revision: 2,
          value: { level: 2, xp: 85, perks: [] }
        }
      ]
    );
  });
});
