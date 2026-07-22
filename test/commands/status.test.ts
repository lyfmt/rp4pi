import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const commandRegistry = await import(pathToFileURL(new URL("../../src/commands/registry.ts", import.meta.url).pathname).href);
const saveCommand = await import(pathToFileURL(new URL("../../src/commands/save.ts", import.meta.url).pathname).href);
const saveRepository = await import(pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href);
const sessionBinding = await import(pathToFileURL(new URL("../../src/state/session-binding.ts", import.meta.url).pathname).href);
const schema = await import(pathToFileURL(new URL("../../src/state/schema.ts", import.meta.url).pathname).href);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const store = await import(pathToFileURL(new URL("../../src/state/store.ts", import.meta.url).pathname).href);
const statusCommand = await import(pathToFileURL(new URL("../../src/commands/status.ts", import.meta.url).pathname).href);

const registerAllCommands =
  commandRegistry.registerAllCommands as typeof import("../../src/commands/registry.js").registerAllCommands;
const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const bindSessionToSave = sessionBinding.bindSessionToSave as typeof import("../../src/state/session-binding.js").bindSessionToSave;
const createInitialState = schema.createInitialState as typeof import("../../src/state/schema.js").createInitialState;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const createStateStore = store.createStateStore as typeof import("../../src/state/store.js").createStateStore;
const status = statusCommand.statusCommand as typeof import("../../src/commands/status.js").statusCommand;
const save = saveCommand.saveCommand as typeof import("../../src/commands/save.js").saveCommand;

function expectSyncString(result: string | Promise<string>): string {
  if (result instanceof Promise) {
    throw new TypeError("Expected synchronous command output");
  }
  return result;
}

function withCommandHarness(
  fn: (harness: { db: ReturnType<typeof openRpDatabase>; stateStore: ReturnType<typeof createStateStore>; saveId: string }) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), "rp-command-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const saveRecord = createSave(db);
    const stateStore = createStateStore(db);
    stateStore.replaceState(
      saveRecord.id,
      createInitialState({
        player: { name: "Ari", status: "Wary", location: "Harbor Gate" },
        time: { day: 3, hour: 21 },
        scene: { summary: "Rain gathers on the empty road." }
      })
    );
    bindSessionToSave(db, "session-1", saveRecord.id);
    fn({ db, stateStore, saveId: saveRecord.id });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("/status outputs the strict status format", () => {
  withCommandHarness(({ db, stateStore }) => {
    assert.equal(
      expectSyncString(status.execute({}, { db, stateStore, piSessionId: "session-1" })),
      [
        "玩家：Ari",
        "状态：Wary",
        "地点：Harbor Gate",
        "时间：第 3 天 21:00",
        "场景：Rain gathers on the empty road."
      ].join("\n")
    );
  });
});

test("/status hydrates the save bound to the current session", () => {
  withCommandHarness(({ db, stateStore }) => {
    const otherSave = createSave(db);
    stateStore.replaceState(otherSave.id, createInitialState({ player: { name: "Wrong", location: "Elsewhere" } }));

    assert.match(
      expectSyncString(status.execute({}, { db, stateStore, piSessionId: "session-1" })),
      /玩家：Ari/
    );
  });
});

test("/status appends System projections for the GM audience", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-command-system-status-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  let projectionRequest: unknown;

  try {
    initializeSchema(db);
    const saveRecord = createSave(db);
    const stateStore = createStateStore(db);
    stateStore.replaceState(
      saveRecord.id,
      createInitialState({ player: { name: "Ari", location: "Harbor Gate" } })
    );
    bindSessionToSave(db, "session-1", saveRecord.id);
    const systemRuntime = {
      activateSave: () => ({ saveId: saveRecord.id, revision: 3, branchEpoch: 0 }),
      commit: async () => {
        throw new Error("not used");
      },
      project: async (request: unknown) => {
        projectionRequest = request;
        return [
          { system: "progression", revision: 3, value: { level: 2, xp: 75 } }
        ];
      }
    };

    const output = await status.execute(
      {},
      { db, stateStore, systemRuntime, piSessionId: "session-1" }
    );

    assert.deepEqual(projectionRequest, {
      saveId: saveRecord.id,
      audience: { kind: "gm" }
    });
    assert.match(output, /玩家：Ari/);
    assert.match(output, /progression \(revision 3\): \{"level":2,"xp":75\}/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/save touches current save and returns only the save id", () => {
  withCommandHarness(({ db, stateStore, saveId }) => {
    const before = db.prepare("SELECT updated_at FROM saves WHERE id = ?").get(saveId) as { updated_at: string };

    const output = expectSyncString(save.execute({}, { db, stateStore, piSessionId: "session-1" }));

    const after = db.prepare("SELECT updated_at FROM saves WHERE id = ?").get(saveId) as { updated_at: string };
    assert.equal(output, saveId);
    assert.equal(output.includes("玩家："), false);
    assert.notEqual(after.updated_at, before.updated_at);
  });
});

test("command registry registers player commands", () => {
  withCommandHarness(({ db, stateStore }) => {
    const commands: Array<{ name: string }> = [];
    registerAllCommands(
      {
        on() {},
        registerTool() {},
        registerCommand: (name) => commands.push({ name }),
        sendMessage() {}
      },
      { db, stateStore }
    );

    assert.deepEqual(
      commands.map((command) => command.name).sort(),
      ["load", "roll", "save", "status"]
    );
  });
});

test("registered commands refuse when ctx has no current session id", async () => {
  await withCommandHarness(async ({ db, stateStore }) => {
    const commands: Array<{ name: string; handler: (args: string, ctx: any) => Promise<void> | void }> = [];
    registerAllCommands(
      {
        on() {},
        registerTool() {},
        registerCommand: (name, options) => {
          commands.push({ name, handler: options.handler });
        },
        sendMessage() {}
      },
      { db, stateStore }
    );

    const statusCmd = commands.find((command) => command.name === "status");
    assert.ok(statusCmd);

    const notices: string[] = [];
    // ctx.sessionManager present but getSessionId returns empty → refuse, do not throw.
    await statusCmd.handler("", {
      sessionManager: { getSessionId: () => "" },
      ui: { notify: (m: string) => notices.push(m) }
    });
    assert.ok(notices.some((message) => /没有当前会话/.test(message)));
  });
});
