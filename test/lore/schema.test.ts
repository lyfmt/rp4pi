import assert from "node:assert/strict";
import test from "node:test";

import { parseLoreEntries } from "../../src/lore/schema.ts";

test("parseLoreEntries accepts generic lore entries", () => {
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
      visibility: "public",
      fields: { grade: "一阶" },
      relations: [{ type: "usable_by", target: "rank.qi-refining" }]
    }
  ]);

  assert.equal(entries[0]?.id, "medicine.gathering-qi-pill");
  assert.deepEqual(entries[0]?.aliases, ["聚灵丹"]);
});

test("parseLoreEntries fills defaults", () => {
  const entries = parseLoreEntries([
    {
      id: "location.border-relay",
      kind: "location",
      name: "北门驿站",
      summary: "边境交通要地。"
    }
  ]);

  assert.deepEqual(entries[0], {
    id: "location.border-relay",
    kind: "location",
    name: "北门驿站",
    aliases: [],
    summary: "边境交通要地。",
    body: "",
    tags: [],
    visibility: "public",
    fields: {},
    relations: []
  });
});

test("parseLoreEntries rejects invalid entries", () => {
  assert.throws(() => parseLoreEntries([{ id: "", kind: "character", name: "A", summary: "S" }]), /id/);
  assert.throws(
    () =>
      parseLoreEntries([
        {
          id: "character.a",
          kind: "character",
          name: "A",
          summary: "S",
          aliases: ["A", 1]
        }
      ]),
    /aliases/
  );
  assert.throws(
    () =>
      parseLoreEntries([
        {
          id: "character.a",
          kind: "character",
          name: "A",
          summary: "S",
          relations: [{ type: "knows", target: 1 }]
        }
      ]),
    /relations/
  );
});
