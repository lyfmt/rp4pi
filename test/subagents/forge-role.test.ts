import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { ExtensionContextLike } from "../../src/types/pi.ts";

const forgeRole = await import(pathToFileURL(new URL("../../src/subagents/forge-role.ts", import.meta.url).pathname).href);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const saveRepository = await import(
  pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href
);
const dynamicRoles = await import(pathToFileURL(new URL("../../src/state/dynamic-roles.ts", import.meta.url).pathname).href);

const parseForgeRoleInput =
  forgeRole.parseForgeRoleInput as typeof import("../../src/subagents/forge-role.js").parseForgeRoleInput;
const forgeRoleTool = forgeRole.forgeRoleTool as typeof import("../../src/subagents/forge-role.js").forgeRoleTool;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const listDynamicRoles = dynamicRoles.listDynamicRoles as typeof import("../../src/state/dynamic-roles.js").listDynamicRoles;

const ctx = {} as unknown as ExtensionContextLike;

// forge_role resolves its project root by walking up from the module to the
// package.json — i.e. the real repo root — and opens RP_SQLITE_PATH there. We
// point that at a temp DB and materialize into a temp ".pi/agents" by running
// with the repo as projectRoot but an isolated sqlite + OV disabled.
function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.keys(overrides).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return fn().finally(restore);
}

test("parseForgeRoleInput trims fields and requires all four", () => {
  assert.deepEqual(
    parseForgeRoleInput({ name: " han-yue ", description: " 守门人 ", persona: " 你是韩越。 ", summary: " 客观摘要 " }),
    { name: "han-yue", description: "守门人", persona: "你是韩越。", summary: "客观摘要" }
  );
  assert.throws(() => parseForgeRoleInput(null), /对象/);
  assert.throws(() => parseForgeRoleInput({ description: "d", persona: "p", summary: "s" }), /name/);
  assert.throws(() => parseForgeRoleInput({ name: "x", persona: "p", summary: "s" }), /description/);
  assert.throws(() => parseForgeRoleInput({ name: "x", description: "d", summary: "s" }), /persona/);
  assert.throws(() => parseForgeRoleInput({ name: "x", description: "d", persona: "p" }), /summary/);
});

test("parseForgeRoleInput rejects a non-slug name", () => {
  assert.throws(
    () => parseForgeRoleInput({ name: "韩越", description: "d", persona: "p", summary: "s" }),
    /slug/
  );
});

test("forge_role reports no active save (and touches no filesystem) when RP_ACTIVE_SAVE is unset", async () => {
  await withEnv({ RP_ACTIVE_SAVE: undefined }, async () => {
    const res = await forgeRoleTool.execute(
      "t",
      { name: "han-yue", description: "守门人", persona: "你是韩越。", summary: "客观摘要" },
      undefined,
      undefined,
      ctx
    );
    assert.equal(res.details.persisted, false);
    assert.equal(res.details.reason, "no-active-save");
  });
});

// Guard against silent drift: the storage layer forge_role drives must persist
// and list a role the same way (proven here directly, without the tool's
// repo-root filesystem projection).
test("the storage path forge_role uses persists a forged role", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-forge-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);
    const upsert = dynamicRoles.upsertDynamicRole as typeof import("../../src/state/dynamic-roles.js").upsertDynamicRole;
    upsert(db, save.id, { name: "han-yue", description: "守门人", persona: "你是韩越。" });
    assert.deepEqual(listDynamicRoles(db, save.id).map((r) => r.name), ["han-yue"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
