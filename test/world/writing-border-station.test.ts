import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadWorldFromDir } from "../../src/world/loader.ts";
import { buildWriterTools, writingGuideCatalogue } from "../../src/runtime/writer-tools.ts";

// W-D: validate the border-station example writing guides end-to-end against the
// base platform — the real world.yaml parses into WritingGuideSpecs, each guide
// body exists on disk, and the read-only writer tool set surfaces them for the
// writer to read on demand. Static counterpart to a live render (no provider).

const worldRoot = new URL("../../worlds/border-station", import.meta.url).pathname;

test("border-station declares the style and dialogue writing guides", () => {
  const world = loadWorldFromDir(worldRoot);
  const byKind = new Map(world.writingGuides.map((guide) => [guide.kind, guide]));

  const style = byKind.get("style");
  assert.ok(style, "style guide missing");
  assert.match(style.path, /\/writing\/style\.md$/);
  // The declared body exists and is non-empty (existence is deferred from load,
  // so pin it here where the example world must actually ship the file).
  assert.ok(readFileSync(style.path, "utf8").trim().length > 0);

  const dialogue = byKind.get("dialogue");
  assert.ok(dialogue, "dialogue guide missing");
  assert.ok(readFileSync(dialogue.path, "utf8").trim().length > 0);
});

test("the writer tool set exposes read_writing_guide over the border-station guides", async () => {
  const world = loadWorldFromDir(worldRoot);
  const tools = buildWriterTools({
    db: { prepare() {}, exec() {} } as never,
    stateStore: {
      getState: () => ({
        player: { name: "", status: "", location: "" },
        time: { day: 1, hour: 7 },
        scene: { summary: "" },
        attributes: {},
        facts: [],
        relationships: []
      })
    } as never,
    ovClient: undefined,
    writingGuides: world.writingGuides,
    worldName: world.name
  });
  const guide = tools.find((t) => t.name === "read_writing_guide");
  assert.ok(guide, "read_writing_guide must be present");

  const body = await guide.execute({ kind: "style" });
  assert.match(body, /叙事风格/);

  // The catalogue the writer sees lists both kinds with their descriptions.
  assert.deepEqual(
    writingGuideCatalogue(world.writingGuides).map((g) => g.kind),
    ["style", "dialogue"]
  );
});

test("border-station declares a banned-word register for the cliché critic", () => {
  const world = loadWorldFromDir(worldRoot);
  assert.ok(world.revision.bannedWords.length > 0, "border-station should ship a banned-word list");
  assert.ok(world.revision.bannedWords.includes("忽然"));
});
