import type { RpDatabase } from "../state/sqlite.ts";
import type { LoreEntry, LoreRelation, LoreVisibility } from "./schema.ts";

export type LoreSourceRecord = {
  path: string;
  contentHash: string;
};

export type LoreSearchRow = LoreEntry & {
  normalizedText: string;
  tokenText: string;
};

type LoreEntryRow = {
  id: string;
  kind: string;
  subtype: string | null;
  name: string;
  summary: string;
  body: string;
  tags_json: string;
  fields_json: string;
  visibility: LoreVisibility;
  source_path: string;
};

export function replaceWorldLore(db: RpDatabase, worldName: string, sources: LoreSourceRecord[], entries: LoreEntry[]): void {
  const now = new Date().toISOString();
  const sourceHashByPath = new Map(sources.map((source) => [source.path, source.contentHash]));

  db.exec("BEGIN");
  try {
    for (const table of ["lore_search_index", "lore_relations", "lore_aliases", "lore_entries", "lore_sources"]) {
      db.prepare(`DELETE FROM ${table} WHERE world_name = ?`).run(worldName);
    }

    const insertSource = db.prepare(`
      INSERT INTO lore_sources (world_name, path, content_hash, imported_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const source of sources) {
      insertSource.run(worldName, source.path, source.contentHash, now);
    }

    const insertEntry = db.prepare(`
      INSERT INTO lore_entries (
        world_name, id, kind, subtype, name, summary, body, tags_json, fields_json,
        visibility, source_path, source_hash, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAlias = db.prepare(`
      INSERT INTO lore_aliases (world_name, entry_id, alias, normalized_alias)
      VALUES (?, ?, ?, ?)
    `);
    const insertRelation = db.prepare(`
      INSERT INTO lore_relations (world_name, from_entry_id, type, to_entry_id, note)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertSearch = db.prepare(`
      INSERT INTO lore_search_index (world_name, entry_id, normalized_text, token_text)
      VALUES (?, ?, ?, ?)
    `);

    for (const entry of entries) {
      const sourcePath = entry.sourcePath ?? "";
      insertEntry.run(
        worldName,
        entry.id,
        entry.kind,
        entry.subtype ?? null,
        entry.name,
        entry.summary,
        entry.body,
        JSON.stringify(entry.tags),
        JSON.stringify(entry.fields),
        entry.visibility,
        sourcePath,
        sourceHashByPath.get(sourcePath) ?? "",
        now
      );

      for (const alias of entry.aliases) {
        insertAlias.run(worldName, entry.id, alias, normalizeText(alias));
      }

      for (const relation of entry.relations) {
        insertRelation.run(worldName, entry.id, relation.type, relation.target, relation.note ?? "");
      }

      const normalizedText = buildNormalizedText(entry);
      insertSearch.run(worldName, entry.id, normalizedText, normalizedText);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getLoreEntry(db: RpDatabase, worldName: string, id: string): LoreEntry | undefined {
  const row = db.prepare("SELECT * FROM lore_entries WHERE world_name = ? AND id = ?").get(worldName, id) as LoreEntryRow | undefined;
  if (!row) {
    return undefined;
  }
  return hydrateLoreEntry(db, worldName, row);
}

export function listLoreEntries(db: RpDatabase, worldName: string): LoreEntry[] {
  const rows = db.prepare("SELECT * FROM lore_entries WHERE world_name = ? ORDER BY kind, name, id").all(worldName) as LoreEntryRow[];
  return rows.map((row) => hydrateLoreEntry(db, worldName, row));
}

export function searchLoreRows(db: RpDatabase, worldName: string): LoreSearchRow[] {
  const rows = db
    .prepare(
      `
        SELECT e.*, i.normalized_text, i.token_text
        FROM lore_entries e
        JOIN lore_search_index i ON i.world_name = e.world_name AND i.entry_id = e.id
        WHERE e.world_name = ?
        ORDER BY e.kind, e.name, e.id
      `
    )
    .all(worldName) as Array<LoreEntryRow & { normalized_text: string; token_text: string }>;

  return rows.map((row) => ({
    ...hydrateLoreEntry(db, worldName, row),
    normalizedText: row.normalized_text,
    tokenText: row.token_text
  }));
}

function hydrateLoreEntry(db: RpDatabase, worldName: string, row: LoreEntryRow): LoreEntry {
  const aliases = db
    .prepare("SELECT alias FROM lore_aliases WHERE world_name = ? AND entry_id = ? ORDER BY alias")
    .all(worldName, row.id)
    .map((aliasRow) => (aliasRow as { alias: string }).alias);
  const relations = db
    .prepare("SELECT type, to_entry_id, note FROM lore_relations WHERE world_name = ? AND from_entry_id = ? ORDER BY type, to_entry_id")
    .all(worldName, row.id)
    .map((relationRow) => hydrateRelation(relationRow as { type: string; to_entry_id: string; note: string }));

  const entry: LoreEntry = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    aliases,
    summary: row.summary,
    body: row.body,
    tags: JSON.parse(row.tags_json) as string[],
    visibility: row.visibility,
    fields: JSON.parse(row.fields_json) as Record<string, unknown>,
    relations,
    sourcePath: row.source_path
  };
  if (row.subtype) {
    entry.subtype = row.subtype;
  }
  return entry;
}

function hydrateRelation(row: { type: string; to_entry_id: string; note: string }): LoreRelation {
  const relation: LoreRelation = {
    type: row.type,
    target: row.to_entry_id
  };
  if (row.note) {
    relation.note = row.note;
  }
  return relation;
}

function buildNormalizedText(entry: LoreEntry): string {
  return normalizeText(
    [
      entry.id,
      entry.kind,
      entry.subtype ?? "",
      entry.name,
      ...entry.aliases,
      entry.summary,
      entry.body,
      ...entry.tags,
      JSON.stringify(entry.fields),
      ...entry.relations.flatMap((relation) => [relation.type, relation.target, relation.note ?? ""])
    ].join(" ")
  );
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}
