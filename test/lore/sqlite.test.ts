import assert from "node:assert/strict";
import test from "node:test";

import { parseLoreEntries } from "../../src/lore/schema.ts";
import { getLoreEntry, listLoreEntries, replaceWorldLore, searchLoreRows } from "../../src/lore/sqlite.ts";
import { initializeSchema, openRpDatabase } from "../../src/state/sqlite.ts";

test("initializeSchema creates lore tables", () => {
  const db = openRpDatabase(":memory:");
  try {
    initializeSchema(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    assert.ok(names.some((row) => row.name === "lore_entries"));
    assert.ok(names.some((row) => row.name === "lore_aliases"));
    assert.ok(names.some((row) => row.name === "lore_relations"));
    assert.ok(names.some((row) => row.name === "lore_search_index"));
    assert.ok(names.some((row) => row.name === "lore_sources"));
  } finally {
    db.close();
  }
});

test("replaceWorldLore stores and replaces one world's lore", () => {
  const db = openRpDatabase(":memory:");
  try {
    initializeSchema(db);
    const source = { path: "/world/lore/medicines.yaml", contentHash: "hash-a" };
    const entries = parseLoreEntries([
      {
        id: "medicine.gathering-qi-pill",
        kind: "medicine",
        subtype: "pill",
        name: "聚气丹",
        aliases: ["聚灵丹"],
        summary: "辅助炼气修士聚拢灵气。",
        body: "适合炼气初中期。",
        tags: ["丹药", "炼气"],
        fields: { grade: "一阶" },
        relations: [{ type: "usable_by", target: "rank.qi-refining", note: "炼气期" }],
        sourcePath: source.path
      }
    ]);

    replaceWorldLore(db, "cultivation", [source], entries);
    replaceWorldLore(db, "other-world", [source], [{ ...entries[0]!, id: "medicine.other", name: "异界丹" }]);

    const entry = getLoreEntry(db, "cultivation", "medicine.gathering-qi-pill");
    assert.equal(entry?.name, "聚气丹");
    assert.deepEqual(entry?.aliases, ["聚灵丹"]);
    assert.deepEqual(entry?.relations, [{ type: "usable_by", target: "rank.qi-refining", note: "炼气期" }]);
    assert.deepEqual(entry?.fields, { grade: "一阶" });
    assert.equal(listLoreEntries(db, "cultivation").length, 1);
    assert.equal(listLoreEntries(db, "other-world").length, 1);

    replaceWorldLore(db, "cultivation", [], []);
    assert.equal(listLoreEntries(db, "cultivation").length, 0);
    assert.equal(listLoreEntries(db, "other-world").length, 1);
  } finally {
    db.close();
  }
});

test("searchLoreRows returns rows with indexed text", () => {
  const db = openRpDatabase(":memory:");
  try {
    initializeSchema(db);
    const entries = parseLoreEntries([
      {
        id: "character.han-yue",
        kind: "character",
        name: "韩越",
        aliases: ["受伤信使"],
        summary: "携带密信的边关信使。",
        tags: ["信使"],
        sourcePath: "/world/lore/characters.yaml"
      }
    ]);
    replaceWorldLore(db, "border-station", [{ path: "/world/lore/characters.yaml", contentHash: "hash-a" }], entries);

    const rows = searchLoreRows(db, "border-station");
    assert.equal(rows[0]?.id, "character.han-yue");
    assert.match(rows[0]?.normalizedText ?? "", /韩越/);
    assert.match(rows[0]?.normalizedText ?? "", /受伤信使/);
  } finally {
    db.close();
  }
});
