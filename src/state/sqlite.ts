import { DatabaseSync } from "node:sqlite";

import type { RpState } from "./schema.ts";

export type RpDatabase = DatabaseSync;

export function openRpDatabase(path: string): RpDatabase {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function initializeSchema(db: RpDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saves (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_bindings (
      pi_session_id TEXT PRIMARY KEY,
      save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ov_session_bindings (
      save_id TEXT PRIMARY KEY REFERENCES saves(id) ON DELETE CASCADE,
      ov_session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS latest_states (
      save_id TEXT PRIMARY KEY REFERENCES saves(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_states (
      save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
      system_name TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (save_id, system_name)
    );

    CREATE TABLE IF NOT EXISTS system_save_revisions (
      save_id TEXT PRIMARY KEY REFERENCES saves(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      branch_epoch INTEGER NOT NULL CHECK(branch_epoch >= 0)
    );

    CREATE TABLE IF NOT EXISTS system_commit_receipts (
      save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
      branch_epoch INTEGER NOT NULL CHECK(branch_epoch >= 0),
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (save_id, branch_epoch, request_id)
    );

    CREATE TABLE IF NOT EXISTS turn_snapshots (
      save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
      turn_no INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (save_id, turn_no)
    );

    CREATE TABLE IF NOT EXISTS character_trajectories (
      save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
      character TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      content TEXT NOT NULL,
      game_day INTEGER NOT NULL,
      game_hour INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (save_id, character, seq)
    );

    CREATE TABLE IF NOT EXISTS character_summaries (
      save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
      character TEXT NOT NULL,
      summary TEXT NOT NULL,
      covers_up_to_seq INTEGER NOT NULL,
      last_day INTEGER NOT NULL,
      last_hour INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (save_id, character)
    );

    CREATE TABLE IF NOT EXISTS dynamic_roles (
      save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      persona TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (save_id, name)
    );

    CREATE TABLE IF NOT EXISTS hook_fire_state (
      save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
      hook_name TEXT NOT NULL,
      last_turn INTEGER NOT NULL,
      last_day INTEGER NOT NULL,
      last_hour INTEGER NOT NULL,
      fire_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (save_id, hook_name)
    );

    CREATE TABLE IF NOT EXISTS lore_entries (
      world_name TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subtype TEXT,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      visibility TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (world_name, id)
    );

    CREATE TABLE IF NOT EXISTS lore_aliases (
      world_name TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      PRIMARY KEY (world_name, entry_id, alias)
    );

    CREATE TABLE IF NOT EXISTS lore_relations (
      world_name TEXT NOT NULL,
      from_entry_id TEXT NOT NULL,
      type TEXT NOT NULL,
      to_entry_id TEXT NOT NULL,
      note TEXT NOT NULL,
      PRIMARY KEY (world_name, from_entry_id, type, to_entry_id)
    );

    CREATE TABLE IF NOT EXISTS lore_search_index (
      world_name TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      token_text TEXT NOT NULL,
      PRIMARY KEY (world_name, entry_id)
    );

    CREATE TABLE IF NOT EXISTS lore_sources (
      world_name TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (world_name, path)
    );
  `);
  migrateSchema(db);
}

function migrateSchema(db: RpDatabase): void {
  ensureColumn(db, "character_trajectories", "game_day", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "character_trajectories", "game_hour", "INTEGER NOT NULL DEFAULT 8");
}

function ensureColumn(db: RpDatabase, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function writeLatestState(db: RpDatabase, saveId: string, state: RpState): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO latest_states (save_id, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(save_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `).run(saveId, JSON.stringify(state), now);
}

export function readLatestState(db: RpDatabase, saveId: string): RpState | undefined {
  const row = db
    .prepare("SELECT state_json FROM latest_states WHERE save_id = ?")
    .get(saveId) as { state_json: string } | undefined;

  if (!row) {
    return undefined;
  }

  return JSON.parse(row.state_json) as RpState;
}
