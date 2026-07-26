import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSystemDefinitions } from "../../src/systems/module-loader.ts";
import { listWorldNames, loadActiveWorld, loadWorldFromDir } from "../../src/world/loader.ts";

const repoRoot = new URL("../../", import.meta.url).pathname;

test("loads the shipped border-station world pack", () => {
  const world = loadActiveWorld(repoRoot, { worldName: "border-station" });
  assert.equal(world.name, "border-station");
  assert.equal(world.displayName, "边境驿站");
  assert.equal(world.initialState.player.location, "边境驿站大厅");
  assert.equal(world.initialState.time.hour, 7);
  assert.deepEqual(world.memory.policy.memory_types, ["characters", "story_events"]);
  assert.deepEqual(world.memory.fallbackMemoryTypes, ["entities", "events"]);
  assert.equal(world.gmPromptPaths.length, 3);
  assert.ok(world.gmPromptPaths.every((p) => p.endsWith(".md")));

  const vigor = world.attributes.find((a) => a.name === "vigor");
  assert.ok(vigor && vigor.kind === "int");
  assert.equal(vigor.initial, 80);
  assert.equal(vigor.max, 100);
});

test("the shipped border-station world registers relay blueprints", () => {
  const world = loadWorldFromDir(join(repoRoot, "worlds", "border-station"));

  assert.deepEqual(world.systemModulePaths, [
    join(world.root, "systems", "relay-blueprints.ts")
  ]);
  const definitions = loadSystemDefinitions(world.systemModulePaths);
  assert.deepEqual(definitions.map((entry) => entry.name), ["relay-blueprints"]);
});

test("all memory schema files resolve under a single directory", () => {
  const world = loadActiveWorld(repoRoot, { worldName: "border-station" });
  assert.equal(world.memory.schemaPaths.length, 2);
  assert.ok(world.memory.schemaPaths.every((p) => p.startsWith(world.memory.schemaDir)));
});

test("RP_WORLD selection: explicit name wins, else first alphabetically", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  // loadActiveWorld falls back to process.env.RP_WORLD when no explicit name is
  // given; an ambient value (per-world smoke run, dev shell) must not leak into
  // these auto-selection assertions.
  const previousWorld = process.env.RP_WORLD;
  delete process.env.RP_WORLD;
  try {
    writeWorld(dir, "aardvark", "Aardvark");
    writeWorld(dir, "zebra", "Zebra");

    // No name → first alphabetically.
    assert.equal(loadActiveWorld(dir, { worldsDir: dir }).name, "aardvark");
    // Explicit name wins.
    assert.equal(loadActiveWorld(dir, { worldsDir: dir, worldName: "zebra" }).name, "zebra");
    assert.deepEqual(listWorldNames(dir, dir), ["aardvark", "zebra"]);
  } finally {
    if (previousWorld === undefined) delete process.env.RP_WORLD;
    else process.env.RP_WORLD = previousWorld;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("underscore-prefixed dirs are never listed or auto-selected", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  const previousWorld = process.env.RP_WORLD;
  delete process.env.RP_WORLD;
  try {
    writeWorld(dir, "_template", "Template");
    writeWorld(dir, "real", "Real");
    assert.deepEqual(listWorldNames(dir, dir), ["real"]);
    assert.equal(loadActiveWorld(dir, { worldsDir: dir }).name, "real");
    assert.throws(() => loadActiveWorld(dir, { worldsDir: dir, worldName: "_template" }), /not found/);
  } finally {
    if (previousWorld === undefined) delete process.env.RP_WORLD;
    else process.env.RP_WORLD = previousWorld;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped _template world pack parses", () => {
  const template = loadWorldFromDir(join(repoRoot, "worlds", "_template"));
  assert.equal(template.name, "_template");
  assert.ok(template.gmPromptPaths.length >= 1);
  assert.ok(template.attributes.some((a) => a.name === "energy"));
});

test("every world pack under worlds/ loads", () => {
  // Guards future packs: a new world directory must parse under the full
  // manifest contract, not just the two specimens named in other tests.
  const worldsBase = join(repoRoot, "worlds");
  const entries = readdirSync(worldsBase).filter((entry) => statSync(join(worldsBase, entry)).isDirectory());
  assert.ok(entries.length >= 2);
  for (const entry of entries) {
    const world = loadWorldFromDir(join(worldsBase, entry));
    assert.equal(world.root, join(worldsBase, entry));
  }
});

test("loads a world whose sections are external yaml modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeSplitWorld(dir, "split");
    const world = loadWorldFromDir(root);
    assert.equal(world.name, "split");
    assert.equal(world.initialState.player.location, "split room");
    assert.deepEqual(world.memory.policy.memory_types, ["characters"]);
    assert.equal(world.gmPromptPaths[0], join(root, "prompts", "gm.md"));
    assert.equal(world.subagents[0].promptPath, join(root, "subagents", "helper", "agent.md"));
    assert.equal(world.hooks[0].name, "opening");
    assert.equal(world.writingGuides[0].path, join(root, "writing", "style.md"));
    assert.deepEqual(world.revision.bannedWords, ["suddenly"]);
    assert.deepEqual(world.tools.extra, [join(root, "tools", "local-tool.ts")]);
    assert.deepEqual(world.lore.sources.map((s) => s.defaultKind), ["character"]);
    assert.equal(world.lore.sources[0]?.path, join(root, "lore", "characters.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing tools section defaults to core GM tool groups", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    const world = loadWorldFromDir(join(dir, "only"));
    assert.deepEqual(world.tools.include, ["core.state", "core.memory"]);
    assert.deepEqual(world.tools.extra, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("world systems resolve to absolute local module paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    const root = join(dir, "only");
    mkdirSync(join(root, "systems"));
    writeFileSync(join(root, "systems", "progression.ts"), "export const marker = true;\n");
    appendFileSync(join(root, "world.yaml"), "systems:\n  - ./systems/progression.ts\n");

    const world = loadWorldFromDir(root);

    assert.deepEqual(world.systemModulePaths, [join(root, "systems", "progression.ts")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing systems defaults to an empty list", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    assert.deepEqual(loadWorldFromDir(join(dir, "only")).systemModulePaths, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed systems is rejected as a named manifest field", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    const root = join(dir, "only");
    appendFileSync(join(root, "world.yaml"), "systems: ./systems/progression.ts\n");

    assert.throws(() => loadWorldFromDir(root), /systems.*list of strings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing system module fails world loading with its resolved path", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    const root = join(dir, "only");
    appendFileSync(join(root, "world.yaml"), "systems:\n  - ./systems/missing.ts\n");

    assert.throws(
      () => loadWorldFromDir(root),
      (error) => error instanceof Error && error.message.includes(join(root, "systems", "missing.ts"))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown world name is a clear error", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    assert.throws(() => loadActiveWorld(dir, { worldsDir: dir, worldName: "missing" }), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing required field fails validation with a named message", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = join(dir, "broken");
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "world.yaml"), "name: broken\nstate:\n  initial: {}\n");
    assert.throws(() => loadWorldFromDir(root), /state.initial.player|state.initial.time/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest validation errors name the world directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = join(dir, "broken");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "world.yaml"), "name: broken\nstate:\n  initial: {}\n");
    assert.throws(
      () => loadWorldFromDir(root),
      (error) => error instanceof Error && error.message.includes(`(while loading world at ${root})`)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown top-level manifest fields are rejected with the allowed key set", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    const root = join(dir, "only");
    // The classic typo: `writting` would silently disable the whole writing axis.
    appendFileSync(join(root, "world.yaml"), "writting: ./writing.yaml\n");

    assert.throws(() => loadWorldFromDir(root), /Unknown world\.yaml field\(s\): "writting".*Allowed keys:.*writing/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools.include that is not a string list is rejected, not defaulted to []", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    const root = join(dir, "only");
    appendFileSync(join(root, "world.yaml"), "tools:\n  include: core.state\n");

    assert.throws(() => loadWorldFromDir(root), /tools\.include.*list of strings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools.extra that is not a string list is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    const root = join(dir, "only");
    appendFileSync(join(root, "world.yaml"), "tools:\n  extra: ./tools/local-tool.ts\n");

    assert.throws(() => loadWorldFromDir(root), /tools\.extra.*list of strings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing gm prompt file fails at load with its resolved path", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    const root = join(dir, "only");
    rmSync(join(root, "prompts", "gm.md"));

    assert.throws(
      () => loadWorldFromDir(root),
      (error) =>
        error instanceof Error &&
        error.message.includes(`prompts.gm[0]`) &&
        error.message.includes(join(root, "prompts", "gm.md"))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing memory schema file fails at load with its resolved path", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    writeWorld(dir, "only", "Only");
    const root = join(dir, "only");
    rmSync(join(root, "memory", "characters.yaml"));

    assert.throws(
      () => loadWorldFromDir(root),
      (error) =>
        error instanceof Error &&
        error.message.includes(`memory.schemas[0]`) &&
        error.message.includes(join(root, "memory", "characters.yaml"))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing lore source file fails at load with its resolved path", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeSplitWorld(dir, "split");
    rmSync(join(root, "lore", "characters.yaml"));

    assert.throws(
      () => loadWorldFromDir(root),
      (error) =>
        error instanceof Error &&
        error.message.includes(`lore.sources[0].path`) &&
        error.message.includes(join(root, "lore", "characters.yaml"))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing tools.extra module fails at load with its resolved path", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeSplitWorld(dir, "split");
    rmSync(join(root, "tools", "local-tool.ts"));

    assert.throws(
      () => loadWorldFromDir(root),
      (error) =>
        error instanceof Error &&
        error.message.includes(`tools.extra[0]`) &&
        error.message.includes(join(root, "tools", "local-tool.ts"))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-integer min/max on an int attribute is rejected, not dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = join(dir, "w");
    mkdirSync(join(root, "memory"), { recursive: true });
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "prompts", "gm.md"), "# GM\n");
    writeFileSync(join(root, "memory", "characters.yaml"), "memory_type: characters\n");
    writeFileSync(
      join(root, "world.yaml"),
      [
        "name: w",
        "state:",
        "  initial:",
        "    player: { name: \"\", status: ok, location: here }",
        "    time: { day: 1, hour: 8 }",
        "    scene: { summary: start }",
        "  attributes:",
        "    energy:",
        "      type: int",
        "      min: \"0\"",
        "      initial: 5",
        "prompts:",
        "  gm: [ ./prompts/gm.md ]",
        "memory:",
        "  policy:",
        "    self: { enabled: true }",
        "    peer: { enabled: false }",
        "    memory_types: [ characters ]",
        "  schemas: [ ./memory/characters.yaml ]",
        "  fallback_memory_types: [ entities ]",
        ""
      ].join("\n")
    );

    assert.throws(() => loadWorldFromDir(root), /state\.attributes\.energy\.min.*must be an integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parses a declared subagent into a normalized spec with absolute paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeWorldWithSubagents(dir, "w", [
      "subagents:",
      "  - name: npc-generator",
      "    description: Forge a new NPC into characters memory.",
      "    model: opencode-go/deepseek-v4-pro",
      "    thinking: high",
      "    tools: [ forge_character, read ]",
      "    prompt: ./subagents/npc-generator/agent.md",
      "    extension: ./subagents/npc-generator/index.ts"
    ].join("\n"));

    const world = loadWorldFromDir(root);
    assert.equal(world.subagents.length, 1);
    const sa = world.subagents[0];
    assert.equal(sa.name, "npc-generator");
    assert.equal(sa.kind, "tool");
    assert.equal(sa.description, "Forge a new NPC into characters memory.");
    assert.equal(sa.model, "opencode-go/deepseek-v4-pro");
    assert.equal(sa.thinking, "high");
    assert.deepEqual(sa.tools, ["forge_character", "read"]);
    assert.equal(sa.promptPath, join(root, "subagents", "npc-generator", "agent.md"));
    assert.equal(sa.extensionPath, join(root, "subagents", "npc-generator", "index.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subagent extension is optional; absent model/thinking stay undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeWorldWithSubagents(dir, "w", [
      "subagents:",
      "  - name: advisor",
      "    description: A read-only advisor with no world tools.",
      "    tools: [ read ]",
      "    prompt: ./subagents/npc-generator/agent.md"
    ].join("\n"));

    const sa = loadWorldFromDir(root).subagents[0];
    assert.equal(sa.extensionPath, undefined);
    assert.equal(sa.model, undefined);
    assert.equal(sa.thinking, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subagent without tools normalizes to a tool-less child ([])", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeWorldWithSubagents(dir, "w", [
      "subagents:",
      "  - name: toolless",
      "    description: pure-reasoning child, no tools.",
      "    prompt: ./subagents/npc-generator/agent.md"
    ].join("\n"));
    assert.deepEqual(loadWorldFromDir(root).subagents[0].tools, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit empty tools list is allowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeWorldWithSubagents(dir, "w", [
      "subagents:",
      "  - name: toolless",
      "    description: explicit empty allowlist.",
      "    tools: []",
      "    prompt: ./subagents/npc-generator/agent.md"
    ].join("\n"));
    assert.deepEqual(loadWorldFromDir(root).subagents[0].tools, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed tools (not a string list) is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeWorldWithSubagents(dir, "w", [
      "subagents:",
      "  - name: broken",
      "    description: tools must be a list.",
      "    tools: read",
      "    prompt: ./subagents/npc-generator/agent.md"
    ].join("\n"));
    assert.throws(() => loadWorldFromDir(root), /subagents\[0\]\.tools/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate subagent names are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeWorldWithSubagents(dir, "w", [
      "subagents:",
      "  - name: dup",
      "    description: first.",
      "    tools: [ read ]",
      "    prompt: ./subagents/npc-generator/agent.md",
      "  - name: dup",
      "    description: second.",
      "    tools: [ read ]",
      "    prompt: ./subagents/npc-generator/agent.md"
    ].join("\n"));
    assert.throws(() => loadWorldFromDir(root), /Duplicate subagent name "dup"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subagent name must be a slug", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeWorldWithSubagents(dir, "w", [
      "subagents:",
      "  - name: bad name!",
      "    description: invalid slug.",
      "    tools: [ read ]",
      "    prompt: ./subagents/npc-generator/agent.md"
    ].join("\n"));
    assert.throws(() => loadWorldFromDir(root), /must be a slug/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subagent kind defaults to tool and accepts an explicit role", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeWorldWithSubagents(dir, "w", [
      "subagents:",
      "  - name: forge",
      "    description: ephemeral, kind omitted.",
      "    prompt: ./subagents/npc-generator/agent.md",
      "  - name: actor",
      "    kind: role",
      "    description: persistent single-character actor.",
      "    prompt: ./subagents/npc-generator/agent.md"
    ].join("\n"));
    const subs = loadWorldFromDir(root).subagents;
    assert.equal(subs[0].kind, "tool");
    assert.equal(subs[1].kind, "role");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown subagent kind is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeWorldWithSubagents(dir, "w", [
      "subagents:",
      "  - name: weird",
      "    kind: sidekick",
      "    description: not a known kind.",
      "    prompt: ./subagents/npc-generator/agent.md"
    ].join("\n"));
    assert.throws(() => loadWorldFromDir(root), /subagents\[0\]\.kind.*tool.*role/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subagent missing description is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "worlds-"));
  try {
    const root = writeWorldWithSubagents(dir, "w", [
      "subagents:",
      "  - name: nodesc",
      "    tools: [ read ]",
      "    prompt: ./subagents/npc-generator/agent.md"
    ].join("\n"));
    assert.throws(() => loadWorldFromDir(root), /subagents\[0\]\.description/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("border-station declares a tool subagent and a role subagent; _template declares none", () => {
  const border = loadActiveWorld(repoRoot, { worldName: "border-station" });
  assert.equal(border.subagents.length, 3);

  const npc = border.subagents.find((s) => s.name === "npc-generator");
  assert.ok(npc);
  assert.equal(npc.kind, "tool");
  assert.deepEqual(npc.tools, ["forge_character"]);
  assert.equal(npc.promptPath, join(border.root, "subagents", "npc-generator", "agent.md"));
  assert.equal(npc.extensionPath, join(border.root, "subagents", "npc-generator", "index.ts"));

  // The GM-facing role forger: tool-kind, least-privilege forge_role allowlist.
  const forger = border.subagents.find((s) => s.name === "role-forger");
  assert.ok(forger);
  assert.equal(forger.kind, "tool");
  assert.deepEqual(forger.tools, ["forge_role"]);
  assert.equal(forger.extensionPath, join(border.root, "subagents", "role-forger", "index.ts"));

  const role = border.subagents.find((s) => s.name === "wounded-messenger");
  assert.ok(role);
  assert.equal(role.kind, "role");
  // A role declares only a persona; base recall/remember tooling is injected at
  // materialization, not in the manifest, so tools/extension stay empty here.
  assert.deepEqual(role.tools, []);
  assert.equal(role.extensionPath, undefined);
  assert.equal(role.promptPath, join(border.root, "subagents", "wounded-messenger", "agent.md"));

  assert.deepEqual(loadWorldFromDir(join(repoRoot, "worlds", "_template")).subagents, []);
});

// Like writeWorld, but appends a caller-supplied `subagents:` section and ships
// the sibling files a subagent references, so resolved paths are realistic.
function writeWorldWithSubagents(base: string, name: string, subagentsYaml: string): string {
  const root = join(base, name);
  mkdirSync(join(root, "memory"), { recursive: true });
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "subagents", "npc-generator"), { recursive: true });
  writeFileSync(join(root, "prompts", "gm.md"), "# GM\n");
  writeFileSync(join(root, "memory", "characters.yaml"), "memory_type: characters\n");
  writeFileSync(join(root, "subagents", "npc-generator", "agent.md"), "# persona\n");
  writeFileSync(join(root, "subagents", "npc-generator", "index.ts"), "export default () => {};\n");
  writeFileSync(
    join(root, "world.yaml"),
    [
      `name: ${name}`,
      "state:",
      "  initial:",
      "    player: { name: \"\", status: ok, location: here }",
      "    time: { day: 1, hour: 8 }",
      "    scene: { summary: start }",
      "prompts:",
      "  gm: [ ./prompts/gm.md ]",
      "memory:",
      "  policy:",
      "    self: { enabled: true }",
      "    peer: { enabled: false }",
      "    memory_types: [ characters ]",
      "  schemas: [ ./memory/characters.yaml ]",
      "  fallback_memory_types: [ entities ]",
      subagentsYaml,
      ""
    ].join("\n")
  );
  return root;
}

function writeWorld(base: string, name: string, display: string): void {
  const root = join(base, name);
  mkdirSync(join(root, "memory"), { recursive: true });
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "gm.md"), "# GM\n");
  writeFileSync(join(root, "memory", "characters.yaml"), "memory_type: characters\n");
  writeFileSync(
    join(root, "world.yaml"),
    [
      `name: ${name}`,
      `display_name: ${display}`,
      "state:",
      "  initial:",
      "    player: { name: \"\", status: ok, location: here }",
      "    time: { day: 1, hour: 8 }",
      "    scene: { summary: start }",
      "prompts:",
      "  gm: [ ./prompts/gm.md ]",
      "memory:",
      "  policy:",
      "    self: { enabled: true }",
      "    peer: { enabled: false }",
      "    memory_types: [ characters ]",
      "  schemas: [ ./memory/characters.yaml ]",
      "  fallback_memory_types: [ entities ]",
      ""
    ].join("\n")
  );
}

function writeSplitWorld(base: string, name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, "memory"), { recursive: true });
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "subagents", "helper"), { recursive: true });
  mkdirSync(join(root, "tools"), { recursive: true });
  mkdirSync(join(root, "writing"), { recursive: true });
  mkdirSync(join(root, "lore"), { recursive: true });
  writeFileSync(join(root, "prompts", "gm.md"), "# GM\n");
  writeFileSync(join(root, "memory", "characters.yaml"), "memory_type: characters\n");
  writeFileSync(join(root, "lore", "characters.yaml"), "[]\n");
  writeFileSync(join(root, "subagents", "helper", "agent.md"), "# helper\n");
  writeFileSync(join(root, "writing", "style.md"), "# style\n");
  writeFileSync(
    join(root, "world.yaml"),
    [
      `name: ${name}`,
      "state: ./state.yaml",
      "prompts: ./prompts.yaml",
      "memory: ./memory-config.yaml",
      "tools: ./tools.yaml",
      "subagents: ./subagents.yaml",
      "hooks: ./hooks.yaml",
      "writing: ./writing.yaml",
      "revision: ./revision.yaml",
      "lore: ./lore.yaml",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(root, "state.yaml"),
    [
      "initial:",
      "  player: { name: \"\", status: ok, location: split room }",
      "  time: { day: 1, hour: 8 }",
      "  scene: { summary: split start }",
      "attributes:",
      "  energy:",
      "    type: int",
      "    min: 0",
      "    max: 100",
      "    initial: 50",
      ""
    ].join("\n")
  );
  writeFileSync(join(root, "prompts.yaml"), "gm: [ ./prompts/gm.md ]\n");
  writeFileSync(
    join(root, "memory-config.yaml"),
    [
      "policy:",
      "  self: { enabled: true }",
      "  peer: { enabled: false }",
      "  memory_types: [ characters ]",
      "schemas: [ ./memory/characters.yaml ]",
      "fallback_memory_types: [ entities ]",
      ""
    ].join("\n")
  );
  writeFileSync(join(root, "tools.yaml"), "include: [ core.state ]\nextra: [ ./tools/local-tool.ts ]\n");
  writeFileSync(join(root, "tools", "local-tool.ts"), "export const localTool = {};\n");
  writeFileSync(
    join(root, "subagents.yaml"),
    [
      "- name: helper",
      "  description: A split manifest helper.",
      "  tools: [ read ]",
      "  prompt: ./subagents/helper/agent.md",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(root, "hooks.yaml"),
    [
      "- name: opening",
      "  on: session_start",
      "  do: { type: inject, as: notice, text: hello }",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(root, "writing.yaml"),
    [
      "- kind: style",
      "  description: Style guide.",
      "  path: ./writing/style.md",
      ""
    ].join("\n")
  );
  writeFileSync(join(root, "revision.yaml"), "banned_words: [ suddenly ]\n");
  writeFileSync(
    join(root, "lore.yaml"),
    [
      "version: 1",
      "sources:",
      "  - path: ./lore/characters.yaml",
      "    default_kind: character",
      ""
    ].join("\n")
  );
  return root;
}
