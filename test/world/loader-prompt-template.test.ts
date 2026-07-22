import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadWorldFromDir } from "../../src/world/loader.ts";

test("missing prompt_template normalizes to an empty promptTemplates object", () => {
  const world = withWorld([]);
  assert.deepEqual(world.promptTemplates, {});
});

test("parses gm and writer prompt templates with literal content, file content, and markers", () => {
  const world = withWorld([
    "prompt_template:",
    "  writer:",
    "    entries:",
    "      - { marker: writer_base }",
    "      - { role: system, path: ./prompts/writer-persona.md }",
    "      - { role: user, content: fake user turn }",
    "      - { role: assistant, content: fake assistant turn }",
    "      - { marker: story_elements }",
    "  gm:",
    "    entries:",
    "      - { role: system, path: ./prompts/gm-core.md }",
    "      - { marker: chat_history }",
    "      - { marker: hook_prompts }"
  ]);

  assert.deepEqual(world.promptTemplates.writer?.entries, [
    { kind: "marker", marker: "writer_base" },
    { kind: "message", role: "system", content: "# Writer persona\n" },
    { kind: "message", role: "user", content: "fake user turn" },
    { kind: "message", role: "assistant", content: "fake assistant turn" },
    { kind: "marker", marker: "story_elements" }
  ]);
  assert.deepEqual(world.promptTemplates.gm?.entries, [
    { kind: "message", role: "system", content: "# GM core\n" },
    { kind: "marker", marker: "chat_history" },
    { kind: "marker", marker: "hook_prompts" }
  ]);
});

test("prompt template entries must provide exactly one of content or path", () => {
  assert.throws(
    () =>
      withWorld([
        "prompt_template:",
        "  writer:",
        "    entries:",
        "      - { role: user, content: x, path: ./prompts/writer-persona.md }"
      ]),
    /prompt_template\.writer\.entries\[0\].*content.*path/s
  );

  assert.throws(
    () =>
      withWorld([
        "prompt_template:",
        "  gm:",
        "    entries:",
        "      - { role: user }"
      ]),
    /prompt_template\.gm\.entries\[0\].*content.*path/s
  );
});

test("prompt template message roles normalize a/u/s aliases and default unknown roles to user", () => {
  const world = withWorld([
    "prompt_template:",
    "  writer:",
    "    entries:",
    "      - { role: a, content: assistant shorthand }",
    "      - { role: u, content: user shorthand }",
    "      - { role: s, content: system shorthand }",
    "      - { role: narrator, content: fallback role }"
  ]);

  assert.deepEqual(world.promptTemplates.writer?.entries, [
    { kind: "message", role: "assistant", content: "assistant shorthand" },
    { kind: "message", role: "user", content: "user shorthand" },
    { kind: "message", role: "system", content: "system shorthand" },
    { kind: "message", role: "user", content: "fallback role" }
  ]);
});

test("prompt template marker names are validated per agent whitelist", () => {
  assert.throws(
    () =>
      withWorld([
        "prompt_template:",
        "  gm:",
        "    entries:",
        "      - { marker: writer_base }"
      ]),
    /prompt_template\.gm\.entries\[0\]\.marker.*chat_history.*hook_prompts/s
  );

  assert.throws(
    () =>
      withWorld([
        "prompt_template:",
        "  writer:",
        "    entries:",
        "      - { marker: chat_history }"
      ]),
    /prompt_template\.writer\.entries\[0\]\.marker.*writer_base.*story_elements/s
  );
});

test("prompt template agent entries must be a non-empty list", () => {
  assert.throws(
    () =>
      withWorld([
        "prompt_template:",
        "  writer:",
        "    entries: []"
      ]),
    /prompt_template\.writer\.entries.*non-empty list/
  );
});

test("declaring a gm prompt template allows prompts.gm to be omitted", () => {
  const world = withWorld(
    [
      "prompt_template:",
      "  gm:",
      "    entries:",
      "      - { role: system, content: full gm prompt }",
      "      - { marker: chat_history }"
    ],
    { includePrompts: false }
  );

  assert.deepEqual(world.gmPromptPaths, []);
  assert.deepEqual(world.promptTemplates.gm?.entries, [
    { kind: "message", role: "system", content: "full gm prompt" },
    { kind: "marker", marker: "chat_history" }
  ]);
});

test("without a gm prompt template prompts.gm remains required", () => {
  assert.throws(() => withWorld([], { includePrompts: false }), /prompts\.gm.*non-empty list/);
});

function withWorld(extraYaml: string[], options: { includePrompts?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "worlds-prompt-template-"));
  const root = join(dir, "w");
  mkdirSync(join(root, "memory"), { recursive: true });
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "memory", "characters.yaml"), "memory_type: characters\n");
  writeFileSync(join(root, "prompts", "gm.md"), "# GM\n");
  writeFileSync(join(root, "prompts", "gm-core.md"), "# GM core\n");
  writeFileSync(join(root, "prompts", "writer-persona.md"), "# Writer persona\n");

  const includePrompts = options.includePrompts ?? true;
  writeFileSync(
    join(root, "world.yaml"),
    [
      "name: w",
      "state:",
      "  initial:",
      "    player: { name: \"\", status: ok, location: here }",
      "    time: { day: 1, hour: 8 }",
      "    scene: { summary: start }",
      ...(includePrompts ? ["prompts:", "  gm: [ ./prompts/gm.md ]"] : []),
      "memory:",
      "  policy:",
      "    self: { enabled: true }",
      "    peer: { enabled: false }",
      "    memory_types: [ characters ]",
      "  schemas: [ ./memory/characters.yaml ]",
      "  fallback_memory_types: [ entities ]",
      ...extraYaml,
      ""
    ].join("\n")
  );

  try {
    return loadWorldFromDir(root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
