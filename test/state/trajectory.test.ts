import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const saveRepository = await import(
  pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href
);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const trajectory = await import(pathToFileURL(new URL("../../src/state/trajectory.ts", import.meta.url).pathname).href);

const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const appendCharacterTrajectory =
  trajectory.appendCharacterTrajectory as typeof import("../../src/state/trajectory.js").appendCharacterTrajectory;
const readTrajectoryTail =
  trajectory.readTrajectoryTail as typeof import("../../src/state/trajectory.js").readTrajectoryTail;
const readCharacterSummary =
  trajectory.readCharacterSummary as typeof import("../../src/state/trajectory.js").readCharacterSummary;
const writeCharacterSummary =
  trajectory.writeCharacterSummary as typeof import("../../src/state/trajectory.js").writeCharacterSummary;
const recallTrajectory =
  trajectory.recallTrajectory as typeof import("../../src/state/trajectory.js").recallTrajectory;
const maxSeqBeforeTurn =
  trajectory.maxSeqBeforeTurn as typeof import("../../src/state/trajectory.js").maxSeqBeforeTurn;
const pruneTrajectoryFrom =
  trajectory.pruneTrajectoryFrom as typeof import("../../src/state/trajectory.js").pruneTrajectoryFrom;

function withTempDatabase(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rp-traj-"));
  try {
    fn(join(dir, "state.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const T = (day: number, hour: number) => ({ day, hour });

test("append assigns increasing seq per (save, character) and records game time", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);

      const s1 = appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 1, content: "opens the gate", gameTime: T(1, 7) });
      const s2 = appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 1, content: "checks the papers", gameTime: T(1, 8) });
      const s3 = appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 2, content: "waves them through", gameTime: T(2, 9) });

      assert.deepEqual([s1, s2, s3], [1, 2, 3]);

      const tail = readTrajectoryTail(db, save.id, "mara", 0);
      assert.deepEqual(tail.map((e) => e.content), ["opens the gate", "checks the papers", "waves them through"]);
      assert.deepEqual(tail.map((e) => e.turnNo), [1, 1, 2]);
      assert.deepEqual(tail.map((e) => [e.gameDay, e.gameHour]), [[1, 7], [1, 8], [2, 9]]);
    } finally {
      db.close();
    }
  });
});

test("seq is independent per character and per save", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const first = createSave(db);
      const second = createSave(db);

      assert.equal(appendCharacterTrajectory(db, first.id, { character: "mara", turnNo: 1, content: "a", gameTime: T(1, 7) }), 1);
      assert.equal(appendCharacterTrajectory(db, first.id, { character: "iven", turnNo: 1, content: "b", gameTime: T(1, 7) }), 1);
      assert.equal(appendCharacterTrajectory(db, first.id, { character: "mara", turnNo: 1, content: "c", gameTime: T(1, 8) }), 2);
      assert.equal(appendCharacterTrajectory(db, second.id, { character: "mara", turnNo: 1, content: "d", gameTime: T(1, 7) }), 1);

      assert.deepEqual(readTrajectoryTail(db, first.id, "mara", 0).map((e) => e.content), ["a", "c"]);
      assert.deepEqual(readTrajectoryTail(db, first.id, "iven", 0).map((e) => e.content), ["b"]);
    } finally {
      db.close();
    }
  });
});

test("readTrajectoryTail returns only entries past the watermark, chronological", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      for (const c of ["one", "two", "three", "four"]) {
        appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 1, content: c, gameTime: T(1, 7) });
      }

      assert.deepEqual(readTrajectoryTail(db, save.id, "mara", 2).map((e) => e.content), ["three", "four"]);
      assert.deepEqual(readTrajectoryTail(db, save.id, "mara", 4), []);
      assert.deepEqual(readTrajectoryTail(db, save.id, "absent", 0), []);
    } finally {
      db.close();
    }
  });
});

test("summary round-trips and recall = summary + verbatim tail past the watermark", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);

      // No summary yet → recall is the full verbatim tail from seq 0.
      appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 1, content: "a", gameTime: T(1, 7) });
      appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 1, content: "b", gameTime: T(1, 8) });
      let recall = recallTrajectory(db, save.id, "mara");
      assert.equal(recall.summary, undefined);
      assert.deepEqual(recall.tail.map((e) => e.content), ["a", "b"]);

      // Fold the first two entries into a summary; a third entry stays as tail.
      appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 2, content: "c", gameTime: T(2, 9) });
      writeCharacterSummary(db, save.id, { character: "mara", summary: "arrived and settled in", coversUpToSeq: 2, lastTime: T(1, 8) });

      recall = recallTrajectory(db, save.id, "mara");
      assert.equal(recall.summary?.summary, "arrived and settled in");
      assert.equal(recall.summary?.coversUpToSeq, 2);
      assert.deepEqual([recall.summary?.lastDay, recall.summary?.lastHour], [1, 8]);
      assert.deepEqual(recall.tail.map((e) => e.content), ["c"]);

      // Rewriting the summary replaces the single row (author-driven compaction).
      writeCharacterSummary(db, save.id, { character: "mara", summary: "settled", coversUpToSeq: 3, lastTime: T(2, 9) });
      assert.equal(readCharacterSummary(db, save.id, "mara")?.summary, "settled");
      assert.equal(recallTrajectory(db, save.id, "mara").tail.length, 0);
    } finally {
      db.close();
    }
  });
});

test("maxSeqBeforeTurn returns the fold ceiling below a turn (keeps summaries roll-safe)", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 1, content: "a", gameTime: T(1, 7) }); // seq 1
      appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 1, content: "b", gameTime: T(1, 8) }); // seq 2
      appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 2, content: "c", gameTime: T(2, 9) }); // seq 3

      // Composing turn 2: only seq from turns < 2 may be folded → ceiling is 2.
      assert.equal(maxSeqBeforeTurn(db, save.id, "mara", 2), 2);
      // Before any turn → nothing foldable.
      assert.equal(maxSeqBeforeTurn(db, save.id, "mara", 1), 0);
      assert.equal(maxSeqBeforeTurn(db, save.id, "absent", 5), 0);
    } finally {
      db.close();
    }
  });
});

test("pruneTrajectoryFrom removes entries at/after a turn; summary is left intact", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      const save = createSave(db);
      const other = createSave(db);

      appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 1, content: "keep-mara", gameTime: T(1, 7) });
      appendCharacterTrajectory(db, save.id, { character: "iven", turnNo: 1, content: "keep-iven", gameTime: T(1, 7) });
      appendCharacterTrajectory(db, save.id, { character: "mara", turnNo: 2, content: "drop-mara", gameTime: T(2, 9) });
      appendCharacterTrajectory(db, save.id, { character: "iven", turnNo: 2, content: "drop-iven", gameTime: T(2, 9) });
      appendCharacterTrajectory(db, other.id, { character: "mara", turnNo: 2, content: "other-save", gameTime: T(2, 9) });
      // Summary watermark is kept below the undoable turn, so it survives a roll.
      writeCharacterSummary(db, save.id, { character: "mara", summary: "day one", coversUpToSeq: 1, lastTime: T(1, 7) });

      const removed = pruneTrajectoryFrom(db, save.id, 2);

      assert.equal(removed, 2);
      assert.deepEqual(readTrajectoryTail(db, save.id, "mara", 0).map((e) => e.content), ["keep-mara"]);
      assert.deepEqual(readTrajectoryTail(db, save.id, "iven", 0).map((e) => e.content), ["keep-iven"]);
      assert.equal(readCharacterSummary(db, save.id, "mara")?.summary, "day one");
      // A different save is untouched by the prune.
      assert.deepEqual(readTrajectoryTail(db, other.id, "mara", 0).map((e) => e.content), ["other-save"]);
    } finally {
      db.close();
    }
  });
});

test("appending for a missing save is rejected by the foreign key", () => {
  withTempDatabase((dbPath) => {
    const db = openRpDatabase(dbPath);
    try {
      initializeSchema(db);
      assert.throws(() => {
        appendCharacterTrajectory(db, "missing-save", { character: "mara", turnNo: 1, content: "x", gameTime: T(1, 7) });
      });
    } finally {
      db.close();
    }
  });
});
