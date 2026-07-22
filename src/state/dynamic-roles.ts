import type { RpDatabase } from "./sqlite.ts";
import { SystemRuntimeError } from "../systems/errors.ts";

// GM-forged role subagents: characters invented DURING play (not declared in the
// world pack) so a game can keep growing its cast. Each row is the persistent
// truth for one such role, scoped to the save that created it — the save that
// forged a character is the only one where it can be re-materialized and played,
// mirroring how its trajectory is save+character scoped (see trajectory.ts).
//
// The `.pi/agents/<name>.md` file pi-subagents discovers is a PROJECTION of this
// table, not the source of truth: it is rewritten from here whenever a save is
// activated (materialize-dynamic-roles.ts), so switching saves never leaves
// another save's forged roles discoverable, and a fresh clone/checkout rebuilds
// them from the db.

export type DynamicRole = {
  name: string;
  description: string;
  persona: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Create or update a forged role for a save. Idempotent on (save, name): a
 * re-forge of the same name refreshes description/persona and preserves the
 * original created_at, so a GM can revise a character without losing its
 * identity (its trajectory keys on the same name).
 */
export function upsertDynamicRole(
  db: RpDatabase,
  saveId: string,
  role: { name: string; description: string; persona: string }
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO dynamic_roles (save_id, name, description, persona, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(save_id, name) DO UPDATE SET
       description = excluded.description,
       persona = excluded.persona,
       updated_at = excluded.updated_at`
  ).run(saveId, role.name, role.description, role.persona, now, now);
}

/** All forged roles for a save, in creation order. */
export function listDynamicRoles(db: RpDatabase, saveId: string): DynamicRole[] {
  const rows = db
    .prepare(
      "SELECT name, description, persona, created_at, updated_at FROM dynamic_roles WHERE save_id = ? ORDER BY created_at ASC, name ASC"
    )
    .all(saveId) as Array<{ name: string; description: string; persona: string; created_at: string; updated_at: string }>;
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    persona: r.persona,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

/** One forged role, or undefined if this save has none by that name. */
export function readDynamicRole(db: RpDatabase, saveId: string, name: string): DynamicRole | undefined {
  const row = db
    .prepare("SELECT name, description, persona, created_at, updated_at FROM dynamic_roles WHERE save_id = ? AND name = ?")
    .get(saveId, name) as
    | { name: string; description: string; persona: string; created_at: string; updated_at: string }
    | undefined;
  return row
    ? { name: row.name, description: row.description, persona: row.persona, createdAt: row.created_at, updatedAt: row.updated_at }
    : undefined;
}

/** Replace the complete forged-role participant. The caller owns the transaction. */
export function replaceDynamicRoles(
  db: RpDatabase,
  saveId: string,
  roles: readonly DynamicRole[]
): void {
  validateDynamicRolesSnapshot(roles);

  db.prepare("DELETE FROM dynamic_roles WHERE save_id = ?").run(saveId);
  const insert = db.prepare(
    `INSERT INTO dynamic_roles (save_id, name, description, persona, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const role of roles) {
    insert.run(
      saveId,
      role.name,
      role.description,
      role.persona,
      role.createdAt,
      role.updatedAt
    );
  }
}

export function validateDynamicRolesSnapshot(roles: readonly DynamicRole[]): void {
  if (!Array.isArray(roles)) {
    incompatibleRoles("roles must be an array");
  }
  const names = new Set<string>();
  for (const [index, role] of roles.entries()) {
    if (
      typeof role !== "object" ||
      role === null ||
      typeof role.name !== "string" ||
      typeof role.description !== "string" ||
      typeof role.persona !== "string" ||
      typeof role.createdAt !== "string" ||
      typeof role.updatedAt !== "string"
    ) {
      incompatibleRoles(`role ${index} is invalid`);
    }
    if (names.has(role.name)) {
      incompatibleRoles(`duplicate role name: ${role.name}`);
    }
    names.add(role.name);
  }
}

function incompatibleRoles(reason: string): never {
  throw new SystemRuntimeError("SNAPSHOT_INCOMPATIBLE", {
    participant: "dynamicRoles",
    reason
  });
}
