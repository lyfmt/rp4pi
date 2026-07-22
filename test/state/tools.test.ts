import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const schema = await import(pathToFileURL(new URL("../../src/state/schema.ts", import.meta.url).pathname).href);
const status = await import(pathToFileURL(new URL("../../src/state/status.ts", import.meta.url).pathname).href);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const sessionBinding = await import(pathToFileURL(new URL("../../src/state/session-binding.ts", import.meta.url).pathname).href);
const saveRepository = await import(pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href);
const store = await import(pathToFileURL(new URL("../../src/state/store.ts", import.meta.url).pathname).href);
const systemDefinition = await import(
  pathToFileURL(new URL("../../src/systems/define-system.ts", import.meta.url).pathname).href
);
const systemRegistryModule = await import(
  pathToFileURL(new URL("../../src/systems/registry.ts", import.meta.url).pathname).href
);
const systemRepository = await import(
  pathToFileURL(new URL("../../src/systems/repository.ts", import.meta.url).pathname).href
);
const systemRuntimeModule = await import(
  pathToFileURL(new URL("../../src/systems/runtime.ts", import.meta.url).pathname).href
);
const registry = await import(pathToFileURL(new URL("../../src/tools/registry.ts", import.meta.url).pathname).href);
const initializeNewGame = await import(
  pathToFileURL(new URL("../../src/tools/state/initialize-new-game.ts", import.meta.url).pathname).href
);
const updateLocation = await import(
  pathToFileURL(new URL("../../src/tools/state/update-location.ts", import.meta.url).pathname).href
);
const updatePlayerStatus = await import(
  pathToFileURL(new URL("../../src/tools/state/update-player-status.ts", import.meta.url).pathname).href
);
const updateTime = await import(pathToFileURL(new URL("../../src/tools/state/update-time.ts", import.meta.url).pathname).href);
const updateScene = await import(
  pathToFileURL(new URL("../../src/tools/state/update-scene.ts", import.meta.url).pathname).href
);

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorySnapshotCoordinator } from "../../src/state/story-snapshot-coordinator.ts";
import { parseStorySnapshotEnvelope } from "../../src/state/snapshot-envelope.ts";
const createInitialState = schema.createInitialState as typeof import("../../src/state/schema.js").createInitialState;
const formatStatus = status.formatStatus as typeof import("../../src/state/status.js").formatStatus;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const readLatestState = sqlite.readLatestState as typeof import("../../src/state/sqlite.js").readLatestState;
const writeLatestState = sqlite.writeLatestState as typeof import("../../src/state/sqlite.js").writeLatestState;
const getBoundSave = sessionBinding.getBoundSave as typeof import("../../src/state/session-binding.js").getBoundSave;
const bindSessionToSave =
  sessionBinding.bindSessionToSave as typeof import("../../src/state/session-binding.js").bindSessionToSave;
const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const createStateStore = store.createStateStore as typeof import("../../src/state/store.js").createStateStore;
const defineSystem = systemDefinition.defineSystem as typeof import("../../src/systems/define-system.js").defineSystem;
const createSystemRegistry =
  systemRegistryModule.createSystemRegistry as typeof import("../../src/systems/registry.js").createSystemRegistry;
const listSystemStates =
  systemRepository.listSystemStates as typeof import("../../src/systems/repository.js").listSystemStates;
const readSystemState =
  systemRepository.readSystemState as typeof import("../../src/systems/repository.js").readSystemState;
const writeSystemState =
  systemRepository.writeSystemState as typeof import("../../src/systems/repository.js").writeSystemState;
const createSystemRuntime =
  systemRuntimeModule.createSystemRuntime as typeof import("../../src/systems/runtime.js").createSystemRuntime;
const registerAllTools = registry.registerAllTools as typeof import("../../src/tools/registry.js").registerAllTools;
const initializeNewGameTool =
  initializeNewGame.initializeNewGameTool as typeof import("../../src/tools/state/initialize-new-game.js").initializeNewGameTool;
const updateLocationTool =
  updateLocation.updateLocationTool as typeof import("../../src/tools/state/update-location.js").updateLocationTool;
const updatePlayerStatusTool =
  updatePlayerStatus.updatePlayerStatusTool as typeof import("../../src/tools/state/update-player-status.js").updatePlayerStatusTool;
const updateTimeTool = updateTime.updateTimeTool as typeof import("../../src/tools/state/update-time.js").updateTimeTool;
const updateSceneTool = updateScene.updateSceneTool as typeof import("../../src/tools/state/update-scene.js").updateSceneTool;
type ToolResult = import("../../src/tools/runtime/result.js").ToolResult;

type StateToolContext = { db: ReturnType<typeof openRpDatabase>; stateStore: ReturnType<typeof createStateStore>; piSessionId?: string };

function withToolHarness(fn: (harness: { db: ReturnType<typeof openRpDatabase>; stateStore: ReturnType<typeof createStateStore> }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rp-tools-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    fn({ db, stateStore: createStateStore(db) });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectSyncResult(result: ToolResult | Promise<ToolResult>): ToolResult {
  if (result instanceof Promise) {
    throw new TypeError("Expected synchronous tool result");
  }
  return result;
}

// Tools take (toolCallId, params, signal, onUpdate, ctx). For direct tests the
// domain ctx is `{ db, stateStore }`; signal/onUpdate are unused.
function ctx(harness: { db: ReturnType<typeof openRpDatabase>; stateStore: ReturnType<typeof createStateStore> }): StateToolContext {
  return { db: harness.db, stateStore: harness.stateStore };
}

test("createInitialState returns the default RP state fields", () => {
  const state = createInitialState();

  assert.deepEqual(state, {
    player: { name: "", status: "", location: "" },
    time: { day: 1, hour: 8 },
    scene: { summary: "" },
    attributes: {},
    facts: [],
    relationships: []
  });
});

test("formatStatus outputs player, status, location, time, and scene", () => {
  const state = createInitialState({
    player: { name: "Ari", status: "Wary", location: "Harbor Gate" },
    time: { day: 3, hour: 21 },
    scene: { summary: "Rain gathers on the empty road." }
  });

  assert.equal(
    formatStatus(state),
    ["玩家：Ari", "状态：Wary", "地点：Harbor Gate", "时间：第 3 天 21:00", "场景：Rain gathers on the empty road."].join("\n")
  );
});

test("initialize_new_game creates a save and initializes latest state", () => {
  withToolHarness((harness) => {
    const result = expectSyncResult(
      initializeNewGameTool.execute(
        "call-1",
        { playerName: "Ari", location: "Border Relay", status: "Awake", scene: "A wounded courier waits." },
        undefined,
        undefined,
        ctx(harness) as unknown as never
      )
    );

    assert.match(result.details?.saveId as string, /^[0-9a-f-]{36}$/);
    assert.equal(harness.stateStore.getState().player.name, "Ari");
    assert.equal(readLatestState(harness.db, result.details?.saveId as string)?.scene.summary, "A wounded courier waits.");
  });
});

test("initialize_new_game initializes every registered System namespace", () => {
  withToolHarness((harness) => {
    const progression = defineSystem({
      name: "progression",
      version: 1,
      initialize: () => ({ xp: 0 }),
      parse: (payload) => payload as { xp: number },
      commands: {},
      project: (_context, state) => state
    });
    const systemRegistry = createSystemRegistry([progression], {
      capabilities: new Map()
    });
    const result = expectSyncResult(
      initializeNewGameTool.execute(
        "call-systems",
        { playerName: "Ari" },
        undefined,
        undefined,
        { ...ctx(harness), systemRegistry, piSessionId: "session-a" } as never
      )
    );

    assert.deepEqual(listSystemStates(harness.db, result.details.saveId as string), [
      { name: "progression", version: 1, payload: { xp: 0 } }
    ]);
  });
});

test("registered state tools carry a TUI label and bound domain context", () => {
  withToolHarness(({ db, stateStore }) => {
    const registeredTools: Array<{ name: string; label?: string; execute: (...args: unknown[]) => ToolResult | Promise<ToolResult> }> = [];
    registerAllTools(
      { on() {}, registerTool: (tool) => registeredTools.push(tool as (typeof registeredTools)[number]), registerCommand() {}, sendMessage() {} },
      { db, stateStore }
    );
    const tool = registeredTools.find((candidate) => candidate.name === "initialize_new_game");
    assert.ok(tool);
    assert.equal(typeof tool.label, "string");
    assert.equal(registeredTools.some((candidate) => candidate.name === "rp_ping"), false);

    const result = expectSyncResult(tool.execute("call-1", { playerName: "Ari" }, undefined, undefined, { db, stateStore } as unknown as never) as ToolResult);
    assert.match(result.details?.saveId as string, /^[0-9a-f-]{36}$/);
    assert.equal(stateStore.getState().player.name, "Ari");
  });
});

test("world tools declaration selects built-in groups and imports extra tool modules", () => {
  withToolHarness(({ db, stateStore }) => {
    const dir = mkdtempSync(join(tmpdir(), "rp-world-tools-"));
    const extraPath = join(dir, "extra-tool.ts");
    writeFileSync(
      extraPath,
      [
        "export const worldEchoTool = {",
        "  name: 'world_echo',",
        "  label: 'World',",
        "  description: 'Echoes a world-local tool result.',",
        "  parameters: { type: 'object', properties: { text: { type: 'string' } } },",
        "  execute(_toolCallId, params) {",
        "    return { content: [{ type: 'text', text: `world:${params.text ?? ''}` }], details: { source: 'world' } };",
        "  }",
        "};",
        ""
      ].join("\n")
    );

    const registeredTools: Array<{ name: string; label?: string; execute: (...args: unknown[]) => ToolResult | Promise<ToolResult> }> = [];
    try {
      registerAllTools(
        { on() {}, registerTool: (tool) => registeredTools.push(tool as (typeof registeredTools)[number]), registerCommand() {}, sendMessage() {} },
        { db, stateStore },
        undefined,
        { include: ["core.state"], extra: [extraPath] }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    assert.equal(registeredTools.some((tool) => tool.name === "initialize_new_game"), true);
    assert.equal(registeredTools.some((tool) => tool.name === "search_memory"), false);
    const extra = registeredTools.find((tool) => tool.name === "world_echo");
    assert.ok(extra);
    const result = expectSyncResult(extra.execute("call-extra", { text: "ok" }, undefined, undefined, {} as never) as ToolResult);
    assert.equal(result.content[0]?.text, "world:ok");
  });
});

test("registered state tools bind a newly initialized save to ctx.sessionManager's session", () => {
  withToolHarness(({ db, stateStore }) => {
    const registeredTools: Array<{ name: string; execute: (...args: unknown[]) => ToolResult | Promise<ToolResult> }> = [];
    registerAllTools(
      { on() {}, registerTool: (tool) => registeredTools.push(tool as (typeof registeredTools)[number]), registerCommand() {}, sendMessage() {} },
      { db, stateStore }
    );
    const initialize = registeredTools.find((candidate) => candidate.name === "initialize_new_game");
    assert.ok(initialize);

    const piCtx = { sessionManager: { getSessionId: () => "session-a" } };
    const result = expectSyncResult(
      initialize.execute("call-1", { playerName: "Ari" }, undefined, undefined, piCtx as unknown as never) as ToolResult
    );
    const saveId = result.details?.saveId as string;

    assert.equal(getBoundSave(db, "session-a"), saveId);
    assert.equal(stateStore.getState().player.name, "Ari");
  });
});

test("registered state tools isolate saves across ctx.sessionManager sessions", () => {
  withToolHarness(({ db, stateStore }) => {
    const registeredTools: Array<{ name: string; execute: (...args: unknown[]) => ToolResult | Promise<ToolResult> }> = [];
    registerAllTools(
      { on() {}, registerTool: (tool) => registeredTools.push(tool as (typeof registeredTools)[number]), registerCommand() {}, sendMessage() {} },
      { db, stateStore }
    );
    const initialize = registeredTools.find((candidate) => candidate.name === "initialize_new_game");
    const updateLocationFromRegistry = registeredTools.find((candidate) => candidate.name === "update_location");
    assert.ok(initialize);
    assert.ok(updateLocationFromRegistry);

    const ctxA = { sessionManager: { getSessionId: () => "session-a" } } as unknown as never;
    const ctxB = { sessionManager: { getSessionId: () => "session-b" } } as unknown as never;

    const saveA = expectSyncResult(initialize.execute("call-1", { playerName: "Ari", location: "Gate A" }, undefined, undefined, ctxA) as ToolResult)
      .details?.saveId as string;
    const saveB = expectSyncResult(initialize.execute("call-2", { playerName: "Bea", location: "Gate B" }, undefined, undefined, ctxB) as ToolResult)
      .details?.saveId as string;

    updateLocationFromRegistry.execute("call-3", { location: "Tower A" }, undefined, undefined, ctxA);

    assert.equal(readLatestState(db, saveA)?.player.location, "Tower A");
    assert.equal(readLatestState(db, saveB)?.player.location, "Gate B");
  });
});

test("registered state tools activate and migrate the session-bound System save before execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-tool-system-migration-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));

  try {
    initializeSchema(db);
    const stateStore = createStateStore(db);
    const save = createSave(db);
    writeLatestState(db, save.id, createInitialState({ player: { name: "Ari" } }));
    writeSystemState(db, save.id, {
      name: "progression",
      version: 1,
      payload: { xp: 10 }
    });
    db.prepare(
      "INSERT INTO turn_snapshots (save_id, turn_no, state_json, created_at) VALUES (?, ?, ?, ?)"
    ).run(save.id, 5, JSON.stringify(createInitialState({ player: { name: "legacy" } })), "t5");
    bindSessionToSave(db, "session-migrate", save.id);
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
    const systemRegistry = createSystemRegistry([progression], {
      capabilities: new Map()
    });
    const systemRuntime = createSystemRuntime({ db, registry: systemRegistry });
    const storySnapshots = createStorySnapshotCoordinator({ db, registry: systemRegistry });
    const registeredTools: Array<{
      name: string;
      execute: (...args: unknown[]) => ToolResult | Promise<ToolResult>;
    }> = [];
    registerAllTools(
      {
        on() {},
        registerTool: (tool) => registeredTools.push(tool as (typeof registeredTools)[number]),
        registerCommand() {},
        sendMessage() {}
      },
      { db, stateStore, systemRegistry, systemRuntime, storySnapshots },
      undefined,
      { include: ["core.state"] }
    );
    const statusTool = registeredTools.find((tool) => tool.name === "get_status");
    assert.ok(statusTool);

    await statusTool.execute(
      "call-status",
      {},
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-migrate" } }
    );

    assert.deepEqual(readSystemState(db, save.id, "progression"), {
      name: "progression",
      version: 2,
      payload: { xp: 10, level: 1 }
    });
    const snapshot = db
      .prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ? AND turn_no = 5")
      .get(save.id) as { state_json: string };
    assert.equal(parseStorySnapshotEnvelope(JSON.parse(snapshot.state_json)).core.payload.player.name, "Ari");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state tool context validation rejects malformed context", () => {
  assert.throws(() => {
    updateLocationTool.execute("call-1", { location: "Nowhere" }, undefined, undefined, { db: {}, stateStore: {} } as unknown as never);
  }, /状态工具上下文/);
});

test("update_location only changes player location", () => {
  withToolHarness((harness) => {
    const saveId = expectSyncResult(
      initializeNewGameTool.execute("c1", { playerName: "Ari", status: "Calm" }, undefined, undefined, ctx(harness) as unknown as never)
    ).details?.saveId as string;
    const before = harness.stateStore.getState();

    updateLocationTool.execute("c2", { location: "Old Road" }, undefined, undefined, ctx(harness) as unknown as never);

    assert.equal(harness.stateStore.getState().player.location, "Old Road");
    assert.equal(harness.stateStore.getState().player.name, before.player.name);
    assert.equal(readLatestState(harness.db, saveId)?.player.location, "Old Road");
  });
});

test("update_player_status coerces adjacent-typed inputs (loose entry)", () => {
  withToolHarness((harness) => {
    initializeNewGameTool.execute("c1", { playerName: "Ari", location: "Gate" }, undefined, undefined, ctx(harness) as unknown as never);
    // a number should be coerced to text, not rejected — 入口宽
    updatePlayerStatusTool.execute("c2", { status: 42 }, undefined, undefined, ctx(harness) as unknown as never);
    assert.equal(harness.stateStore.getState().player.status, "42");
  });
});

test("update_time supports absolute and relative modes but not both", () => {
  withToolHarness((harness) => {
    initializeNewGameTool.execute("c1", {}, undefined, undefined, ctx(harness) as unknown as never);

    updateTimeTool.execute("c2", { absolute: { day: 2, hour: 23 } }, undefined, undefined, ctx(harness) as unknown as never);
    assert.deepEqual(harness.stateStore.getState().time, { day: 2, hour: 23 });

    updateTimeTool.execute("c3", { advanceHours: 3 }, undefined, undefined, ctx(harness) as unknown as never);
    assert.deepEqual(harness.stateStore.getState().time, { day: 3, hour: 2 });

    assert.throws(() => {
      updateTimeTool.execute("c4", { absolute: { day: 4, hour: 8 }, advanceHours: 1 }, undefined, undefined, ctx(harness) as unknown as never);
    }, /恰好一种模式/);
  });
});

test("update_scene only changes scene summary", () => {
  withToolHarness((harness) => {
    initializeNewGameTool.execute("c1", { playerName: "Ari", status: "Ready" }, undefined, undefined, ctx(harness) as unknown as never);
    const before = harness.stateStore.getState();

    updateSceneTool.execute("c2", { summary: "The road is quiet." }, undefined, undefined, ctx(harness) as unknown as never);

    assert.equal(harness.stateStore.getState().scene.summary, "The road is quiet.");
    assert.equal(harness.stateStore.getState().player.status, before.player.status);
  });
});
