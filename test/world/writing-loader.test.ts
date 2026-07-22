import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadWorldFromDir } from "../../src/world/loader.ts";

// W-A: the declarative `writing:` axis. A world declares writing guides (a
// category `kind` + one-line `description` + a `path` to the guide body); the
// loader normalizes and strictly validates them, mirroring the subagents/hooks
// axes. These tests pin the contract the writer agent (W-C) then consumes via a
// read-only `read_writing_guide` tool. File existence is deliberately NOT checked
// at load — a missing body surfaces when the writer reads it, not at boot.

test("parses a writing guide list into normalized specs with absolute paths", () => {
  const world = withWriting([
    "writing:",
    "  - kind: style",
    "    description: 叙事语气与节奏。",
    "    path: ./writing/style.md",
    "  - kind: dialogue",
    "    description: 对话与潜台词处理。",
    "    path: ./writing/dialogue.md"
  ]);
  assert.equal(world.writingGuides.length, 2);
  const [style, dialogue] = world.writingGuides;
  assert.equal(style.kind, "style");
  assert.equal(style.description, "叙事语气与节奏。");
  assert.match(style.path, /\/writing\/style\.md$/);
  assert.ok(style.path.startsWith("/"), "path must be resolved to absolute");
  assert.equal(style.when, undefined);
  assert.equal(dialogue.kind, "dialogue");
});

test("carries an optional when gate through untouched", () => {
  const guide = withWriting([
    "writing:",
    "  - kind: adult",
    "    description: 成人场景指导。",
    "    path: ./writing/adult.md",
    "    when: adult_scene"
  ]).writingGuides[0];
  assert.equal(guide.when, "adult_scene");
});

test("missing writing section normalizes to []", () => {
  assert.deepEqual(withWriting([]).writingGuides, []);
});

test("does not require the guide file to exist at load time", () => {
  // Path points at a file we never wrote — loading still succeeds (existence is
  // deferred to read time, like the subagents axis).
  const world = withWriting(["writing:", "  - kind: style", "    description: x", "    path: ./writing/absent.md"]);
  assert.equal(world.writingGuides.length, 1);
  assert.match(world.writingGuides[0].path, /absent\.md$/);
});

test("duplicate writing kinds are rejected", () => {
  assert.throws(
    () =>
      withWriting([
        "writing:",
        "  - { kind: style, description: a, path: ./writing/a.md }",
        "  - { kind: style, description: b, path: ./writing/b.md }"
      ]),
    /Duplicate writing guide kind "style"/
  );
});

test("writing kind must be a slug", () => {
  assert.throws(
    () => withWriting(["writing:", "  - { kind: bad kind!, description: a, path: ./writing/a.md }"]),
    /writing\[0\]\.kind.*must be a slug/s
  );
});

test("missing description is rejected", () => {
  assert.throws(
    () => withWriting(["writing:", "  - { kind: style, path: ./writing/a.md }"]),
    /writing\[0\]\.description/
  );
});

test("missing path is rejected", () => {
  assert.throws(
    () => withWriting(["writing:", "  - { kind: style, description: a }"]),
    /writing\[0\]\.path/
  );
});

test("a non-list writing section is rejected", () => {
  assert.throws(() => withWriting(["writing: { not: a-list }"]), /"writing" must be a list/);
});

// Write a minimal valid world with a caller-supplied `writing:` block and load it.
function withWriting(writingYaml: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "worlds-writing-"));
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
      "prompts:",
      "  gm: [ ./prompts/gm.md ]",
      "memory:",
      "  policy:",
      "    self: { enabled: true }",
      "    peer: { enabled: false }",
      "    memory_types: [ characters ]",
      "  schemas: [ ./memory/characters.yaml ]",
      "  fallback_memory_types: [ entities ]",
      ...writingYaml,
      ""
    ].join("\n")
  );
  try {
    return loadWorldFromDir(root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
