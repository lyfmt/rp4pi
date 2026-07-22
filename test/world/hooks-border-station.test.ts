import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fireHooks, type HookDelivery } from "../../src/hooks/engine.ts";
import { readHookFireState } from "../../src/state/hook-fire-state.ts";
import { createInitialState } from "../../src/state/schema.ts";
import { createSave } from "../../src/state/save-repository.ts";
import { recordEmptySystemStorySnapshot } from "../helpers/story-snapshots.ts";
import { initializeSchema, openRpDatabase, readLatestState } from "../../src/state/sqlite.ts";
import { createStateStore } from "../../src/state/store.ts";
import { loadWorldFromDir } from "../../src/world/loader.ts";

// H-C: validate the border-station example hooks end-to-end against the base
// platform — the real world.yaml parses into HookSpecs, and a dry-run of the
// engine over those specs produces the declared effects. This is the static
// counterpart to a live playthrough: no GM/provider, just loader + engine.

const worldRoot = new URL("../../worlds/border-station", import.meta.url).pathname;

test("border-station declares the three example hooks across the anchors", () => {
  const world = loadWorldFromDir(worldRoot);
  const byName = new Map(world.hooks.map((hook) => [hook.name, hook]));

  const opening = byName.get("opening-atmosphere");
  assert.ok(opening, "opening-atmosphere hook missing");
  assert.equal(opening.on, "session_start");
  assert.equal(opening.action.type, "inject");
  if (opening.action.type === "inject") {
    assert.equal(opening.action.as, "notice");
  }

  const clock = byName.get("clock-drift");
  assert.ok(clock, "clock-drift hook missing");
  assert.equal(clock.on, "turn_committed");
  assert.equal(clock.action.type, "state");

  const beat = byName.get("background-beat");
  assert.ok(beat, "background-beat hook missing");
  assert.equal(beat.on, "turn_committed");
  assert.deepEqual(beat.every, { turns: 4 });
  assert.equal(beat.action.type, "inject");
  if (beat.action.type === "inject") {
    assert.equal(beat.action.as, "prompt");
  }
});

test("dry-running the border-station hooks yields the declared effects", () => {
  const world = loadWorldFromDir(worldRoot);
  const dir = mkdtempSync(join(tmpdir(), "rp-border-hooks-"));
  try {
    const db = openRpDatabase(join(dir, "state.sqlite"));
    initializeSchema(db);
    const { id: saveId } = createSave(db);
    const stateStore = createStateStore(db);
    stateStore.replaceState(saveId, createInitialState(world.initialState, world.attributes));

    const prompts: string[] = [];
    const notices: string[] = [];
    const delivery: HookDelivery = { prompt: (t) => prompts.push(t), notice: (t) => notices.push(t) };
    const deps = { db, stateStore, delivery };

    // session_start: the opening-atmosphere notice fires once.
    fireHooks({ hooks: world.hooks, anchor: "session_start", saveId, deps });
    assert.equal(notices.length, 1);
    assert.match(notices[0], /晨雾/);

    const startHour = world.initialState.time.hour;

    // Five committed turns: clock-drift fires every turn (+1h each); background-beat
    // fires on turn 1 (cadence bootstrap) and again at turn 5 (its `every: 4` gate
    // — four turns elapsed since the bootstrap fire).
    for (let turn = 1; turn <= 5; turn++) {
      recordEmptySystemStorySnapshot(db, saveId, stateStore.getState());
      fireHooks({ hooks: world.hooks, anchor: "turn_committed", saveId, deps });
    }

    // clock-drift: five +1h advances off the world's opening hour.
    assert.equal(readLatestState(db, saveId)?.time.hour, startHour + 5);
    // background-beat prompt fired exactly twice (turns 1 and 5).
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /背景动静/);
    assert.equal(readHookFireState(db, saveId, "background-beat")?.fireCount, 2);
    assert.equal(readHookFireState(db, saveId, "clock-drift")?.fireCount, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
