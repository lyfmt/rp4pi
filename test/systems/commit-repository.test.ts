import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSave } from "../../src/state/save-repository.ts";
import { initializeSchema, openRpDatabase, type RpDatabase } from "../../src/state/sqlite.ts";
import {
  advanceSaveBranchMetadata,
  ensureSaveCommitMetadata,
  readCommitReceipt,
  readSaveCommitMetadata,
  writeCommitReceipt,
  writeSaveRevision
} from "../../src/systems/commit-repository.ts";

function withDatabase(run: (db: RpDatabase) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "rp-system-commit-repository-"));
  const db = openRpDatabase(join(directory, "state.sqlite"));
  try {
    initializeSchema(db);
    run(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("save commit metadata initializes once without resetting existing values", () => {
  withDatabase((db) => {
    const save = createSave(db);

    assert.deepEqual(ensureSaveCommitMetadata(db, save.id), {
      revision: 0,
      branchEpoch: 0
    });
    db.prepare(
      "UPDATE system_save_revisions SET revision = ?, branch_epoch = ? WHERE save_id = ?"
    ).run(4, 2, save.id);

    assert.deepEqual(ensureSaveCommitMetadata(db, save.id), {
      revision: 4,
      branchEpoch: 2
    });
    assert.deepEqual(readSaveCommitMetadata(db, save.id), {
      revision: 4,
      branchEpoch: 2
    });
  });
});

test("writeSaveRevision updates only the current revision", () => {
  withDatabase((db) => {
    const save = createSave(db);
    ensureSaveCommitMetadata(db, save.id);
    db.prepare("UPDATE system_save_revisions SET branch_epoch = ? WHERE save_id = ?").run(
      3,
      save.id
    );

    writeSaveRevision(db, save.id, 7);

    assert.deepEqual(readSaveCommitMetadata(db, save.id), {
      revision: 7,
      branchEpoch: 3
    });
  });
});

test("advanceSaveBranchMetadata increments revision and branch epoch in the caller transaction", () => {
  withDatabase((db) => {
    const save = createSave(db);
    ensureSaveCommitMetadata(db, save.id);
    db.prepare(
      "UPDATE system_save_revisions SET revision = ?, branch_epoch = ? WHERE save_id = ?"
    ).run(4, 2, save.id);

    db.exec("BEGIN IMMEDIATE");
    assert.deepEqual(advanceSaveBranchMetadata(db, save.id), {
      revision: 5,
      branchEpoch: 3
    });
    db.exec("ROLLBACK");

    assert.deepEqual(readSaveCommitMetadata(db, save.id), {
      revision: 4,
      branchEpoch: 2
    });
  });
});

test("commit receipts round-trip within a save branch", () => {
  withDatabase((db) => {
    const save = createSave(db);
    const receipt = {
      commitId: "commit-1",
      revision: 1,
      branchEpoch: 2,
      operations: [{ system: "progression", command: "gain_xp", result: { xp: 25 } }]
    };

    writeCommitReceipt(db, save.id, 2, "request-1", "hash-1", receipt);

    assert.deepEqual(readCommitReceipt(db, save.id, 2, "request-1"), {
      requestHash: "hash-1",
      receipt
    });
    assert.equal(readCommitReceipt(db, save.id, 1, "request-1"), undefined);
  });
});

test("receipt request ids are unique per branch epoch", () => {
  withDatabase((db) => {
    const save = createSave(db);
    writeCommitReceipt(db, save.id, 0, "request-1", "hash-1", { revision: 1 });

    assert.throws(() => {
      writeCommitReceipt(db, save.id, 0, "request-1", "hash-2", { revision: 2 });
    });
    assert.deepEqual(readCommitReceipt(db, save.id, 0, "request-1"), {
      requestHash: "hash-1",
      receipt: { revision: 1 }
    });

    writeCommitReceipt(db, save.id, 1, "request-1", "hash-2", { revision: 2 });
    assert.deepEqual(readCommitReceipt(db, save.id, 1, "request-1"), {
      requestHash: "hash-2",
      receipt: { revision: 2 }
    });
  });
});

test("commit metadata and receipts require an existing save", () => {
  withDatabase((db) => {
    assert.throws(() => ensureSaveCommitMetadata(db, "missing-save"));
    assert.throws(() => writeSaveRevision(db, "missing-save", 1));
    assert.throws(() => advanceSaveBranchMetadata(db, "missing-save"));
    assert.throws(() => {
      writeCommitReceipt(db, "missing-save", 0, "request-1", "hash-1", { revision: 1 });
    });

    assert.equal(readSaveCommitMetadata(db, "missing-save"), undefined);
    assert.equal(readCommitReceipt(db, "missing-save", 0, "request-1"), undefined);
  });
});
