import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { ExtensionContextLike } from "../../src/types/pi.ts";
import { recordEmptySystemStorySnapshot } from "../helpers/story-snapshots.ts";

const roleRuntime = await import(
  pathToFileURL(new URL("../../src/subagents/role-runtime.ts", import.meta.url).pathname).href
);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const saveRepository = await import(
  pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href
);
const store = await import(pathToFileURL(new URL("../../src/state/store.ts", import.meta.url).pathname).href);
const schema = await import(pathToFileURL(new URL("../../src/state/schema.ts", import.meta.url).pathname).href);
const trajectory = await import(pathToFileURL(new URL("../../src/state/trajectory.ts", import.meta.url).pathname).href);

const {
  parseRememberInput,
  resolveRoleBinding,
  assessMaintenance,
  renderRecall,
  recallSelfTool,
  rememberActionTool,
  TAIL_FOLD_THRESHOLD_CHARS
} = roleRuntime;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const createStateStore = store.createStateStore as typeof import("../../src/state/store.js").createStateStore;
const createInitialState = schema.createInitialState as typeof import("../../src/state/schema.js").createInitialState;
const recallTrajectory = trajectory.recallTrajectory as typeof import("../../src/state/trajectory.js").recallTrajectory;

const ctx = {} as unknown as ExtensionContextLike;

// Restore env this file mutates so it can't leak into sibling tests.
function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const keys = Object.keys(overrides);
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    return out instanceof Promise ? out.finally(restore) : (restore(), out);
  } catch (error) {
    restore();
    throw error;
  }
}

// Build a temp sqlite the role tools will open via RP_SQLITE_PATH, seed a save
// with committed turns + game time, and run `fn` with the role env bound.
async function withRoleDb(
  fn: (env: { saveId: string; dbPath: string }) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rp-role-"));
  const dbPath = join(dir, "state.sqlite");
  const db = openRpDatabase(dbPath);
  let saveId = "";
  try {
    initializeSchema(db);
    const save = createSave(db);
    saveId = save.id;
    const stateStore = createStateStore(db);
    stateStore.replaceState(saveId, createInitialState({ time: { day: 2, hour: 14 } }));
    // One committed story turn → current composing turn is 2.
    recordEmptySystemStorySnapshot(db, saveId, createInitialState({ time: { day: 2, hour: 14 } }));
  } finally {
    db.close();
  }
  try {
    await withEnv(
      { RP_SQLITE_PATH: dbPath, RP_ACTIVE_SAVE: saveId, PI_SUBAGENT_CHILD_AGENT: "wounded-messenger" },
      () => fn({ saveId, dbPath })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveRoleBinding reads save + character from env, else names what is missing", () => {
  assert.deepEqual(resolveRoleBinding({ RP_ACTIVE_SAVE: "s1", PI_SUBAGENT_CHILD_AGENT: "mara" }), {
    saveId: "s1",
    character: "mara"
  });
  assert.deepEqual(resolveRoleBinding({ PI_SUBAGENT_CHILD_AGENT: "mara" }), { reason: "no-active-save" });
  assert.deepEqual(resolveRoleBinding({ RP_ACTIVE_SAVE: "s1" }), { reason: "no-character-identity" });
});

test("parseRememberInput requires content and treats summary as optional", () => {
  assert.deepEqual(parseRememberInput({ content: " 我按住肩伤 " }), { content: "我按住肩伤", summary: undefined });
  assert.deepEqual(parseRememberInput({ content: "我点头", summary: " 至此我仍守口如瓶 " }), {
    content: "我点头",
    summary: "至此我仍守口如瓶"
  });
  assert.throws(() => parseRememberInput(null), /对象/);
  assert.throws(() => parseRememberInput({ summary: "x" }), /content/);
  assert.throws(() => parseRememberInput({ content: "   " }), /content/);
});

test("assessMaintenance flags a fold once the verbatim tail exceeds the char threshold", () => {
  const big = "x".repeat(TAIL_FOLD_THRESHOLD_CHARS + 1);
  const recall = { summary: undefined, tail: [{ character: "m", turnNo: 1, seq: 1, content: big, gameDay: 1, gameHour: 8, createdAt: "t" }] };
  const hint = assessMaintenance(recall);
  assert.equal(hint.needsFold, true);
  assert.equal(hint.needsCompact, false);
});

test("renderRecall shows summary + tail and surfaces the maintenance note when needed", () => {
  const big = "x".repeat(TAIL_FOLD_THRESHOLD_CHARS + 1);
  const text = renderRecall(
    {
      summary: { character: "韩越", summary: "我伤在左肩", coversUpToSeq: 1, lastDay: 2, lastHour: 10, updatedAt: "t" },
      tail: [{ character: "韩越", turnNo: 2, seq: 2, content: big, gameDay: 2, gameHour: 14, createdAt: "t" }]
    },
    "韩越"
  );
  assert.match(text, /既往轨迹/);
  assert.match(text, /我伤在左肩/);
  assert.match(text, /记忆维护提醒/);
});

test("recall_self reports the missing binding instead of throwing", async () => {
  await withEnv({ RP_ACTIVE_SAVE: undefined, PI_SUBAGENT_CHILD_AGENT: "mara" }, async () => {
    const res = await recallSelfTool.execute("t", {}, undefined, undefined, ctx);
    assert.equal(res.details.available, false);
    assert.equal(res.details.reason, "no-active-save");
  });
});

test("remember_action then recall_self round-trips through the shared db, tagged with the current turn + game time", async () => {
  await withRoleDb(async ({ saveId, dbPath }) => {
    const r1 = await rememberActionTool.execute("t", { content: "我勉强坐直，按住左肩。" }, undefined, undefined, ctx);
    assert.equal(r1.details.persisted, true);
    assert.equal(r1.details.folded, false);
    assert.equal(r1.details.character, "wounded-messenger");

    // recall_self sees it as verbatim tail (no summary yet).
    const recall = await recallSelfTool.execute("t", {}, undefined, undefined, ctx);
    assert.equal(recall.details.available, true);
    assert.equal(recall.details.entryCount, 1);
    assert.equal(recall.details.hasSummary, false);
    assert.match(recall.content[0].text, /我勉强坐直/);

    // Verify persistence directly: tagged turn_no = 2 (current composing turn),
    // game time from the save's latest state (day 2, hour 14).
    const db = openRpDatabase(dbPath);
    try {
      const t = recallTrajectory(db, saveId, "wounded-messenger");
      assert.equal(t.tail.length, 1);
      assert.equal(t.tail[0].turnNo, 2);
      assert.deepEqual([t.tail[0].gameDay, t.tail[0].gameHour], [2, 14]);
    } finally {
      db.close();
    }
  });
});

test("remember_action with a summary folds prior turns while keeping this turn as tail", async () => {
  await withRoleDb(async ({ saveId, dbPath }) => {
    // Seed a prior-turn (turn 1) entry directly so there is something below the
    // fold watermark; then this turn (turn 2) supplies a summary.
    const seed = openRpDatabase(dbPath);
    try {
      const traj = await import(pathToFileURL(new URL("../../src/state/trajectory.ts", import.meta.url).pathname).href);
      (traj.appendCharacterTrajectory as typeof import("../../src/state/trajectory.js").appendCharacterTrajectory)(
        seed,
        saveId,
        { character: "wounded-messenger", turnNo: 1, content: "旧事一", gameTime: { day: 2, hour: 10 } }
      );
    } finally {
      seed.close();
    }

    const res = await rememberActionTool.execute(
      "t",
      { content: "我望向门口。", summary: "我伤在左肩，尚未交出密信。" },
      undefined,
      undefined,
      ctx
    );
    assert.equal(res.details.folded, true);

    const db = openRpDatabase(dbPath);
    try {
      const t = recallTrajectory(db, saveId, "wounded-messenger");
      // Summary covers only the prior committed turn (watermark below turn 2);
      // this turn's action remains visible as tail.
      assert.equal(t.summary?.summary, "我伤在左肩，尚未交出密信。");
      assert.equal(t.summary?.coversUpToSeq, 1);
      assert.deepEqual(t.tail.map((e) => e.content), ["我望向门口。"]);
    } finally {
      db.close();
    }
  });
});
