import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { activateAllExtensions } from "../helpers/extensions.ts";
import { registerAllCommands } from "../../src/commands/registry.ts";
import { createSave } from "../../src/state/save-repository.ts";
import { createInitialState } from "../../src/state/schema.ts";
import { bindSessionToSave } from "../../src/state/session-binding.ts";
import { initializeSchema, openRpDatabase } from "../../src/state/sqlite.ts";
import { createStorySnapshotCoordinator } from "../../src/state/story-snapshot-coordinator.ts";
import { createStateStore } from "../../src/state/store.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";
import { createSystemRuntime } from "../../src/systems/runtime.ts";

type RegisteredCommand = {
  name: string;
  description?: string;
  handler: (args: string, ctx: any) => Promise<void> | void;
};

function activateCommands(): RegisteredCommand[] {
  const commands: RegisteredCommand[] = [];
  activateAllExtensions({
    on() {},
    registerTool() {},
    registerCommand(name, options) {
      commands.push({ name, description: options.description, handler: options.handler });
    },
    sendMessage() {}
  });
  return commands;
}

function sessionCtx(sessionId: string): unknown {
  return { sessionManager: { getSessionId: () => sessionId } };
}

test("extension commands register with the real Pi command API shape (name + handler)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-commands-"));
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  process.env.RP_SQLITE_PATH = join(dir, "state.sqlite");
  try {
    const commands = activateCommands();

    assert.deepEqual(
      commands.map((command) => command.name).sort(),
      ["load", "roll", "rpconfig", "save", "status"]
    );
    assert.equal(commands.every((command) => typeof command.handler === "function"), true);
    assert.equal(commands.every((command) => typeof command.description === "string"), true);
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/rpconfig is wired through registerAllCommands with Pi model selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-rpconfig-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const stateStore = createStateStore(db);
    mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "agent", "settings.json"),
      `${JSON.stringify({
        defaultProvider: "old-provider",
        defaultModel: "old-model",
        writer: { provider: "old-provider", model: "old-model", thinking: "high" }
      }, null, 2)}\n`,
      "utf8"
    );

    const commands: RegisteredCommand[] = [];
    registerAllCommands(
      {
        on() {},
        registerTool() {},
        registerCommand(name, options) {
          commands.push({ name, description: options.description, handler: options.handler });
        },
        sendMessage() {}
      },
      {
        db,
        stateStore,
        projectRoot: dir,
        getSubagents: () => [],
        onSubagentsChanged() {}
      }
    );

    const command = commands.find((candidate) => candidate.name === "rpconfig");
    assert.ok(command);
    await command.handler("", {
      mode: "rpc",
      sessionManager: { getSessionId: () => "session-rpconfig" },
      modelRegistry: {
        refresh() {},
        getAvailable: () => [{ provider: "new-provider", id: "org/new-model" }]
      },
      ui: {
        async select(_title: string, options: string[]) {
          return options[0];
        },
        notify() {}
      }
    });

    const settings = JSON.parse(readFileSync(join(dir, ".pi", "agent", "settings.json"), "utf8"));
    assert.deepEqual(settings.writer, {
      provider: "new-provider",
      model: "org/new-model",
      thinking: "high"
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension commands require a current Pi session id on ctx.sessionManager", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-session-"));
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  process.env.RP_SQLITE_PATH = join(dir, "state.sqlite");
  try {
    const commands = activateCommands();
    const statusCmd = commands.find((command) => command.name === "status");
    assert.ok(statusCmd);

    const notices: string[] = [];
    // No getSessionId on the session manager → command refuses with an error notice.
    await statusCmd.handler("", { sessionManager: {}, ui: { notify: (m: string) => notices.push(m) } });

    assert.ok(notices.some((message) => /没有当前会话/.test(message)));
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/status surfaces the active save state through ctx.ui.notify", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-status-"));
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  process.env.RP_SQLITE_PATH = join(dir, "state.sqlite");
  try {
    const tools: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];
    activateAllExtensions({
      on() {},
      registerTool(tool) {
        tools.push(tool as (typeof tools)[number]);
      },
      registerCommand() {},
      sendMessage() {}
    });
    const init = tools.find((tool) => tool.name === "initialize_new_game");
    assert.ok(init);
    init.execute("c1", { playerName: "Ari", location: "Harbor Gate" }, undefined, undefined, sessionCtx("session-a"));

    const commands = activateCommands();
    const statusCmd = commands.find((command) => command.name === "status");
    assert.ok(statusCmd);

    const notices: string[] = [];
    await statusCmd.handler("", {
      sessionManager: { getSessionId: () => "session-a" },
      ui: { notify: (m: string) => notices.push(m) }
    });

    // Aretha isn't bound to session-a (initialize didn't get a sessionManager), but the
    // latest active save is still Aretha — status reports whatever the hot save is.
    assert.ok(notices.some((message) => /玩家：/.test(message)), `notices: ${notices.join("|")}`);
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/roll command wiring uses ctx rerun capability and latest user message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-extension-roll-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const stateStore = createStateStore(db);
    const save = createSave(db);
    bindSessionToSave(db, "session-roll", save.id);
    stateStore.replaceState(save.id, createInitialState({ scene: { summary: "current" } }));
    const systemRegistry = createSystemRegistry([], { capabilities: new Map() });
    const systemRuntime = createSystemRuntime({ db, registry: systemRegistry });
    systemRuntime.activateSave(save.id);
    const storySnapshots = createStorySnapshotCoordinator({ db, registry: systemRegistry, systemRuntime });
    storySnapshots.captureSuccessfulStory(save.id, createInitialState({ scene: { summary: "previous" } }));
    storySnapshots.captureSuccessfulStory(save.id, createInitialState({ scene: { summary: "latest" } }));

    const commands: RegisteredCommand[] = [];
    registerAllCommands(
      {
        on() {},
        registerTool() {},
        registerCommand(name, options) {
          commands.push({ name, description: options.description, handler: options.handler });
        },
        sendMessage() {}
      },
      { db, stateStore, systemRuntime, storySnapshots }
    );

    const rollCmd = commands.find((command) => command.name === "roll");
    assert.ok(rollCmd);

    const notices: string[] = [];
    const rerunInputs: string[] = [];
    await rollCmd.handler("", {
      sessionManager: {
        getSessionId: () => "session-roll",
        getEntries: () => [{ type: "message", message: { role: "user", content: "再试一次" } }]
      },
      rerunTurn(message: string) {
        rerunInputs.push(message);
      },
      ui: { notify: (message: string) => notices.push(message) }
    });

    assert.deepEqual(rerunInputs, ["再试一次"]);
    assert.ok(notices.some((message) => /reran latest user message/i.test(message)), notices.join("|"));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
