import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { activateAllExtensions } from "../helpers/extensions.ts";
import { latestStorySnapshotTurnNo } from "../../src/state/snapshots.ts";
const sqlite = await import(new URL("../../src/state/sqlite.ts", import.meta.url).pathname);
const contextFilter = await import(new URL("../../src/runtime/context-filter.ts", import.meta.url).pathname);
const writerHistory = await import(new URL("../../src/runtime/writer-history.ts", import.meta.url).pathname);

const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const readLatestState = sqlite.readLatestState as typeof import("../../src/state/sqlite.js").readLatestState;
const filterGmContextMessages = contextFilter.filterGmContextMessages as typeof import("../../src/runtime/context-filter.js").filterGmContextMessages;
const formatPacketForWriter = writerHistory.formatPacketForWriter as typeof import("../../src/runtime/writer-history.js").formatPacketForWriter;

type ToolResultEntry = { name: string; execute: (...args: unknown[]) => unknown };

test("demo flow runs state tools, writer commit, and snapshot via real pi contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-demo-flow-"));
  const sqlitePath = join(dir, "state.sqlite");
  const previousSqlitePath = process.env.RP_SQLITE_PATH;
  const previousOvDisable = process.env.RP_DISABLE_OPENVIKING;
  process.env.RP_SQLITE_PATH = sqlitePath;
  process.env.RP_DISABLE_OPENVIKING = "1"; // fully opt out of OV: no client, no per-turn append, no error message
  try {
    const tools: ToolResultEntry[] = [];
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const discoverResults: Array<{ skillPaths?: string[]; promptPaths?: string[] }> = [];
    const sentMessages: unknown[] = [];
    const timers: Array<() => void> = [];
    let idle = false;
    let storyCompletion: Promise<void> | undefined;

    activateAllExtensions(
      {
        on(name, handler) {
          hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown);
          if (name === "resources_discover") {
            const result = (handler as (event: unknown) => { skillPaths?: string[]; promptPaths?: string[] })({});
            if (result) discoverResults.push(result);
          }
        },
        registerTool(tool) {
          tools.push(tool as ToolResultEntry);
        },
        registerCommand() {},
        sendMessage(message) {
          sentMessages.push(message);
        }
      },
      {
        setTimeoutFn(callback) {
          timers.push(callback);
        },
        observeCompletion(completion) {
          storyCompletion = completion;
        },
        createWriterClient: () => ({
          async render(input) {
            const last = formatPacketForWriter(input.packet);
            assert.match(last, /# Story Elements/);
            assert.match(last, /Current situation: 玩家在边境驿站医务间/);
            // Reconciled role-subagent output reaches the writer as an authoritative section.
            assert.match(last, /Character actions \(authoritative/);
            assert.match(last, /- 受伤信使：咬牙撑起身，说密信原本要送往北营。/);
            assert.doesNotMatch(last, /^Plot:/m);
            return "你替信使重新缠紧绷带，火漆密信在桌沿投下一小片暗红的影子。";
          }
        })
      }
    );

    // resources_discover surfaces skill + prompt paths
    assert.equal(discoverResults.length, 1);
    const discover = discoverResults[0] ?? {};
    // GM prompts now come from the active world pack, not a global agents/ dir.
    assert.deepEqual(
      (discover.promptPaths ?? []).map((path) => path.split("/").slice(-2).join("/")).sort(),
      ["prompts/gm-core.md", "prompts/gm-output.md", "prompts/gm-tools.md"]
    );
    assert.ok((discover.promptPaths ?? []).every((path) => path.includes("worlds/border-station/")));
    assert.ok((discover.skillPaths ?? []).some((path) => path.endsWith("skills/start-game")));
    assert.ok((discover.skillPaths ?? []).some((path) => path.endsWith("skills/development-guide")));

    // GM prompt + skill files still carry the demo anchors
    const promptText = (await Promise.all((discover.promptPaths ?? []).map((path) => readFile(path, "utf8")))).join("\n");
    const skillPath = (discover.skillPaths ?? []).find((path) => path.endsWith("skills/start-game"));
    const skillText = skillPath ? await readFile(join(skillPath, "SKILL.md"), "utf8") : "";
    const worldLore = await readFile(new URL("../../worlds/border-station/lore/setting.md", import.meta.url), "utf8");
    assert.match(skillText, /开始新游戏，使用默认 demo 世界。/);
    assert.match(promptText, /initialize_new_game/);
    assert.match(promptText, /submit_direction_packet/);
    assert.match(worldLore, /边境驿站/);

    const sessionId = "session-demo";
    let entries: unknown[] = [];
    const piCtx = () => ({ sessionManager: { getSessionId: () => sessionId, getEntries: () => entries }, isIdle: () => idle });
    const exec = (name: string, params: unknown): unknown => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `Missing tool: ${name}`);
      return tool.execute("call", params, undefined, undefined, piCtx());
    };

    const init = exec("initialize_new_game", {
      playerName: "Ari",
      location: "边境驿站",
      status: "刚醒来",
      scene: "驿站大厅里有一个受伤信使和一封未送达的密信。"
    }) as { details?: { saveId?: string } };
    const saveId = init.details?.saveId;
    assert.ok(saveId);

    exec("update_location", { location: "边境驿站医务间" });
    exec("update_player_status", { status: "警觉，正在处理伤口" });
    exec("update_time", { absolute: { day: 1, hour: 9 } });
    exec("update_scene", { summary: "信使靠在木椅上，密信仍封着火漆。" });

    const packetResult = exec("submit_direction_packet", {
      storyElements: {
        currentSituation: "玩家在边境驿站医务间，信使靠在木椅上，密信仍封着火漆。",
        playerIntent: "玩家替信使包扎，并注意到密信还没有送达。",
        visibleChanges: ["信使的绷带被重新缠紧", "密信被玩家注意到"],
        presentCharacters: ["Ari", "受伤信使"],
        characterActions: [{ name: "受伤信使", action: "咬牙撑起身，说密信原本要送往北营。" }],
        tension: "密信必须尽快送出。"
      },
      needsRender: true,
      directReply: ""
    }) as { details?: { packet?: unknown } };

    // The GM loop leaves the submitted packet in the transcript; agent_end renders it.
    entries = [
      { type: "message", message: { role: "user", content: "我替信使包扎并查看密信。" } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "submit_direction_packet",
          toolCallId: "call-submit",
          details: packetResult.details
        }
      }
    ];

    const agentEnd = hooks.get("agent_end");
    assert.ok(agentEnd);
    await agentEnd({}, piCtx());

    assert.ok(storyCompletion);
    assert.equal(sentMessages.length, 0);
    assert.equal(timers.length, 1);
    const pendingDb = openRpDatabase(sqlitePath);
    try {
      const pending = pendingDb
        .prepare("SELECT COUNT(*) AS count FROM turn_snapshots WHERE save_id = ?")
        .get(saveId) as { count: number };
      assert.equal(pending.count, 0);
    } finally {
      pendingDb.close();
    }
    idle = true;
    timers.shift()!();
    await storyCompletion;

    // prose delivered via sendMessage, writer-prose custom message filtered from GM context
    assert.equal(sentMessages.length, 1);
    const sent = sentMessages[0] as { customType: string; content: string; details: { prose?: string } };
    assert.equal(sent.customType, "writer-prose");
    assert.ok(sent.content.length > 0);
    assert.deepEqual(
      filterGmContextMessages([
        { role: "assistant", type: "custom", source: "writer-prose", content: sent.content, data: { prose: sent.content } }
      ]),
      []
    );

    const db = openRpDatabase(sqlitePath);
    try {
      assert.equal(latestStorySnapshotTurnNo(db, saveId), 1);
      const snapshotRow = db
        .prepare("SELECT state_json FROM turn_snapshots WHERE save_id = ?")
        .get(saveId) as { state_json: string };
      const snapshotState = JSON.parse(snapshotRow.state_json).core.payload as unknown;
      assert.deepEqual(snapshotState, expectedDemoState());
      // border-station's `clock-drift` turn_committed hook advances the clock one
      // hour AFTER the snapshot is taken, so latest state (next turn's start) is an
      // hour ahead of the committed snapshot. This confirms the hooks axis is wired
      // end-to-end through agent_end → turn-rendered → turn_committed.
      assert.deepEqual(readLatestState(db, saveId), expectedDemoLatestState());
    } finally {
      db.close();
    }
  } finally {
    if (previousSqlitePath === undefined) delete process.env.RP_SQLITE_PATH;
    else process.env.RP_SQLITE_PATH = previousSqlitePath;
    if (previousOvDisable === undefined) delete process.env.RP_DISABLE_OPENVIKING;
    else process.env.RP_DISABLE_OPENVIKING = previousOvDisable;
    rmSync(dir, { recursive: true, force: true });
  }
});

function expectedDemoState() {
  return {
    player: { name: "Ari", location: "边境驿站医务间", status: "警觉，正在处理伤口" },
    time: { day: 1, hour: 9 },
    scene: { summary: "信使靠在木椅上，密信仍封着火漆。" },
    attributes: { vigor: 80 },
    facts: [],
    relationships: []
  };
}

// Latest state after the committed turn: identical to the snapshot except the
// `clock-drift` hook advanced the hour by one.
function expectedDemoLatestState() {
  return { ...expectedDemoState(), time: { day: 1, hour: 10 } };
}
