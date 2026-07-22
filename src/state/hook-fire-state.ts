import type { HookFirePoint } from "../hooks/cadence.ts";
import type { RpDatabase } from "./sqlite.ts";

// Per-(save, hook) record of when a hook last fired, so a cadence gate
// (`every: { turns / gameHours / gameDays }`) survives reloads and roll-backs.
// Deliberately separate from state snapshots: the fire-state is engine
// bookkeeping, not part of the story the player can roll back — a `/roll` that
// rewinds the clock does NOT rewind a hook's cadence, which would otherwise let a
// once-per-day hook re-fire on every undo. `fire_count` is a monotone counter
// exposed for logs / future "fire only the first N times" gates.

export type HookFireRecord = HookFirePoint & { fireCount: number };

/** Read the last fire point for a hook in a save, or undefined if never fired. */
export function readHookFireState(db: RpDatabase, saveId: string, hookName: string): HookFireRecord | undefined {
  const row = db
    .prepare("SELECT last_turn, last_day, last_hour, fire_count FROM hook_fire_state WHERE save_id = ? AND hook_name = ?")
    .get(saveId, hookName) as { last_turn: number; last_day: number; last_hour: number; fire_count: number } | undefined;
  if (!row) {
    return undefined;
  }
  return { lastTurn: row.last_turn, lastDay: row.last_day, lastHour: row.last_hour, fireCount: row.fire_count };
}

/** Record that a hook fired now (turn + in-game clock), bumping its fire count. */
export function recordHookFire(
  db: RpDatabase,
  saveId: string,
  hookName: string,
  at: { turn: number; day: number; hour: number }
): void {
  db.prepare(
    `INSERT INTO hook_fire_state (save_id, hook_name, last_turn, last_day, last_hour, fire_count, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(save_id, hook_name) DO UPDATE SET
       last_turn = excluded.last_turn,
       last_day = excluded.last_day,
       last_hour = excluded.last_hour,
       fire_count = hook_fire_state.fire_count + 1,
       updated_at = excluded.updated_at`
  ).run(saveId, hookName, at.turn, at.day, at.hour, new Date().toISOString());
}
