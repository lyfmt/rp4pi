import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import type { RpDatabase } from "../state/sqlite.ts";
import type { WorldLoreConfig } from "../world/schema.ts";
import { parseLoreEntries, type LoreEntry } from "./schema.ts";
import { replaceWorldLore, type LoreSourceRecord } from "./sqlite.ts";

export type LoreImportWorld = {
  name: string;
  lore: WorldLoreConfig;
};

export function importWorldLore(db: RpDatabase, world: LoreImportWorld): void {
  const sources: LoreSourceRecord[] = [];
  const entries: LoreEntry[] = [];
  const seenIds = new Set<string>();

  for (const source of world.lore.sources) {
    const content = readFileSync(source.path, "utf8");
    sources.push({ path: source.path, contentHash: hashContent(content) });

    for (const entry of parseSourceEntries(content, source.path, source.defaultKind)) {
      if (seenIds.has(entry.id)) {
        throw new Error(`Duplicate lore id "${entry.id}" in world "${world.name}".`);
      }
      seenIds.add(entry.id);
      entries.push(entry);
    }
  }

  replaceWorldLore(db, world.name, sources, entries);
}

function parseSourceEntries(content: string, sourcePath: string, defaultKind: string | undefined): LoreEntry[] {
  const parsed = parseYaml(content) as unknown;
  const rawEntries = Array.isArray(parsed) ? parsed : parseEntriesObject(parsed, sourcePath);
  const prepared = rawEntries.map((entry, index) => prepareEntry(entry, defaultKind, sourcePath, index));
  return parseLoreEntries(prepared);
}

function parseEntriesObject(value: unknown, sourcePath: string): unknown[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Lore source ${sourcePath} must contain a list or an object with entries.`);
  }
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(`Lore source ${sourcePath} field entries must be a list.`);
  }
  return entries;
}

function prepareEntry(entry: unknown, defaultKind: string | undefined, sourcePath: string, index: number): Record<string, unknown> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`Lore source ${sourcePath} entry ${index} must be an object.`);
  }
  const record = { ...(entry as Record<string, unknown>) };
  if ((record.kind === undefined || record.kind === null) && defaultKind !== undefined) {
    record.kind = defaultKind;
  }
  record.sourcePath = sourcePath;
  return record;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
