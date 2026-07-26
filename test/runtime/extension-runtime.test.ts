import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { activateAllExtensions, activateOvMemory, resetShared } from "../helpers/extensions.ts";
import { formatPacketForWriter } from "../../src/runtime/writer-history.ts";
import { parseStorySnapshotEnvelope } from "../../src/state/snapshot-envelope.ts";
import { latestStorySnapshotTurnNo } from "../../src/state/snapshots.ts";
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);

const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
type OpenVikingClient = import("../../src/ov/client.js").OpenVikingClient;
type ToolResultEntry = { name: string; execute: (...args: unknown[]) => unknown };
type RegisteredCommand = { name: string; description?: string; handler: (args: string, ctx: any) => Promise<void> | void };

function sessionCtx(sessionId: string, getEntries?: () => unknown[]): unknown {
  const sessionManager: { getSessionId(): string; getEntries?(): unknown[] } = { getSessionId: () => sessionId };
  if (getEntries) sessionManager.getEntries = getEntries;
  return {
    sessionManager,
    isIdle: () => true,
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

// A session transcript ending in a submitted (but unrendered) direction packet,
// the shape createAgentEndHandler reads via findPendingDirectionPacket.
function entriesWithSubmittedPacket(packet: unknown, playerInput: string): unknown[] {
  return [
    { type: "message", message: { role: "user", content: playerInput } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "submit_direction_packet",
        toolCallId: "call-submit",
        details: { packet }
      }
    }
  ];
}

async function awaitStoryCompletion(completion: Promise<void> | undefined): Promise<void> {
  assert.ok(completion);
  await completion;
}

test("extension keeps commit_turn in the GM loop and reserves termination for presentation handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rp-extension-commit-turn-"));
  const previousWorld = process.env.RP_WORLD;
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  const previousOvDisable = process.env.RP_DISABLE_OPENVIKING;
  const tools: ToolResultEntry[] = [];

  try {
    process.env.RP_WORLD = "border-station";
    process.env.RP_SQLITE_PATH = join(directory, "state.sqlite");
    process.env.RP_DISABLE_OPENVIKING = "1";
    activateAllExtensions({
      on() {},
      registerTool(tool) {
        tools.push(tool as ToolResultEntry);
      },
      registerCommand() {},
      sendMessage() {}
    });

    const initialize = tools.find((tool) => tool.name === "initialize_new_game");
    const commitTurn = tools.find((tool) => tool.name === "commit_turn");
    const submitDirection = tools.find(
      (tool) => tool.name === "submit_direction_packet"
    );
    assert.ok(initialize);
    assert.ok(commitTurn);
    assert.ok(submitDirection);
    const context = sessionCtx("session-system");
    initialize.execute("call-init", {}, undefined, undefined, context);

    const first = await commitTurn.execute(
      "call-commit-1",
      {
        operations: [
          {
            system: "relay-blueprints",
            command: "create",
            input: { id: "relay-alpha", parts: ["core"], stability: 0.8 }
          }
        ]
      },
      undefined,
      undefined,
      context
    ) as { terminate?: boolean; details: Record<string, unknown> };
    const second = await commitTurn.execute(
      "call-commit-2",
      {
        operations: [
          {
            system: "relay-blueprints",
            command: "create",
            input: { id: "relay-beta", parts: ["antenna"], stability: 0.7 }
          }
        ]
      },
      undefined,
      undefined,
      context
    ) as { terminate?: boolean; details: Record<string, unknown> };
    const submitted = submitDirection.execute(
      "call-submit",
      {
        storyElements: {
          currentSituation: "The relay is quiet.",
          playerIntent: "Continue.",
          visibleChanges: [],
          presentCharacters: ["player"],
          characterActions: [],
          tension: "The road remains uncertain."
        },
        needsRender: true,
        directReply: ""
      },
      undefined,
      undefined,
      context
    ) as { terminate?: boolean };

    assert.equal(first.terminate, undefined);
    assert.equal(first.details.revision, 1);
    assert.equal(second.terminate, undefined);
    assert.equal(second.details.revision, 2);
    assert.equal(submitted.terminate, true);
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
});

test("extension agent_end hook commits submitted direction packets through the writer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-"));
  const sqlitePath = join(dir, "state.sqlite");
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  process.env.RP_SQLITE_PATH = sqlitePath;

  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sentMessages: Array<{ customType: string; content: string; options?: { triggerTurn?: boolean } }> = [];
  const writerInputs: unknown[] = [];
  const ovCalls: string[] = [];
  const tools: ToolResultEntry[] = [];
  let storyCompletion: Promise<void> | undefined;

  try {
    activateAllExtensions(
      {
        on(name, handler) {
          hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown);
        },
        registerTool(tool) {
          tools.push(tool as ToolResultEntry);
        },
        registerCommand() {},
        sendMessage(message, options) {
          sentMessages.push({ customType: message.customType, content: (message as { content: string }).content, options });
        }
      },
      {
        observeCompletion(completion) {
          storyCompletion = completion;
        },
        createWriterClient: () => ({
          async render(messages) {
            writerInputs.push(messages);
            return "Rendered by fake writer.";
          }
        })
      }
    );

    const init = tools.find((tool) => tool.name === "initialize_new_game");
    assert.ok(init);
    const initResult = init.execute("c1", { playerName: "Ari", scene: "Start" }, undefined, undefined, sessionCtx("session-x")) as {
      details?: { saveId?: string };
    };
    const saveId = initResult.details?.saveId;
    assert.ok(saveId);

    const submitDirection = tools.find((tool) => tool.name === "submit_direction_packet");
    assert.ok(submitDirection);
    const packet = {
      storyElements: {
        currentSituation: "A courier is at the relay station.",
        playerIntent: "The player helps the courier.",
        visibleChanges: ["The courier arrives."],
        presentCharacters: ["player", "courier"],
        tension: "The road ahead is still unsafe."
      },
      needsRender: true,
      directReply: ""
    };

    const agentEnd = hooks.get("agent_end");
    assert.ok(agentEnd);
    await agentEnd(
      {},
      sessionCtx("session-x", () => entriesWithSubmittedPacket(packet, "I help the courier."))
    );
    await awaitStoryCompletion(storyCompletion);

    // writer rendered via configured model and prose delivered via sendMessage
    assert.equal(sentMessages[0]?.customType, "writer-prose");
    assert.equal(sentMessages[0]?.content, "Rendered by fake writer.");
    assert.deepEqual(sentMessages[0]?.options, { triggerTurn: false });
    assert.equal(writerInputs.length, 1);
    const writerInput = writerInputs[0] as Parameters<import("../../src/runtime/writer-client.js").WriterClient["render"]>[0];
    const writerText = formatPacketForWriter(writerInput.packet);
    assert.match(writerText, /# Story Elements/);
    assert.match(writerText, /Current situation: A courier is at the relay station\./);
    assert.doesNotMatch(writerText, /^Start:/m);
    const db = openRpDatabase(sqlitePath);
    try {
      assert.equal(latestStorySnapshotTurnNo(db, saveId), 1);
    } finally {
      db.close();
    }
    void writerInputs;
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension streams writer, commit, and hook progress into the current UI context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-progress-"));
  const sqlitePath = join(dir, "state.sqlite");
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  const previousOvDisable = process.env.RP_DISABLE_OPENVIKING;
  process.env.RP_SQLITE_PATH = sqlitePath;
  process.env.RP_DISABLE_OPENVIKING = "1";

  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: ToolResultEntry[] = [];
  const workingMessages: string[] = [];
  let storyCompletion: Promise<void> | undefined;

  try {
    activateAllExtensions(
      {
        on(name, handler) {
          hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown);
        },
        registerTool(tool) {
          tools.push(tool as ToolResultEntry);
        },
        registerCommand() {},
        sendMessage() {}
      },
      {
        observeCompletion(completion) {
          storyCompletion = completion;
        },
        createWriterClient: () => ({
          async render(input: any) {
            input.progress?.({ type: "stage_start", stage: "draft" });
            input.progress?.({ type: "stage_end", stage: "draft", output: "Draft done." });
            return "Rendered with live progress.";
          }
        })
      }
    );

    const initialize = tools.find((tool) => tool.name === "initialize_new_game");
    const agentEnd = hooks.get("agent_end");
    assert.ok(initialize);
    assert.ok(agentEnd);
    initialize.execute("c1", { scene: "Start" }, undefined, undefined, sessionCtx("session-progress"));

    const packet = {
      storyElements: {
        currentSituation: "Progress scene.",
        playerIntent: "Continue.",
        visibleChanges: ["Progress changes."],
        presentCharacters: ["player"],
        tension: "Progress tension."
      },
      needsRender: true,
      directReply: ""
    };
    const ctx = sessionCtx("session-progress", () => entriesWithSubmittedPacket(packet, "Continue.")) as any;
    ctx.hasUI = true;
    ctx.mode = "tui";
    ctx.ui = {
      select: async () => undefined,
      confirm: async () => true,
      input: async () => undefined,
      notify() {},
      setWorkingMessage(message?: string) {
        workingMessages.push(message ?? "");
      }
    };

    await agentEnd({}, ctx);
    await awaitStoryCompletion(storyCompletion);

    const visibleProgress = workingMessages.join("\n");
    assert.match(visibleProgress, /draft/);
    assert.match(visibleProgress, /commit/);
    assert.match(visibleProgress, /hook/);
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    if (previousOvDisable === undefined) delete process.env.RP_DISABLE_OPENVIKING;
    else process.env.RP_DISABLE_OPENVIKING = previousOvDisable;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension surfaces OpenViking append failures as memory error messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-ov-error-"));
  const sqlitePath = join(dir, "state.sqlite");
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  const previousFetch = globalThis.fetch;
  process.env.RP_SQLITE_PATH = sqlitePath;
  globalThis.fetch = (async () => {
    throw new Error("OV refused connection");
  }) as typeof fetch;

  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sentMessages: Array<{
    customType: string;
    content: string;
    details?: Record<string, unknown>;
    options?: { triggerTurn?: boolean };
  }> = [];
  const tools: ToolResultEntry[] = [];
  const workingMessages: string[] = [];
  let storyCompletion: Promise<void> | undefined;

  try {
    activateAllExtensions(
      {
        on(name, handler) {
          hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown);
        },
        registerTool(tool) {
          tools.push(tool as ToolResultEntry);
        },
        registerCommand() {},
        sendMessage(message, options) {
          sentMessages.push({
            customType: message.customType,
            content: message.content,
            details: message.details,
            options
          });
        }
      },
      {
        observeCompletion(completion) {
          storyCompletion = completion;
        },
        createWriterClient: () => ({
          async render() {
            return "Rendered by fake writer.";
          }
        })
      }
    );

    const init = tools.find((tool) => tool.name === "initialize_new_game");
    const submitDirection = tools.find((tool) => tool.name === "submit_direction_packet");
    const agentEnd = hooks.get("agent_end");
    assert.ok(init);
    assert.ok(submitDirection);
    assert.ok(agentEnd);

    init.execute("c1", { scene: "Start" }, undefined, undefined, sessionCtx("session-ov-error"));
    const packet = {
      storyElements: {
        currentSituation: "A courier is at the relay station.",
        playerIntent: "The player helps the courier.",
        visibleChanges: ["The courier arrives."],
        presentCharacters: ["player", "courier"],
        tension: "The road ahead is still unsafe."
      },
      needsRender: true,
      directReply: ""
    };

    const ctx = sessionCtx("session-ov-error", () => entriesWithSubmittedPacket(packet, "I help the courier.")) as any;
    ctx.hasUI = true;
    ctx.mode = "tui";
    ctx.ui = {
      select: async () => undefined,
      confirm: async () => true,
      input: async () => undefined,
      notify() {},
      setWorkingMessage(message?: string) {
        workingMessages.push(message ?? "");
      }
    };

    await agentEnd({}, ctx);
    await awaitStoryCompletion(storyCompletion);

    assert.equal(sentMessages[0]?.customType, "writer-prose");
    assert.deepEqual(sentMessages[0]?.options, { triggerTurn: false });
    assert.equal(sentMessages[1]?.customType, "openviking-memory-error");
    assert.equal(sentMessages[1]?.content, "OpenViking memory append failed: OV refused connection");
    assert.equal(sentMessages[1]?.details?.kind, "openviking-memory-error");
    assert.deepEqual(sentMessages[1]?.options, { triggerTurn: false });
    // Memory sedimentation is widget-owned: it must never reach the working
    // label (the append runs after idle, and its completion can arrive
    // mid-NEXT-turn where a label write would clobber that turn's loader).
    assert.doesNotMatch(workingMessages.join("\n"), /openviking/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension follows the async extraction task and reports the real sedimentation outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-ov-async-"));
  const sqlitePath = join(dir, "state.sqlite");
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  const previousFetch = globalThis.fetch;
  const previousPollInterval = process.env.OPENVIKING_EXTRACT_POLL_INTERVAL_MS;
  process.env.RP_SQLITE_PATH = sqlitePath;
  process.env.OPENVIKING_EXTRACT_POLL_INTERVAL_MS = "5";

  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  let taskPolls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const target = String(url);
    if (target.includes("/api/v1/tasks/")) {
      taskPolls += 1;
      return taskPolls < 2
        ? jsonResponse({ status: "ok", result: { task_id: "task-9", status: "running" } })
        : jsonResponse({
            status: "ok",
            result: { task_id: "task-9", status: "completed", result: { memories_extracted: { memory_write: 2 } } }
          });
    }
    if (target.endsWith("/commit")) {
      return jsonResponse({ status: "ok", result: { status: "accepted", task_id: "task-9" } });
    }
    return jsonResponse({ status: "ok", result: { session_id: "session-async" } });
  }) as typeof fetch;

  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: ToolResultEntry[] = [];
  const widgets = new Map<string, unknown>();
  const workingMessages: string[] = [];
  let storyCompletion: Promise<void> | undefined;
  let component: { render(width: number): string[]; dispose?(): void } | undefined;

  try {
    activateAllExtensions(
      {
        on(name, handler) {
          hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown);
        },
        registerTool(tool) {
          tools.push(tool as ToolResultEntry);
        },
        registerCommand() {},
        sendMessage() {}
      },
      {
        observeCompletion(completion) {
          storyCompletion = completion;
        },
        createWriterClient: () => ({
          async render() {
            return "Rendered by fake writer.";
          }
        })
      }
    );

    const init = tools.find((tool) => tool.name === "initialize_new_game");
    const agentEnd = hooks.get("agent_end");
    assert.ok(init);
    assert.ok(agentEnd);

    init.execute("c1", { scene: "Start" }, undefined, undefined, sessionCtx("session-ov-async"));
    const packet = {
      storyElements: {
        currentSituation: "A courier is at the relay station.",
        playerIntent: "The player helps the courier.",
        visibleChanges: ["The courier arrives."],
        presentCharacters: ["player", "courier"],
        tension: "The road ahead is still unsafe."
      },
      needsRender: true,
      directReply: ""
    };

    const ctx = sessionCtx("session-ov-async", () => entriesWithSubmittedPacket(packet, "I help the courier.")) as any;
    ctx.hasUI = true;
    ctx.mode = "tui";
    ctx.ui = {
      select: async () => undefined,
      confirm: async () => true,
      input: async () => undefined,
      notify() {},
      setWorkingMessage(message?: string) {
        workingMessages.push(message ?? "");
      },
      setWidget(key: string, content: unknown) {
        if (content === undefined) {
          widgets.delete(key);
          return;
        }
        widgets.set(key, content);
        const factory = content as (tui: unknown) => { render(width: number): string[]; dispose?(): void };
        component = factory({ requestRender() {} });
      }
    };

    await agentEnd({}, ctx);
    await awaitStoryCompletion(storyCompletion);
    assert.equal(widgets.size, 1, "widget must survive pipeline_done while the extraction task runs");

    // The watcher polls the task API (5ms interval here) until it completes.
    let outcome: string | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      outcome = component?.render(80)[0];
      if (outcome?.includes("记忆已沉淀")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(outcome?.includes("记忆已沉淀 ✓"), `real outcome must land in the widget: ${outcome}`);
    assert.ok(outcome?.includes("2 条记忆"), `memory count is part of the outcome: ${outcome}`);
    assert.ok(taskPolls >= 2, "watcher must have polled the task API");
    // The watcher's stage_end (arriving minutes after idle in production) must
    // never reach the working label — it would clobber the NEXT turn's loader.
    assert.doesNotMatch(workingMessages.join("\n"), /openviking/);
  } finally {
    component?.dispose?.();
    globalThis.fetch = previousFetch;
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    if (previousPollInterval === undefined) delete process.env.OPENVIKING_EXTRACT_POLL_INTERVAL_MS;
    else process.env.OPENVIKING_EXTRACT_POLL_INTERVAL_MS = previousPollInterval;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension cancels stale extraction watches on the next turn and on shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-ov-cancel-"));
  const sqlitePath = join(dir, "state.sqlite");
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  const previousFetch = globalThis.fetch;
  const previousPollInterval = process.env.OPENVIKING_EXTRACT_POLL_INTERVAL_MS;
  process.env.RP_SQLITE_PATH = sqlitePath;
  process.env.OPENVIKING_EXTRACT_POLL_INTERVAL_MS = "5";

  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  // Both turns' tasks stay running forever — only cancellation stops polling.
  let commits = 0;
  const taskPolls = new Map<string, number>([["task-A", 0], ["task-B", 0]]);
  globalThis.fetch = (async (url: string | URL) => {
    const target = String(url);
    const pollMatch = /\/api\/v1\/tasks\/(task-[AB])/.exec(target);
    if (pollMatch !== null) {
      const taskId = pollMatch[1] as string;
      taskPolls.set(taskId, (taskPolls.get(taskId) ?? 0) + 1);
      return jsonResponse({ status: "ok", result: { task_id: taskId, status: "running" } });
    }
    if (target.endsWith("/commit")) {
      commits += 1;
      return jsonResponse({ status: "ok", result: { status: "accepted", task_id: commits === 1 ? "task-A" : "task-B" } });
    }
    return jsonResponse({ status: "ok", result: { session_id: "session-cancel" } });
  }) as typeof fetch;

  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const frozen = async (taskId: string): Promise<boolean> => {
    const before = taskPolls.get(taskId) ?? 0;
    await settle(60);
    return (taskPolls.get(taskId) ?? 0) === before;
  };
  const polling = async (taskId: string): Promise<boolean> => {
    const before = taskPolls.get(taskId) ?? 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await settle(10);
      if ((taskPolls.get(taskId) ?? 0) > before) {
        return true;
      }
    }
    return false;
  };

  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: ToolResultEntry[] = [];
  const completions: Array<Promise<void>> = [];

  try {
    activateAllExtensions(
      {
        on(name, handler) {
          hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown);
        },
        registerTool(tool) {
          tools.push(tool as ToolResultEntry);
        },
        registerCommand() {},
        sendMessage() {}
      },
      {
        observeCompletion(completion) {
          completions.push(completion);
        },
        createWriterClient: () => ({
          async render() {
            return "Rendered by fake writer.";
          }
        })
      }
    );

    const init = tools.find((tool) => tool.name === "initialize_new_game");
    const agentEnd = hooks.get("agent_end");
    // openviking-memory activates last, so the map holds ITS shutdown handler.
    const sessionShutdown = hooks.get("session_shutdown");
    assert.ok(init);
    assert.ok(agentEnd);
    assert.ok(sessionShutdown);

    init.execute("c1", { scene: "Start" }, undefined, undefined, sessionCtx("session-ov-cancel"));
    const packet = {
      storyElements: {
        currentSituation: "A courier is at the relay station.",
        playerIntent: "The player helps the courier.",
        visibleChanges: ["The courier arrives."],
        presentCharacters: ["player", "courier"],
        tension: "The road ahead is still unsafe."
      },
      needsRender: true,
      directReply: ""
    };
    const turnEntries = (toolCallId: string, playerInput: string): unknown[] => [
      { type: "message", message: { role: "user", content: playerInput } },
      {
        type: "message",
        message: { role: "toolResult", toolName: "submit_direction_packet", toolCallId, details: { packet } }
      }
    ];

    // A watcher only spawns when there is a progress sink to report to.
    const minimalUi = {
      select: async () => undefined,
      confirm: async () => true,
      input: async () => undefined,
      notify() {},
      setWorkingMessage() {}
    };

    // Turn 1: watcher A starts polling its never-completing task.
    const ctx1 = sessionCtx("session-ov-cancel", () => turnEntries("call-1", "I help the courier.")) as any;
    ctx1.ui = minimalUi;
    await agentEnd({}, ctx1);
    await awaitStoryCompletion(completions[0]);
    assert.ok(await polling("task-A"), "turn 1's watcher must be polling its task");

    // Turn 2: its append cancels watcher A before spawning watcher B.
    const ctx2 = sessionCtx("session-ov-cancel", () => turnEntries("call-2", "I ask about the letter.")) as any;
    ctx2.ui = minimalUi;
    await agentEnd({}, ctx2);
    await awaitStoryCompletion(completions[1]);
    assert.ok(await frozen("task-A"), "the previous turn's watcher must stop polling once the next turn appends");
    assert.ok(await polling("task-B"), "the new turn's watcher polls its own task");

    // Shutdown: the remaining watcher is canceled after the drain.
    await sessionShutdown({}, sessionCtx("session-ov-cancel"));
    assert.ok(await frozen("task-B"), "shutdown must cancel the in-flight watcher so no timer pins the process");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    if (previousPollInterval === undefined) delete process.env.OPENVIKING_EXTRACT_POLL_INTERVAL_MS;
    else process.env.OPENVIKING_EXTRACT_POLL_INTERVAL_MS = previousPollInterval;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension registers a styled renderer for OpenViking memory errors", () => {
  let rendered: unknown;
  let rendererType: string | undefined;

  resetShared();
  activateOvMemory({
    on() {},
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer(customType, renderer) {
      if (customType === "openviking-memory-error") {
        rendererType = customType;
        rendered = renderer(
          {
            content: "OpenViking memory append failed: OV refused connection",
            details: {
              saveId: "save-1",
              error: "OV refused connection"
            }
          },
          {}
        );
      }
    },
    sendMessage() {}
  });

  assert.equal(rendererType, "openviking-memory-error");
  assert.equal(typeof (rendered as { render?: unknown })?.render, "function");
  assert.deepEqual((rendered as { render(width: number): string[] }).render(80), [
    "⚠ OpenViking memory append failed",
    "save: save-1",
    "reason: OV refused connection"
  ]);
});

test("extension registers memory lookup tools from default OpenViking config", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-no-ov-"));
  const previousUrl = process.env.OPENVIKING_URL;
  const previousKey = process.env.OPENVIKING_API_KEY;
  const previousAccount = process.env.OPENVIKING_ACCOUNT;
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  process.env.RP_SQLITE_PATH = join(dir, "state.sqlite");
  delete process.env.OPENVIKING_URL;
  delete process.env.OPENVIKING_API_KEY;
  delete process.env.OPENVIKING_ACCOUNT;

  const tools: ToolResultEntry[] = [];
  try {
    activateAllExtensions({
      on() {},
      registerTool(tool) {
        tools.push(tool as ToolResultEntry);
      },
      registerCommand() {},
      sendMessage() {}
    });

    assert.equal(tools.some((tool) => tool.name === "search_memory"), true);
    assert.equal(tools.some((tool) => tool.name === "read_memory"), true);
    assert.equal(tools.some((tool) => tool.name === "initialize_new_game"), true);
  } finally {
    if (previousUrl === undefined) delete process.env.OPENVIKING_URL;
    else process.env.OPENVIKING_URL = previousUrl;
    if (previousKey === undefined) delete process.env.OPENVIKING_API_KEY;
    else process.env.OPENVIKING_API_KEY = previousKey;
    if (previousAccount === undefined) delete process.env.OPENVIKING_ACCOUNT;
    else process.env.OPENVIKING_ACCOUNT = previousAccount;
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension tools bind initialized saves to the session for later status reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-session-bind-"));
  const sqlitePath = join(dir, "state.sqlite");
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  process.env.RP_SQLITE_PATH = sqlitePath;

  const tools: ToolResultEntry[] = [];
  const commands: RegisteredCommand[] = [];
  const notices: string[] = [];

  try {
    activateAllExtensions({
      on() {},
      registerTool(tool) {
        tools.push(tool as ToolResultEntry);
      },
      registerCommand(name, options) {
        commands.push({ name, description: options.description, handler: options.handler });
      },
      sendMessage() {}
    });

    const initialize = tools.find((tool) => tool.name === "initialize_new_game");
    const statusCommand = commands.find((command) => command.name === "status");
    assert.ok(initialize);
    assert.ok(statusCommand);

    initialize.execute("c1", { playerName: "Ari", location: "Harbor Gate" }, undefined, undefined, sessionCtx("session-a"));
    await statusCommand.handler("", { sessionManager: { getSessionId: () => "session-a" }, ui: { notify: (m: string) => notices.push(m) } });

    assert.ok(notices.some((message) => /玩家：Ari/.test(message)), `notices: ${notices.join("|")}`);
    assert.ok(notices.some((message) => /地点：Harbor Gate/.test(message)));
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension promotes a bound legacy baseline before the agent starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-snapshot-promotion-"));
  const sqlitePath = join(dir, "state.sqlite");
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  process.env.RP_SQLITE_PATH = sqlitePath;
  const tools: ToolResultEntry[] = [];
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();

  try {
    activateAllExtensions({
      on(name, handler) {
        hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown);
      },
      registerTool(tool) {
        tools.push(tool as ToolResultEntry);
      },
      registerCommand() {},
      sendMessage() {}
    });
    const initialize = tools.find((tool) => tool.name === "initialize_new_game");
    const beforeAgentStart = hooks.get("before_agent_start");
    assert.ok(initialize);
    assert.ok(beforeAgentStart);
    const saveId = (initialize.execute(
      "c1",
      { playerName: "Ari", scene: "current state" },
      undefined,
      undefined,
      sessionCtx("session-a")
    ) as { details?: { saveId?: string } }).details?.saveId;
    assert.ok(saveId);

    const db = openRpDatabase(sqlitePath);
    try {
      const current = db
        .prepare("SELECT state_json FROM latest_states WHERE save_id = ?")
        .get(saveId) as { state_json: string };
      db.prepare(
        "INSERT INTO turn_snapshots (save_id, turn_no, state_json, created_at) VALUES (?, ?, ?, ?)"
      ).run(saveId, 5, current.state_json, "t5");
    } finally {
      db.close();
    }

    await beforeAgentStart({}, sessionCtx("session-a"));

    const readDb = openRpDatabase(sqlitePath);
    try {
      const row = readDb
        .prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ? AND turn_no = 5")
        .get(saveId) as { state_json: string };
      assert.equal(
        parseStorySnapshotEnvelope(JSON.parse(row.state_json)).core.payload.scene.summary,
        "current state"
      );
    } finally {
      readDb.close();
    }
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension agent_end hook isolates commits per session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-hook-session-"));
  const sqlitePath = join(dir, "state.sqlite");
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  process.env.RP_SQLITE_PATH = sqlitePath;

  const tools: ToolResultEntry[] = [];
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let storyCompletion: Promise<void> | undefined;

  try {
    activateAllExtensions(
      {
        on(name, handler) {
          hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown);
        },
        registerTool(tool) {
          tools.push(tool as ToolResultEntry);
        },
        registerCommand() {},
        sendMessage() {}
      },
      {
        observeCompletion(completion) {
          storyCompletion = completion;
        },
        createWriterClient: () => ({
          async render() {
            return "Rendered for session isolation.";
          }
        })
      }
    );

    const initialize = tools.find((tool) => tool.name === "initialize_new_game");
    const updateScene = tools.find((tool) => tool.name === "update_scene");
    const agentEnd = hooks.get("agent_end");
    assert.ok(initialize);
    assert.ok(updateScene);
    assert.ok(agentEnd);

    const saveA = (initialize.execute("c1", { scene: "Scene A" }, undefined, undefined, sessionCtx("session-a")) as {
      details?: { saveId?: string };
    }).details?.saveId;
    const saveB = (initialize.execute("c2", { scene: "Scene B" }, undefined, undefined, sessionCtx("session-b")) as {
      details?: { saveId?: string };
    }).details?.saveId;
    assert.ok(saveA);
    assert.ok(saveB);

    updateScene.execute("c3", { summary: "Committed scene A" }, undefined, undefined, sessionCtx("session-a"));

    const submitDirection = tools.find((tool) => tool.name === "submit_direction_packet");
    assert.ok(submitDirection);
    const packet = {
      storyElements: {
        currentSituation: "Scene A is active.",
        playerIntent: "A input",
        visibleChanges: ["Committed scene A"],
        presentCharacters: ["player"],
        tension: "Session A continues."
      },
      needsRender: true,
      directReply: ""
    };

    await agentEnd(
      {},
      sessionCtx("session-a", () => entriesWithSubmittedPacket(packet, "A input"))
    );
    await awaitStoryCompletion(storyCompletion);

    // committing session-a must not touch session-b's save
    updateScene.execute("c5", { summary: "Committed scene B" }, undefined, undefined, sessionCtx("session-b"));

    const db = openRpDatabase(sqlitePath);
    try {
      const snapshotA = db.prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ?").get(saveA) as { state_json: string } | undefined;
      const snapshotB = db.prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ?").get(saveB) as { state_json: string } | undefined;
      assert.ok(snapshotA);
      assert.equal(JSON.parse(snapshotA.state_json).core.payload.scene.summary, "Committed scene A");
      assert.equal(snapshotB, undefined);
    } finally {
      db.close();
    }
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new input drains the in-flight story commit before proceeding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-input-drain-"));
  const sqlitePath = join(dir, "state.sqlite");
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  const previousOvDisable = process.env.RP_DISABLE_OPENVIKING;
  process.env.RP_SQLITE_PATH = sqlitePath;
  process.env.RP_DISABLE_OPENVIKING = "1";

  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sentMessages: Array<{ customType: string }> = [];
  const tools: ToolResultEntry[] = [];
  const timers: Array<() => void> = [];
  let storyCompletion: Promise<void> | undefined;
  // The next-input race: the previous turn ended but its prose delivery is
  // still waiting for an idle window. Model it with a controllable isIdle.
  let idle = false;

  const drainCtx = (getEntries?: () => unknown[]): unknown => {
    const base = sessionCtx("session-drain", getEntries) as Record<string, unknown>;
    base.isIdle = () => idle;
    return base;
  };

  try {
    activateAllExtensions(
      {
        on(name, handler) {
          hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown);
        },
        registerTool(tool) {
          tools.push(tool as ToolResultEntry);
        },
        registerCommand() {},
        sendMessage(message) {
          sentMessages.push({ customType: (message as { customType: string }).customType });
        }
      },
      {
        observeCompletion(completion) {
          storyCompletion = completion;
        },
        setTimeoutFn: (callback) => {
          timers.push(callback);
        },
        createWriterClient: () => ({
          render: async () => "Rendered prose."
        })
      }
    );

    const init = tools.find((tool) => tool.name === "initialize_new_game");
    assert.ok(init);
    init.execute("c1", { playerName: "Ari", scene: "Start" }, undefined, undefined, drainCtx());

    const packet = {
      storyElements: {
        currentSituation: "Situation.",
        playerIntent: "Intent.",
        visibleChanges: ["Change."],
        presentCharacters: ["player"],
        tension: "Tension."
      },
      needsRender: true,
      directReply: ""
    };

    const agentEnd = hooks.get("agent_end");
    const input = hooks.get("input");
    assert.ok(agentEnd);
    assert.ok(input, "two-pass-render must register an input handler");

    // The turn ends; delivery starts polling but never sees idle yet.
    await agentEnd({}, drainCtx(() => entriesWithSubmittedPacket(packet, "第一句输入")));

    let inputResolved = false;
    const inputDone = Promise.resolve(input({ type: "input", text: "第二句输入", source: "interactive" }, drainCtx())).then(() => {
      inputResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(inputResolved, false, "input must wait for the in-flight story commit");
    assert.equal(sentMessages.length, 0, "prose not delivered yet");

    // The agent goes idle (previous prompt fully resolved): queued delivery
    // polls now succeed, the commit chain completes, and only then does the
    // input proceed.
    idle = true;
    while (timers.length > 0 && !inputResolved) {
      timers.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await inputDone;
    assert.equal(inputResolved, true);
    assert.equal(sentMessages[0]?.customType, "writer-prose", "prose delivered before the next input proceeds");
    await awaitStoryCompletion(storyCompletion);

    // A steer during streaming must NOT block on the commit.
    let steerResolved = false;
    await Promise.resolve(
      input({ type: "input", text: "steer", source: "interactive", streamingBehavior: "steer" }, sessionCtx("session-drain"))
    ).then(() => {
      steerResolved = true;
    });
    assert.equal(steerResolved, true);
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    if (previousOvDisable === undefined) delete process.env.RP_DISABLE_OPENVIKING;
    else process.env.RP_DISABLE_OPENVIKING = previousOvDisable;
    rmSync(dir, { recursive: true, force: true });
  }
});
