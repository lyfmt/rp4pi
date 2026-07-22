import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSave } from "../../src/state/save-repository.ts";
import { initializeSchema, openRpDatabase, type RpDatabase } from "../../src/state/sqlite.ts";
import {
  captureTrajectorySnapshot,
  restoreTrajectorySnapshot
} from "../../src/state/trajectory-snapshot.ts";
import {
  appendCharacterTrajectory,
  readCharacterSummary,
  readTrajectoryTail,
  writeCharacterSummary
} from "../../src/state/trajectory.ts";
import { SystemRuntimeError } from "../../src/systems/errors.ts";

const T = (day: number, hour: number) => ({ day, hour });

test("capture records each character watermark and complete summaries", () => {
  withDatabase((db) => {
    const save = createSave(db);
    seedTrajectory(db, save.id);

    const snapshot = captureTrajectorySnapshot(db, save.id);

    assert.deepEqual(snapshot.watermarks, { "han-yue": 4 });
    assert.equal(snapshot.summaries.length, 1);
    assert.equal(snapshot.summaries[0]?.character, "han-yue");
    assert.equal(snapshot.summaries[0]?.coversUpToSeq, 2);
    assert.equal(snapshot.summaries[0]?.summary, "守门的前两步");
  });
});

test("restore prunes newer entries and exactly replaces characters and summaries", () => {
  withDatabase((db) => {
    const save = createSave(db);
    seedTrajectory(db, save.id);
    const snapshot = captureTrajectorySnapshot(db, save.id);

    appendCharacterTrajectory(db, save.id, {
      character: "han-yue",
      turnNo: 3,
      content: "new fifth entry",
      gameTime: T(3, 9)
    });
    appendCharacterTrajectory(db, save.id, {
      character: "new-character",
      turnNo: 3,
      content: "new branch entry",
      gameTime: T(3, 9)
    });
    writeCharacterSummary(db, save.id, {
      character: "han-yue",
      summary: "new branch summary",
      coversUpToSeq: 4,
      lastTime: T(2, 10)
    });
    writeCharacterSummary(db, save.id, {
      character: "new-character",
      summary: "new character summary",
      coversUpToSeq: 1,
      lastTime: T(3, 9)
    });

    restoreTrajectorySnapshot(db, save.id, snapshot);

    assert.deepEqual(readTrajectoryTail(db, save.id, "han-yue", 0).map((entry) => entry.seq), [1, 2, 3, 4]);
    assert.deepEqual(readTrajectoryTail(db, save.id, "new-character", 0), []);
    assert.deepEqual(readCharacterSummary(db, save.id, "han-yue"), snapshot.summaries[0]);
    assert.equal(readCharacterSummary(db, save.id, "new-character"), undefined);
  });
});

test("restore rejects a summary past its watermark before deleting any data", () => {
  withDatabase((db) => {
    const save = createSave(db);
    seedTrajectory(db, save.id);
    const snapshot = captureTrajectorySnapshot(db, save.id);
    appendCharacterTrajectory(db, save.id, {
      character: "han-yue",
      turnNo: 3,
      content: "must survive failed restore",
      gameTime: T(3, 9)
    });
    const invalid = structuredClone(snapshot);
    invalid.summaries[0]!.coversUpToSeq = 5;
    const before = dumpTrajectory(db, save.id);

    assert.throws(
      () => restoreTrajectorySnapshot(db, save.id, invalid),
      (error) => error instanceof SystemRuntimeError && error.code === "SNAPSHOT_INCOMPATIBLE"
    );
    assert.deepEqual(dumpTrajectory(db, save.id), before);
  });
});

function seedTrajectory(db: RpDatabase, saveId: string): void {
  for (let seq = 1; seq <= 4; seq += 1) {
    appendCharacterTrajectory(db, saveId, {
      character: "han-yue",
      turnNo: seq <= 2 ? 1 : 2,
      content: `entry ${seq}`,
      gameTime: T(seq <= 2 ? 1 : 2, 7 + seq)
    });
  }
  writeCharacterSummary(db, saveId, {
    character: "han-yue",
    summary: "守门的前两步",
    coversUpToSeq: 2,
    lastTime: T(1, 9)
  });
}

function dumpTrajectory(db: RpDatabase, saveId: string): unknown {
  return {
    entries: db
      .prepare("SELECT * FROM character_trajectories WHERE save_id = ? ORDER BY character, seq")
      .all(saveId),
    summaries: db
      .prepare("SELECT * FROM character_summaries WHERE save_id = ? ORDER BY character")
      .all(saveId)
  };
}

function withDatabase(run: (db: RpDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rp-trajectory-snapshot-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
