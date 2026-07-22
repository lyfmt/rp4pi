import type { RpDatabase } from "./sqlite.ts";

export type SaveRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export function createSave(db: RpDatabase): SaveRecord {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  db.prepare("INSERT INTO saves (id, created_at, updated_at) VALUES (?, ?, ?)").run(id, now, now);

  return {
    id,
    createdAt: now,
    updatedAt: now
  };
}

export function touchSave(db: RpDatabase, saveId: string): void {
  db.prepare("UPDATE saves SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), saveId);
}

export function listSaves(db: RpDatabase): SaveRecord[] {
  const rows = db.prepare("SELECT id, created_at, updated_at FROM saves ORDER BY updated_at DESC").all() as Array<{
    id: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}
