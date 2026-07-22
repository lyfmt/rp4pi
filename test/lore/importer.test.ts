import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { importWorldLore } from "../../src/lore/importer.ts";
import { getLoreEntry, listLoreEntries } from "../../src/lore/sqlite.ts";
import { initializeSchema, openRpDatabase } from "../../src/state/sqlite.ts";

test("importWorldLore loads yaml sources into sqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "lore-import-"));
  const db = openRpDatabase(":memory:");
  try {
    initializeSchema(db);
    const medicinesYaml = join(dir, "medicines.yaml");
    writeFileSync(
      medicinesYaml,
      [
        "entries:",
        "  - id: medicine.gathering-qi-pill",
        "    name: 聚气丹",
        "    aliases: [聚灵丹]",
        "    summary: 辅助炼气修士聚拢灵气。",
        "    body: 适合炼气初中期。",
        "    tags: [丹药, 炼气]",
        "    fields: { grade: 一阶 }",
        "    relations:",
        "      - type: usable_by",
        "        target: rank.qi-refining",
        ""
      ].join("\n")
    );

    importWorldLore(db, {
      name: "cultivation",
      lore: { sources: [{ path: medicinesYaml, defaultKind: "medicine" }] }
    });

    const entry = getLoreEntry(db, "cultivation", "medicine.gathering-qi-pill");
    assert.equal(entry?.kind, "medicine");
    assert.equal(entry?.name, "聚气丹");
    assert.equal(entry?.sourcePath, medicinesYaml);
    assert.equal(listLoreEntries(db, "cultivation").length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importWorldLore rejects duplicate ids in one world", () => {
  const dir = mkdtempSync(join(tmpdir(), "lore-import-"));
  const db = openRpDatabase(":memory:");
  try {
    initializeSchema(db);
    const first = join(dir, "first.yaml");
    const second = join(dir, "second.yaml");
    const body = "- id: character.same\n  kind: character\n  name: Same\n  summary: Same.\n";
    writeFileSync(first, body);
    writeFileSync(second, body);

    assert.throws(
      () =>
        importWorldLore(db, {
          name: "demo",
          lore: { sources: [{ path: first }, { path: second }] }
        }),
      /Duplicate lore id "character.same"/
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
