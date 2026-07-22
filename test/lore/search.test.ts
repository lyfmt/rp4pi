import assert from "node:assert/strict";
import test from "node:test";

import { parseLoreEntries } from "../../src/lore/schema.ts";
import { formatLoreLookupResults, normalizeSearchText, searchLore } from "../../src/lore/search.ts";
import { replaceWorldLore } from "../../src/lore/sqlite.ts";
import { initializeSchema, openRpDatabase } from "../../src/state/sqlite.ts";

test("searchLore finds entries by aliases and multi terms", () => {
  const db = openRpDatabase(":memory:");
  try {
    initializeSchema(db);
    replaceWorldLore(
      db,
      "cultivation",
      [],
      parseLoreEntries([
        {
          id: "medicine.gathering-qi-pill",
          kind: "medicine",
          subtype: "pill",
          name: "聚气丹",
          aliases: ["聚灵丹"],
          summary: "辅助炼气修士聚拢灵气。",
          body: "适合炼气初中期。",
          tags: ["丹药", "炼气"],
          visibility: "public",
          fields: { grade: "一阶" },
          relations: [{ type: "usable_by", target: "rank.qi-refining" }]
        },
        {
          id: "location.border-relay",
          kind: "location",
          name: "北门驿站",
          summary: "边境交通要地。",
          tags: ["地点"]
        }
      ])
    );

    const results = searchLore(db, "cultivation", {
      query: "聚灵丹 炼气",
      kind: "medicine",
      limit: 5
    });

    assert.equal(results[0]?.id, "medicine.gathering-qi-pill");
    assert.match(results[0]?.reason ?? "", /别名|正文|标签/);
  } finally {
    db.close();
  }
});

test("formatLoreLookupResults omits full body text", () => {
  const output = formatLoreLookupResults([
    {
      id: "medicine.gathering-qi-pill",
      kind: "medicine",
      name: "聚气丹",
      summary: "辅助炼气修士聚拢灵气。",
      reason: "别名精确匹配",
      score: 104
    }
  ]);

  assert.match(output, /### \[medicine\] 聚气丹 - medicine\.gathering-qi-pill（别名精确匹配）/);
  assert.match(output, /辅助炼气修士聚拢灵气。/);
  assert.doesNotMatch(output, /适合炼气初中期/);
});

test("normalizeSearchText folds punctuation and whitespace", () => {
  assert.equal(normalizeSearchText(" Qi-Refining（初期）. "), "qirefining初期");
});
