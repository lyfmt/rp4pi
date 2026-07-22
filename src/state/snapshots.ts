import type { RpDatabase } from "./sqlite.ts";

/** The latest committed story turn number for a save, or 0 if none. This is the
 * turn a `/roll` undoes, and `MAX + 1` is the turn currently being composed —
 * the value a role tags its in-progress actions with (see `trajectory.ts`). */
export function latestStorySnapshotTurnNo(db: RpDatabase, saveId: string): number {
  const row = db.prepare("SELECT MAX(turn_no) AS turn_no FROM turn_snapshots WHERE save_id = ?").get(saveId) as
    | { turn_no: number | null }
    | undefined;
  return row?.turn_no ?? 0;
}
