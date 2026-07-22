import type { RpDatabase } from "./sqlite.ts";

// A role-subagent's action trajectory: the character's own prior replies,
// appended verbatim so a later spawn can recall and continue its own thread —
// the mechanism that turns an otherwise-stateless child process into a
// persistent single-character actor ("the trajectory is inherited from its
// previous replies").
//
// Two layers, both save+character-scoped in SQLite and deliberately SEPARATE
// from OpenViking `characters` memory (OV holds the distilled "who the character
// is"; these tables hold "what it has done"):
//
//   character_trajectories — verbatim entries, one per remembered action.
//   character_summaries    — one rolling summary row per (save, character),
//                            covering everything up to `coversUpToSeq`.
//
// Recall is layered rather than "last N": the rolling summary (older actions,
// author-compressed) + the verbatim tail (entries with seq > coversUpToSeq,
// chronological). When the tail grows past the harness's char threshold the
// author folds its oldest span into the summary and advances the watermark;
// when the summary text itself grows too large the author rewrites it smaller.
// This module is pure storage — it does NOT call an LLM. The role-subagent
// authors summary text itself (decided upstream); harness code here only stores
// what it is given and reports sizes so callers can decide when to prompt for a
// fold/compaction.
//
// Time: each verbatim entry records the in-game `game_day`/`game_hour` at which
// it happened (from RpState.time), and the summary records the day/hour it now
// covers up to. These are recorded for harness logic (a later recall may key on
// game time and/or turn); this module never interprets them.
//
// Rollback: `turn_no` tags the story turn an entry belongs to. `/roll` (undo the
// last turn) calls `pruneTrajectoryFrom` to drop entries at/after the undone
// turn. The fold watermark is kept strictly BELOW the current turn (callers use
// `maxSeqBeforeTurn` to clamp `coversUpToSeq`), so a summary never absorbs a
// roll-undoable action and prune only ever removes verbatim tail — the two can
// never disagree. `seq` is a per-(save,character) monotonic counter giving a
// stable chronological order independent of wall-clock timestamps.

export type GameTime = { day: number; hour: number };

export type TrajectoryEntry = {
  character: string;
  turnNo: number;
  seq: number;
  content: string;
  gameDay: number;
  gameHour: number;
  createdAt: string;
};

export type CharacterSummary = {
  character: string;
  summary: string;
  coversUpToSeq: number;
  lastDay: number;
  lastHour: number;
  updatedAt: string;
};

/** The assembled memory handed back for a recall: the rolling summary (may be
 * undefined before the first fold) plus the verbatim tail after its watermark. */
export type TrajectoryRecall = {
  summary: CharacterSummary | undefined;
  tail: TrajectoryEntry[];
};

/**
 * Append one verbatim entry to a character's trajectory and return its assigned
 * `seq`. `turnNo` is the story turn currently being composed (the value the next
 * successful snapshot will get) so a later roll can prune it precisely;
 * `gameTime` is the in-game clock recorded for that action.
 */
export function appendCharacterTrajectory(
  db: RpDatabase,
  saveId: string,
  entry: { character: string; turnNo: number; content: string; gameTime: GameTime }
): number {
  const row = db
    .prepare("SELECT MAX(seq) AS seq FROM character_trajectories WHERE save_id = ? AND character = ?")
    .get(saveId, entry.character) as { seq: number | null } | undefined;
  const nextSeq = (row?.seq ?? 0) + 1;

  db.prepare(
    "INSERT INTO character_trajectories (save_id, character, turn_no, seq, content, game_day, game_hour, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(saveId, entry.character, entry.turnNo, nextSeq, entry.content, entry.gameTime.day, entry.gameTime.hour, new Date().toISOString());

  return nextSeq;
}

/** The current rolling summary for a character, or undefined if none folded yet. */
export function readCharacterSummary(db: RpDatabase, saveId: string, character: string): CharacterSummary | undefined {
  const row = db
    .prepare(
      "SELECT character, summary, covers_up_to_seq, last_day, last_hour, updated_at FROM character_summaries WHERE save_id = ? AND character = ?"
    )
    .get(saveId, character) as
    | { character: string; summary: string; covers_up_to_seq: number; last_day: number; last_hour: number; updated_at: string }
    | undefined;
  return row ? mapSummary(row) : undefined;
}

/**
 * The verbatim entries a character has produced after the summary watermark,
 * in chronological order (oldest → newest) — the "tail" not yet folded into the
 * rolling summary. Callers pass the current watermark (0 when no summary yet).
 */
export function readTrajectoryTail(
  db: RpDatabase,
  saveId: string,
  character: string,
  afterSeq: number
): TrajectoryEntry[] {
  const rows = db
    .prepare(
      "SELECT character, turn_no, seq, content, game_day, game_hour, created_at FROM character_trajectories WHERE save_id = ? AND character = ? AND seq > ? ORDER BY seq ASC"
    )
    .all(saveId, character, afterSeq) as Array<{
    character: string;
    turn_no: number;
    seq: number;
    content: string;
    game_day: number;
    game_hour: number;
    created_at: string;
  }>;
  return rows.map(mapEntry);
}

/**
 * Assemble a character's recall: the rolling summary plus the verbatim tail past
 * its watermark. This is the shape a fresh spawn re-injects to continue in
 * character. World-general knowledge and OV `characters` background are layered
 * on OUTSIDE this module (by the caller); this returns only the trajectory
 * layers.
 */
export function recallTrajectory(db: RpDatabase, saveId: string, character: string): TrajectoryRecall {
  const summary = readCharacterSummary(db, saveId, character);
  const tail = readTrajectoryTail(db, saveId, character, summary?.coversUpToSeq ?? 0);
  return { summary, tail };
}

/**
 * Store an author-written rolling summary (create or replace the single row for
 * this character). `coversUpToSeq` is the watermark: recall will show verbatim
 * entries with a greater seq. Callers MUST keep this below the current turn's
 * entries (see `maxSeqBeforeTurn`) so a roll can never contradict the summary.
 * `lastTime` records the in-game clock the summary now reaches.
 */
export function writeCharacterSummary(
  db: RpDatabase,
  saveId: string,
  summary: { character: string; summary: string; coversUpToSeq: number; lastTime: GameTime }
): void {
  db.prepare(
    `INSERT INTO character_summaries (save_id, character, summary, covers_up_to_seq, last_day, last_hour, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(save_id, character) DO UPDATE SET
       summary = excluded.summary,
       covers_up_to_seq = excluded.covers_up_to_seq,
       last_day = excluded.last_day,
       last_hour = excluded.last_hour,
       updated_at = excluded.updated_at`
  ).run(
    saveId,
    summary.character,
    summary.summary,
    summary.coversUpToSeq,
    summary.lastTime.day,
    summary.lastTime.hour,
    new Date().toISOString()
  );
}

/**
 * The largest `seq` for a character strictly before `turnNo`, or 0 if none —
 * the safe ceiling for a fold watermark. A summary must not cover the turn a
 * `/roll` could still undo, so callers clamp `coversUpToSeq` to this value.
 */
export function maxSeqBeforeTurn(db: RpDatabase, saveId: string, character: string, turnNo: number): number {
  const row = db
    .prepare("SELECT MAX(seq) AS seq FROM character_trajectories WHERE save_id = ? AND character = ? AND turn_no < ?")
    .get(saveId, character, turnNo) as { seq: number | null } | undefined;
  return row?.seq ?? 0;
}

/**
 * Delete every verbatim entry at/after `turnNo` for a save (across all
 * characters), returning how many rows were removed. Called when a `/roll` undoes
 * a turn. Summaries are untouched: their watermark is always kept below the
 * undoable turn, so no summary can reference a pruned entry.
 */
export function pruneTrajectoryFrom(db: RpDatabase, saveId: string, turnNo: number): number {
  const result = db
    .prepare("DELETE FROM character_trajectories WHERE save_id = ? AND turn_no >= ?")
    .run(saveId, turnNo);
  return Number(result.changes ?? 0);
}

function mapEntry(r: {
  character: string;
  turn_no: number;
  seq: number;
  content: string;
  game_day: number;
  game_hour: number;
  created_at: string;
}): TrajectoryEntry {
  return {
    character: r.character,
    turnNo: r.turn_no,
    seq: r.seq,
    content: r.content,
    gameDay: r.game_day,
    gameHour: r.game_hour,
    createdAt: r.created_at
  };
}

function mapSummary(r: {
  character: string;
  summary: string;
  covers_up_to_seq: number;
  last_day: number;
  last_hour: number;
  updated_at: string;
}): CharacterSummary {
  return {
    character: r.character,
    summary: r.summary,
    coversUpToSeq: r.covers_up_to_seq,
    lastDay: r.last_day,
    lastHour: r.last_hour,
    updatedAt: r.updated_at
  };
}
