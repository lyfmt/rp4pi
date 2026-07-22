import type { RpDatabase } from "../state/sqlite.ts";

export type SaveCommitMetadata = Readonly<{
  revision: number;
  branchEpoch: number;
}>;

type SaveCommitMetadataRow = {
  revision: number;
  branch_epoch: number;
};

type CommitReceiptRow = {
  request_hash: string;
  receipt_json: string;
};

export type StoredCommitReceipt<Receipt = unknown> = Readonly<{
  requestHash: string;
  receipt: Receipt;
}>;

export function ensureSaveCommitMetadata(
  db: RpDatabase,
  saveId: string
): SaveCommitMetadata {
  db.prepare(`
    INSERT INTO system_save_revisions (save_id, revision, branch_epoch)
    VALUES (?, 0, 0)
    ON CONFLICT(save_id) DO NOTHING
  `).run(saveId);

  const metadata = readSaveCommitMetadata(db, saveId);
  if (metadata === undefined) {
    throw new Error(`System commit metadata is unavailable for save "${saveId}".`);
  }
  return metadata;
}

export function readSaveCommitMetadata(
  db: RpDatabase,
  saveId: string
): SaveCommitMetadata | undefined {
  const row = db
    .prepare(`
      SELECT revision, branch_epoch
      FROM system_save_revisions
      WHERE save_id = ?
    `)
    .get(saveId) as SaveCommitMetadataRow | undefined;

  return row === undefined
    ? undefined
    : { revision: row.revision, branchEpoch: row.branch_epoch };
}

export function writeSaveRevision(db: RpDatabase, saveId: string, revision: number): void {
  const result = db
    .prepare("UPDATE system_save_revisions SET revision = ? WHERE save_id = ?")
    .run(revision, saveId);
  if (result.changes !== 1) {
    throw new Error(`System commit metadata is unavailable for save "${saveId}".`);
  }
}

export function advanceSaveBranchMetadata(
  db: RpDatabase,
  saveId: string
): SaveCommitMetadata {
  const row = db
    .prepare(`
      UPDATE system_save_revisions
      SET revision = revision + 1, branch_epoch = branch_epoch + 1
      WHERE save_id = ?
      RETURNING revision, branch_epoch
    `)
    .get(saveId) as SaveCommitMetadataRow | undefined;
  if (row === undefined) {
    throw new Error(`System commit metadata is unavailable for save "${saveId}".`);
  }
  return { revision: row.revision, branchEpoch: row.branch_epoch };
}

export function writeCommitReceipt(
  db: RpDatabase,
  saveId: string,
  branchEpoch: number,
  requestId: string,
  requestHash: string,
  receipt: unknown
): void {
  db.prepare(`
    INSERT INTO system_commit_receipts (
      save_id, branch_epoch, request_id, request_hash, receipt_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    saveId,
    branchEpoch,
    requestId,
    requestHash,
    JSON.stringify(receipt),
    new Date().toISOString()
  );
}

export function readCommitReceipt<Receipt = unknown>(
  db: RpDatabase,
  saveId: string,
  branchEpoch: number,
  requestId: string
): StoredCommitReceipt<Receipt> | undefined {
  const row = db
    .prepare(`
      SELECT request_hash, receipt_json
      FROM system_commit_receipts
      WHERE save_id = ? AND branch_epoch = ? AND request_id = ?
    `)
    .get(saveId, branchEpoch, requestId) as CommitReceiptRow | undefined;

  return row === undefined
    ? undefined
    : { requestHash: row.request_hash, receipt: JSON.parse(row.receipt_json) as Receipt };
}
