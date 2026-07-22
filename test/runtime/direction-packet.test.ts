import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const directionPacketModule = await import(
  pathToFileURL(new URL("../../src/runtime/direction-packet.ts", import.meta.url).pathname).href
);
const schema = await import(pathToFileURL(new URL("../../src/state/schema.ts", import.meta.url).pathname).href);
const store = await import(pathToFileURL(new URL("../../src/state/store.ts", import.meta.url).pathname).href);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const saveRepository = await import(
  pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href
);
const submitDirectionPacket = await import(
  pathToFileURL(new URL("../../src/tools/state/submit-direction-packet.ts", import.meta.url).pathname).href
);

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parseDirectionPacket =
  directionPacketModule.parseDirectionPacket as typeof import("../../src/runtime/direction-packet.js").parseDirectionPacket;
const createInitialState = schema.createInitialState as typeof import("../../src/state/schema.js").createInitialState;
const createStateStore = store.createStateStore as typeof import("../../src/state/store.js").createStateStore;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const readLatestState = sqlite.readLatestState as typeof import("../../src/state/sqlite.js").readLatestState;
const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const submitDirectionPacketTool =
  submitDirectionPacket.submitDirectionPacketTool as typeof import("../../src/tools/state/submit-direction-packet.js").submitDirectionPacketTool;
type ToolResult = import("../../src/tools/runtime/result.js").ToolResult;

function expectSyncResult(result: ToolResult | Promise<ToolResult>): ToolResult {
  if (result instanceof Promise) {
    throw new TypeError("Expected synchronous tool result");
  }
  return result;
}

test("parseDirectionPacket accepts a render packet with current story elements", () => {
  const packet = parseDirectionPacket({
    storyElements: {
      currentSituation: "信使靠在医务间的木椅上，密信仍封着火漆。",
      playerIntent: "玩家替信使包扎并追问密信去向。",
      visibleChanges: ["信使止住出血", "密信被放到桌面"],
      presentCharacters: ["玩家", "受伤信使"],
      tension: "北门即将关闭，密信必须尽快送出。"
    },
    needsRender: true,
    directReply: ""
  });

  assert.deepEqual(packet, {
    storyElements: {
      currentSituation: "信使靠在医务间的木椅上，密信仍封着火漆。",
      playerIntent: "玩家替信使包扎并追问密信去向。",
      visibleChanges: ["信使止住出血", "密信被放到桌面"],
      presentCharacters: ["玩家", "受伤信使"],
      characterActions: [],
      tension: "北门即将关闭，密信必须尽快送出。"
    },
    needsRender: true,
    directReply: ""
  });
});

test("parseDirectionPacket accepts a direct reply packet when directReply is non-empty", () => {
  const packet = parseDirectionPacket({
    needsRender: false,
    directReply: "The door is locked."
  });

  assert.equal(packet.needsRender, false);
  assert.equal(packet.directReply, "The door is locked.");
});

test("parseDirectionPacket rejects a direct reply packet with empty directReply", () => {
  assert.throws(() => {
    parseDirectionPacket({
      storyElements: {},
      needsRender: false,
      directReply: ""
    });
  }, /directReply 必须非空/);
});

test("parseDirectionPacket coerces loose story element fields but rejects invalid objects", () => {
  const coerced = parseDirectionPacket({
    storyElements: {
      currentSituation: 1,
      playerIntent: true,
      visibleChanges: ["ok", 2],
      presentCharacters: "玩家",
      tension: null
    },
    needsRender: "true",
    directReply: ""
  });
  const storyElements = (coerced as unknown as { storyElements: Record<string, unknown> }).storyElements;
  assert.equal(storyElements.currentSituation, "1");
  assert.equal(storyElements.playerIntent, "true");
  assert.deepEqual(storyElements.visibleChanges, ["ok", "2"]);
  assert.deepEqual(storyElements.presentCharacters, ["玩家"]);
  assert.equal(storyElements.tension, "");
  assert.equal(coerced.needsRender, true);

  assert.throws(() => {
    parseDirectionPacket({
      storyElements: {
        currentSituation: ["bad"]
      },
      needsRender: true,
      directReply: ""
    });
  }, /currentSituation 需要文本/);

  assert.throws(() => {
    parseDirectionPacket({
      storyElements: {},
      needsRender: "maybe",
      directReply: ""
    });
  }, /needsRender 需要布尔值/);
});

test("parseDirectionPacket coerces characterActions and drops empty entries", () => {
  const packet = parseDirectionPacket({
    storyElements: {
      currentSituation: "医务间",
      characterActions: [
        { name: "韩越", action: "咬牙坐直，说密信要送往北营。" },
        "无名守卫低声催促北门快关了。",
        { name: "", action: "" },
        { name: "阿里", action: 42 }
      ]
    },
    needsRender: true,
    directReply: ""
  });

  const storyElements = (packet as unknown as { storyElements: { characterActions: unknown } }).storyElements;
  assert.deepEqual(storyElements.characterActions, [
    { name: "韩越", action: "咬牙坐直，说密信要送往北营。" },
    { name: "", action: "无名守卫低声催促北门快关了。" },
    { name: "阿里", action: "42" }
  ]);
});

test("submit_direction_packet does not mutate state and returns packet details", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-packet-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);
    const stateStore = createStateStore(db);
    const initialState = createInitialState({ player: { location: "Gate" } });
    stateStore.replaceState(save.id, initialState);

    const result = expectSyncResult(
      submitDirectionPacketTool.execute(
        "call-1",
        {
          storyElements: {
            currentSituation: "Gate",
            playerIntent: "The player leaves.",
            visibleChanges: ["The road opens."],
            presentCharacters: ["player"],
            tension: "Night is falling."
          },
          needsRender: true,
          directReply: ""
        },
        undefined,
        undefined,
        { db, stateStore } as unknown as never
      )
    );

    assert.deepEqual(readLatestState(db, save.id), initialState);
    assert.deepEqual(result.details?.packet, {
      storyElements: {
        currentSituation: "Gate",
        playerIntent: "The player leaves.",
        visibleChanges: ["The road opens."],
        presentCharacters: ["player"],
        characterActions: [],
        tension: "Night is falling."
      },
      needsRender: true,
      directReply: ""
    });
    assert.match(result.content[0]?.text ?? "", /Direction packet submitted/);
    assert.equal(result.terminate, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
