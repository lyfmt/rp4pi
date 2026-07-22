import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Memory schemas now live inside the world pack (single source of truth).
const schemaPath = fileURLToPath(new URL("../../worlds/border-station/memory/story_events.yaml", import.meta.url));
const memoryDir = fileURLToPath(new URL("../../worlds/border-station/memory", import.meta.url));
const openVikingPython = configuredOpenVikingPython();

test("story_events schema does not depend on ranges for URI generation", () => {
  const schema = readFileSync(schemaPath, "utf8");

  assert.match(schema, /filename_template:\s*"{{ event_name }}\.md"/);
  assert.doesNotMatch(schema, /extract_context/);
  assert.doesNotMatch(schema, /\branges\b/);
});

test("story_events event_name describes save-local uniqueness requirements", () => {
  const schema = readFileSync(schemaPath, "utf8");

  assert.match(schema, /同一 save 内稳定唯一/);
  assert.match(schema, /角色/);
  assert.match(schema, /地点/);
  assert.match(schema, /动作/);
});

test("RP memory schemas explicitly instruct extraction for successful turns", () => {
  const storyEvents = readFileSync(schemaPath, "utf8");
  const characters = readFileSync(new URL("../../worlds/border-station/memory/characters.yaml", import.meta.url), "utf8");

  assert.match(storyEvents, /每个成功 RP 正文回合/);
  assert.match(storyEvents, /至少创建一条 story_events/);
  assert.match(characters, /具名角色/);
  assert.match(characters, /至少创建或更新一条 characters/);
});

test("OpenViking registry can load project memory schemas", { skip: openVikingPython === undefined }, () => {
  const result = spawnSync(
    openVikingPython!,
    [
      "-c",
      [
        "from openviking.session.memory.memory_type_registry import MemoryTypeRegistry",
        "registry = MemoryTypeRegistry(load_schemas=False)",
        `loaded = registry.load_from_directory(${JSON.stringify(memoryDir)})`,
        "assert loaded == 2",
        "story_events = registry.get('story_events')",
        "assert story_events",
        "assert story_events.filename_template == '{{ event_name }}.md'",
        "assert all(field.name != 'ranges' for field in story_events.fields)",
        "assert registry.get('characters')"
      ].join("; ")
    ],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

function configuredOpenVikingPython(): string | undefined {
  const path = process.env.OPENVIKING_PYTHON;
  return path && existsSync(path) ? path : undefined;
}
