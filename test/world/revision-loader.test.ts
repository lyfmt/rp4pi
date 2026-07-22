import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadWorldFromDir } from "../../src/world/loader.ts";

// W-F: the declarative `revision:` axis. A world declares the cliché critic's
// banned-word list; the loader normalizes and strictly validates it. The
// revision pipeline (W-G) then consumes this. Absent ⇒ empty list (critics still
// run). These tests pin the loader contract.

test("parses a banned_words list", () => {
  const world = withRevision([
    "revision:",
    "  banned_words:",
    "    - 忽然",
    "    - 顿时",
    "    - 仿佛时间静止"
  ]);
  assert.deepEqual(world.revision.bannedWords, ["忽然", "顿时", "仿佛时间静止"]);
});

test("missing revision section normalizes to an empty banned-word list", () => {
  assert.deepEqual(withRevision([]).revision, { bannedWords: [] });
});

test("revision present but without banned_words normalizes to empty", () => {
  assert.deepEqual(withRevision(["revision: {}"]).revision, { bannedWords: [] });
});

test("a non-list banned_words is rejected", () => {
  assert.throws(() => withRevision(["revision:", "  banned_words: 忽然"]), /revision\.banned_words.*list of strings/s);
});

test("an empty-string banned word is rejected", () => {
  assert.throws(
    () => withRevision(["revision:", "  banned_words: [ 忽然, '' ]"]),
    /revision\.banned_words\[1\].*non-empty string/s
  );
});

// Write a minimal valid world with a caller-supplied `revision:` block and load it.
function withRevision(revisionYaml: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "worlds-revision-"));
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
      ...revisionYaml,
      ""
    ].join("\n")
  );
  try {
    return loadWorldFromDir(root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
