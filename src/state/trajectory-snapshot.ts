import { SystemRuntimeError } from "../systems/errors.ts";
import type { TrajectorySnapshot } from "./snapshot-envelope.ts";
import type { RpDatabase } from "./sqlite.ts";
import type { CharacterSummary } from "./trajectory.ts";

type WatermarkRow = { character: string; watermark: number };
type SummaryRow = {
  character: string;
  summary: string;
  covers_up_to_seq: number;
  last_day: number;
  last_hour: number;
  updated_at: string;
};

export type { TrajectorySnapshot } from "./snapshot-envelope.ts";

export function captureTrajectorySnapshot(db: RpDatabase, saveId: string): TrajectorySnapshot {
  const watermarkRows = db
    .prepare(
      `SELECT character, MAX(seq) AS watermark
       FROM character_trajectories
       WHERE save_id = ?
       GROUP BY character
       ORDER BY character`
    )
    .all(saveId) as WatermarkRow[];
  const summaryRows = db
    .prepare(
      `SELECT character, summary, covers_up_to_seq, last_day, last_hour, updated_at
       FROM character_summaries
       WHERE save_id = ?
       ORDER BY character`
    )
    .all(saveId) as SummaryRow[];

  const watermarks: Record<string, number> = {};
  for (const row of watermarkRows) {
    watermarks[row.character] = row.watermark;
  }
  for (const row of summaryRows) {
    watermarks[row.character] ??= 0;
  }

  return {
    watermarks: sortWatermarks(watermarks),
    summaries: summaryRows.map(fromSummaryRow)
  };
}

/** Restore the complete trajectory participant. The caller owns the transaction. */
export function restoreTrajectorySnapshot(
  db: RpDatabase,
  saveId: string,
  snapshot: TrajectorySnapshot
): void {
  preflightTrajectorySnapshot(db, saveId, snapshot);

  const characters = Object.keys(snapshot.watermarks);
  for (const character of characters) {
    db.prepare(
      "DELETE FROM character_trajectories WHERE save_id = ? AND character = ? AND seq > ?"
    ).run(saveId, character, snapshot.watermarks[character]!);
  }

  if (characters.length === 0) {
    db.prepare("DELETE FROM character_trajectories WHERE save_id = ?").run(saveId);
  } else {
    const placeholders = characters.map(() => "?").join(", ");
    db.prepare(
      `DELETE FROM character_trajectories WHERE save_id = ? AND character NOT IN (${placeholders})`
    ).run(saveId, ...characters);
  }

  db.prepare("DELETE FROM character_summaries WHERE save_id = ?").run(saveId);
  const insertSummary = db.prepare(
    `INSERT INTO character_summaries (
       save_id, character, summary, covers_up_to_seq, last_day, last_hour, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const summary of snapshot.summaries) {
    insertSummary.run(
      saveId,
      summary.character,
      summary.summary,
      summary.coversUpToSeq,
      summary.lastDay,
      summary.lastHour,
      summary.updatedAt
    );
  }
}

export function validateTrajectorySnapshot(snapshot: TrajectorySnapshot): void {
  if (typeof snapshot !== "object" || snapshot === null) {
    incompatibleTrajectory("trajectory must be an object");
  }
  if (
    typeof snapshot.watermarks !== "object" ||
    snapshot.watermarks === null ||
    Array.isArray(snapshot.watermarks)
  ) {
    incompatibleTrajectory("watermarks must be an object");
  }
  if (!Array.isArray(snapshot.summaries)) {
    incompatibleTrajectory("summaries must be an array");
  }

  for (const [character, watermark] of Object.entries(snapshot.watermarks)) {
    if (character.length === 0 || !Number.isInteger(watermark) || watermark < 0) {
      incompatibleTrajectory(`invalid watermark for ${character || "<empty>"}`);
    }
  }

  const summarizedCharacters = new Set<string>();
  for (const [index, summary] of snapshot.summaries.entries()) {
    validateSummary(summary, index);
    const watermark = snapshot.watermarks[summary.character];
    if (watermark === undefined) {
      incompatibleTrajectory(`summary character ${summary.character} has no watermark`);
    }
    if (summary.coversUpToSeq > watermark) {
      incompatibleTrajectory(
        `summary for ${summary.character} covers seq ${summary.coversUpToSeq} past watermark ${watermark}`
      );
    }
    if (summarizedCharacters.has(summary.character)) {
      incompatibleTrajectory(`duplicate summary for ${summary.character}`);
    }
    summarizedCharacters.add(summary.character);
  }
}

export function preflightTrajectorySnapshot(
  db: RpDatabase,
  saveId: string,
  snapshot: TrajectorySnapshot
): void {
  validateTrajectorySnapshot(snapshot);
  validateRetainedEntriesExist(db, saveId, snapshot.watermarks);
}

function validateRetainedEntriesExist(
  db: RpDatabase,
  saveId: string,
  watermarks: Record<string, number>
): void {
  for (const [character, watermark] of Object.entries(watermarks)) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM character_trajectories
         WHERE save_id = ? AND character = ? AND seq <= ?`
      )
      .get(saveId, character, watermark) as { count: number };
    if (row.count !== watermark) {
      incompatibleTrajectory(`entries through watermark ${watermark} are missing for ${character}`);
    }
  }
}

function validateSummary(summary: CharacterSummary, index: number): void {
  if (
    typeof summary !== "object" ||
    summary === null ||
    typeof summary.character !== "string" ||
    typeof summary.summary !== "string" ||
    !Number.isInteger(summary.coversUpToSeq) ||
    summary.coversUpToSeq < 0 ||
    !Number.isInteger(summary.lastDay) ||
    !Number.isInteger(summary.lastHour) ||
    typeof summary.updatedAt !== "string"
  ) {
    incompatibleTrajectory(`summary ${index} is invalid`);
  }
}

function fromSummaryRow(row: SummaryRow): CharacterSummary {
  return {
    character: row.character,
    summary: row.summary,
    coversUpToSeq: row.covers_up_to_seq,
    lastDay: row.last_day,
    lastHour: row.last_hour,
    updatedAt: row.updated_at
  };
}

function sortWatermarks(watermarks: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(watermarks).sort(([left], [right]) => left.localeCompare(right)));
}

function incompatibleTrajectory(reason: string): never {
  throw new SystemRuntimeError("SNAPSHOT_INCOMPATIBLE", {
    participant: "trajectory",
    reason
  });
}
