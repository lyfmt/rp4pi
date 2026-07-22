import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInitialState, parseState } from "../../src/state/schema.ts";
import { createStateStore } from "../../src/state/store.ts";
import { initializeSchema, openRpDatabase } from "../../src/state/sqlite.ts";
import { createSave } from "../../src/state/save-repository.ts";
import { updateAttributeTool } from "../../src/tools/state/update-attribute.ts";
import type { AttributeSpec } from "../../src/world/schema.ts";

const VIGOR: AttributeSpec = { kind: "int", name: "vigor", initial: 80, min: 0, max: 100 };

test("createInitialState seeds declared attributes", () => {
  const state = createInitialState({}, [VIGOR]);
  assert.equal(state.attributes.vigor, 80);
});

test("old saves without attributes hydrate as empty map", () => {
  const legacy = parseState({
    player: { name: "a", status: "b", location: "c" },
    time: { day: 1, hour: 8 },
    scene: { summary: "s" }
  });
  assert.deepEqual(legacy.attributes, {});
});

test("update_attribute writes a declared attribute within bounds", () => {
  const { db, store, saveId, cleanup } = freshStore();
  try {
    store.replaceState(saveId, createInitialState({}, [VIGOR]));
    const ctx = { db, stateStore: store, attributeSpecs: [VIGOR] } as unknown;
    const result = updateAttributeTool.execute("id", { name: "vigor", value: 55 }, undefined, undefined, ctx as never);
    assert.match((result as { content: { text: string }[] }).content[0].text, /vigor = 55/);
    assert.equal(store.getState().attributes.vigor, 55);
  } finally {
    cleanup();
  }
});

test("update_attribute rejects unknown attribute and out-of-range value", () => {
  const { db, store, saveId, cleanup } = freshStore();
  try {
    store.replaceState(saveId, createInitialState({}, [VIGOR]));
    const ctx = { db, stateStore: store, attributeSpecs: [VIGOR] } as unknown;
    assert.throws(
      () => updateAttributeTool.execute("id", { name: "karma", value: 1 }, undefined, undefined, ctx as never),
      /未知属性/
    );
    assert.throws(
      () => updateAttributeTool.execute("id", { name: "vigor", value: 999 }, undefined, undefined, ctx as never),
      /不能大于 100/
    );
  } finally {
    cleanup();
  }
});

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "attr-"));
  const db = openRpDatabase(join(dir, "t.sqlite"));
  initializeSchema(db);
  const store = createStateStore(db);
  const save = createSave(db);
  return {
    db,
    store,
    saveId: save.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
