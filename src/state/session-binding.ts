import type { RpDatabase } from "./sqlite.ts";

export function bindSessionToSave(db: RpDatabase, piSessionId: string, saveId: string): void {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO session_bindings (pi_session_id, save_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(pi_session_id) DO UPDATE SET
      save_id = excluded.save_id,
      updated_at = excluded.updated_at
  `).run(piSessionId, saveId, now);
}

export function getBoundSave(db: RpDatabase, piSessionId: string): string | undefined {
  const row = db
    .prepare("SELECT save_id FROM session_bindings WHERE pi_session_id = ?")
    .get(piSessionId) as { save_id: string } | undefined;

  return row?.save_id;
}
