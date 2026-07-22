import { randomUUID } from "node:crypto";

import type { RpDatabase } from "../state/sqlite.ts";

export function getOrCreateOvSessionForSave(db: RpDatabase, saveId: string): string {
  const existing = db
    .prepare("SELECT ov_session_id FROM ov_session_bindings WHERE save_id = ?")
    .get(saveId) as { ov_session_id: string } | undefined;

  if (existing) {
    return existing.ov_session_id;
  }

  const ovSessionId = randomUUID();
  db.prepare("INSERT INTO ov_session_bindings (save_id, ov_session_id, updated_at) VALUES (?, ?, ?)").run(
    saveId,
    ovSessionId,
    new Date().toISOString()
  );
  return ovSessionId;
}

export function replaceOvSessionForSave(db: RpDatabase, saveId: string): string {
  const ovSessionId = randomUUID();
  db.prepare(
    `
      INSERT INTO ov_session_bindings (save_id, ov_session_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(save_id) DO UPDATE SET
        ov_session_id = excluded.ov_session_id,
        updated_at = excluded.updated_at
    `
  ).run(saveId, ovSessionId, new Date().toISOString());
  return ovSessionId;
}
