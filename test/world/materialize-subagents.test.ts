import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  materializeWorldSubagents,
  NO_TOOLS_SENTINEL,
  renderSubagentMarkdown,
  ROLE_RUNTIME_EXTENSION_RELATIVE,
  RP_SUBAGENT_MARKER
} from "../../src/world/materialize-subagents.ts";
import type { LoadedWorld, SubagentSpec } from "../../src/world/schema.ts";

// materialize only reads world.name + world.subagents; a partial cast keeps the
// tests focused on this unit without assembling a whole world pack.
function makeWorld(name: string, subagents: SubagentSpec[]): LoadedWorld {
  return { name, subagents } as unknown as LoadedWorld;
}

// Build a spec whose persona file actually exists under `dir` (materialize
// reads it). Override any field; `persona` sets the agent.md body.
function spec(dir: string, over: Partial<SubagentSpec> & { name: string; persona?: string }): SubagentSpec {
  const promptPath = over.promptPath ?? join(dir, `${over.name}.persona.md`);
  writeFileSync(promptPath, over.persona ?? `# ${over.name}\nYou are ${over.name}.\n`);
  return {
    name: over.name,
    kind: over.kind ?? "tool",
    description: over.description ?? `desc for ${over.name}`,
    model: over.model,
    thinking: over.thinking,
    tools: over.tools ?? [],
    promptPath,
    extensionPath: over.extensionPath
  };
}

test("renders pi-subagents frontmatter with declared fields and persona body", () => {
  const dir = mkdtempSync(join(tmpdir(), "mat-"));
  try {
    const s = spec(dir, {
      name: "npc-generator",
      description: "Forge a new NPC.",
      model: "opencode-go/deepseek-v4-pro",
      thinking: "high",
      tools: ["forge_character", "read"],
      extensionPath: "/abs/ext/index.ts",
      persona: "# NPC Generator\nForge NPCs.\n"
    });
    const md = renderSubagentMarkdown(s, "border-station");
    assert.ok(md.startsWith("---\n"));
    assert.match(md, new RegExp(RP_SUBAGENT_MARKER));
    assert.match(md, /\nname: npc-generator\n/);
    assert.match(md, /\ndescription: Forge a new NPC\.\n/);
    assert.match(md, /\nmodel: opencode-go\/deepseek-v4-pro\n/);
    assert.match(md, /\nthinking: high\n/);
    assert.match(md, /\ntools: forge_character, read\n/);
    assert.match(md, /\nsubagentOnlyExtensions: \/abs\/ext\/index\.ts\n/);
    assert.match(md, /\nsystemPromptMode: replace\n/);
    assert.match(md, /\ninheritProjectContext: false\n/);
    assert.match(md, /\ninheritSkills: false\n/);
    // body after the closing frontmatter fence
    assert.match(md, /---\n\n# NPC Generator\nForge NPCs\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a role subagent auto-gets recall/remember tools and the role-runtime extension", () => {
  const dir = mkdtempSync(join(tmpdir(), "mat-"));
  try {
    // A role declaring only a world-specific tool + persona; base tooling is added.
    const s = spec(dir, { name: "wounded-messenger", kind: "role", tools: ["search_memory"] });
    const md = renderSubagentMarkdown(s, "border-station", "/proj");
    // world tool preserved, base role tools appended (once, in order)
    assert.match(md, /\ntools: search_memory, recall_self, remember_action\n/);
    // base role-runtime extension folded into child-only extensions
    assert.match(md, new RegExp(`\\nsubagentOnlyExtensions: /proj/${ROLE_RUNTIME_EXTENSION_RELATIVE.replace(/\//g, "\\/")}\\n`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a role subagent with a world extension keeps both it and the role-runtime extension", () => {
  const dir = mkdtempSync(join(tmpdir(), "mat-"));
  try {
    const s = spec(dir, { name: "actor", kind: "role", tools: [], extensionPath: "/abs/world-ext.ts" });
    const md = renderSubagentMarkdown(s, "w", "/proj");
    // role with no declared tools still gets the two base tools (never the sentinel)
    assert.match(md, /\ntools: recall_self, remember_action\n/);
    assert.doesNotMatch(md, new RegExp(NO_TOOLS_SENTINEL));
    assert.match(md, new RegExp(`\\nsubagentOnlyExtensions: /abs/world-ext\\.ts, /proj/${ROLE_RUNTIME_EXTENSION_RELATIVE.replace(/\//g, "\\/")}\\n`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rendering a role subagent without projectRoot is a clear error", () => {
  const dir = mkdtempSync(join(tmpdir(), "mat-"));
  try {
    const s = spec(dir, { name: "actor", kind: "role", tools: [] });
    assert.throws(() => renderSubagentMarkdown(s, "w"), /requires projectRoot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool subagent is unaffected by role auto-injection", () => {
  const dir = mkdtempSync(join(tmpdir(), "mat-"));
  try {
    const s = spec(dir, { name: "npc-generator", kind: "tool", tools: ["forge_character"] });
    const md = renderSubagentMarkdown(s, "w", "/proj");
    assert.match(md, /\ntools: forge_character\n/);
    assert.doesNotMatch(md, /recall_self/);
    assert.doesNotMatch(md, new RegExp(ROLE_RUNTIME_EXTENSION_RELATIVE.replace(/\//g, "\\/")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lookup tools are only exposed to subagents when explicitly allowlisted", () => {
  const dir = mkdtempSync(join(tmpdir(), "mat-"));
  try {
    const researcher = renderSubagentMarkdown(spec(dir, { name: "researcher", kind: "tool", tools: ["lookup", "read_lore"] }), "w");
    const actor = renderSubagentMarkdown(spec(dir, { name: "actor", kind: "role", tools: [] }), "w", "/proj");

    assert.match(researcher, /\ntools: lookup, read_lore\n/);
    assert.doesNotMatch(actor, /lookup/);
    assert.doesNotMatch(actor, /read_lore/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty tools becomes a zero-tools sentinel; model/thinking/extension omitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "mat-"));
  try {
    const md = renderSubagentMarkdown(spec(dir, { name: "advisor", tools: [] }), "w");
    // empty tools ⇒ sentinel allowlist (pi ignores the unknown name ⇒ no tools)
    assert.match(md, new RegExp(`\\ntools: ${NO_TOOLS_SENTINEL}\\n`));
    assert.doesNotMatch(md, /\nmodel:/);
    assert.doesNotMatch(md, /\nthinking:/);
    assert.doesNotMatch(md, /\nsubagentOnlyExtensions:/);
    // required keys still present
    assert.match(md, /\nname: advisor\n/);
    assert.match(md, /\nsystemPromptMode: replace\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materializes declared subagents into <root>/.pi/agents and returns paths", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  try {
    const s = spec(root, { name: "npc-generator", tools: ["forge_character"] });
    const written = materializeWorldSubagents(root, makeWorld("border-station", [s]));
    const file = join(root, ".pi", "agents", "npc-generator.md");
    assert.deepEqual(written, [file]);
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, "utf8"), /name: npc-generator/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materialization applies per-subagent model settings from .pi/agent/settings.json", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  try {
    mkdirSync(join(root, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "agent", "settings.json"),
      JSON.stringify({
        subagents: {
          disableBuiltins: true
        },
        rpSubagents: {
          "npc-generator": {
            provider: "opencode-go",
            model: "deepseek-v4-pro",
            thinking: "high"
          }
        }
      })
    );

    materializeWorldSubagents(root, makeWorld("border-station", [spec(root, { name: "npc-generator", tools: ["forge_character"] })]));

    const file = join(root, ".pi", "agents", "npc-generator.md");
    const md = readFileSync(file, "utf8");
    assert.match(md, /\nmodel: opencode-go\/deepseek-v4-pro\n/);
    assert.match(md, /\nthinking: high\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rewrites generated files while preserving hand-authored ones", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  try {
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "writer.md"), "# Writer\n只返回正文。\n");
    writeFileSync(join(agentsDir, "old.md"), `---\n# ${RP_SUBAGENT_MARKER}\nname: old\ndescription: x\n---\nbody\n`);

    materializeWorldSubagents(root, makeWorld("w", [spec(root, { name: "fresh", tools: ["read"] })]));

    assert.ok(existsSync(join(agentsDir, "writer.md")), "hand-authored writer preserved");
    assert.ok(!existsSync(join(agentsDir, "old.md")), "stale generated file removed");
    assert.ok(existsSync(join(agentsDir, "fresh.md")), "current subagent written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite a hand-authored file of the same name", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  try {
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "writer.md"), "# Writer\nhand-authored\n");
    const s = spec(root, { name: "writer", tools: ["read"] });
    assert.throws(() => materializeWorldSubagents(root, makeWorld("w", [s])), /would overwrite a hand-authored/);
    assert.match(readFileSync(join(agentsDir, "writer.md"), "utf8"), /hand-authored/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a world with no subagents cleans up stale generated files and writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  try {
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "old.md"), `---\n# ${RP_SUBAGENT_MARKER}\nname: old\n---\nx\n`);
    writeFileSync(join(agentsDir, "writer.md"), "# Writer\n");

    const written = materializeWorldSubagents(root, makeWorld("w", []));
    assert.deepEqual(written, []);
    assert.ok(!existsSync(join(agentsDir, "old.md")));
    assert.ok(existsSync(join(agentsDir, "writer.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing persona file is a clear error", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  try {
    const broken: SubagentSpec = {
      name: "broken",
      kind: "tool",
      description: "x",
      tools: ["read"],
      promptPath: join(root, "nope.md"),
      model: undefined,
      thinking: undefined,
      extensionPath: undefined
    };
    assert.throws(() => materializeWorldSubagents(root, makeWorld("w", [broken])), /persona file is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
