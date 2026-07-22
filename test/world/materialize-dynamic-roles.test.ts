import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  materializeDynamicRoles,
  renderDynamicRoleMarkdown,
  RP_DYNAMIC_ROLE_MARKER
} from "../../src/world/materialize-dynamic-roles.ts";
import { RP_SUBAGENT_MARKER, ROLE_RUNTIME_EXTENSION_RELATIVE } from "../../src/world/materialize-subagents.ts";

const saveRepository = await import(
  pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href
);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const dynamicRoles = await import(pathToFileURL(new URL("../../src/state/dynamic-roles.ts", import.meta.url).pathname).href);

const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const upsertDynamicRole = dynamicRoles.upsertDynamicRole as typeof import("../../src/state/dynamic-roles.js").upsertDynamicRole;

test("renderDynamicRoleMarkdown produces a role-kind agent with base tools + runtime extension", () => {
  const md = renderDynamicRoleMarkdown("/proj", { name: "han-yue", description: "守门人", persona: "你是韩越。" });
  assert.match(md, new RegExp(RP_DYNAMIC_ROLE_MARKER));
  assert.match(md, /\nname: han-yue\n/);
  assert.match(md, /\ntools: recall_self, remember_action\n/);
  assert.match(md, new RegExp(`\\nsubagentOnlyExtensions: /proj/${ROLE_RUNTIME_EXTENSION_RELATIVE.replace(/\//g, "\\/")}\\n`));
  assert.match(md, /---\n\n你是韩越。/);
});

test("materialize writes the active save's forged roles and clears another save's on switch", () => {
  const root = mkdtempSync(join(tmpdir(), "dyn-proj-"));
  const db = openRpDatabase(join(root, "state.sqlite"));
  try {
    initializeSchema(db);
    const saveA = createSave(db);
    const saveB = createSave(db);
    upsertDynamicRole(db, saveA.id, { name: "role-a", description: "A", persona: "你是 A。" });
    upsertDynamicRole(db, saveB.id, { name: "role-b", description: "B", persona: "你是 B。" });

    const agentsDir = join(root, ".pi", "agents");

    const writtenA = materializeDynamicRoles(root, db, saveA.id);
    assert.deepEqual(writtenA, [join(agentsDir, "role-a.md")]);
    assert.ok(existsSync(join(agentsDir, "role-a.md")));

    // Switching to save B removes A's forged file and writes B's.
    const writtenB = materializeDynamicRoles(root, db, saveB.id);
    assert.deepEqual(writtenB, [join(agentsDir, "role-b.md")]);
    assert.ok(!existsSync(join(agentsDir, "role-a.md")), "other save's forged role cleared");
    assert.ok(existsSync(join(agentsDir, "role-b.md")));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("materialize applies per-role model settings to forged dynamic roles", () => {
  const root = mkdtempSync(join(tmpdir(), "dyn-proj-"));
  const db = openRpDatabase(join(root, "state.sqlite"));
  try {
    mkdirSync(join(root, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "agent", "settings.json"),
      JSON.stringify({
        rpSubagents: {
          "role-a": {
            provider: "opencode-go",
            model: "deepseek-v4-pro",
            thinking: "high"
          }
        }
      })
    );
    initializeSchema(db);
    const save = createSave(db);
    upsertDynamicRole(db, save.id, { name: "role-a", description: "A", persona: "你是 A。" });

    materializeDynamicRoles(root, db, save.id);

    const md = readFileSync(join(root, ".pi", "agents", "role-a.md"), "utf8");
    assert.match(md, /\nmodel: opencode-go\/deepseek-v4-pro\n/);
    assert.match(md, /\nthinking: high\n/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("materialize leaves world-static and hand-authored agents untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "dyn-proj-"));
  const db = openRpDatabase(join(root, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);
    upsertDynamicRole(db, save.id, { name: "forged", description: "f", persona: "你是被铸造者。" });

    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "writer.md"), "# Writer\n只返回正文。\n");
    writeFileSync(
      join(agentsDir, "npc-generator.md"),
      `---\n# ${RP_SUBAGENT_MARKER}\nname: npc-generator\ndescription: x\n---\nbody\n`
    );

    materializeDynamicRoles(root, db, save.id);

    assert.ok(existsSync(join(agentsDir, "writer.md")), "hand-authored preserved");
    assert.ok(existsSync(join(agentsDir, "npc-generator.md")), "world-static preserved");
    assert.ok(existsSync(join(agentsDir, "forged.md")), "forged role written");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forged role that would shadow a world-static agent is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "dyn-proj-"));
  const db = openRpDatabase(join(root, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);
    upsertDynamicRole(db, save.id, { name: "npc-generator", description: "clash", persona: "你是冲突者。" });

    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "npc-generator.md"),
      `---\n# ${RP_SUBAGENT_MARKER}\nname: npc-generator\ndescription: x\n---\nbody\n`
    );

    assert.throws(() => materializeDynamicRoles(root, db, save.id), /would overwrite/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
