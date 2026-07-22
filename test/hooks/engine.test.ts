import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fireHooks, type HookDelivery } from "../../src/hooks/engine.ts";
import { createInitialState } from "../../src/state/schema.ts";
import { createSave } from "../../src/state/save-repository.ts";
import { recordEmptySystemStorySnapshot } from "../helpers/story-snapshots.ts";
import { readHookFireState } from "../../src/state/hook-fire-state.ts";
import { initializeSchema, openRpDatabase, readLatestState } from "../../src/state/sqlite.ts";
import { createStateStore } from "../../src/state/store.ts";
import type { HookSpec } from "../../src/world/schema.ts";

function withEngine(fn: (h: {
  db: ReturnType<typeof openRpDatabase>;
  saveId: string;
  deps: Parameters<typeof fireHooks>[0]["deps"];
  prompts: string[];
  notices: string[];
  advanceTurn: () => void;
}) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rp-hooks-"));
  try {
    const db = openRpDatabase(join(dir, "state.sqlite"));
    initializeSchema(db);
    const { id: saveId } = createSave(db);
    const stateStore = createStateStore(db);
    const attributeSpecs = [{ kind: "int" as const, name: "vigor", initial: 80, min: 0, max: 100 }];
    stateStore.replaceState(saveId, createInitialState({ time: { day: 1, hour: 8 } }, attributeSpecs));

    const prompts: string[] = [];
    const notices: string[] = [];
    const delivery: HookDelivery = {
      prompt: (t) => prompts.push(t),
      notice: (t) => notices.push(t)
    };
    const advanceTurn = () => {
      recordEmptySystemStorySnapshot(db, saveId, stateStore.getState());
    };

    fn({ db, saveId, deps: { db, stateStore, delivery }, prompts, notices, advanceTurn });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const injectPrompt: HookSpec = {
  name: "note",
  on: "turn_start",
  action: { type: "inject", text: "雾未散", as: "prompt" }
};

test("inject prompt hook delivers to the GM prompt channel and records a fire", () => {
  withEngine(({ saveId, deps, prompts, db }) => {
    const fired = fireHooks({ hooks: [injectPrompt], anchor: "turn_start", saveId, deps });
    assert.deepEqual(prompts, ["雾未散"]);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].name, "note");
    const rec = readHookFireState(db, saveId, "note");
    assert.ok(rec);
    assert.equal(rec.fireCount, 1);
  });
});

test("only hooks bound to the anchor fire", () => {
  withEngine(({ saveId, deps, prompts }) => {
    fireHooks({ hooks: [injectPrompt], anchor: "turn_committed", saveId, deps });
    assert.deepEqual(prompts, []);
  });
});

test("notice inject goes to the notice channel", () => {
  withEngine(({ saveId, deps, notices }) => {
    const hook: HookSpec = { name: "late", on: "turn_committed", action: { type: "inject", text: "夜深了", as: "notice" } };
    fireHooks({ hooks: [hook], anchor: "turn_committed", saveId, deps });
    assert.deepEqual(notices, ["夜深了"]);
  });
});

test("state hook mutates and persists through the store", () => {
  withEngine(({ saveId, deps, db }) => {
    const hook: HookSpec = {
      name: "drift",
      on: "turn_committed",
      action: { type: "state", mutations: [{ path: "attributes.vigor", op: "add", value: -3 }] }
    };
    fireHooks({ hooks: [hook], anchor: "turn_committed", saveId, deps });
    assert.equal(readLatestState(db, saveId)?.attributes.vigor, 77);
  });
});

test("delegate hook injects a GM instruction naming the subagent and task", () => {
  withEngine(({ saveId, deps, prompts }) => {
    const hook: HookSpec = {
      name: "scout",
      on: "turn_committed",
      action: { type: "delegate", subagent: "event-scout", task: "生成后台事件" }
    };
    fireHooks({ hooks: [hook], anchor: "turn_committed", saveId, deps });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /event-scout/);
    assert.match(prompts[0], /生成后台事件/);
  });
});

test("cadence gate throttles across turns and persists last-fire", () => {
  withEngine(({ saveId, deps, prompts, advanceTurn }) => {
    const hook: HookSpec = {
      name: "every3",
      on: "turn_committed",
      every: { turns: 3 },
      action: { type: "inject", text: "tick", as: "prompt" }
    };
    // turn 1 committed → first fire (bootstrap).
    advanceTurn();
    fireHooks({ hooks: [hook], anchor: "turn_committed", saveId, deps });
    // turns 2,3 → not yet 3 apart.
    advanceTurn();
    fireHooks({ hooks: [hook], anchor: "turn_committed", saveId, deps });
    advanceTurn();
    fireHooks({ hooks: [hook], anchor: "turn_committed", saveId, deps });
    // turn 4 → 3 turns since fire at turn 1 → fires again.
    advanceTurn();
    fireHooks({ hooks: [hook], anchor: "turn_committed", saveId, deps });
    assert.deepEqual(prompts, ["tick", "tick"]);
  });
});

test("a throwing hook does not break the batch and is skipped from fired", () => {
  withEngine(({ saveId, deps, prompts, db }) => {
    const bad: HookSpec = {
      name: "bad",
      on: "turn_committed",
      action: { type: "state", mutations: [{ path: "nope.field", op: "set", value: 1 }] }
    };
    const good: HookSpec = { name: "good", on: "turn_committed", action: { type: "inject", text: "ok", as: "prompt" } };
    const fired = fireHooks({ hooks: [bad, good], anchor: "turn_committed", saveId, deps });
    assert.deepEqual(prompts, ["ok"]);
    assert.deepEqual(fired.map((f) => f.name), ["good"]);
    // The failed hook recorded no fire-state.
    assert.equal(readHookFireState(db, saveId, "bad"), undefined);
  });
});
