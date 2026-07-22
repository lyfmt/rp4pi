import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateAllExtensions,
  resetShared,
  type ActivateAllOptions
} from "../helpers/extensions.ts";
import { onTurnRendered } from "../../src/runtime/turn-events.ts";
import { createSave } from "../../src/state/save-repository.ts";
import { createInitialState } from "../../src/state/schema.ts";
import { initializeSchema, openRpDatabase } from "../../src/state/sqlite.ts";
import { createStorySnapshotCoordinator } from "../../src/state/story-snapshot-coordinator.ts";
import { createStateStore } from "../../src/state/store.ts";
import { defineSystem } from "../../src/systems/define-system.ts";
import { SystemRuntimeError } from "../../src/systems/errors.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";
import { createSystemRuntime } from "../../src/systems/runtime.ts";
import type {
  AgentToolResult,
  ExtensionCommandContextLike,
  ExtensionContextLike,
  OutboundCustomMessage,
  PiLike
} from "../../src/types/pi.ts";
import { relayBlueprints } from "../../worlds/border-station/systems/relay-blueprints.ts";

type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => unknown;
};

type ToolResult = AgentToolResult<Record<string, unknown>>;

type RegisteredHook = (event: unknown, context: ExtensionContextLike) => unknown;

type RegisteredCommand = {
  name: string;
  handler: (args: string, context: ExtensionCommandContextLike) => Promise<void> | void;
};

type ShippedExtensionHarness = {
  sqlitePath: string;
  tools: RegisteredTool[];
  hooks: Map<string, RegisteredHook>;
  commands: RegisteredCommand[];
  sentMessages: Array<{
    message: OutboundCustomMessage;
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
  }>;
  completions: Promise<void>[];
};

type ShippedExtensionOptions = ActivateAllOptions & {
  sendMessage?: PiLike["sendMessage"];
};

function sessionCtx(
  sessionId: string,
  options: {
    getEntries?: () => unknown[];
    isIdle?: () => boolean;
  } = {}
): ExtensionContextLike {
  const sessionManager: ExtensionContextLike["sessionManager"] = {
    getSessionId: () => sessionId
  };
  if (options.getEntries) {
    sessionManager.getEntries = options.getEntries;
  }
  return {
    sessionManager,
    isIdle: options.isIdle ?? (() => true),
    modelRegistry: {
      find(provider: string, modelId: string) {
        return { provider, id: modelId, api: "test" };
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key" };
      }
    }
  };
}

test("shipped relay blueprints commit through Pi and expose only their projection", async () => {
  await withShippedExtension(async ({ sqlitePath, tools }) => {
    const context = sessionCtx("session-blueprint-success");
    const initialize = requireTool(tools, "initialize_new_game");
    const commitTurn = requireTool(tools, "commit_turn");
    const getStatus = requireTool(tools, "get_status");

    const initialized = initialize.execute(
      "call-init",
      {},
      undefined,
      undefined,
      context
    ) as ToolResult;
    const saveId = initialized.details.saveId;
    assert.ok(typeof saveId === "string");

    const committed = await commitTurn.execute(
      "call-create-alpha",
      {
        operations: [
          {
            system: "relay-blueprints",
            command: "create",
            input: {
              id: "relay-alpha",
              parts: ["core", "antenna"],
              stability: 0.82
            }
          }
        ]
      },
      undefined,
      undefined,
      context
    ) as ToolResult;
    const status = await getStatus.execute(
      "call-status",
      {},
      undefined,
      undefined,
      context
    ) as ToolResult;

    assert.equal(committed.terminate, undefined);
    assert.equal(committed.details.ok, true);
    assert.equal(committed.details.revision, 1);
    assert.equal(committed.details.branchEpoch, 0);
    assert.equal(typeof committed.details.commitId, "string");
    assert.notEqual(committed.details.commitId, "");
    assert.deepEqual(committed.details.operations, [
      {
        system: "relay-blueprints",
        command: "create",
        result: { id: "relay-alpha", accepted: true }
      }
    ]);

    assert.deepEqual(status.details.projections, [
      {
        system: "relay-blueprints",
        revision: 1,
        value: {
          count: 1,
          blueprints: [{ id: "relay-alpha", partCount: 2, stability: 0.82 }]
        }
      }
    ]);
    const publicResults = JSON.stringify({ committed, status });
    assert.doesNotMatch(publicResults, /payload_json/);
    assert.doesNotMatch(publicResults, /"parts"/);

    const db = openRpDatabase(sqlitePath);
    try {
      const row = db.prepare(`
        SELECT version, payload_json
        FROM system_states
        WHERE save_id = ? AND system_name = ?
      `).get(saveId, "relay-blueprints") as {
        version: number;
        payload_json: string;
      };
      assert.equal(row.version, 1);
      assert.deepEqual(JSON.parse(row.payload_json), {
        blueprints: [
          {
            id: "relay-alpha",
            parts: ["core", "antenna"],
            stability: 0.82
          }
        ]
      });
    } finally {
      db.close();
    }
  });
});

test("a duplicate create rolls back the whole Pi operation batch", async () => {
  await withShippedExtension(async ({ sqlitePath, tools }) => {
    const sessionId = "session-blueprint-atomic";
    const toolCallId = "call-duplicate-batch";
    const context = sessionCtx(sessionId);
    const initialize = requireTool(tools, "initialize_new_game");
    const commitTurn = requireTool(tools, "commit_turn");
    const getStatus = requireTool(tools, "get_status");
    const initialized = initialize.execute(
      "call-init",
      {},
      undefined,
      undefined,
      context
    ) as ToolResult;
    const saveId = initialized.details.saveId;
    assert.ok(typeof saveId === "string");

    const failed = await commitTurn.execute(
      toolCallId,
      {
        operations: [
          {
            system: "relay-blueprints",
            command: "create",
            input: { id: "relay-alpha", parts: ["core"], stability: 0.82 }
          },
          {
            system: "relay-blueprints",
            command: "create",
            input: { id: "relay-alpha", parts: ["antenna"], stability: 0.72 }
          }
        ]
      },
      undefined,
      undefined,
      context
    ) as ToolResult;
    const status = await getStatus.execute(
      "call-status",
      {},
      undefined,
      undefined,
      context
    ) as ToolResult;

    assert.equal(failed.terminate, undefined);
    assert.equal(failed.details.ok, false);
    assert.equal(
      (failed.details.error as { code?: unknown } | undefined)?.code,
      "COMMAND_FAILED"
    );
    assert.deepEqual(status.details.projections, [
      {
        system: "relay-blueprints",
        revision: 0,
        value: { count: 0, blueprints: [] }
      }
    ]);

    const requestId = createHash("sha256")
      .update(JSON.stringify(["pi-tool", sessionId, toolCallId]))
      .digest("hex");
    const db = openRpDatabase(sqlitePath);
    try {
      const metadata = db.prepare(`
        SELECT revision, branch_epoch
        FROM system_save_revisions
        WHERE save_id = ?
      `).get(saveId) as { revision: number; branch_epoch: number };
      assert.equal(metadata.revision, 0);
      assert.equal(metadata.branch_epoch, 0);

      const state = db.prepare(`
        SELECT payload_json
        FROM system_states
        WHERE save_id = ? AND system_name = ?
      `).get(saveId, "relay-blueprints") as { payload_json: string };
      assert.deepEqual(JSON.parse(state.payload_json), { blueprints: [] });

      const receipt = db.prepare(`
        SELECT COUNT(*) AS count
        FROM system_commit_receipts
        WHERE save_id = ? AND branch_epoch = 0 AND request_id = ?
      `).get(saveId, requestId) as { count: number };
      assert.equal(receipt.count, 0);
    } finally {
      db.close();
    }
  });
});

test("a dependent system reads candidate projection and rolls back across namespaces", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rp-system-probe-cross-system-"));
  const db = openRpDatabase(join(directory, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);
    type QuestState = { recorded: string[] };
    type RecordInput = { id: string; fail?: boolean };
    const blueprintQuest = defineSystem<QuestState>({
      name: "blueprint-quest",
      version: 1,
      dependsOn: ["relay-blueprints"],
      initialize: () => ({ recorded: [] }),
      parse(payload) {
        const recorded = (payload as { recorded?: unknown } | null)?.recorded;
        if (!Array.isArray(recorded) || recorded.some((id) => typeof id !== "string")) {
          throw new TypeError("invalid blueprint-quest state");
        }
        return { recorded: [...recorded] };
      },
      commands: {
        record_blueprint: {
          parseInput(input) {
            const { id, fail } = input as { id?: unknown; fail?: unknown };
            if (typeof id !== "string" || (fail !== undefined && typeof fail !== "boolean")) {
              throw new TypeError("invalid record_blueprint input");
            }
            return { id, fail } satisfies RecordInput;
          },
          execute(context, state, input) {
            const { id, fail } = input as RecordInput;
            const projection = context.read("relay-blueprints") as {
              count: number;
              blueprints: Array<Record<string, unknown>>;
            };
            const blueprint = projection.blueprints.find((entry) => entry.id === id);
            if (!blueprint) {
              throw new Error(`blueprint not projected: ${id}`);
            }
            if (Object.hasOwn(blueprint, "parts")) {
              throw new Error("relay-blueprints exposed raw parts to a dependant");
            }
            if (fail) {
              throw new Error("blueprint-quest fixture failure");
            }
            return {
              nextState: { recorded: [...state.recorded, id] },
              result: {
                id,
                observedPartCount: blueprint.partCount,
                rawPartsVisible: false
              }
            };
          }
        }
      },
      project: (_context, state) => ({ recorded: [...state.recorded] })
    });
    const registry = createSystemRegistry([blueprintQuest, relayBlueprints], {
      capabilities: new Map()
    });
    const runtime = createSystemRuntime({ db, registry });
    runtime.activateSave(save.id);

    const committed = await runtime.commit({
      saveId: save.id,
      requestId: "cross-system-success",
      caller: { kind: "gm", sessionId: "session-cross-system" },
      operations: [
        {
          system: "relay-blueprints",
          command: "create",
          input: {
            id: "relay-alpha",
            parts: ["core", "antenna"],
            stability: 0.82
          }
        },
        {
          system: "blueprint-quest",
          command: "record_blueprint",
          input: { id: "relay-alpha" }
        }
      ]
    });
    assert.equal(committed.revision, 1);
    assert.deepEqual(committed.operations[1]?.result, {
      id: "relay-alpha",
      observedPartCount: 2,
      rawPartsVisible: false
    });

    await assert.rejects(
      runtime.commit({
        saveId: save.id,
        requestId: "cross-system-failure",
        caller: { kind: "gm", sessionId: "session-cross-system" },
        operations: [
          {
            system: "relay-blueprints",
            command: "create",
            input: { id: "relay-beta", parts: ["lens"], stability: 0.61 }
          },
          {
            system: "blueprint-quest",
            command: "record_blueprint",
            input: { id: "relay-beta", fail: true }
          }
        ]
      }),
      (error) =>
        error instanceof SystemRuntimeError &&
        error.code === "COMMAND_FAILED" &&
        error.context.index === 1
    );

    const projections = await runtime.project({
      saveId: save.id,
      audience: { kind: "gm" }
    });
    assert.deepEqual(projections, [
      {
        system: "relay-blueprints",
        revision: 1,
        value: {
          count: 1,
          blueprints: [{ id: "relay-alpha", partCount: 2, stability: 0.82 }]
        }
      },
      {
        system: "blueprint-quest",
        revision: 1,
        value: { recorded: ["relay-alpha"] }
      }
    ]);
    const receiptCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM system_commit_receipts
      WHERE save_id = ?
    `).get(save.id) as { count: number };
    assert.equal(receiptCount.count, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("story delivery snapshots relay state and roll starts a replacement branch", async () => {
  const timers: Array<() => void> = [];
  let writerCalls = 0;
  await withShippedExtension(
    async ({ sqlitePath, tools, hooks, commands, sentMessages, completions }) => {
      const sessionId = "session-blueprint-roll";
      const baseContext = sessionCtx(sessionId);
      const initialize = requireTool(tools, "initialize_new_game");
      const commitTurn = requireTool(tools, "commit_turn");
      const updateScene = requireTool(tools, "update_scene");
      const submitDirection = requireTool(tools, "submit_direction_packet");
      const getStatus = requireTool(tools, "get_status");
      const agentEnd = hooks.get("agent_end");
      const roll = requireCommand(commands, "roll");
      assert.ok(agentEnd);

      const initialized = initialize.execute(
        "call-init",
        { scene: "snapshot one scene" },
        undefined,
        undefined,
        baseContext
      ) as ToolResult;
      const saveId = initialized.details.saveId;
      assert.ok(typeof saveId === "string");
      const db = openRpDatabase(sqlitePath);
      try {
        let idle = false;
        let latestEntries: unknown[] = [];
        const deliverStory = async (
          turn: number,
          playerInput: string
        ): Promise<void> => {
          idle = false;
          const submitted = submitDirection.execute(
            `call-submit-${turn}`,
            directionPacket(`story ${turn}`),
            undefined,
            undefined,
            baseContext
          ) as ToolResult;
          assert.equal(submitted.terminate, true);
          latestEntries = submittedPacketEntries(
            submitted,
            `call-submit-${turn}`,
            playerInput
          );

          const completionsBefore = completions.length;
          await agentEnd(
            {},
            sessionCtx(sessionId, {
              getEntries: () => latestEntries,
              isIdle: () => idle
            })
          );
          assert.equal(completions.length, completionsBefore + 1);
          assert.equal(snapshotTurns(db, saveId).length, turn - 1);
          assert.equal(timers.length, 1);

          idle = true;
          timers.shift()!();
          await completions.at(-1);
          assert.equal(snapshotTurns(db, saveId).length, turn);
        };

        const firstPlayerInput = "I inspect the silent relay.";
        await deliverStory(1, firstPlayerInput);
        const firstSnapshot = snapshotEnvelope(db, saveId, 1);
        assert.deepEqual(firstSnapshot.systems["relay-blueprints"], {
          version: 1,
          payload: { blueprints: [] }
        });

        const createInput = {
          operations: [
            {
              system: "relay-blueprints",
              command: "create",
              input: {
                id: "relay-alpha",
                parts: ["core", "antenna"],
                stability: 0.82
              }
            }
          ]
        };
        const oldReceipt = await commitTurn.execute(
          "call-create-alpha",
          createInput,
          undefined,
          undefined,
          baseContext
        ) as ToolResult;
        assert.equal(oldReceipt.details.revision, 1);
        assert.equal(oldReceipt.details.branchEpoch, 0);

        updateScene.execute(
          "call-scene-two",
          { summary: "snapshot two scene" },
          undefined,
          undefined,
          baseContext
        );
        const secondPlayerInput = "I assemble the relay blueprint.";
        await deliverStory(2, secondPlayerInput);
        const secondSnapshot = snapshotEnvelope(db, saveId, 2);
        assert.deepEqual(secondSnapshot.systems["relay-blueprints"], {
          version: 1,
          payload: {
            blueprints: [
              {
                id: "relay-alpha",
                parts: ["core", "antenna"],
                stability: 0.82
              }
            ]
          }
        });
        assert.equal(sentMessages.filter(({ message }) => message.customType === "writer-prose").length, 2);

        const rerunInputs: string[] = [];
        const notices: string[] = [];
        const commandContext: ExtensionCommandContextLike = {
          ...sessionCtx(sessionId, { getEntries: () => latestEntries }),
          rerunTurn(message) {
            rerunInputs.push(message);
          },
          ui: {
            async select() {
              return undefined;
            },
            async confirm() {
              return true;
            },
            async input() {
              return undefined;
            },
            notify(message) {
              notices.push(message);
            },
            setWorkingMessage() {}
          }
        };
        await roll.handler("", commandContext);

        const statusAfterRoll = await getStatus.execute(
          "call-status-after-roll",
          {},
          undefined,
          undefined,
          baseContext
        ) as ToolResult;
        assert.deepEqual(statusAfterRoll.details.projections, [
          {
            system: "relay-blueprints",
            revision: 2,
            value: { count: 0, blueprints: [] }
          }
        ]);
        const restoredCore = db.prepare(`
          SELECT state_json
          FROM latest_states
          WHERE save_id = ?
        `).get(saveId) as { state_json: string };
        assert.equal(JSON.parse(restoredCore.state_json).scene.summary, "snapshot one scene");
        assert.deepEqual(snapshotTurns(db, saveId), [1]);
        const metadata = readCommitMetadata(db, saveId);
        assert.equal(metadata.revision, 2);
        assert.equal(metadata.branchEpoch, 1);
        assert.deepEqual(rerunInputs, [secondPlayerInput]);
        assert.ok(notices.some((message) => /Rolled back/.test(message)));

        const replacementReceipt = await commitTurn.execute(
          "call-create-alpha",
          createInput,
          undefined,
          undefined,
          baseContext
        ) as ToolResult;
        assert.equal(replacementReceipt.details.requestId, oldReceipt.details.requestId);
        assert.equal(replacementReceipt.details.revision, 3);
        assert.equal(replacementReceipt.details.branchEpoch, 1);
        assert.notEqual(replacementReceipt.details.commitId, oldReceipt.details.commitId);

        const receiptRows = db.prepare(`
          SELECT branch_epoch, receipt_json
          FROM system_commit_receipts
          WHERE save_id = ? AND request_id = ?
          ORDER BY branch_epoch
        `).all(saveId, oldReceipt.details.requestId as string) as Array<{
          branch_epoch: number;
          receipt_json: string;
        }>;
        assert.deepEqual(
          receiptRows.map((row) => ({
            branchEpoch: row.branch_epoch,
            commitId: JSON.parse(row.receipt_json).commitId
          })),
          [
            { branchEpoch: 0, commitId: oldReceipt.details.commitId },
            { branchEpoch: 1, commitId: replacementReceipt.details.commitId }
          ]
        );
      } finally {
        db.close();
      }
    },
    {
      setTimeoutFn(callback) {
        timers.push(callback);
      },
      createWriterClient: () => ({
        async render() {
          writerCalls += 1;
          return `Rendered story ${writerCalls}.`;
        }
      })
    }
  );
});

test("writer failure preserves relay commits without publishing a story turn", async () => {
  await withShippedExtension(
    async ({ sqlitePath, tools, hooks, sentMessages, completions }) => {
      const sessionId = "session-blueprint-writer-failure";
      const context = sessionCtx(sessionId);
      const initialize = requireTool(tools, "initialize_new_game");
      const commitTurn = requireTool(tools, "commit_turn");
      const submitDirection = requireTool(tools, "submit_direction_packet");
      const getStatus = requireTool(tools, "get_status");
      const agentEnd = hooks.get("agent_end");
      assert.ok(agentEnd);

      const initialized = initialize.execute(
        "call-init",
        {},
        undefined,
        undefined,
        context
      ) as ToolResult;
      const saveId = initialized.details.saveId;
      assert.ok(typeof saveId === "string");
      const committed = await commitTurn.execute(
        "call-create-beta",
        {
          operations: [
            {
              system: "relay-blueprints",
              command: "create",
              input: { id: "relay-beta", parts: ["lens"], stability: 0.74 }
            }
          ]
        },
        undefined,
        undefined,
        context
      ) as ToolResult;
      assert.equal(committed.details.revision, 1);

      const submitted = submitDirection.execute(
        "call-submit-writer-failure",
        directionPacket("writer failure"),
        undefined,
        undefined,
        context
      ) as ToolResult;
      const entries = submittedPacketEntries(
        submitted,
        "call-submit-writer-failure",
        "I test the unstable relay."
      );
      let renderedEvents = 0;
      const unsubscribe = onTurnRendered(() => {
        renderedEvents += 1;
      });
      try {
        await assert.rejects(
          async () =>
            agentEnd(
              {},
              sessionCtx(sessionId, { getEntries: () => entries })
            ),
          /writer failed/
        );
      } finally {
        unsubscribe();
      }

      const status = await getStatus.execute(
        "call-status-after-writer-failure",
        {},
        undefined,
        undefined,
        context
      ) as ToolResult;
      assert.deepEqual(status.details.projections, [
        {
          system: "relay-blueprints",
          revision: 1,
          value: {
            count: 1,
            blueprints: [{ id: "relay-beta", partCount: 1, stability: 0.74 }]
          }
        }
      ]);
      assert.equal(completions.length, 0);
      assert.equal(sentMessages.length, 0);
      assert.equal(renderedEvents, 0);

      const db = openRpDatabase(sqlitePath);
      try {
        assert.deepEqual(snapshotTurns(db, saveId), []);
        const metadata = readCommitMetadata(db, saveId);
        assert.equal(metadata.revision, 1);
        assert.equal(metadata.branchEpoch, 0);
      } finally {
        db.close();
      }
    },
    {
      createWriterClient: () => ({
        async render() {
          throw new Error("writer failed");
        }
      })
    }
  );
});

for (const failure of ["idle timeout", "send failure"] as const) {
  test(`${failure} prevents a story snapshot after a relay commit`, async () => {
    const blueprintId = failure === "idle timeout" ? "relay-timeout" : "relay-send";
    await withShippedExtension(
      async ({ sqlitePath, tools, hooks, completions, sentMessages }) => {
        const sessionId = `session-blueprint-${blueprintId}`;
        const context = sessionCtx(sessionId);
        const initialize = requireTool(tools, "initialize_new_game");
        const commitTurn = requireTool(tools, "commit_turn");
        const submitDirection = requireTool(tools, "submit_direction_packet");
        const getStatus = requireTool(tools, "get_status");
        const agentEnd = hooks.get("agent_end");
        assert.ok(agentEnd);

        const initialized = initialize.execute(
          "call-init",
          {},
          undefined,
          undefined,
          context
        ) as ToolResult;
        const saveId = initialized.details.saveId;
        assert.ok(typeof saveId === "string");
        await commitTurn.execute(
          `call-create-${blueprintId}`,
          {
            operations: [
              {
                system: "relay-blueprints",
                command: "create",
                input: { id: blueprintId, parts: ["core"], stability: 0.65 }
              }
            ]
          },
          undefined,
          undefined,
          context
        );

        const submitted = submitDirection.execute(
          `call-submit-${blueprintId}`,
          directionPacket(failure),
          undefined,
          undefined,
          context
        ) as ToolResult;
        const entries = submittedPacketEntries(
          submitted,
          `call-submit-${blueprintId}`,
          `Player input for ${failure}.`
        );
        let renderedEvents = 0;
        const unsubscribe = onTurnRendered(() => {
          renderedEvents += 1;
        });
        try {
          await agentEnd(
            {},
            sessionCtx(sessionId, {
              getEntries: () => entries,
              isIdle: () => failure === "send failure"
            })
          );
          assert.equal(completions.length, 1);
          await completions[0];
        } finally {
          unsubscribe();
        }

        const status = await getStatus.execute(
          `call-status-${blueprintId}`,
          {},
          undefined,
          undefined,
          context
        ) as ToolResult;
        assert.deepEqual(status.details.projections, [
          {
            system: "relay-blueprints",
            revision: 1,
            value: {
              count: 1,
              blueprints: [{ id: blueprintId, partCount: 1, stability: 0.65 }]
            }
          }
        ]);
        assert.equal(renderedEvents, 0);
        assert.equal(sentMessages.length, failure === "send failure" ? 1 : 0);

        const db = openRpDatabase(sqlitePath);
        try {
          assert.deepEqual(snapshotTurns(db, saveId), []);
          assert.equal(readCommitMetadata(db, saveId).revision, 1);
        } finally {
          db.close();
        }
      },
      {
        createWriterClient: () => ({
          async render() {
            return `Rendered before ${failure}.`;
          }
        }),
        setTimeoutFn:
          failure === "idle timeout"
            ? (callback) => {
                callback();
              }
            : undefined,
        sendMessage:
          failure === "send failure"
            ? () => {
                throw new Error("send failed");
              }
            : undefined
      }
    );
  });
}

test("restore rejects a snapshot whose relay module is missing without partial writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rp-system-probe-missing-module-"));
  const db = openRpDatabase(join(directory, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);
    const stateStore = createStateStore(db);
    stateStore.replaceState(
      save.id,
      createInitialState({ scene: { summary: "snapshot one scene" } })
    );
    const registry = createSystemRegistry([relayBlueprints], {
      capabilities: new Map()
    });
    const runtime = createSystemRuntime({ db, registry });
    runtime.activateSave(save.id);
    const snapshots = createStorySnapshotCoordinator({
      db,
      registry,
      systemRuntime: runtime
    });
    snapshots.captureSuccessfulStory(save.id, stateStore.getState());
    await runtime.commit({
      saveId: save.id,
      requestId: "missing-module-seed",
      caller: { kind: "gm", sessionId: "session-missing-module" },
      operations: [
        {
          system: "relay-blueprints",
          command: "create",
          input: { id: "relay-alpha", parts: ["core"], stability: 0.8 }
        }
      ]
    });
    stateStore.mutateState((state) => {
      state.scene.summary = "snapshot two scene";
    });
    snapshots.captureSuccessfulStory(save.id, stateStore.getState());

    const registryWithoutRelay = createSystemRegistry([], {
      capabilities: new Map()
    });
    const incompatibleSnapshots = createStorySnapshotCoordinator({
      db,
      registry: registryWithoutRelay
    });
    const before = dumpRestoreParticipants(db, save.id);

    assert.throws(
      () => incompatibleSnapshots.restorePreviousAndSupersedeLatest(save.id),
      (error) =>
        error instanceof SystemRuntimeError &&
        error.code === "SNAPSHOT_INCOMPATIBLE" &&
        error.context.participant === "systems"
    );
    assert.equal(dumpRestoreParticipants(db, save.id), before);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function requireTool(tools: readonly RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `missing registered tool: ${name}`);
  return tool;
}

function requireCommand(
  commands: readonly RegisteredCommand[],
  name: string
): RegisteredCommand {
  const command = commands.find((entry) => entry.name === name);
  assert.ok(command, `missing registered command: ${name}`);
  return command;
}

function directionPacket(label: string): Record<string, unknown> {
  return {
    storyElements: {
      currentSituation: `${label} current situation.`,
      playerIntent: `${label} player intent.`,
      visibleChanges: [`${label} visible change.`],
      presentCharacters: ["player"],
      characterActions: [],
      tension: `${label} tension.`
    },
    needsRender: true,
    directReply: ""
  };
}

function submittedPacketEntries(
  result: ToolResult,
  toolCallId: string,
  playerInput: string
): unknown[] {
  return [
    { type: "message", message: { role: "user", content: playerInput } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "submit_direction_packet",
        toolCallId,
        details: result.details
      }
    }
  ];
}

function snapshotTurns(db: ReturnType<typeof openRpDatabase>, saveId: string): number[] {
  return db.prepare(`
    SELECT turn_no
    FROM turn_snapshots
    WHERE save_id = ?
    ORDER BY turn_no
  `).all(saveId).map((row) => row.turn_no as number);
}

function snapshotEnvelope(
  db: ReturnType<typeof openRpDatabase>,
  saveId: string,
  turnNo: number
): {
  systems: Record<string, { version: number; payload: unknown }>;
} {
  const row = db.prepare(`
    SELECT state_json
    FROM turn_snapshots
    WHERE save_id = ? AND turn_no = ?
  `).get(saveId, turnNo) as { state_json: string };
  return JSON.parse(row.state_json) as {
    systems: Record<string, { version: number; payload: unknown }>;
  };
}

function readCommitMetadata(
  db: ReturnType<typeof openRpDatabase>,
  saveId: string
): { revision: number; branchEpoch: number } {
  const row = db.prepare(`
    SELECT revision, branch_epoch
    FROM system_save_revisions
    WHERE save_id = ?
  `).get(saveId) as { revision: number; branch_epoch: number };
  return { revision: row.revision, branchEpoch: row.branch_epoch };
}

function dumpRestoreParticipants(
  db: ReturnType<typeof openRpDatabase>,
  saveId: string
): string {
  return JSON.stringify({
    core: db.prepare("SELECT * FROM latest_states WHERE save_id = ?").all(saveId),
    systems: db
      .prepare("SELECT * FROM system_states WHERE save_id = ? ORDER BY system_name")
      .all(saveId),
    snapshots: db
      .prepare("SELECT * FROM turn_snapshots WHERE save_id = ? ORDER BY turn_no")
      .all(saveId),
    metadata: db
      .prepare("SELECT * FROM system_save_revisions WHERE save_id = ?")
      .all(saveId),
    receipts: db
      .prepare(
        "SELECT * FROM system_commit_receipts WHERE save_id = ? ORDER BY branch_epoch, request_id"
      )
      .all(saveId)
  });
}

async function withShippedExtension(
  run: (harness: ShippedExtensionHarness) => Promise<void>,
  options: ShippedExtensionOptions = {}
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "rp-system-probe-"));
  const sqlitePath = join(directory, "state.sqlite");
  const previousWorld = process.env.RP_WORLD;
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  const previousOvDisable = process.env.RP_DISABLE_OPENVIKING;
  const tools: RegisteredTool[] = [];
  const hooks = new Map<string, RegisteredHook>();
  const commands: RegisteredCommand[] = [];
  const sentMessages: ShippedExtensionHarness["sentMessages"] = [];
  const completions: Promise<void>[] = [];

  process.env.RP_WORLD = "border-station";
  process.env.RP_SQLITE_PATH = sqlitePath;
  process.env.RP_DISABLE_OPENVIKING = "1";
  try {
    activateAllExtensions(
      {
        on(name, handler) {
          hooks.set(name, handler as RegisteredHook);
        },
        registerTool(tool) {
          tools.push(tool as RegisteredTool);
        },
        registerCommand(name, commandOptions) {
          commands.push({ name, handler: commandOptions.handler });
        },
        sendMessage(message, messageOptions) {
          sentMessages.push({ message, options: messageOptions });
          options.sendMessage?.(message, messageOptions);
        }
      },
      {
        createWriterClient: options.createWriterClient,
        setTimeoutFn: options.setTimeoutFn,
        observeCompletion(completion) {
          completions.push(completion);
          options.observeCompletion?.(completion);
        }
      }
    );
    await run({ sqlitePath, tools, hooks, commands, sentMessages, completions });
  } finally {
    resetShared();
    if (previousWorld === undefined) delete process.env.RP_WORLD;
    else process.env.RP_WORLD = previousWorld;
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    if (previousOvDisable === undefined) delete process.env.RP_DISABLE_OPENVIKING;
    else process.env.RP_DISABLE_OPENVIKING = previousOvDisable;
    rmSync(directory, { recursive: true, force: true });
  }
}
