import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const saveRepository = await import(pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const store = await import(pathToFileURL(new URL("../../src/state/store.ts", import.meta.url).pathname).href);
const schema = await import(pathToFileURL(new URL("../../src/state/schema.ts", import.meta.url).pathname).href);
const turnMemoryHook = await import(pathToFileURL(new URL("../../src/ov/turn-memory-hook.ts", import.meta.url).pathname).href);
const registry = await import(pathToFileURL(new URL("../../src/tools/registry.ts", import.meta.url).pathname).href);
const searchMemory = await import(pathToFileURL(new URL("../../src/tools/lookup/search-memory.ts", import.meta.url).pathname).href);
const readMemory = await import(pathToFileURL(new URL("../../src/tools/lookup/read-memory.ts", import.meta.url).pathname).href);

const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const createStateStore = store.createStateStore as typeof import("../../src/state/store.js").createStateStore;
const createInitialState = schema.createInitialState as typeof import("../../src/state/schema.js").createInitialState;
const appendTurnToMemory =
  turnMemoryHook.appendTurnToMemory as typeof import("../../src/ov/turn-memory-hook.js").appendTurnToMemory;
const registerAllTools = registry.registerAllTools as typeof import("../../src/tools/registry.js").registerAllTools;
const searchMemoryTool = searchMemory.searchMemoryTool as typeof import("../../src/tools/lookup/search-memory.js").searchMemoryTool;
const readMemoryTool = readMemory.readMemoryTool as typeof import("../../src/tools/lookup/read-memory.js").readMemoryTool;
type ToolResult = import("../../src/tools/runtime/result.js").ToolResult;
type ToolResultEntry = { name: string; execute: (...args: unknown[]) => unknown };
type OpenVikingClient = import("../../src/ov/client.js").OpenVikingClient;
type OpenVikingEnsureSessionOptions = import("../../src/ov/client.js").OpenVikingEnsureSessionOptions;

async function withOvHarness(
  fn: (harness: {
    db: ReturnType<typeof openRpDatabase>;
    stateStore: ReturnType<typeof createStateStore>;
    saveId: string;
  }) => Promise<void> | void
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rp-ov-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);
    const stateStore = createStateStore(db);
    stateStore.replaceState(save.id, createInitialState());
    await fn({ db, stateStore, saveId: save.id });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function scopedOvClient(saveId: string, methods: Partial<OpenVikingClient>): OpenVikingClient {
  const client = {
    forUser(user: string) {
      assert.equal(user, `save-${saveId}`);
      return client;
    },
    async ensureSession(sessionId: string, options?: OpenVikingEnsureSessionOptions) {
      return methods.ensureSession?.(sessionId, options);
    },
    async addSessionMessage(sessionId: string, role: "user" | "assistant", content: string) {
      return methods.addSessionMessage?.(sessionId, role, content);
    },
    async commitSession(sessionId: string, options: { keepRecentCount: number; wait?: boolean }) {
      return (await methods.commitSession?.(sessionId, options)) ?? {};
    },
    async find(query: string, targetUri: string, limit: number) {
      return (await methods.find?.(query, targetUri, limit)) ?? [];
    },
    async read(uri: string) {
      return (await methods.read?.(uri)) ?? "";
    }
  };
  return client;
}

test("appendTurnToMemory creates RP memory session, appends messages, then commits", async () => {
  await withOvHarness(async ({ db, saveId }) => {
    const calls: string[] = [];
    await appendTurnToMemory({
      db,
      saveId,
      playerInput: "I help the courier.",
      writerProse: "You bind the courier's wound.",
      memoryPolicy: { self: { enabled: true }, peer: { enabled: false }, memory_types: ["characters", "story_events"] },
      fallbackMemoryPolicy: { self: { enabled: true }, peer: { enabled: false }, memory_types: ["entities", "events"] },
      client: scopedOvClient(saveId, {
        async ensureSession(sessionId, options) {
          calls.push(`ensure:${sessionId}`);
          assert.deepEqual(options, {
            memoryPolicy: {
              self: { enabled: true },
              peer: { enabled: false },
              memory_types: ["characters", "story_events"]
            }
          });
        },
        async addSessionMessage(_sessionId, role, content) {
          calls.push(`${role}:${content}`);
        },
        async commitSession(_sessionId, options) {
          calls.push(`commit:${options.keepRecentCount}`);
          return { status: "accepted", taskId: "task-1" };
        },
        async find() {
          return [];
        },
        async read() {
          return "";
        }
      })
    });

    assert.equal(calls.length, 4);
    assert.match(calls[0] ?? "", /^ensure:/);
    assert.equal(calls[1], "user:I help the courier.");
    assert.equal(calls[2], "assistant:You bind the courier's wound.");
    assert.equal(calls[3], "commit:0");
    const taskRows = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%task%'").all();
    assert.deepEqual(taskRows, []);
  });
});

test("appendTurnToMemory falls back to built-in memory types when custom schemas are not registered", async () => {
  await withOvHarness(async ({ db, saveId }) => {
    const ensureOptions: unknown[] = [];
    const committedSessions: string[] = [];

    await appendTurnToMemory({
      db,
      saveId,
      playerInput: "I help the courier.",
      writerProse: "You bind the courier's wound.",
      memoryPolicy: { self: { enabled: true }, peer: { enabled: false }, memory_types: ["characters", "story_events"] },
      fallbackMemoryPolicy: { self: { enabled: true }, peer: { enabled: false }, memory_types: ["entities", "events"] },
      client: scopedOvClient(saveId, {
        async ensureSession(sessionId, options) {
          ensureOptions.push({ sessionId, options });
          if (ensureOptions.length === 1) {
            throw new Error("Unknown memory_policy.memory_types: characters, story_events");
          }
        },
        async addSessionMessage() {},
        async commitSession(sessionId) {
          committedSessions.push(sessionId);
          return { status: "accepted", taskId: "task-1" };
        }
      })
    });

    assert.equal(ensureOptions.length, 2);
    assert.notEqual(
      (ensureOptions[0] as { sessionId: string }).sessionId,
      (ensureOptions[1] as { sessionId: string }).sessionId
    );
    assert.deepEqual((ensureOptions[1] as { options: unknown }).options, {
      memoryPolicy: {
        self: { enabled: true },
        peer: { enabled: false },
        memory_types: ["entities", "events"]
      }
    });
    assert.deepEqual(committedSessions, [(ensureOptions[1] as { sessionId: string }).sessionId]);
  });
});

test("search_memory is scoped to current save memory root", async () => {
  await withOvHarness(async ({ db, stateStore, saveId }) => {
    const result = (await searchMemoryTool.execute(
      "call-1",
      { query: "courier", limit: 3 },
      undefined,
      undefined,
      {
        db,
        stateStore,
        ovClient: scopedOvClient(saveId, {
          async find(query: string, targetUri: string, limit: number) {
            assert.equal(query, "courier");
            assert.equal(targetUri, `viking://user/save-${saveId}/memories`);
            assert.equal(limit, 3);
            return [{ uri: `${targetUri}/story_events/1.md`, abstract: "A courier arrived.", score: 0.9 }];
          },
          async read() {
            return "";
          }
        })
      } as unknown as never
    )) as ToolResult;

    assert.match((result.content[0]?.text) ?? "", /A courier arrived/);
    assert.deepEqual(result.details?.results, [
      {
        uri: `viking://user/save-${saveId}/memories/story_events/1.md`,
        abstract: "A courier arrived.",
        score: 0.9
      }
    ]);
  });
});

test("registered memory lookup tools are bound to OpenViking context", async () => {
  await withOvHarness(async ({ db, stateStore, saveId }) => {
    const registeredTools: ToolResultEntry[] = [];
    registerAllTools(
      { on() {}, registerTool: (tool) => registeredTools.push(tool as ToolResultEntry), registerCommand() {}, sendMessage() {} },
      { db, stateStore },
      {
        db,
        stateStore,
        ovClient: scopedOvClient(saveId, {
          async find(_query, targetUri) {
            assert.equal(targetUri, `viking://user/save-${saveId}/memories`);
            return [{ uri: `${targetUri}/characters/Ari.md`, abstract: "Ari", score: 1 }];
          },
          async read() {
            return "";
          }
        })
      }
    );
    const tool = registeredTools.find((candidate) => candidate.name === "search_memory");
    assert.ok(tool);

    const result = (await tool.execute("call-1", { query: "Ari" }, undefined, undefined, {} as unknown as never)) as ToolResult;

    assert.match(result.content[0]?.text ?? "", /Ari/);
  });
});

test("read_memory rejects cross-save URIs and returns markdown for current save", async () => {
  await withOvHarness(async ({ db, stateStore, saveId }) => {
    const currentUri = `viking://user/save-${saveId}/memories/characters/Ari.md`;
    const result = (await readMemoryTool.execute(
      "call-1",
      { uri: currentUri },
      undefined,
      undefined,
      {
        db,
        stateStore,
        ovClient: scopedOvClient(saveId, {
          async find() {
            return [];
          },
          async read(uri: string) {
            assert.equal(uri, currentUri);
            return "# Ari\n";
          }
        })
      } as unknown as never
    )) as ToolResult;

    assert.equal(result.content[0]?.text, "# Ari\n");
    await assert.rejects(
      async () => {
        await readMemoryTool.execute(
          "call-2",
          { uri: "viking://user/save-other/memories/characters/Ari.md" },
          undefined,
          undefined,
          {
            db,
            stateStore,
            ovClient: scopedOvClient(saveId, {
              async find() {
                return [];
              },
              async read() {
                return "";
              }
            })
          } as unknown as never
        );
      },
      /outside current save/
    );
  });
});
